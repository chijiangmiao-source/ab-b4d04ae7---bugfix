'use strict';

// Offline review console: draft management (tokens / structured rows),
// submit-to-API, conclusion rendering, and explicit evidence removal.

const MAX_TOKENS = 8;
const MAX_ROWS = 96;

const OPTS = [
  { value: 'acquire', label: 'acquire · 获取' },
  { value: 'act', label: 'act · 操作' },
  { value: 'release', label: 'release · 释放' },
  { value: 'if', label: 'if · 条件分支' },
  { value: 'else', label: 'else · 分支另一支' },
  { value: 'loop', label: 'loop · 有限次数循环' },
  { value: 'cleanup', label: 'cleanup · 清理块开始' },
  { value: 'end', label: 'end · 块结束' },
  { value: 'return', label: 'return · 返回' },
  { value: 'abort', label: 'abort · 中止' },
];
const TOKEN_OPS = new Set(['acquire', 'act', 'release', 'if']);
const TOKEN_FREE_OPS = new Set(['else', 'loop', 'cleanup', 'end', 'return', 'abort']);

const state = {
  tokens: [''],
  rows: [
    { op: 'acquire', token: '', bound: 1 },
  ],
};

const els = {
  tokenList: document.getElementById('token-list'),
  rows: document.getElementById('rows'),
  addToken: document.getElementById('add-token'),
  addRow: document.getElementById('add-row'),
  submit: document.getElementById('submit'),
  clear: document.getElementById('clear'),
  count: document.getElementById('draft-count'),
  conclusion: document.getElementById('conclusion'),
  health: document.getElementById('health'),
  tplError: document.getElementById('tpl-error'),
  tplViolation: document.getElementById('tpl-violation'),
  tplSafe: document.getElementById('tpl-safe'),
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function updateCount() {
  const t = state.tokens.filter((x) => x.trim()).length;
  els.count.textContent = `已填令牌 ${t}/${MAX_TOKENS} ｜ 指令 ${state.rows.length}/${MAX_ROWS}`;
}

// ---- tokens ---------------------------------------------------------------

function renderTokens() {
  els.tokenList.innerHTML = '';
  state.tokens.forEach((value, i) => {
    const input = el('input', {
      value, placeholder: `令牌 ${i + 1}，如 ISO-A`,
      input: (e) => { state.tokens[i] = e.target.value; updateCount(); },
    });
    const del = el('button', {
      type: 'button', title: '移除令牌',
      click: () => {
        if (state.tokens.length <= 1) { state.tokens[0] = ''; }
        else state.tokens.splice(i, 1);
        renderTokens();
      },
    }, '✕');
    els.tokenList.appendChild(el('div', { class: 'token-item' }, [input, del]));
  });
  if (state.tokens.length < MAX_TOKENS) {
    els.tokenList.appendChild(
      el('button', {
        class: 'btn', type: 'button',
        click: () => { state.tokens.push(''); renderTokens(); },
      }, '＋'),
    );
  }
  updateCount();
}

els.addToken.addEventListener('click', () => {
  if (state.tokens.length >= MAX_TOKENS) return;
  state.tokens.push('');
  renderTokens();
});

// ---- instructions ----------------------------------------------------------

function renderRows() {
  els.rows.innerHTML = '';
  state.rows.forEach((row, i) => {
    const tr = el('tr');

    tr.appendChild(el('td', { class: 'line-no' }, String(i + 1)));

    const opSel = el('select');
    for (const o of OPTS) {
      const opt = el('option', { value: o.value }, o.label);
      if (row.op === o.value) opt.selected = true;
      opSel.appendChild(opt);
    }
    opSel.addEventListener('change', (e) => {
      row.op = e.target.value;
      if (row.op === 'loop') row.bound = row.bound || 1;
      renderRows();
    });
    tr.appendChild(el('td', {}, opSel));

    const tokenCell = el('td');
    if (TOKEN_OPS.has(row.op)) {
      const inp = el('input', {
        value: row.token || '', placeholder: '令牌名',
        input: (e) => { row.token = e.target.value; },
      });
      tokenCell.appendChild(inp);
    } else {
      tokenCell.appendChild(el('span', { class: 'muted' }, '—'));
    }
    tr.appendChild(tokenCell);

    const boundCell = el('td');
    if (row.op === 'loop') {
      const inp = el('input', {
        type: 'number', min: '1', max: '64', value: String(row.bound || 1),
        input: (e) => { row.bound = Number(e.target.value); },
      });
      boundCell.appendChild(inp);
    } else {
      boundCell.appendChild(el('span', { class: 'muted' }, '—'));
    }
    tr.appendChild(boundCell);

    tr.appendChild(el('td', {}, el('button', {
      class: 'del-row', type: 'button', title: '删除该行',
      click: () => { state.rows.splice(i, 1); renderRows(); },
    }, '✕')));

    els.rows.appendChild(tr);
  });
  updateCount();
}

els.addRow.addEventListener('click', () => {
  if (state.rows.length >= MAX_ROWS) return;
  state.rows.push({ op: 'act', token: '', bound: 1 });
  renderRows();
});

// ---- conclusion ------------------------------------------------------------

function clearEvidence() {
  els.conclusion.innerHTML = '';
}

function fmtSet(names) {
  return names && names.length ? `{${names.map(escapeHtml).join(', ')}}` : '∅';
}

function renderError(err) {
  clearEvidence();
  const node = els.tplError.content.firstElementChild.cloneNode(true);
  node.querySelector('[data-field="message"]').textContent = err.message;
  node.querySelector('[data-field="code"]').textContent = `错误码: ${err.code}${err.line != null ? ` ｜ 第 ${err.line} 行` : ''}`;
  els.conclusion.appendChild(node);
}

function renderViolation(result) {
  clearEvidence();
  const node = els.tplViolation.content.firstElementChild.cloneNode(true);
  const v = result.violation;
  node.querySelector('[data-field="message"]').textContent = v.message;
  node.querySelector('[data-field="code"]').textContent = v.code;
  node.querySelector('[data-field="pathLength"]').textContent = String(result.pathLength);
  if (v.line == null) node.querySelector('[data-field="lineWrap"]').remove();
  else node.querySelector('[data-field="line"]').textContent = String(v.line);

  const tbody = node.querySelector('[data-field="steps"]');
  for (const st of result.steps) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, String(st.seq)));
    tr.appendChild(el('td', {}, st.line == null ? '—' : `L${st.line}`));
    tr.appendChild(el('td', { class: 'op-name' }, st.cleanupExpand ? 'cleanup 展开' : st.label));
    tr.appendChild(el('td', {}, st.token || '—'));

    const bf = el('td');
    if (st.branch) {
      bf.appendChild(el('span', {
        class: `branch ${escapeHtml(st.branch)}`,
      }, st.branch === 'true' ? '结果①成立' : '结果②不成立'));
    }
    if (st.iteration) {
      bf.appendChild(el('span', { class: 'iteration' }, `第 ${st.iteration} 轮`));
    }
    if (!st.branch && !st.iteration) bf.appendChild(el('span', { class: 'muted' }, '—'));
    tr.appendChild(bf);

    tr.appendChild(el('td', {}, [
      el('span', {}, fmtSet(st.heldBefore)),
      document.createTextNode(' → '),
      el('span', {}, fmtSet(st.heldAfter)),
    ]));
    tr.appendChild(el('td', {}, [
      el('span', { class: st.pendingBefore && st.pendingBefore.length ? 'tag-cleanup' : '' }, fmtSet(st.pendingBefore)),
      document.createTextNode(' → '),
      el('span', { class: st.pendingAfter && st.pendingAfter.length ? 'tag-cleanup' : '' }, fmtSet(st.pendingAfter)),
    ]));
    tr.appendChild(el('td', {}, st.detail || ''));
    tbody.appendChild(tr);
  }
  els.conclusion.appendChild(node);
}

function renderSafe(result) {
  clearEvidence();
  const node = els.tplSafe.content.firstElementChild.cloneNode(true);
  for (const [k, v] of Object.entries(result.stats)) {
    const slot = node.querySelector(`[data-field="${k}"]`);
    if (slot) slot.textContent = String(v);
  }
  const tbody = node.querySelector('[data-field="exits"]');
  if (!result.exits.length) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '4' }, '无出口（空脚本）')));
  }
  for (const ex of result.exits) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, ex.kindLabel));
    tr.appendChild(el('td', {}, ex.triggerLine == null ? '脚本末尾' : `L${ex.triggerLine}`));
    tr.appendChild(el('td', {}, ex.released.length
      ? ex.released.map(escapeHtml).join('；')
      : '无持有令牌需释放'));
    tr.appendChild(el('td', {}, String(ex.canonicalArrivals)));
    tbody.appendChild(tr);
  }
  els.conclusion.appendChild(node);
}

async function submitReview() {
  clearEvidence();
  const tokens = state.tokens.map((t) => t.trim()).filter(Boolean);
  const instructions = state.rows.map((r) => {
    const base = { op: r.op };
    if (TOKEN_OPS.has(r.op)) base.token = (r.token || '').trim();
    if (r.op === 'loop') base.bound = r.bound;
    return base;
  });
  let resp;
  try {
    resp = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens, instructions }),
    });
  } catch {
    renderError({ code: 'NETWORK', message: '复核服务不可达' });
    return;
  }
  const data = await resp.json();
  if (!data.ok) renderError(data.error);
  else if (data.result.safe) renderSafe(data.result);
  else renderViolation(data.result);
}

els.submit.addEventListener('click', submitReview);
els.clear.addEventListener('click', () => {
  state.tokens = [''];
  state.rows = [{ op: 'acquire', token: '', bound: 1 }];
  clearEvidence();
  renderTokens();
  renderRows();
});

// ---- health ---------------------------------------------------------------

async function pollHealth() {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    const data = await r.json();
    els.health.textContent = `● 服务正常 :${data.port}`;
    els.health.className = 'health ok';
  } catch {
    els.health.textContent = '● 服务不可达';
    els.health.className = 'health bad';
  }
}

renderTokens();
renderRows();
pollHealth();
setInterval(pollHealth, 10000);
