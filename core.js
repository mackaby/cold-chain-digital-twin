// Runtime-agnostic dashboard state. Used by both the Node server (server.js)
// and the Cloudflare Worker (worker/index.js).

import { Simulator } from './simulator.js';

const HISTORY = 360;
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

// A unit reported by a real device belongs to that device; the simulator stays
// quiet for it until the device has been silent this long.
const DEVICE_TTL_MS = 10_000;

// Where an attack request came from, for display. Private addresses are shown
// as they are; public ones are shortened because every viewer sees them.
function originLabel(ip) {
  const a = str(ip, 64).replace(/^::ffff:/, '');
  if (!a) return '';
  if (a === '::1' || a.startsWith('127.')) return 'localhost';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) return a;
  const v4 = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  return v4 ? `${v4[1]}.${v4[2]}.x.x` : `${a.split(':').slice(0, 2).join(':')}:…`;
}

// Optional per-reading output of the on-device ML model (see edge/ml_bridge.py).
function mlInfo(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    score: num(m.anomaly_score), thr: num(m.threshold),
    fault: str(m.fault, 64), p: num(m.fault_confidence),
    sup: num(m.supply_air_c), ret: num(m.return_air_c),
    gin: num(m.gas_cooler_in_c), gout: num(m.gas_cooler_out_c),
    rec: str(m.recording, 64), at: str(m.recorded_at, 32),
  };
}

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
    this.deviceUnits = new Map(); // unit_id -> last time a real device reported it
    // Fault injection for the ML replay bridge (edge/ml_bridge.py). The bridge reads the
    // requested scenario from the response to its own POST; nothing connects in to it.
    this.ml = { seen: 0, scenarios: [], playing: '', ready: [], scenario: null, injected_at: null };
    this.sim = simEnabled
      ? new Simulator(layout, (p) => this.ingest(p, true), () => this.broadcast({ type: 'sim', sim: this.simState() }))
      : null;
  }

  simState() {
    return this.sim ? this.sim.state() : { enabled: false, attacks: [], edge_probe_until: 0, edge_probe_origin: '' };
  }

  mlState() {
    const { seen, ...rest } = this.ml;
    return { ...rest, connected: Date.now() - seen < DEVICE_TTL_MS };
  }

  #mlBridge(b) {
    const before = JSON.stringify(this.mlState());
    this.ml.seen = Date.now();
    if (Array.isArray(b.scenarios)) {
      this.ml.scenarios = b.scenarios.slice(0, 20).map((s) => ({
        id: str(s?.id, 64), label: str(s?.label, 64),
        units: (Array.isArray(s?.units) ? s.units : []).filter((u) => this.history.has(u)),
      })).filter((s) => s.id);
    }
    if (Array.isArray(b.ready)) this.ml.ready = b.ready.slice(0, 20).map((id) => str(id, 64));
    this.ml.playing = str(b.playing, 64);
    if (JSON.stringify(this.mlState()) !== before) this.broadcast({ type: 'ml', ml: this.mlState() });
  }

  #mlSet(scenario) {
    this.ml.scenario = scenario;
    this.ml.injected_at = scenario ? Date.now() : null;
    this.broadcast({ type: 'ml', ml: this.mlState() });
  }

  snapshot() {
    return {
      type: 'snapshot',
      ml: this.mlState(),
      history: Object.fromEntries(this.history),
      faults: [...this.faults.values()],
      alerts: this.alerts,
      sim: this.simState(),
      device_id: this.lastDevice,
    };
  }

  // The single entry point for edge data. Adapt field names here if the real device differs.
  // fromSim marks payloads from the built-in simulator, which yields to real devices.
  ingest(p, fromSim = false) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.readings)) {
      throw new Error('payload must be an object with a readings[] array');
    }
    const ts = num(p.ts) ?? Date.now();
    const now = Date.now();
    const source = fromSim ? 'sim' : 'device';
    let handover = false;
    if (fromSim) {
      for (const [id, seen] of this.deviceUnits) {
        if (now - seen <= DEVICE_TTL_MS) continue;
        this.deviceUnits.delete(id); // device went silent: hand the unit back
        if (this.ml.seen && now - this.ml.seen > DEVICE_TTL_MS) { this.ml.seen = 0; this.ml.scenario = null; this.ml.injected_at = null; }
        this.#dropFaults(id, 'device');
        this.history.get(id).length = 0;
        handover = true;
      }
    } else {
      this.lastDevice = str(p.device_id, 64) || this.lastDevice;
      if (p.ml_bridge && typeof p.ml_bridge === 'object') this.#mlBridge(p.ml_bridge);
    }

    const readings = [];
    for (const r of p.readings) {
      const hist = this.history.get(r?.unit_id);
      const temp = num(r?.temp_c);
      if (!hist || temp === null) continue;
      if (fromSim && this.deviceUnits.has(r.unit_id)) continue;
      if (!fromSim) {
        if (this.sim && !this.deviceUnits.has(r.unit_id)) {
          this.#dropFaults(r.unit_id, 'sim');
          hist.length = 0;
          handover = true;
        }
        this.deviceUnits.set(r.unit_id, now);
      }
      const row = {
        unit_id: r.unit_id,
        t: ts,
        temp,
        rep: num(r.reported_temp_c),
        sp: num(r.setpoint_c),
        pw: num(r.power_w),
        comp: typeof r.compressor_on === 'boolean' ? r.compressor_on : null,
      };
      const ml = mlInfo(r.ml);
      if (ml) row.ml = ml;
      hist.push(row);
      if (hist.length > HISTORY) hist.shift();
      readings.push(row);
    }

    const newAlerts = [];
    for (const f of Array.isArray(p.faults) ? p.faults : []) {
      if (!this.history.has(f?.unit_id) || typeof f.type !== 'string') continue;
      if (fromSim && this.deviceUnits.has(f.unit_id)) continue;
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
        source, model: str(f.model, 40),
        detected_at: prev?.detected_at ?? num(f.detected_at) ?? ts,
      };
      this.faults.set(key, fault);
      if (!prev || prev.severity !== severity) {
        const started = prev ? null : fromSim ? this.sim.attackStartFor(f.unit_id) : this.ml.injected_at;
        newAlerts.push({
          id: ++this.alertSeq, ts, ...fault, status: 'active',
          latency_s: started ? Math.max(0, Math.round((ts - started) / 100) / 10) : null,
        });
      }
    }
    if (newAlerts.length) this.alerts = [...newAlerts.reverse(), ...this.alerts].slice(0, 300);

    // A unit changing hands resets its chart, so clients get a full snapshot instead.
    if (handover) this.broadcast(this.snapshot());
    else this.broadcast({ type: 'ingest', ts, device_id: this.lastDevice, readings, faults: [...this.faults.values()], alerts: newAlerts });
    return fromSim || !p.ml_bridge ? { accepted: readings.length } : { accepted: readings.length, scenario: this.ml.scenario };
  }

  #dropFaults(unitId, source) {
    for (const [key, f] of this.faults) {
      if (f.unit_id === unitId && f.source === source) this.faults.delete(key);
    }
  }

  hardReset() {
    for (const h of this.history.values()) h.length = 0;
    this.faults.clear();
    this.alerts = [];
    this.deviceUnits.clear();
    this.ml.scenario = null;
    this.ml.injected_at = null;
    this.sim?.hardReset();
    this.broadcast(this.snapshot());
  }

  // JSON API shared by both runtimes. Returns null when the route is not an API route.
  // origin: the caller's address, recorded on attacks so the dashboard can show who started them.
  api(method, path, body, authorization, origin = '') {
    if (method === 'GET' && path === '/api/layout') return [200, this.layout];
    if (method === 'POST' && path === '/ingest') {
      if (this.ingestToken && authorization !== `Bearer ${this.ingestToken}`) return [401, { error: 'unauthorized' }];
      try { return [200, this.ingest(body)]; } catch (err) { return [400, { error: err.message }]; }
    }
    if (method === 'POST' && path === '/api/ml/inject') {
      if (!this.mlState().connected) return [409, { error: 'ML bridge not connected' }];
      if (!this.ml.scenarios.some((s) => s.id === body?.scenario)) return [400, { error: 'unknown scenario' }];
      this.#mlSet(body.scenario);
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/api/ml/restore') { this.#mlSet(null); return [200, { ok: true }]; }
    if (method === 'POST' && path.startsWith('/api/sim/')) {
      if (!this.sim) return [409, { error: 'simulator disabled (SIM=0)' }];
      if (path === '/api/sim/attack') return this.sim.attack(body?.scenario, originLabel(origin)) ? [200, { ok: true }] : [400, { error: 'unknown scenario' }];
      if (path === '/api/sim/restore') { this.sim.restore(); return [200, { ok: true }]; }
      if (path === '/api/sim/reset') { this.hardReset(); return [200, { ok: true }]; }
    }
    return null;
  }
}
