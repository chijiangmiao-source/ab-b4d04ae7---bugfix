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
  //   { edges: [{ state, step, triggerStep? }] }
  //   { violation: { code, message, line, step } }
  //   { terminal: { kind, triggerLine } }
  function expand(s) {
    const atEnd = s.phase === 'run' ? s.pc >= n : s.pc >= s.bodyEnd;
    if (atEnd) return segmentEnded(s);

    const ins = instrs[s.pc];
    const stepBase = {
      line: ins.line,
      op: ins.op,
      label: OP_LABEL[ins.op],
      token: ins.token || null,
      phase: s.phase,
      heldBefore: heldNames(s.mask),
      heldAfter: heldNames(s.mask),
      pendingBefore: pendingNames(s.pending),
      pendingAfter: pendingNames(s.pending),
    };
    const one = (next, extra, triggerStep) =>
      ({ edges: [{ state: next, step: Object.assign({}, stepBase, extra), triggerStep: triggerStep || null }] });
    const fail = (code, message, extra) => ({
      violation: { code, message, line: ins.line, step: Object.assign({}, stepBase, extra) },
    });

    switch (ins.op) {
      case 'acquire': {
        if (s.mask & bit.get(ins.token)) {
          return fail('DUP_ACQUIRE', `重复获取令牌 ${ins.token}：该令牌已处于持有状态`, {
            detail: `尝试获取已持有的 ${ins.token}`, outcome: '违规',
          });
        }
        const mask = s.mask | bit.get(ins.token);
        return one(go(clone(s, { mask }), s.pc + 1), {
          heldAfter: heldNames(mask),
          detail: `持有集合: ${fmt(stepBase.heldBefore)} → ${fmt(heldNames(mask))}`,
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
        return one(go(clone(s, { mask }), s.pc + 1), {
          heldAfter: heldNames(mask),
          detail: `持有集合: ${fmt(stepBase.heldBefore)} → ${fmt(heldNames(mask))}`,
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
          step: Object.assign({}, stepBase, {
            branch: 'true',
            heldAfter: heldNames(trueMask),
            detail: `条件 ${ins.token} 按结果①展开：判定成立，${ins.token} 确认持有，进入 THEN 分支`,
          }),
          triggerStep: null,
        });
        const target = ins.elseIndex >= 0 ? ins.elseIndex + 1 : endOf(s.pc) + 1;
        edges.push({
          state: go(s, target),
          step: Object.assign({}, stepBase, {
            branch: 'false',
            heldAfter: stepBase.heldBefore,
            detail: ins.elseIndex >= 0
              ? `条件 ${ins.token} 按结果②展开：判定不成立，已持有令牌保持不变，进入 ELSE 分支`
              : `条件 ${ins.token} 按结果②展开：判定不成立，已持有令牌保持不变，跳过 THEN 分支`,
          }),
          triggerStep: null,
        });
        return { edges };
      }
      case 'loop': {
        const k = counterOf(s, s.pc);
        if (k < ins.bound) {
          return one(go(s, s.pc + 1), {
            iteration: k + 1,
            detail: `进入循环第 ${k + 1}/${ins.bound} 轮`,
          });
        }
        return one(go(dropCounter(s, s.pc), endOf(s.pc) + 1), {
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
          return one(go(next, head), {
            detail: `循环体第 ${k + 1} 轮结束，回到循环头`,
          });
        }
        return one(go(s, s.pc + 1), { detail: '条件分支结束' });
      }
      case 'else':
        return one(go(s, ins.endIndex + 1), { detail: '跳过 ELSE 分支' });
      case 'cleanup': {
        const pending = s.pending.concat(s.pc);
        const next = clone(s, { pending });
        return one(go(next, endOf(s.pc) + 1), {
          pendingAfter: pendingNames(pending),
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

  function exitStep(s, kind, triggerLine) {
    return {
      line: triggerLine,
      op: kind,
      label: OP_LABEL[kind],
      token: null,
      phase: s.phase,
      heldBefore: heldNames(s.mask),
      heldAfter: heldNames(s.mask),
      pendingBefore: pendingNames(s.pending),
      pendingAfter: pendingNames(s.pending),
      detail: kind === 'implicit'
        ? '控制流到达脚本末尾，开始后进先出展开清理续体'
        : `${OP_LABEL[kind]}离开脚本，开始后进先出展开清理续体`,
    };
  }

  function continuationStep(s, head, pending) {
    return {
      line: instrs[head].line,
      op: 'cleanup',
      label: '展开清理',
      token: null,
      phase: 'clean',
      cleanupExpand: true,
      heldBefore: heldNames(s.mask),
      heldAfter: heldNames(s.mask),
      pendingBefore: pendingNames(s.pending),
      pendingAfter: pendingNames(pending),
      detail: `展开清理续体 L${instrs[head].line}，剩余待执行: ${fmt(pendingNames(pending))}`,
    };
  }

  function beginExit(s, kind, triggerLine) {
    const marker = exitStep(s, kind, triggerLine);
    return unwind(s, kind, triggerLine, marker);
  }

  // Run-mode flow fell off the script, or a clean-mode body finished.
  function segmentEnded(s) {
    if (s.phase === 'clean') {
      if (s.pending.length === 0) return terminal(s);
      const head = s.pending[s.pending.length - 1];
      const pending = s.pending.slice(0, -1);
      const next = clone(s, { phase: 'clean', pc: head + 1, bodyEnd: endOf(head), pending });
      return { edges: [{ state: next, step: continuationStep(s, head, pending), triggerStep: null }] };
    }
    return unwind(s, 'implicit', null, exitStep(s, 'implicit', null));
  }

  function unwind(s, kind, trigger, marker) {
    if (s.pending.length === 0) return terminal(s, marker);
    const head = s.pending[s.pending.length - 1];
    const pending = s.pending.slice(0, -1);
    const next = clone(s, {
      phase: 'clean', pc: head + 1, bodyEnd: endOf(head), pending, kind, trigger,
    });
    // marker (return/abort/implicit-exit) precedes the first expansion.
    return { edges: [{ state: next, step: continuationStep(s, head, pending), triggerStep: marker }] };
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
  const STATE_BUDGET = 120000;
  const queue = [start];
  const seen = new Map(); // key -> { state, parentKey, step, triggerStep }
  seen.set(keyOf(start), { state: start, parentKey: null, step: null, triggerStep: null });
  const exits = new Map(); // `${kind}@${trigger}` -> summary
  let edgeCount = 0;

  const releasedOnPath = (key) => {
    const out = [];
    let k = key;
    while (k) {
      const node = seen.get(k);
      if (node.step && node.step.op === 'release' && node.step.phase === 'clean') {
        out.push({ token: node.step.token, line: node.step.line });
      }
      k = node.parentKey;
    }
    return out;
  };

  while (queue.length) {
    const s = queue.shift();
    const curKey = keyOf(s);
    const res = expand(s);

    if (res.violation) return buildViolation(res.violation, seen, curKey);

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
      for (const r of releasedOnPath(curKey)) rec.released.add(`${r.token}@L${r.line}`);
      continue;
    }

    for (const e of res.edges) {
      edgeCount += 1;
      const k = keyOf(e.state);
      if (!seen.has(k)) {
        if (seen.size >= STATE_BUDGET) {
          throw makeError(
            'STATE_BUDGET',
            `穷尽展开超过 ${STATE_BUDGET} 个规范状态（嵌套循环上界乘积过大），请调小循环次数`,
          );
        }
        seen.set(k, {
          state: e.state,
          parentKey: curKey,
          step: e.step,
          triggerStep: e.triggerStep || null,
        });
        queue.push(e.state);
      }
    }
  }

  return {
    safe: true,
    stats: {
      canonicalStates: seen.size,
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

  function buildViolation(v, seenMap, curKey) {
    // Walk leaf -> root; for each node the trigger marker precedes its step.
    const reversed = [];
    let k = curKey;
    while (k) {
      const node = seenMap.get(k);
      if (node.step) reversed.push(node.step);
      if (node.triggerStep) reversed.push(node.triggerStep);
      k = node.parentKey;
    }
    reversed.reverse();
    if (v.step) reversed.push(v.step);
    const chain = reversed;
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
