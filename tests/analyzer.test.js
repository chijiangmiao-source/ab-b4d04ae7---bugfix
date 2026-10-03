'use strict';

// Acceptance tests for the exhaustive isolation-token auditor.
// Run with: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/verify');

function op(ops) { return ops; }

test('场景一：条件分支遗漏释放 —— false 路径最短违规，令牌变化逐步可见', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'acquire', token: 'ISO-A' }, // 1
    { op: 'if', token: 'ISO-A' },      // 2
    { op: 'release', token: 'ISO-A' }, // 3  (仅 THEN 释放)
    { op: 'end' },                     // 4
  ]));
  assert.equal(r.safe, false);
  assert.equal(r.violation.code, 'LEAK_ON_EXIT');
  assert.match(r.violation.message, /ISO-A/);
  // Shortest witness: acquire -> if(false) -> implicit exit.
  assert.equal(r.pathLength, 3);
  const branch = r.steps.find((s) => s.op === 'if');
  assert.equal(branch.branch, 'false');
  assert.deepEqual(branch.heldAfter, ['ISO-A']); // 已持有令牌在 false 路径仍保持
  const acquire = r.steps.find((s) => s.op === 'acquire');
  assert.deepEqual(acquire.heldBefore, []);
  assert.deepEqual(acquire.heldAfter, ['ISO-A']);
});

test('场景一(对照)：THEN/ELSE 两支都释放时安全', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'if', token: 'ISO-A' },
    { op: 'release', token: 'ISO-A' },
    { op: 'else' },
    { op: 'acquire', token: 'ISO-A' },
    { op: 'release', token: 'ISO-A' },
    { op: 'end' },
  ]));
  assert.equal(r.safe, true);
  assert.ok(r.stats.canonicalStates >= 5);
  assert.equal(r.exits.length, 1);
  assert.equal(r.exits[0].kind, 'implicit');
});

test('场景二：中止触发嵌套清理 —— LIFO 续体全部执行后才离开', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'acquire', token: 'ISO-A' }, // 1
    { op: 'cleanup' },                 // 2 外层续体
    { op: 'cleanup' },                 // 3 内层续体
    { op: 'act', token: 'ISO-A' },     // 4 内层清理体内操作
    { op: 'release', token: 'ISO-A' }, // 5 内层清理释放
    { op: 'end' },                     // 6
    { op: 'end' },                     // 7
    { op: 'abort' },                   // 8 中止
  ]));
  assert.equal(r.safe, true, '嵌套清理应在中止路径上完成释放');
  const abortExit = r.exits.find((e) => e.kind === 'abort');
  assert.ok(abortExit, '应存在中止出口');
  assert.equal(abortExit.triggerLine, 8);
  assert.ok(abortExit.released.includes('ISO-A@L5'), '清理体 L5 的释放应计入出口结果');
});

test('场景二(反例)：中止时注册的清理未释放持有令牌 -> 泄漏违规', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'acquire', token: 'ISO-A' },
    { op: 'cleanup' },
    { op: 'act', token: 'ISO-A' }, // 只操作不释放
    { op: 'end' },
    { op: 'abort' },
  ]));
  assert.equal(r.safe, false);
  assert.equal(r.violation.code, 'LEAK_ON_EXIT');
});

test('场景三：循环重复获取 —— 每轮配对获取/释放安全', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'loop', bound: 3 },
    { op: 'acquire', token: 'ISO-A' },
    { op: 'act', token: 'ISO-A' },
    { op: 'release', token: 'ISO-A' },
    { op: 'end' },
  ]));
  assert.equal(r.safe, true);
  // 头 + 3*(体3) + 出口相关状态均被穷尽
  assert.ok(r.stats.canonicalStates >= 10);
});

test('场景三(反例)：循环体内获取未释放，第二轮重复获取即违规并显示轮次', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'loop', bound: 3 },
    { op: 'acquire', token: 'ISO-A' },
    { op: 'end' },
    { op: 'release', token: 'ISO-A' },
  ]));
  assert.equal(r.safe, false);
  assert.equal(r.violation.code, 'DUP_ACQUIRE');
  assert.equal(r.violation.line, 2);
  const loopSteps = r.steps.filter((s) => s.op === 'loop');
  assert.equal(loopSteps[0].iteration, 1);
  assert.equal(loopSteps[1].iteration, 2);
  // 违规发生在第二轮
  const acquireSteps = r.steps.filter((s) => s.op === 'acquire');
  assert.equal(acquireSteps.length, 2);
  assert.deepEqual(acquireSteps[1].heldBefore, ['ISO-A']);
});

test('操作未持有令牌被检出', () => {
  const r = analyze(['ISO-A'], [{ op: 'act', token: 'ISO-A' }]);
  assert.equal(r.safe, false);
  assert.equal(r.violation.code, 'USE_NOT_HELD');
});

test('释放未持有令牌被检出', () => {
  const r = analyze(['ISO-A'], [{ op: 'release', token: 'ISO-A' }]);
  assert.equal(r.safe, false);
  assert.equal(r.violation.code, 'RELEASE_NOT_HELD');
});

test('返回离开前完成清理：安全且记录 return 出口', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'acquire', token: 'ISO-A' },
    { op: 'cleanup' },
    { op: 'release', token: 'ISO-A' },
    { op: 'end' },
    { op: 'return' },
  ]));
  assert.equal(r.safe, true);
  const ret = r.exits.find((e) => e.kind === 'return');
  assert.ok(ret);
  assert.deepEqual(ret.released, ['ISO-A@L3']);
});

test('多出口：return 与隐式结束各自完成清理并分别报告', () => {
  const r = analyze(['ISO-A'], op([
    { op: 'acquire', token: 'ISO-A' },
    { op: 'cleanup' },
    { op: 'release', token: 'ISO-A' },
    { op: 'end' },
    { op: 'if', token: 'ISO-A' },
    { op: 'return' },
    { op: 'end' },
  ]));
  assert.equal(r.safe, true);
  const kinds = r.exits.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['implicit', 'return']);
});

test('最短路径与源序：THEN 内长路径违规，但 false 路径更短的泄漏优先报告', () => {
  // true 路径: act(违规? A 在 then 中确认持有 -> 合法)... 构造：
  // THEN 内先 release 再 act（act 违规，步长较长）；
  // false 路径跳过 release，直接到出口泄漏（步长更短）。
  const r = analyze(['ISO-A'], op([
    { op: 'acquire', token: 'ISO-A' }, // 1
    { op: 'if', token: 'ISO-A' },      // 2
    { op: 'release', token: 'ISO-A' }, // 3
    { op: 'act', token: 'ISO-A' },     // 4 true 路径在此违规（第 4 步）
    { op: 'end' },                     // 5
  ]));
  assert.equal(r.safe, false);
  // false 路径仅 3 步即泄漏，短于 true 路径的 4 步
  assert.equal(r.pathLength, 3);
  assert.equal(r.steps.find((s) => s.op === 'if').branch, 'false');
});

test('结构性错误：未知令牌直接报错', () => {
  assert.throws(
    () => analyze(['ISO-A'], [{ op: 'acquire', token: 'GHOST' }]),
    (e) => e.code === 'UNKNOWN_TOKEN' && e.line === 1,
  );
});

test('结构性错误：循环上界越限报错（65 > 64）', () => {
  assert.throws(
    () => analyze(['ISO-A'], [{ op: 'loop', bound: 65 }, { op: 'end' }]),
    (e) => e.code === 'BOUND_LIMIT' && e.line === 1,
  );
});

test('结构性错误：非法跳出清理作用域报错', () => {
  assert.throws(
    () => analyze(['ISO-A'], op([
      { op: 'cleanup' },
      { op: 'return' },
      { op: 'end' },
    ])),
    (e) => e.code === 'ILLEGAL_LEAVE' && e.line === 2,
  );
  assert.throws(
    () => analyze(['ISO-A'], op([
      { op: 'cleanup' },
      { op: 'abort' },
      { op: 'end' },
    ])),
    (e) => e.code === 'ILLEGAL_LEAVE',
  );
});

test('结构性错误：块未闭合 / END 多余 / 令牌与指令上限', () => {
  assert.throws(() => analyze(['A'], [{ op: 'if', token: 'A' }]), (e) => e.code === 'UNTERMINATED_BLOCK');
  assert.throws(() => analyze(['A'], [{ op: 'end' }]), (e) => e.code === 'UNMATCHED_END');
  assert.throws(
    () => analyze(['A'], Array.from({ length: 97 }, () => ({ op: 'act', token: 'A' }))),
    (e) => e.code === 'INSTR_LIMIT',
  );
  assert.throws(
    () => analyze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], []),
    (e) => e.code === 'TOKEN_LIMIT',
  );
});

test('清理续体栈在路径中逐步可见', () => {
  const r = analyze(['A', 'B'], op([
    { op: 'cleanup' },                 // L1 注册 C1
    { op: 'release', token: 'B' },     // L2 正常流违规（B 未持有）→ 但先确认注册步
    { op: 'end' },
  ]));
  assert.equal(r.safe, false);
  const reg = r.steps.find((s) => s.op === 'cleanup' && !s.cleanupExpand);
  assert.deepEqual(reg.pendingBefore, []);
  assert.deepEqual(reg.pendingAfter, ['L1']);
});
