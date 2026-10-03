'use strict';

// Page build: copy web-src/ into public/ and syntax-check the browser JS.
// Zero bundler, zero network — the page uses only native browser APIs.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web-src');
const OUT = path.join(ROOT, 'public');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`缺少页面源目录: ${SRC}`);
  rmrf(OUT);
  copyDir(SRC, OUT);

  const appJs = path.join(OUT, 'app.js');
  new vm.Script(fs.readFileSync(appJs, 'utf8'), { filename: 'app.js' });

  const required = ['index.html', 'styles.css', 'app.js'];
  for (const f of required) {
    if (!fs.existsSync(path.join(OUT, f))) throw new Error(`构建产物缺失: ${f}`);
  }
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  for (const f of ['/styles.css', '/app.js']) {
    if (!html.includes(f)) throw new Error(`index.html 未引用 ${f}`);
  }
  console.log('[build] 页面构建完成 -> public/ (index.html, styles.css, app.js)');
}

main();
