'use strict';

// Exhaustive control-path auditor for isolation-token maintenance scripts.
//
// Semantics (user-facing version lives in the web page help):
//   - acquire T : legal only when T is NOT held; afterwards T is held.
//   - act/release T : legal only when T IS held; release drops T.
//   - if T : the condition is expanded into BOTH outcomes in source order —
//            ① true : T is confirmed HELD on this path (mask set), control
//                     enters the THEN arm, so the arm may act/release T
//                     without a preceding acquire;
//            ② false: control skips the THEN arm; tokens acquired earlier
//                     remain held (the failed test does not release them),
//                     so a release present only in the THEN arm surfaces as
//                     a held token at the exit.
//            Paths reconverge after END; identical canonical states merge.
//   - loop n : the body is repeated exactly n times (bounded back-edges; the
//              bound is statically capped). A token acquired but not released
//              inside the body surfaces as a repeated acquire on iteration 2.
//   - cleanup ... end : the body is NOT executed inline. Reaching CLEANUP
//                registers a pending continuation (identified by its line)
//                and control jumps past END. RETURN / ABORT / falling off the
//                script all run every pending continuation LIFO on exit;
//                lexically nested cleanup blocks register while an outer
//                continuation is expanding and unwind in the same order.
//   - return / abort : unwind pending continuations, then leave the script.
//
// RETURN / ABORT are forbidden lexically inside a cleanup body (they would
// jump out of the cleanup scope).
//
// The analysis is a bounded exhaustive graph traversal over canonical states
// (pc, held-token bitmask, pending-continuation stack, loop counters). Each
// expand() returns an ORDERED edge list; BFS explores edges in that order, so
// the first violation witness is shortest in executed instruction steps and,
// among equal-length witnesses, earliest in source order (THEN before ELSE,
// loop body before loop exit).
//
// Storage note: with three nested loops at the public bound of 64 the
// canonical graph has upwards of 64^3 (about 262k) counter combinations, i.e.
// over a million states. To keep that tractable, per-node witness steps are
// stored as compact records (small arrays of integers/references) and only
// materialized into full step objects when a witness is rebuilt; expanded
// state objects are released immediately after their edges are generated.
// The explored graph, its order and every reported result are identical to
// a naive store-everything traversal.

const { normalizeTokens, parseInstructions, makeError } = require('./instr');

const OP_LABEL = {
  acquire: '获取',
  act: '操作',
  release: '释放',
  if: '条件分支',
  loop: '有限循环',
  cleanup: '清理块',
  end: 'END',
  else: 'ELSE',
  return: '返回',
  abort: '中止',
  implicit: '脚本结束',
};

function exitLabel(kind) {
  return kind === 'return' ? '返回出口' : kind === 'abort' ? '中止出口' : '隐式结束出口';
}

function fmt(names) {
  return names.length ? `{${names.join(', ')}}` : '∅';
}

// ---- lexical checks after block matching ----------------------------------

function lexicalChecks(instrs) {
  const stack = [];
  for (let i = 0; i < instrs.length; i++) {
    const ins = instrs[i];
    if ((ins.op === 'return' || ins.op === 'abort') && stack.includes('cleanup')) {
      throw makeError(
        'ILLEGAL_LEAVE',
        `第 ${ins.line} 行: 非法跳出清理作用域（${ins.op.toUpperCase()} 不得位于清理块内）`,
        ins.line,
      );
    }
    if (ins.op === 'if' || ins.op === 'loop' || ins.op === 'cleanup') stack.push(ins.op);
    else if (ins.op === 'end') stack.pop();
  }
  for (const ins of instrs) {
    if (ins.op === 'else' && !ins.claimed) {
      throw makeError('ELSE_WITHOUT_IF', `第 ${ins.line} 行: ELSE 没有匹配的 IF`, ins.line);
    }
  }
}

// ---- analysis --------------------------------------------------------------

function analyze(rawTokens, rawRows) {
  const tokens = normalizeTokens(rawTokens);
  if (tokens.length < 1) throw makeError('NO_TOKEN', '至少需要录入 1 个令牌');
  const instrs = parseInstructions(rawRows, tokens);
  lexicalChecks(instrs);

  const bit = new Map(tokens.map((t, i) => [t, 1 << i]));
  const n = instrs.length;
  const endOf = (idx) => instrs[idx].endIndex;
  const heldNames = (mask) => tokens.filter((_, i) => mask & (1 << i));
  const pendingNames = (pending) => pending.map((h) => `L${instrs[h].line}`);

  // state:
  //   phase   : 'run' normal flow | 'clean' executing a continuation body
  //   pc      : next instruction index (run: program-wide; clean: body index)
  //   bodyEnd : exclusive end index while in clean mode
  //   mask    : held token bits
  //   pending : LIFO stack of cleanup head indices
  //   loops   : [[headIndex, iterationsDone]] for currently open loops
  //   kind/trigger : exit kind that initiated the current unwind
  const start = {
    phase: 'run', pc: 0, bodyEnd: -1, mask: 0,
    pending: [], loops: [], kind: null, trigger: null,
  };

  const keyOf = (s) =>
    `${s.phase}|${s.pc}|${s.bodyEnd}|${s.mask}|${s.pending.join('.')}|` +
    `${s.loops.map(([h, c]) => `${h}:${c}`).join('.')}|${s.kind}|${s.trigger}`;

  const clone = (s, patch) => {
    const next = Object.assign({}, s);
    next.pending = (patch && Object.prototype.hasOwnProperty.call(patch, 'pending'))
      ? patch.pending.slice()
      : s.pending.slice();
    next.loops = (patch && Object.prototype.hasOwnProperty.call(patch, 'loops'))
      ? patch.loops.map((x) => x.slice())
      : s.loops.map((x) => x.slice());
    if (patch) Object.assign(next, patch);
    return next;
  };
  const go = (s, pc) => clone(s, { pc });
  const counterOf = (s, head) => {
    const f = s.loops.find(([h]) => h === head);
    return f ? f[1] : 0;
  };
  const dropCounter = (s, head) => {
    const next = clone(s, {});
    next.loops = next.loops.filter(([h]) => h !== head);
    return next;
  };

  // expand() returns exactly one of:
  //   { edges: [{ state, step, triggerRaw? }] }  (compact witness records)
  //   { violation: { code, message, line, step } }
  //   { terminal: { kind, triggerLine } }
  function expand(s) {
    const atEnd = s.phase === 'run' ? s.pc >= n : s.pc >= s.bodyEnd;
    if (atEnd) return segmentEnded(s);

    const ins = instrs[s.pc];
    // Compact witness records (see storage note above):
    //   { pc, ph, m, p, e } — pc of the instruction, phase, held mask BEFORE
    //   the step, pending stack (head indices) BEFORE the step, and an `e`
    //   bag holding only varying fields: after (held mask after), pa (pending
    //   stack after), branch, iteration, detail, outcome.
    // materializeStep() rebuilds the full user-facing step object only when
    // a violation witness is reported.
    const rawStep = (s, extra) => ({ pc: s.pc, ph: s.phase, m: s.mask, p: s.pending, e: extra || null });
    const oneRaw = (next, extra, triggerRaw) =>
      ({ edges: [{ state: next, step: rawStep(s, extra), triggerRaw: triggerRaw || null }] });
    const fail = (code, message, extra) => ({
      violation: { code, message, line: ins.line, step: rawStep(s, extra) },
    });

    switch (ins.op) {
      case 'acquire': {
        if (s.mask & bit.get(ins.token)) {
          return fail('DUP_ACQUIRE', `重复获取令牌 ${ins.token}：该令牌已处于持有状态`, {
            detail: `尝试获取已持有的 ${ins.token}`, outcome: '违规',
          });
        }
        const mask = s.mask | bit.get(ins.token);
        return oneRaw(go(clone(s, { mask }), s.pc + 1), {
          after: mask,
          detail: `持有集合: ${fmt(heldNames(s.mask))} → ${fmt(heldNames(mask))}`,
        });
      }
      case 'act':
      case 'release': {
        if (!(s.mask & bit.get(ins.token))) {
          return fail(
            ins.op === 'act' ? 'USE_NOT_HELD' : 'RELEASE_NOT_HELD',
            `${OP_LABEL[ins.op]}未持有令牌 ${ins.token}：操作或释放只能作用于当前持有令牌`,
            { detail: `尝试${OP_LABEL[ins.op]}未持有的 ${ins.token}`, outcome: '违规' },
          );
        }
        const mask = ins.op === 'release' ? s.mask & ~bit.get(ins.token) : s.mask;
        return oneRaw(go(clone(s, { mask }), s.pc + 1), {
          after: mask,
          detail: `持有集合: ${fmt(heldNames(s.mask))} → ${fmt(heldNames(mask))}`,
        });
      }
      case 'if': {
        // Both outcomes are ALWAYS expanded (exhaustive review).
        // ① true : the condition confirms T is held -> set T's bit; THEN arm
        //    may therefore act/release T without a preceding acquire.
        // ② false: skip the THEN arm (jump to ELSE arm or past END); tokens
        //    acquired earlier remain held, so a release that exists only in
        //    the THEN arm is detected as a leak on this path.
        // Edges are emitted in source order (true first).
        const tbit = bit.get(ins.token);
        const trueMask = s.mask | tbit;
        const edges = [];
        edges.push({
          state: go(clone(s, { mask: trueMask }), s.pc + 1),
          step: rawStep(s, {
            branch: 'true',
            after: trueMask,
            detail: `条件 ${ins.token} 按结果①展开：判定成立，${ins.token} 确认持有，进入 THEN 分支`,
          }),
          triggerRaw: null,
        });
        const target = ins.elseIndex >= 0 ? ins.elseIndex + 1 : endOf(s.pc) + 1;
        edges.push({
          state: go(s, target),
          step: rawStep(s, {
            branch: 'false',
            detail: ins.elseIndex >= 0
              ? `条件 ${ins.token} 按结果②展开：判定不成立，已持有令牌保持不变，进入 ELSE 分支`
              : `条件 ${ins.token} 按结果②展开：判定不成立，已持有令牌保持不变，跳过 THEN 分支`,
          }),
          triggerRaw: null,
        });
        return { edges };
      }
      case 'loop': {
        const k = counterOf(s, s.pc);
        if (k < ins.bound) {
          return oneRaw(go(s, s.pc + 1), {
            iteration: k + 1,
            detail: `进入循环第 ${k + 1}/${ins.bound} 轮`,
          });
        }
        return oneRaw(go(dropCounter(s, s.pc), endOf(s.pc) + 1), {
          detail: `已完成 ${ins.bound} 轮循环，退出循环`,
        });
      }
      case 'end': {
        if (ins.kind === 'loop') {
          const head = ins.headIndex;
          const k = counterOf(s, head);
          const next = clone(s, {});
          next.loops = next.loops.filter(([h]) => h !== head);
          next.loops.push([head, k + 1]);
          return oneRaw(go(next, head), {
            detail: `循环体第 ${k + 1} 轮结束，回到循环头`,
          });
        }
        return oneRaw(go(s, s.pc + 1), { detail: '条件分支结束' });
      }
      case 'else':
        return oneRaw(go(s, ins.endIndex + 1), { detail: '跳过 ELSE 分支' });
      case 'cleanup': {
        const pending = s.pending.concat(s.pc);
        const next = clone(s, { pending });
        return oneRaw(go(next, endOf(s.pc) + 1), {
          pa: pending,
          detail: `注册清理续体 L${ins.line}（内联跳过主体），续体栈: ${fmt(pendingNames(pending))}`,
        });
      }
      case 'return':
      case 'abort':
        return beginExit(s, ins.op, ins.line);
      default:
        throw makeError('INTERNAL', `未实现的指令 ${ins.op}`, ins.line);
    }
  }

  // Exit/continuation records mirror rawStep but carry the exit kind or
  // cleanup head directly (there is no single program pc for them).
  function exitRaw(s, kind, triggerLine) {
    return {
      kind,
      line: triggerLine,
      ph: s.phase,
      m: s.mask,
      p: s.pending,
      detail: kind === 'implicit'
        ? '控制流到达脚本末尾，开始后进先出展开清理续体'
        : `${OP_LABEL[kind]}离开脚本，开始后进先出展开清理续体`,
    };
  }

  function continuationRaw(s, head, pending) {
    return {
      head,
      line: instrs[head].line,
      ph: 'clean',
      m: s.mask,
      p: s.pending,
      pa: pending,
      detail: `展开清理续体 L${instrs[head].line}，剩余待执行: ${fmt(pendingNames(pending))}`,
    };
  }

  function beginExit(s, kind, triggerLine) {
    const marker = exitRaw(s, kind, triggerLine);
    return unwind(s, kind, triggerLine, marker);
  }

  // Run-mode flow fell off the script, or a clean-mode body finished.
  function segmentEnded(s) {
    if (s.phase === 'clean') {
      if (s.pending.length === 0) return terminal(s);
      const head = s.pending[s.pending.length - 1];
      const pending = s.pending.slice(0, -1);
      const next = clone(s, { phase: 'clean', pc: head + 1, bodyEnd: endOf(head), pending });
      return { edges: [{ state: next, step: continuationRaw(s, head, pending), triggerRaw: null }] };
    }
    return unwind(s, 'implicit', null, exitRaw(s, 'implicit', null));
  }

  function unwind(s, kind, trigger, marker) {
    if (s.pending.length === 0) return terminal(s, marker);
    const head = s.pending[s.pending.length - 1];
    const pending = s.pending.slice(0, -1);
    const next = clone(s, {
      phase: 'clean', pc: head + 1, bodyEnd: endOf(head), pending, kind, trigger,
    });
    // marker (return/abort/implicit-exit) precedes the first expansion.
    return { edges: [{ state: next, step: continuationRaw(s, head, pending), triggerRaw: marker }] };
  }

  function terminal(s, marker) {
    const remain = heldNames(s.mask);
    if (remain.length) {
      return {
        violation: {
          code: 'LEAK_ON_EXIT',
          message: `${exitLabel(s.kind || 'implicit')}完成全部清理后仍持有令牌 ${remain.join('、')}，隔离状态泄漏`,
          line: s.trigger,
          step: marker || null,
        },
      };
    }
    return { terminal: { kind: s.kind || 'implicit', triggerLine: s.trigger } };
  }

  // ---- BFS with parent tracking ----
  // The public per-loop bound is 64, so three nested loops legitimately
  // produce ~64^3 counter combinations (over 1e6 canonical states); the
  // budget must comfortably cover every script the parser accepts.
  const STATE_BUDGET = 2_000_000;
  // Witness detail strings repeat verbatim across the vast majority of the
  // millions of edges (loop entry/exit text, held-set deltas, ...); intern
  // them so each distinct wording is retained once.
  const detailIntern = new Map();
  const intern = (text) => {
    const hit = detailIntern.get(text);
    if (hit !== undefined) return hit;
    detailIntern.set(text, text);
    return text;
  };

  // Nodes are integer ids; parallel arrays replace per-node wrapper objects
  // and duplicated parent-key strings.
  const seen = new Map(); // canonical key -> node id
  let parentIds = new Int32Array(1024);
  let stepRecs = new Array(1024);
  let trigRecs = new Array(1024);
  const ensureCap = (need) => {
    if (need <= parentIds.length) return;
    const cap = parentIds.length * 2;
    const p = new Int32Array(cap);
    p.set(parentIds);
    parentIds = p;
    const oldSteps = stepRecs;
    const oldTrigs = trigRecs;
    stepRecs = new Array(cap);
    trigRecs = new Array(cap);
    for (let i = 0; i < oldSteps.length; i++) {
      stepRecs[i] = oldSteps[i];
      trigRecs[i] = oldTrigs[i];
    }
  };
  let nodeCount = 0;
  const addNode = (key, parentId, step, trigger) => {
    ensureCap(nodeCount + 1);
    parentIds[nodeCount] = parentId;
    stepRecs[nodeCount] = step;
    trigRecs[nodeCount] = trigger;
    seen.set(key, nodeCount);
    return nodeCount++;
  };
  addNode(keyOf(start), -1, null, null);

  const queue = [start];
  const queueIds = [0];
  const exits = new Map(); // `${kind}@${trigger}` -> summary
  let edgeCount = 0;
  let head = 0; // BFS read cursor (avoids O(n^2) queue.shift())

  // Recover the cleanup-body releases (token + line) sitting on a witness
  // path, straight from the compact records.
  const releasedOnPath = (id) => {
    const out = [];
    let k = id;
    while (k >= 0) {
      const rec = stepRecs[k];
      if (rec && 'pc' in rec && rec.ph === 'clean') {
        const insAt = instrs[rec.pc];
        if (insAt.op === 'release') out.push({ token: insAt.token, line: insAt.line });
      }
      k = parentIds[k];
    }
    return out;
  };

  while (head < queue.length) {
    const s = queue[head];
    queue[head] = null; // processed states are unreachable otherwise; free them
    const curId = queueIds[head];
    head++;
    const res = expand(s);

    if (res.violation) return buildViolation(res.violation, curId);

    if (res.terminal) {
      const id = `${res.terminal.kind}@${res.terminal.triggerLine == null ? 'end' : res.terminal.triggerLine}`;
      if (!exits.has(id)) {
        exits.set(id, {
          kind: res.terminal.kind,
          triggerLine: res.terminal.triggerLine,
          released: new Set(),
          canonicalArrivals: 0,
        });
      }
      const rec = exits.get(id);
      rec.canonicalArrivals += 1;
      for (const r of releasedOnPath(curId)) rec.released.add(`${r.token}@L${r.line}`);
      continue;
    }

    for (const e of res.edges) {
      edgeCount += 1;
      const k = keyOf(e.state);
      if (!seen.has(k)) {
        if (nodeCount >= STATE_BUDGET) {
          throw makeError(
            'STATE_BUDGET',
            `穷尽展开超过 ${STATE_BUDGET} 个规范状态（嵌套循环上界乘积过大），请调小循环次数`,
          );
        }
        if (e.step && e.step.e && e.step.e.detail) e.step.e.detail = intern(e.step.e.detail);
        if (e.triggerRaw && e.triggerRaw.detail) e.triggerRaw.detail = intern(e.triggerRaw.detail);
        const id = addNode(k, curId, e.step, e.triggerRaw || null);
        queue.push(e.state);
        queueIds.push(id);
      }
    }
  }

  return {
    safe: true,
    stats: {
      canonicalStates: nodeCount,
      transitions: edgeCount,
      instructionCount: n,
      tokenCount: tokens.length,
      exitCount: exits.size,
    },
    exits: [...exits.values()].map((r) => ({
      kind: r.kind,
      kindLabel: exitLabel(r.kind),
      triggerLine: r.triggerLine,
      released: [...r.released].sort(),
      canonicalArrivals: r.canonicalArrivals,
    })),
    tokens,
    instructions: instrs.map(dumpInstr),
  };

  // Turn a compact stored record back into the full user-facing step object.
  function materializeStep(rec) {
    if ('pc' in rec) {
      const ins = instrs[rec.pc];
      const e = rec.e || {};
      const before = rec.m;
      const after = Object.prototype.hasOwnProperty.call(e, 'after') ? e.after : before;
      const pendingBefore = rec.p;
      const pendingAfter = Object.prototype.hasOwnProperty.call(e, 'pa') ? e.pa : pendingBefore;
      const step = {
        line: ins.line,
        op: ins.op,
        label: OP_LABEL[ins.op],
        token: ins.token || null,
        phase: rec.ph,
        heldBefore: heldNames(before),
        heldAfter: heldNames(after),
        pendingBefore: pendingNames(pendingBefore),
        pendingAfter: pendingNames(pendingAfter),
      };
      if (e.branch) step.branch = e.branch;
      if (e.iteration) step.iteration = e.iteration;
      if (e.detail) step.detail = e.detail;
      if (e.outcome) step.outcome = e.outcome;
      return step;
    }
    if ('head' in rec) {
      return {
        line: rec.line,
        op: 'cleanup',
        label: '展开清理',
        token: null,
        phase: 'clean',
        cleanupExpand: true,
        heldBefore: heldNames(rec.m),
        heldAfter: heldNames(rec.m),
        pendingBefore: pendingNames(rec.p),
        pendingAfter: pendingNames(rec.pa),
        detail: rec.detail,
      };
    }
    // Exit marker (return / abort / implicit end).
    return {
      line: rec.line,
      op: rec.kind,
      label: OP_LABEL[rec.kind],
      token: null,
      phase: rec.ph,
      heldBefore: heldNames(rec.m),
      heldAfter: heldNames(rec.m),
      pendingBefore: pendingNames(rec.p),
      pendingAfter: pendingNames(rec.p),
      detail: rec.detail,
    };
  }

  function buildViolation(v, curId) {
    // Walk leaf -> root; for each node the trigger marker precedes its step.
    const reversed = [];
    let k = curId;
    while (k >= 0) {
      if (stepRecs[k]) reversed.push(stepRecs[k]);
      if (trigRecs[k]) reversed.push(trigRecs[k]);
      k = parentIds[k];
    }
    reversed.reverse();
    if (v.step) reversed.push(v.step);
    const chain = reversed.map(materializeStep);
    chain.forEach((st, i) => { st.seq = i + 1; });
    return {
      safe: false,
      violation: { code: v.code, message: v.message, line: v.line },
      pathLength: chain.length,
      steps: chain,
      tokens,
      instructions: instrs.map(dumpInstr),
    };
  }
}

function dumpInstr(ins) {
  return {
    line: ins.line,
    op: ins.op,
    label: OP_LABEL[ins.op],
    token: ins.token || null,
    bound: ins.bound || null,
    endLine: ins.endLine || null,
  };
}

module.exports = { analyze, OP_LABEL, exitLabel };
