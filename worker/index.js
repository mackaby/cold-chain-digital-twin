// Cloudflare deployment: static assets + one Durable Object that holds the
// store state in memory and fans it out to browsers over Server-Sent Events.
// Same routes as server.js. The simulator only ticks while someone is watching.

import { DurableObject } from 'cloudflare:workers';
import layout from '../store-layout.json';
import { Twin } from '../core.js';

const enc = new TextEncoder();
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } });

export class StoreTwin extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Set();
    this.ping = null;
    this.twin = new Twin(layout, {
      simEnabled: env.SIM !== '0',
      ingestToken: env.INGEST_TOKEN || '',
      broadcast: (msg) => this.send(`data: ${JSON.stringify(msg)}\n\n`),
    });
  }

  send(text) {
    const chunk = enc.encode(text);
    for (const c of this.clients) {
      try { c.enqueue(chunk); } catch { this.drop(c); }
    }
  }

  drop(c) {
    this.clients.delete(c);
    if (this.clients.size === 0) {
      this.twin.sim?.stop();
      clearInterval(this.ping);
      this.ping = null;
    }
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/events') {
      let ctrl;
      const stream = new ReadableStream({
        start: (c) => {
          ctrl = c;
          c.enqueue(enc.encode(`data: ${JSON.stringify(this.twin.snapshot())}\n\n`));
          this.clients.add(c);
          this.twin.sim?.start();
          this.ping ??= setInterval(() => this.send(': ping\n\n'), 15000);
        },
        cancel: () => this.drop(ctrl),
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    }
    let body = null;
    if (req.method === 'POST') {
      const text = await req.text();
      if (text.length > 1_000_000) return json(413, { error: 'payload too large' });
      try { body = text ? JSON.parse(text) : {}; } catch { return json(400, { error: 'invalid JSON' }); }
    }
    const out = this.twin.api(req.method, path, body, req.headers.get('authorization'), req.headers.get('cf-connecting-ip') || '');
    return out ? json(out[0], out[1]) : json(404, { error: 'not found' });
  }
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === '/ingest' || path === '/events' || path.startsWith('/api/')) {
      return env.STORE.get(env.STORE.idFromName('demo-store-01')).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
