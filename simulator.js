// Stand-in for the real edge AI device. It produces exactly the payload the
// real device would POST to /ingest: time series readings + detected faults.
// It also plays the attacker, so the demo works with no hardware attached.

const TICK_MS = 500;
const DT = TICK_MS / 1000;

export const SCENARIOS = {
  setpoint_hijack: { mode: 'heat', match: (u) => u.model === 'upright' },
  sensor_spoof: { mode: 'spoof', match: (u) => u.model === 'chest' },
  short_cycle: { mode: 'cycle', match: (u) => u.model === 'multideck' },
  slow_drift: { mode: 'drift', match: (u) => u.kind === 'pharma' },
};

const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const noise = (s) => (Math.random() + Math.random() + Math.random() - 1.5) * s;

export class Simulator {
  constructor(layout, emit, onState) {
    this.layout = layout;
    this.emit = emit;
    this.onState = onState;
    this.attacks = new Map(); // scenario -> { scenario, targets, started_at }
    this.edgeProbeUntil = 0;
    this.seq = 0;
    this.tickNo = 0;
    this.units = layout.units.map((cfg) => this.#fresh(cfg));
  }

  #fresh(cfg) {
    const k = this.layout.kinds[cfg.kind];
    return {
      cfg, k,
      T: k.setpoint + noise(0.2),
      ema: k.setpoint,
      phase: Math.random() * Math.PI * 2,
      mode: null,
      offset: 0,
      hist: [],
      comp: [],
      faults: new Map(), // type -> { severity, miss }
    };
  }

  start() {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  state() {
    return {
      enabled: true,
      attacks: [...this.attacks.values()],
      edge_probe_until: this.edgeProbeUntil,
    };
  }

  attackStartFor(unitId) {
    let t = null;
    for (const a of this.attacks.values()) {
      if (a.targets.includes(unitId) && (t === null || a.started_at < t)) t = a.started_at;
    }
    return t;
  }

  attack(scenario) {
    if (scenario === 'edge_probe') {
      this.edgeProbeUntil = Date.now() + 9000;
      this.onState();
      return true;
    }
    if (scenario === 'coordinated') {
      for (const s of Object.keys(SCENARIOS)) this.attack(s);
      return true;
    }
    const sc = SCENARIOS[scenario];
    if (!sc) return false;
    if (this.attacks.has(scenario)) return true;
    const targets = [];
    for (const u of this.units) {
      if (sc.match(u.cfg)) {
        u.mode = sc.mode;
        targets.push(u.cfg.id);
      }
    }
    this.attacks.set(scenario, { scenario, targets, started_at: Date.now() });
    this.onState();
    return true;
  }

  // Attacker is kicked out; units recover on their own physics.
  restore() {
    for (const u of this.units) { u.mode = null; u.offset = 0; }
    this.attacks.clear();
    this.edgeProbeUntil = 0;
    this.onState();
  }

  // Instant clean slate for re-running the demo.
  hardReset() {
    this.units = this.layout.units.map((cfg) => this.#fresh(cfg));
    this.attacks.clear();
    this.edgeProbeUntil = 0;
    this.onState();
  }

  tick() {
    this.tickNo++;
    const ts = Date.now();
    const readings = [];
    const faults = [];

    for (const u of this.units) {
      const { k } = u;
      u.phase += 0.15;
      let comp, power, reported, reportedSet = k.setpoint;

      switch (u.mode) {
        case 'heat': // setpoint forced to +50 °C, defrost heaters on
          u.T += (50 - u.T) * 0.008;
          comp = false; power = 950 + noise(40);
          reported = u.T; reportedSet = 50;
          break;
        case 'spoof': // compressor killed, controller replays a healthy reading
          u.T += (21 - u.T) * 0.006;
          comp = false; power = 12 + noise(3);
          reported = k.setpoint + 0.3 * Math.sin(u.phase);
          break;
        case 'cycle': // compressor forced on/off to destroy it
          comp = Math.floor(this.tickNo / 2) % 2 === 0;
          power = comp ? 880 + noise(60) : 18 + noise(3);
          u.T += (k.setpoint + 7 - u.T) * 0.004;
          reported = u.T;
          break;
        case 'drift': // slow, stays under classic alarm thresholds for a long time
          u.offset = Math.min(6, u.offset + 0.02);
          u.T += (k.setpoint + u.offset + 0.15 * Math.sin(u.phase) - u.T) * 0.08;
          comp = Math.cos(u.phase) < 0; power = comp ? 150 + noise(10) : 14 + noise(2);
          reported = u.T;
          break;
        default: {
          const recovering = u.T > k.setpoint + 1;
          u.T += (k.setpoint + 0.3 * Math.sin(u.phase) - u.T) * 0.06;
          comp = recovering || Math.cos(u.phase) < 0.3;
          power = comp ? (recovering ? 430 : 380) + noise(25) : 18 + noise(3);
          reported = u.T;
        }
      }
      u.T += noise(0.04);
      const T = u.T;

      // ---- stand-in for the on-device anomaly model ----
      u.hist.push(T); if (u.hist.length > 24) u.hist.shift();
      u.comp.push(comp); if (u.comp.length > 20) u.comp.shift();
      const prevEma = u.ema;
      u.ema += (T - u.ema) * 0.1;
      const rate = u.hist.length > 6 ? (T - u.hist[u.hist.length - 7]) / (6 * DT) : 0;
      let flips = 0;
      for (let i = 1; i < u.comp.length; i++) if (u.comp[i] !== u.comp[i - 1]) flips++;

      const want = new Map();
      if (rate > 0.2) {
        want.set('rapid_temp_rise', {
          severity: 'warning', confidence: clamp(0.75 + rate * 0.25, 0, 0.99),
          message: `Temperature rising ${rate.toFixed(2)} °C/s, far outside the normal compressor cycle`,
        });
      }
      if (T > k.crit) {
        want.set('temp_excursion', {
          severity: 'critical', confidence: 0.99,
          message: `Probe reads ${T.toFixed(1)} °C, above the critical limit of ${k.crit} °C`,
        });
      } else if (T > k.warn) {
        want.set('temp_excursion', {
          severity: 'warning', confidence: 0.95,
          message: `Probe reads ${T.toFixed(1)} °C, above the warning limit of ${k.warn} °C`,
        });
      }
      if (Math.abs(reported - T) > 1.5) {
        want.set('sensor_spoofing', {
          severity: 'critical', confidence: 0.97,
          message: `Controller reports ${reported.toFixed(1)} °C but the independent probe reads ${T.toFixed(1)} °C`,
        });
      }
      if (Math.abs(reportedSet - k.setpoint) > 2) {
        want.set('setpoint_tamper', {
          severity: 'critical', confidence: 0.98,
          message: `Setpoint changed from ${k.setpoint} °C to ${reportedSet} °C outside any maintenance window`,
        });
      }
      if (flips >= 6) {
        want.set('compressor_short_cycle', {
          severity: 'critical', confidence: 0.93,
          message: `Compressor switched ${flips}× in 10 s. Power signature matches forced short-cycling`,
        });
      }
      const slope = (u.ema - prevEma) / DT;
      if (u.ema - k.setpoint > 0.6 && T <= k.warn && rate <= 0.2 && slope > 0 && !want.has('compressor_short_cycle')) {
        const eta = Math.round((k.crit - T) / slope);
        want.set('slow_drift', {
          severity: 'warning', confidence: 0.86,
          message: `Sustained drift of +${(u.ema - k.setpoint).toFixed(1)} °C over baseline. Limit breach predicted in ~${eta} s`,
        });
      }

      for (const [type, w] of want) {
        const cur = u.faults.get(type);
        if (!cur || cur.severity !== w.severity) {
          faults.push({ unit_id: u.cfg.id, type, status: 'active', severity: w.severity, confidence: r2(w.confidence), message: w.message, detected_at: ts, sms_sent: w.severity === 'critical' && !u.smsSent });
          if (w.severity === 'critical') u.smsSent = true; // one text per unit per incident
        }
        u.faults.set(type, { severity: w.severity, miss: 0 });
      }
      for (const [type, cur] of u.faults) {
        if (want.has(type)) continue;
        if (++cur.miss >= 6) {
          u.faults.delete(type);
          faults.push({ unit_id: u.cfg.id, type, status: 'cleared', severity: cur.severity, detected_at: ts });
        }
      }

      if (u.faults.size === 0) u.smsSent = false;

      readings.push({
        unit_id: u.cfg.id,
        temp_c: r2(T),
        reported_temp_c: r2(reported),
        setpoint_c: reportedSet,
        power_w: Math.max(0, Math.round(power)),
        compressor_on: comp,
      });
    }

    this.emit({ device_id: 'edge-sim-01', seq: ++this.seq, ts, readings, faults });
  }
}
