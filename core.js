// Runtime-agnostic dashboard state. Used by both the Node server (server.js)
// and the Cloudflare Worker (worker/index.js).

import { Simulator } from './simulator.js';

const HISTORY = 360;
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

export class Twin {
  constructor(layout, { simEnabled = true, ingestToken = '', broadcast }) {
    this.layout = layout;
    this.broadcast = broadcast;
    this.ingestToken = ingestToken;
    this.history = new Map(layout.units.map((u) => [u.id, []]));
    this.faults = new Map(); // `${unit}|${type}` -> fault
    this.alerts = [];
    this.alertSeq = 0;
    this.lastDevice = null;
    this.sim = simEnabled
      ? new Simulator(layout, (p) => this.ingest(p), () => this.broadcast({ type: 'sim', sim: this.simState() }))
      : null;
  }

  simState() {
    return this.sim ? this.sim.state() : { enabled: false, attacks: [], edge_probe_until: 0 };
  }

  snapshot() {
    return {
      type: 'snapshot',
      history: Object.fromEntries(this.history),
      faults: [...this.faults.values()],
      alerts: this.alerts,
      sim: this.simState(),
      device_id: this.lastDevice,
    };
  }

  // The single entry point for edge data. Adapt field names here if the real device differs.
  ingest(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.readings)) {
      throw new Error('payload must be an object with a readings[] array');
    }
    const ts = num(p.ts) ?? Date.now();
    this.lastDevice = str(p.device_id, 64) || this.lastDevice;

    const readings = [];
    for (const r of p.readings) {
      const hist = this.history.get(r?.unit_id);
      const temp = num(r?.temp_c);
      if (!hist || temp === null) continue;
      const row = {
        unit_id: r.unit_id,
        t: ts,
        temp,
        rep: num(r.reported_temp_c),
        sp: num(r.setpoint_c),
        pw: num(r.power_w),
        comp: typeof r.compressor_on === 'boolean' ? r.compressor_on : null,
      };
      hist.push(row);
      if (hist.length > HISTORY) hist.shift();
      readings.push(row);
    }

    const newAlerts = [];
    for (const f of Array.isArray(p.faults) ? p.faults : []) {
      if (!this.history.has(f?.unit_id) || typeof f.type !== 'string') continue;
      const type = str(f.type, 64);
      const key = `${f.unit_id}|${type}`;
      const prev = this.faults.get(key);
      if (f.status === 'cleared') {
        if (!prev) continue;
        this.faults.delete(key);
        newAlerts.push({ id: ++this.alertSeq, ts, unit_id: f.unit_id, type, severity: prev.severity, status: 'cleared', message: '' });
        continue;
      }
      const severity = SEVERITIES.has(f.severity) ? f.severity : 'warning';
      const fault = {
        unit_id: f.unit_id, type, severity,
        confidence: num(f.confidence),
        message: str(f.message),
        sms_sent: f.sms_sent === true,
        detected_at: prev?.detected_at ?? num(f.detected_at) ?? ts,
      };
      this.faults.set(key, fault);
      if (!prev || prev.severity !== severity) {
        const started = !prev && this.sim ? this.sim.attackStartFor(f.unit_id) : null;
        newAlerts.push({
          id: ++this.alertSeq, ts, ...fault, status: 'active',
          latency_s: started ? Math.max(0, Math.round((ts - started) / 100) / 10) : null,
        });
      }
    }
    if (newAlerts.length) this.alerts = [...newAlerts.reverse(), ...this.alerts].slice(0, 150);

    this.broadcast({ type: 'ingest', ts, device_id: this.lastDevice, readings, faults: [...this.faults.values()], alerts: newAlerts });
    return { accepted: readings.length };
  }

  hardReset() {
    for (const h of this.history.values()) h.length = 0;
    this.faults.clear();
    this.alerts = [];
    this.sim?.hardReset();
    this.broadcast(this.snapshot());
  }

  // JSON API shared by both runtimes. Returns null when the route is not an API route.
  api(method, path, body, authorization) {
    if (method === 'GET' && path === '/api/layout') return [200, this.layout];
    if (method === 'POST' && path === '/ingest') {
      if (this.ingestToken && authorization !== `Bearer ${this.ingestToken}`) return [401, { error: 'unauthorized' }];
      try { return [200, this.ingest(body)]; } catch (err) { return [400, { error: err.message }]; }
    }
    if (method === 'POST' && path.startsWith('/api/sim/')) {
      if (!this.sim) return [409, { error: 'simulator disabled (SIM=0)' }];
      if (path === '/api/sim/attack') return this.sim.attack(body?.scenario) ? [200, { ok: true }] : [400, { error: 'unknown scenario' }];
      if (path === '/api/sim/restore') { this.sim.restore(); return [200, { ok: true }]; }
      if (path === '/api/sim/reset') { this.hardReset(); return [200, { ok: true }]; }
    }
    return null;
  }
}
