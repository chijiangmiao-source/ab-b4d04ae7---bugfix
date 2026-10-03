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
// A legal script can legitimately expand to ~1e6 canonical states (three
// nested loops at the public bound of 64). Rows therefore live in packed
// typed arrays (~40 bytes/state) with hash-consed persistent stacks; the rich
// step objects rendered for a violation witness are reconstructed only on
// demand by walking parent rows.

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

  // ---- packed encodings ----
  const PHASE_RUN = 0;
  const PHASE_CLEAN = 1;
  const KIND_NONE = 0;
  const KIND_RETURN = 1;
  const KIND_ABORT = 2;
  const KIND_IMPLICIT = 3;
  const KIND_OF = { return: KIND_RETURN, abort: KIND_ABORT, implicit: KIND_IMPLICIT };
  const NAME_OF = { [KIND_RETURN]: 'return', [KIND_ABORT]: 'abort', [KIND_IMPLICIT]: 'implicit' };
  // Why the successor row exists — selects witness reconstruction detail.
  const EDGE_PLAIN = 0;
  const EDGE_LOOP_ENTER = 1;
  const EDGE_IF_TRUE = 2;
  const EDGE_IF_FALSE = 3;
  const EDGE_CONTINUE = 4;

  // Interned loop-counter stacks (immutable linked sequences, empty = -1):
  // each ref stores { head: loop-head instruction index,
  //                  count: iterations already done, tail: older ref }.
  // Hash consing makes structurally equal stacks share one id across paths.
  const loopsMap = new Map();
  const loopsHead = [];
  const loopsCount = [];
  const loopsTail = [];
  function loopsCons(tail, head, count) {
    const key = `${tail}|${head}|${count}`;
    const hit = loopsMap.get(key);
    if (hit !== undefined) return hit;
    const ref = loopsHead.length;
    loopsMap.set(key, ref);
    loopsHead.push(head);
    loopsCount.push(count);
    loopsTail.push(tail);
    return ref;
  }
  function loopsCounter(ref, head) {
    for (let r = ref; r >= 0; r = loopsTail[r]) {
      if (loopsHead[r] === head) return loopsCount[r];
    }
    return 0;
  }
  // Stack copy with one loop head removed, rebuilt through the cons table so
  // the remainder is shared with every other path holding the same counters.
  function loopsWithout(ref, dropped) {
    const kept = []; // traversal is inner -> outer
    for (let r = ref; r >= 0; r = loopsTail[r]) {
      if (loopsHead[r] !== dropped) kept.push([loopsHead[r], loopsCount[r]]);
    }
    let out = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      out = loopsCons(out, kept[i][0], kept[i][1]);
    }
    return out;
  }

  // Interned pending-continuation stacks (empty = -1); entries hold a cleanup
  // head instruction index.
  const pendingMap = new Map();
  const pendingHead = [];
  const pendingTail = [];
  function pendingCons(tail, head) {
    const key = `${tail}|${head}`;
    const hit = pendingMap.get(key);
    if (hit !== undefined) return hit;
    const ref = pendingHead.length;
    pendingMap.set(key, ref);
    pendingHead.push(head);
    pendingTail.push(tail);
    return ref;
  }
  function pendingNames(ref) {
    const out = [];
    for (let r = ref; r >= 0; r = pendingTail[r]) {
      out.push(`L${instrs[pendingHead[r]].line}`);
    }
    return out.reverse();
  }

  // Canonical-state rows, grown on demand.
  const STATE_BUDGET = 3000000;
  let cap = 4096;
  let rows = 0;
  const col = {
    par: new Int32Array(cap),     // parent row (-1 for the start row)
    pc: new Int32Array(cap),      // next instruction to execute
    bodyEnd: new Int32Array(cap), // exclusive body end while in clean mode
    stepPc: new Int32Array(cap),  // instruction whose execution made this row
    mask: new Uint32Array(cap),   // held-token bits
    loops: new Int32Array(cap),   // interned loop-counter stack ref
    pending: new Int32Array(cap), // interned continuation stack ref
    trigger: new Int32Array(cap), // exit trigger line (-1 = none / implicit)
    kind: new Uint8Array(cap),    // exit kind during unwind (KIND_*)
    phase: new Uint8Array(cap),   // PHASE_RUN / PHASE_CLEAN
    edge: new Uint8Array(cap),    // EDGE_* kind of the incoming edge
    marker: new Uint8Array(cap),  // 1: exit marker precedes this row's step
  };
  function growColumns() {
    cap *= 2;
    for (const k of Object.keys(col)) {
      const next = new col[k].constructor(cap);
      next.set(col[k]);
      col[k] = next;
    }
  }

  const seen = new Map(); // canonical key -> row id
  const queue = [];       // BFS FIFO (qhead index avoids Array#shift cost)
  let qhead = 0;

  // Successor frame; `kind`/`trigger` are string/null on the way in.
  // intern() deduplicates canonically equal frames and schedules fresh rows.
  function intern(f, parent) {
    const kindCode = f.kind ? KIND_OF[f.kind] : KIND_NONE;
    const trig = f.trigger == null ? -1 : f.trigger;
    const key =
      `${f.phase}|${f.pc}|${f.bodyEnd}|${f.mask}|${f.pending}|${f.loops}|${kindCode}|${trig}`;
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    if (rows >= STATE_BUDGET) {
      throw makeError(
        'STATE_BUDGET',
        `穷尽展开超过 ${STATE_BUDGET} 个规范状态（嵌套循环上界乘积过大），请调小循环次数`,
      );
    }
    if (rows === col.par.length) growColumns();
    const id = rows++;
    col.par[id] = parent;
    col.pc[id] = f.pc;
    col.bodyEnd[id] = f.bodyEnd;
    col.stepPc[id] = f.stepPc;
    col.mask[id] = f.mask;
    col.loops[id] = f.loops;
    col.pending[id] = f.pending;
    col.kind[id] = kindCode;
    col.trigger[id] = trig;
    col.phase[id] = f.phase;
    col.edge[id] = f.edge;
    col.marker[id] = f.marker ? 1 : 0;
    seen.set(key, id);
    queue.push(id);
    return id;
  }

  function triggerOf(id) {
    return col.trigger[id] === -1 ? null : col.trigger[id];
  }
  function kindOf(id) {
    return col.kind[id] === KIND_NONE ? null : NAME_OF[col.kind[id]];
  }

  // Rich exit marker (return / abort / implicit unwind start). It always
  // originates in run mode and precedes the first continuation expansion.
  function markerStep(id, kind, trigger) {
    const names = heldNames(col.mask[id]);
    const pend = pendingNames(col.pending[id]);
    return {
      line: trigger,
      op: kind,
      label: OP_LABEL[kind],
      token: null,
      phase: 'run',
      heldBefore: names,
      heldAfter: names,
      pendingBefore: pend,
      pendingAfter: pend,
      detail: kind === 'implicit'
        ? '控制流到达脚本末尾，开始后进先出展开清理续体'
        : `${OP_LABEL[kind]}离开脚本，开始后进先出展开清理续体`,
    };
  }

  // All continuations finished: safe exit, or held tokens left behind.
  // marker is the rich exit step when the unwind starts here, or null for a
  // continuation chain whose marker is recorded on an ancestor row.
  function terminalOrLeak(id, kind, trigger, marker) {
    const remain = heldNames(col.mask[id]);
    if (remain.length) {
      return {
        violation: {
          code: 'LEAK_ON_EXIT',
          message: `${exitLabel(kind)}完成全部清理后仍持有令牌 ${remain.join('、')}，隔离状态泄漏`,
          line: trigger,
          step: marker,
        },
      };
    }
    return { terminal: { kind, triggerLine: trigger } };
  }

  // Edge into the next pending continuation body (LIFO unwind).
  function continuationEdge(id, kind, trigger, withMarker) {
    const pend = col.pending[id];
    const head = pendingHead[pend];
    return {
      edges: [{
        phase: PHASE_CLEAN,
        pc: head + 1,
        bodyEnd: endOf(head),
        stepPc: head,
        mask: col.mask[id],
        loops: col.loops[id],
        pending: pendingTail[pend],
        kind,
        trigger,
        edge: EDGE_CONTINUE,
        marker: withMarker,
      }],
    };
  }

  function beginExit(id, kind, trigger) {
    if (col.pending[id] === -1) {
      return terminalOrLeak(id, kind, trigger, markerStep(id, kind, trigger));
    }
    return continuationEdge(id, kind, trigger, 1);
  }

  // Run-mode flow fell off the script, or a clean-mode body finished.
  function segmentEnded(id) {
    if (col.phase[id] === PHASE_CLEAN) {
      const kind = kindOf(id);
      if (col.pending[id] === -1) return terminalOrLeak(id, kind, triggerOf(id), null);
      return continuationEdge(id, kind, triggerOf(id), 0);
    }
    if (col.pending[id] === -1) {
      return terminalOrLeak(id, 'implicit', null, markerStep(id, 'implicit', null));
    }
    return continuationEdge(id, 'implicit', null, 1);
  }

  function fail(id, ins, code, message, extra) {
    const names = heldNames(col.mask[id]);
    const pend = pendingNames(col.pending[id]);
    return {
      violation: {
        code,
        message,
        line: ins.line,
        step: Object.assign({
          line: ins.line,
          op: ins.op,
          label: OP_LABEL[ins.op],
          token: ins.token || null,
          phase: col.phase[id] === PHASE_CLEAN ? 'clean' : 'run',
          heldBefore: names,
          heldAfter: names,
          pendingBefore: pend,
          pendingAfter: pend,
        }, extra),
      },
    };
  }

  // expand() returns exactly one of:
  //   { edges: [successorFrame, ...] }
  //   { violation: { code, message, line, step } }
  //   { terminal: { kind, triggerLine } }
  function expand(id) {
    const pc = col.pc[id];
    const phase = col.phase[id];
    const atEnd = phase === PHASE_RUN ? pc >= n : pc >= col.bodyEnd[id];
    if (atEnd) return segmentEnded(id);

    const ins = instrs[pc];
    const mask = col.mask[id];
    // Default successor stays in the same frame with unchanged holdings.
    const edge = (patch) => Object.assign({
      phase,
      pc: pc + 1,
      bodyEnd: col.bodyEnd[id],
      stepPc: pc,
      mask,
      loops: col.loops[id],
      pending: col.pending[id],
      kind: kindOf(id),
      trigger: triggerOf(id),
      edge: EDGE_PLAIN,
      marker: 0,
    }, patch);

    switch (ins.op) {
      case 'acquire': {
        if (mask & bit.get(ins.token)) {
          return fail(id, ins, 'DUP_ACQUIRE',
            `重复获取令牌 ${ins.token}：该令牌已处于持有状态`,
            { detail: `尝试获取已持有的 ${ins.token}`, outcome: '违规' });
        }
        return { edges: [edge({ mask: mask | bit.get(ins.token) })] };
      }
      case 'act':
      case 'release': {
        if (!(mask & bit.get(ins.token))) {
          return fail(id, ins,
            ins.op === 'act' ? 'USE_NOT_HELD' : 'RELEASE_NOT_HELD',
            `${OP_LABEL[ins.op]}未持有令牌 ${ins.token}：操作或释放只能作用于当前持有令牌`,
            { detail: `尝试${OP_LABEL[ins.op]}未持有的 ${ins.token}`, outcome: '违规' });
        }
        const nextMask = ins.op === 'release' ? mask & ~bit.get(ins.token) : mask;
        return { edges: [edge({ mask: nextMask })] };
      }
      case 'if': {
        // Both outcomes are ALWAYS expanded (exhaustive review), in source
        // order: ① true confirms T held and enters THEN; ② false skips THEN
        // (to ELSE or past END) while earlier-acquired tokens stay held.
        const tbit = bit.get(ins.token);
        const target = ins.elseIndex >= 0 ? ins.elseIndex + 1 : endOf(pc) + 1;
        return {
          edges: [
            edge({ mask: mask | tbit, edge: EDGE_IF_TRUE }),
            edge({ pc: target, edge: EDGE_IF_FALSE }),
          ],
        };
      }
      case 'loop': {
        const k = loopsCounter(col.loops[id], pc);
        if (k < ins.bound) return { edges: [edge({ edge: EDGE_LOOP_ENTER })] };
        return { edges: [edge({ pc: endOf(pc) + 1, loops: loopsWithout(col.loops[id], pc) })] };
      }
      case 'end': {
        if (ins.kind === 'loop') {
          const head = ins.headIndex;
          const k = loopsCounter(col.loops[id], head);
          let nextLoops = loopsWithout(col.loops[id], head);
          nextLoops = loopsCons(nextLoops, head, k + 1);
          return { edges: [edge({ pc: head, loops: nextLoops })] };
        }
        return { edges: [edge({})] };
      }
      case 'else':
        return { edges: [edge({ pc: ins.endIndex + 1 })] };
      case 'cleanup':
        return { edges: [edge({
          pc: endOf(pc) + 1,
          pending: pendingCons(col.pending[id], pc),
        })] };
      case 'return':
      case 'abort':
        return beginExit(id, ins.op, ins.line);
      default:
        throw makeError('INTERNAL', `未实现的指令 ${ins.op}`, ins.line);
    }
  }

  // ---- BFS ----
  intern({
    phase: PHASE_RUN, pc: 0, bodyEnd: -1, stepPc: -1, mask: 0,
    loops: -1, pending: -1, kind: null, trigger: null,
    edge: EDGE_PLAIN, marker: 0,
  }, -1); // row 0

  const exits = new Map(); // `${kind}@${trigger}` -> summary
  let edgeCount = 0;

  while (qhead < queue.length) {
    const id = queue[qhead++];
    const res = expand(id);

    if (res.violation) return buildViolation(id, res.violation);

    if (res.terminal) {
      const t = res.terminal;
      const eid = `${t.kind}@${t.triggerLine == null ? 'end' : t.triggerLine}`;
      let rec = exits.get(eid);
      if (!rec) {
        rec = { kind: t.kind, triggerLine: t.triggerLine, released: new Set(), canonicalArrivals: 0 };
        exits.set(eid, rec);
      }
      rec.canonicalArrivals += 1;
      for (let p = id; p > 0; p = col.par[p]) {
        if (col.phase[p] !== PHASE_CLEAN) continue;
        const si = col.stepPc[p];
        if (si >= 0 && instrs[si].op === 'release') {
          rec.released.add(`${instrs[si].token}@L${instrs[si].line}`);
        }
      }
      continue;
    }

    for (const f of res.edges) {
      edgeCount += 1;
      intern(f, id);
    }
  }

  return {
    safe: true,
    stats: {
      canonicalStates: rows,
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

  // Reconstruct the rich ordered step list of the first violation by walking
  // parent rows leaf -> root, then reversing; the exit marker precedes the
  // first continuation expansion of its unwind.
  function buildViolation(curId, v) {
    const leafToRoot = [];
    for (let id = curId; id > 0; id = col.par[id]) {
      leafToRoot.push(richStep(id));
      if (col.marker[id]) {
        leafToRoot.push(markerStep(col.par[id], NAME_OF[col.kind[id]], triggerOf(id)));
      }
    }
    leafToRoot.reverse();
    if (v.step) leafToRoot.push(v.step);
    leafToRoot.forEach((st, i) => { st.seq = i + 1; });
    return {
      safe: false,
      violation: { code: v.code, message: v.message, line: v.line },
      pathLength: leafToRoot.length,
      steps: leafToRoot,
      tokens,
      instructions: instrs.map(dumpInstr),
    };
  }

  // Rich step object for the edge that led to row id.
  function richStep(id) {
    const parent = col.par[id];
    const edgeKind = col.edge[id];
    const isContinue = edgeKind === EDGE_CONTINUE;
    const headInstr = instrs[col.stepPc[id]];
    const before = heldNames(col.mask[parent]);
    const after = heldNames(col.mask[id]);
    const beforePending = pendingNames(col.pending[parent]);
    const afterPending = pendingNames(col.pending[id]);
    const st = {
      line: headInstr.line,
      op: isContinue ? 'cleanup' : headInstr.op,
      label: isContinue ? '展开清理' : OP_LABEL[headInstr.op],
      token: headInstr.token || null,
      phase: isContinue || col.phase[parent] === PHASE_CLEAN ? 'clean' : 'run',
      heldBefore: before,
      heldAfter: after,
      pendingBefore: beforePending,
      pendingAfter: afterPending,
    };
    if (isContinue) st.cleanupExpand = true;
    if (edgeKind === EDGE_IF_TRUE) st.branch = 'true';
    if (edgeKind === EDGE_IF_FALSE) st.branch = 'false';

    if (isContinue) {
      st.detail = `展开清理续体 L${headInstr.line}，剩余待执行: ${fmt(afterPending)}`;
    } else if (headInstr.op === 'acquire' || headInstr.op === 'act' || headInstr.op === 'release') {
      st.detail = `持有集合: ${fmt(before)} → ${fmt(after)}`;
    } else if (headInstr.op === 'if') {
      if (edgeKind === EDGE_IF_TRUE) {
        st.detail = `条件 ${headInstr.token} 按结果①展开：判定成立，${headInstr.token} 确认持有，进入 THEN 分支`;
      } else if (headInstr.elseIndex >= 0) {
        st.detail = `条件 ${headInstr.token} 按结果②展开：判定不成立，已持有令牌保持不变，进入 ELSE 分支`;
      } else {
        st.detail = `条件 ${headInstr.token} 按结果②展开：判定不成立，已持有令牌保持不变，跳过 THEN 分支`;
      }
    } else if (headInstr.op === 'loop') {
      if (edgeKind === EDGE_LOOP_ENTER) {
        const k = loopsCounter(col.loops[id], col.stepPc[id]);
        st.iteration = k + 1;
        st.detail = `进入循环第 ${k + 1}/${headInstr.bound} 轮`;
      } else {
        st.detail = `已完成 ${headInstr.bound} 轮循环，退出循环`;
      }
    } else if (headInstr.op === 'end') {
      if (headInstr.kind === 'loop') {
        const k = loopsCounter(col.loops[parent], headInstr.headIndex);
        st.detail = `循环体第 ${k + 1} 轮结束，回到循环头`;
      } else {
        st.detail = '条件分支结束';
      }
    } else if (headInstr.op === 'else') {
      st.detail = '跳过 ELSE 分支';
    } else if (headInstr.op === 'cleanup') {
      st.detail = `注册清理续体 L${headInstr.line}（内联跳过主体），续体栈: ${fmt(afterPending)}`;
    }
    return st;
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
