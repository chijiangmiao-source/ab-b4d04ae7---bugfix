'use strict';

// Zero-dependency HTTP host for the offline review page and review API.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('./verify');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = (() => {
    try { return new URL(req.url, 'http://localhost').pathname; }
    catch { return null; }
  })();

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'isolation-token-review',
      time: new Date().toISOString(),
      port: PORT,
    });
  }

  if (req.method === 'POST' && pathname === '/api/review') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return sendJson(res, e.status || 400, {
        ok: false, error: { code: 'BAD_JSON', message: '请求不是合法 JSON' },
      });
    }
    try {
      const result = analyze(payload.tokens, payload.instructions);
      return sendJson(res, 200, { ok: true, result });
    } catch (e) {
      // Structural errors invalidate the draft: old evidence is removed
      // client-side; the API reports the precise parse/validation error.
      return sendJson(res, 200, {
        ok: false,
        error: { code: e.code || 'ERROR', message: e.message, line: e.line || null },
      });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
});

function start(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server.address()));
  });
}

if (require.main === module) {
  start().then((addr) => {
    console.log(`[review] 复核页: http://${addr.address === '::' ? 'localhost' : 'localhost'}:${addr.port}/`);
    console.log(`[review] 健康地址: http://localhost:${addr.port}/health`);
  });
}

module.exports = { server, start };
