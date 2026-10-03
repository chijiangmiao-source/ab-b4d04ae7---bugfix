#!/usr/bin/env node
'use strict';

// One-shot acceptance service ("verify"):
//   1. runs the code tests (node --test tests/)
//   2. builds the review page (scripts/build.js)
//   3. starts a local server (unless --base is given, e.g. the Compose host)
//   4. HTTP smoke: GET /health and the static page assets
//   5. drives the three mandated scenarios through POST /api/review
// Exits non-zero if anything fails; prints a final acceptance report.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const baseArg = (() => {
  const i = args.indexOf('--base');
  return i >= 0 ? args[i + 1] : null;
})();
const PORT = Number(process.env.PORT || 8080);

const failures = [];
const notes = [];
function ok(name, detail) { notes.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
function bad(name, detail) { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }

function run(cmd, cmdArgs, label) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    bad(label, `退出码 ${r.status}\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-15).join('\n')}`);
    return false;
  }
  ok(label, '通过');
  return true;
}

function request(method, urlPath, body) {
  const base = baseArg || `http://127.0.0.1:${PORT}`;
  const u = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: body
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
        : {},
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    // 穷尽复核合法上界脚本（如三层 64 循环约百万级规范状态）可能耗时数秒。
    req.setTimeout(30000);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealthy(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await request('GET', '/health');
      if (r.status === 200) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log('=== 航电隔离令牌复核 · verify 一次性验收 ===\n');

  // 1. code tests
  console.log('[1/4] 代码测试 (node --test)');
  run(process.execPath, ['--test', 'tests/'], '单元/场景测试');

  // 2. page build
  console.log('[2/4] 页面构建');
  run(process.execPath, ['scripts/build.js'], '构建复核页');

  // 3. local server (skipped when an external --base is supplied)
  let localServer = null;
  if (!baseArg) {
    console.log('[3/4] 启动本地复核服务');
    const { start } = require('../src/server');
    try {
      const addr = await start(PORT, '127.0.0.1');
      localServer = require('../src/server').server;
      ok(`服务监听 127.0.0.1:${addr.port}`);
    } catch (e) {
      bad('启动本地服务', e.message);
    }
  } else {
    console.log(`[3/4] 使用外部复核服务 ${baseArg}`);
  }

  const healthy = await waitForHealthy();
  if (!healthy) {
    bad('健康检查', '/health 不可达');
  } else {
    ok('健康检查 GET /health', '200 status=ok');
  }

  if (healthy) {
    // 4a. static smoke
    console.log('[4/4] HTTP 冒烟与三场景复核');
    for (const p of ['/', '/styles.css', '/app.js']) {
      try {
        const r = await request('GET', p);
        if (r.status !== 200) { bad(`静态资源 GET ${p}`, `HTTP ${r.status}`); continue; }
        if (p === '/' && !r.body.includes('离线复核')) bad('静态页面 GET /', '缺少页面标识文案');
        else if (p === '/app.js' && !r.body.includes('api/review')) bad('静态脚本 GET /app.js', '内容不符');
        else ok(`静态资源 GET ${p}`, `${r.status}, ${r.body.length} 字节`);
      } catch (e) {
        bad(`静态资源 GET ${p}`, e.message);
      }
    }

    // 4b. mandated scenarios through the API
    const scenarios = [
      {
        name: '场景一 · 分支遗漏释放',
        tokens: ['ISO-A'],
        instructions: [
          { op: 'acquire', token: 'ISO-A' },
          { op: 'if', token: 'ISO-A' },
          { op: 'release', token: 'ISO-A' },
          { op: 'end' },
        ],
        expect: (d) => d.ok && d.result.safe === false
          && d.result.violation.code === 'LEAK_ON_EXIT',
      },
      {
        name: '场景二 · 中止触发嵌套清理',
        tokens: ['ISO-A'],
        instructions: [
          { op: 'acquire', token: 'ISO-A' },
          { op: 'cleanup' },
          { op: 'cleanup' },
          { op: 'act', token: 'ISO-A' },
          { op: 'release', token: 'ISO-A' },
          { op: 'end' },
          { op: 'end' },
          { op: 'abort' },
        ],
        expect: (d) => d.ok && d.result.safe === true
          && d.result.exits.some((e) => e.kind === 'abort' && e.released.includes('ISO-A@L5')),
      },
      {
        name: '场景三 · 循环重复获取',
        tokens: ['ISO-A'],
        instructions: [
          { op: 'loop', bound: 3 },
          { op: 'acquire', token: 'ISO-A' },
          { op: 'release', token: 'ISO-A' },
          { op: 'end' },
        ],
        expect: (d) => d.ok && d.result.safe === true && d.result.stats.canonicalStates > 0,
      },
      {
        name: '回归 · 三层循环均取公开上界 64（8 条指令，内层获取后立即释放）穷尽安全',
        tokens: ['A'],
        instructions: [
          { op: 'loop', bound: 64 },
          { op: 'loop', bound: 64 },
          { op: 'loop', bound: 64 },
          { op: 'acquire', token: 'A' },
          { op: 'release', token: 'A' },
          { op: 'end' },
          { op: 'end' },
          { op: 'end' },
        ],
        expect: (d) => d.ok && d.result.safe === true
          && d.result.exits.length === 1
          && d.result.exits[0].kind === 'implicit'
          && d.result.stats.canonicalStates > 120000,
      },
      {
        name: '附加反例 · 循环内获取不释放（第二轮重复获取）',
        tokens: ['ISO-A'],
        instructions: [
          { op: 'loop', bound: 3 },
          { op: 'acquire', token: 'ISO-A' },
          { op: 'end' },
          { op: 'release', token: 'ISO-A' },
        ],
        expect: (d) => d.ok && d.result.safe === false
          && d.result.violation.code === 'DUP_ACQUIRE',
      },
      {
        name: '结构性错误 · 未知令牌报错并移除旧证据',
        tokens: ['ISO-A'],
        instructions: [{ op: 'acquire', token: 'GHOST' }],
        expect: (d) => d.ok === false && d.error.code === 'UNKNOWN_TOKEN',
      },
    ];

    for (const sc of scenarios) {
      try {
        const r = await request('POST', '/api/review', JSON.stringify({
          tokens: sc.tokens,
          instructions: sc.instructions,
        }));
        const data = JSON.parse(r.body);
        if (r.status !== 200) { bad(sc.name, `HTTP ${r.status}`); continue; }
        if (!sc.expect(data)) {
          bad(sc.name, `结论不符: ${JSON.stringify(data).slice(0, 300)}`);
          continue;
        }
        const detail = data.ok === false
          ? `报错 ${data.error.code}`
          : data.result.safe
            ? `安全（${data.result.stats.canonicalStates} 个规范状态）`
            : `违规 ${data.result.violation.code}（最短 ${data.result.pathLength} 步）`;
        ok(sc.name, detail);
      } catch (e) {
        bad(sc.name, e.message);
      }
    }
  }

  if (localServer) await new Promise((r) => localServer.close(r));

  console.log('\n=== 验收明细 ===');
  for (const n of notes) console.log(n);
  if (failures.length) {
    console.log('\n=== 验收失败 ===');
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log(`\nverify 结论: 不通过（${failures.length} 项失败）`);
    process.exit(1);
  }
  console.log(`\nverify 结论: 全部通过（${notes.length} 项检查），退出码 0`);
  process.exit(0);
}

main().catch((e) => {
  console.error('verify 异常中止:', e);
  process.exit(1);
});
