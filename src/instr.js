'use strict';

// Structured instruction parsing / validation for the isolation-token auditor.
//
// Instruction shapes (line numbers are 1-based and assigned by the parser):
//   { op: 'acquire', token }
//   { op: 'release', token }
//   { op: 'act',     token }
//   { op: 'if',      token, elseIndex, endIndex }
//   { op: 'loop',    bound, endIndex }
//   { op: 'cleanup', endIndex }
//   { op: 'else' }
//   { op: 'end' }
//   { op: 'return' }
//   { op: 'abort' }
//
// Structured nesting: every IF/LOOP/CLEANUP is closed by a matching END.
// IF takes an optional ELSE; RETURN / ABORT are legal outside cleanup bodies
// only (enforced in the analyzer's lexical checks).

const MAX_TOKENS = 8;
const MAX_INSTRUCTIONS = 96;
const MAX_LOOP_BOUND = 64;
const VALID_OPS = new Set([
  'acquire', 'release', 'act', 'if', 'loop',
  'end', 'else', 'return', 'abort', 'cleanup',
]);

function makeError(code, message, line = null) {
  const err = new Error(message);
  err.code = code;
  err.line = line;
  return err;
}

// tokens: array of raw strings (trimmed, non-empty), max 8.
function normalizeTokens(rawTokens) {
  const list = Array.isArray(rawTokens) ? rawTokens : [];
  const tokens = [];
  const seen = new Set();
  for (const item of list) {
    const t = String(item == null ? '' : item).trim();
    if (!t) continue;
    if (tokens.length >= MAX_TOKENS) {
      throw makeError('TOKEN_LIMIT', `最多只能录入 ${MAX_TOKENS} 个令牌`);
    }
    if (!/^[A-Za-z0-9_一-龥][A-Za-z0-9_\-一-龥]*$/.test(t)) {
      throw makeError('TOKEN_SYNTAX', `非法令牌名: ${JSON.stringify(t)}`);
    }
    if (seen.has(t)) {
      throw makeError('TOKEN_DUPLICATE', `令牌重复: ${t}`);
    }
    seen.add(t);
    tokens.push(t);
  }
  return tokens;
}

function parseInstructions(rawRows, declaredTokens) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  if (rows.length > MAX_INSTRUCTIONS) {
    throw makeError('INSTR_LIMIT', `最多只能录入 ${MAX_INSTRUCTIONS} 条指令`);
  }
  const tokenSet = new Set(declaredTokens);
  const instrs = [];

  rows.forEach((row, idx) => {
    const line = idx + 1;
    const op = String((row && row.op) || '').trim().toLowerCase();
    if (!op) return; // blank rows are ignored
    if (!VALID_OPS.has(op)) {
      throw makeError('UNKNOWN_OP', `第 ${line} 行: 未知指令 ${JSON.stringify(op)}`, line);
    }
    const rawToken = row && row.token != null ? String(row.token).trim() : '';
    const tokenOps = new Set(['acquire', 'release', 'act', 'if']);
    const needToken = tokenOps.has(op);
    if (needToken) {
      if (!rawToken) {
        throw makeError('MISSING_TOKEN', `第 ${line} 行: ${op} 缺少令牌`, line);
      }
      if (!tokenSet.has(rawToken)) {
        throw makeError('UNKNOWN_TOKEN', `第 ${line} 行: 未知令牌 ${rawToken}`, line);
      }
    } else if (rawToken) {
      throw makeError('UNEXPECTED_TOKEN', `第 ${line} 行: ${op} 不接受令牌`, line);
    }

    if (op === 'loop') {
      const bound = Number(row && row.bound);
      if (!Number.isInteger(bound) || bound < 1) {
        throw makeError('BAD_BOUND', `第 ${line} 行: 循环次数必须是 >=1 的整数`, line);
      }
      if (bound > MAX_LOOP_BOUND) {
        throw makeError(
          'BOUND_LIMIT',
          `第 ${line} 行: 循环上界越限 (${bound} > ${MAX_LOOP_BOUND})`,
          line,
        );
      }
      instrs.push({ line, op, bound });
    } else if (op === 'if') {
      instrs.push({ line, op, token: rawToken });
    } else {
      instrs.push({ line, op, token: rawToken || null });
    }
  });

  // Match IF/LOOP/CLEANUP ... END and record exit targets.
  const stack = [];
  for (let i = 0; i < instrs.length; i++) {
    const ins = instrs[i];
    if (ins.op === 'if' || ins.op === 'loop' || ins.op === 'cleanup') {
      stack.push({ index: i, kind: ins.op, line: ins.line });
    } else if (ins.op === 'end') {
      const head = stack.pop();
      if (!head) {
        throw makeError('UNMATCHED_END', `第 ${ins.line} 行: END 没有匹配的开始`, ins.line);
      }
      instrs[head.index].endLine = ins.line;
      instrs[head.index].endIndex = i;
      ins.kind = head.kind;
      ins.headIndex = head.index;
      if (head.kind === 'if') linkIf(instrs, head.index, i);
    }
  }
  if (stack.length) {
    const h = stack[stack.length - 1];
    throw makeError(
      'UNTERMINATED_BLOCK',
      `第 ${h.line} 行: ${h.kind.toUpperCase()} 缺少匹配的 END`,
      h.line,
    );
  }
  return instrs;
}

// Inside an IF block the first ELSE separates the two arms; the END closes
// both. Without ELSE the second arm is empty. Jumps target indices AFTER the
// relevant boundary (pc = index of next instruction to execute).
function linkIf(instrs, headIdx, endIdx) {
  let elseIdx = -1;
  let depth = 0;
  for (let i = headIdx + 1; i < endIdx; i++) {
    const op = instrs[i].op;
    if (op === 'if' || op === 'loop' || op === 'cleanup') depth++;
    else if (op === 'end') depth--;
    else if (op === 'else' && depth === 0) { elseIdx = i; break; }
  }
  if (elseIdx >= 0) {
    instrs[elseIdx] = { line: instrs[elseIdx].line, op: 'else', claimed: true };
    instrs[headIdx].elseIndex = elseIdx;
    instrs[headIdx].thenJump = elseIdx + 1; // after then-arm: skip else marker
    instrs[headIdx].elseJump = endIdx + 1;
    instrs[elseIdx].endIndex = endIdx;
  } else {
    instrs[headIdx].elseIndex = -1;
    instrs[headIdx].thenJump = endIdx + 1; // then-arm falls to end
    instrs[headIdx].elseJump = endIdx + 1; // empty else-arm
  }
}

module.exports = {
  MAX_TOKENS,
  MAX_INSTRUCTIONS,
  MAX_LOOP_BOUND,
  makeError,
  normalizeTokens,
  parseInstructions,
};
