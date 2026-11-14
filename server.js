// Local Node server. Zero runtime dependencies.
//   POST /ingest   <- the edge device pushes readings + faults here (outbound-only from its side)
//   GET  /events   -> browsers subscribe (Server-Sent Events)
// The dashboard never talks back to the edge device; there is no route for it.
// The hosted version (worker/index.js) exposes the same routes on Cloudflare.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Twin } from './core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4310;
const SIM_ENABLED = process.env.SIM !== '0';

const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'store-layout.json'), 'utf8'));
const clients = new Set();
const twin = new Twin(layout, {
  simEnabled: SIM_ENABLED,
  ingestToken: process.env.INGEST_TOKEN || '',
  broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(data);
  },
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, rel) {
  const file = path.resolve(PUBLIC, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(twin.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : null;
    const out = twin.api(req.method, p, body, req.headers.authorization);
    if (out) return send(res, out[0], out[1]);
    if (req.method === 'GET') return serveFile(res, p === '/' ? 'index.html' : p);
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

server.listen(PORT, () => {
  console.log(`Digital twin dashboard: http://localhost:${PORT}`);
  console.log(SIM_ENABLED ? 'Built-in edge simulator: ON (SIM=0 to disable)' : 'Waiting for edge device data on POST /ingest');
  twin.sim?.start();
});
