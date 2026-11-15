import { createScene } from '/scene.js';
import { createCircuit } from '/circuit.js';
import { ATTACK_TITLE } from '/attacks.js';

// Read-only view: this page only listens on /events. It has no controls and sends
// nothing; attacks are started from the attacker console (/attacker) on another device.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const TYPE = {
  rapid_temp_rise: 'Rapid temperature rise',
  temp_excursion: 'Temperature excursion',
  sensor_spoofing: 'Controller reading spoofed',
  setpoint_tamper: 'Setpoint tampering',
  compressor_short_cycle: 'Compressor short-cycling',
  slow_drift: 'Slow drift',
  // Fault classes of the edge ML model (edge/ml_bridge.py)
  freezer_door_open: 'Freezer door open',
  evaporator_ice_accumulation: 'Evaporator ice accumulation',
  expansion_valve_failure: 'Expansion valve failure',
  chilled_case_evaporator_fan_failure: 'Evaporator fan failure',
  gas_cooler_airflow_blockage: 'Gas cooler airflow blockage',
  chilled_case_evaporator_airflow_blockage: 'Evaporator airflow blockage',
  unclassified_anomaly: 'Unclassified anomaly',
};
const typeName = (t) => TYPE[t] || t.replace(/_/g, ' ');
const RANK = { ok: 0, info: 0, warning: 1, critical: 2 };
const WINDOW = 240;
const fmtT = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(1)} °C`);
const fmtEur = (v) => '€' + Math.round(v).toLocaleString('en-US');
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-GB');

const layout = await (await fetch('/api/layout')).json();
const units = new Map(layout.units.map((cfg) => [cfg.id, { cfg, kind: layout.kinds[cfg.kind], hist: [], state: 'ok' }]));
let faults = [];
let alerts = [];
let incidents = [];
let sim = { enabled: false, attacks: [], edge_probe_until: 0 };
let deviceId = null;
let selected = null;
let lastIngest = 0;

$('store-name').textContent = layout.store.name;
$('kpi-units').textContent = units.size;

const scene = createScene($('stage'), layout, { onSelect: select });

$('detail-close').onclick = () => select(null);

// Circuit overlay: opens with a unit, can be closed and reopened from the unit panel.
let circuitOpen = false;
const circuit = createCircuit($('circuit'), { typeName, onClose: () => setCircuit(false) });
$('btn-circuit').onclick = () => setCircuit(!circuitOpen);
function setCircuit(open) {
  circuitOpen = open && !!selected;
  $('circuit').hidden = !circuitOpen;
  $('btn-circuit').textContent = circuitOpen ? 'Hide circuit diagram' : 'Show circuit diagram';
  renderDetail();
}

let toastTimer, toastFor = 0;
function showToast() {
  const t = $('toast');
  t.replaceChildren();
  t.append(el('b', '', 'Inbound attack blocked. '), 'The edge device listens on no ports and accepts no connections. Data only flows out, so there is nothing to break into.');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 9000);
}

// ---------- data ----------
const es = new EventSource('/events');
es.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'snapshot') {
    for (const u of units.values()) u.hist = (m.history[u.cfg.id] || []).slice(-WINDOW);
    faults = m.faults; alerts = m.alerts; sim = m.sim; deviceId = m.device_id;
    renderAlerts(); renderSim(); refresh();
  } else if (m.type === 'ingest') {
    lastIngest = Date.now();
    deviceId = m.device_id;
    for (const r of m.readings) {
      const u = units.get(r.unit_id);
      if (!u) continue;
      u.hist.push(r);
      if (u.hist.length > WINDOW) u.hist.shift();
    }
    faults = m.faults;
    if (m.alerts.length) { alerts = [...m.alerts.slice().reverse(), ...alerts].slice(0, 300); renderAlerts(); }
    refresh();
  } else if (m.type === 'sim') {
    sim = m.sim;
    renderSim();
  }
};

function refresh() {
  const worst = new Map();
  for (const f of faults) if (RANK[f.severity] > RANK[worst.get(f.unit_id) || 'ok']) worst.set(f.unit_id, f.severity);
  let risk = 0, crit = 0, warn = 0;
  for (const u of units.values()) {
    u.state = worst.get(u.cfg.id) || 'ok';
    if (u.state !== 'ok') risk += u.cfg.stock_eur;
    if (u.state === 'critical') crit++; else if (u.state === 'warning') warn++;
    const last = u.hist[u.hist.length - 1];
    const temp = last ? last.temp : null;
    const heat = last ? Math.min(1, Math.max(0, (last.temp - u.kind.setpoint) / u.kind.heat_range)) : 0;
    scene.updateUnit(u.cfg.id, temp, u.state, heat);
  }
  $('kpi-faults').textContent = faults.length;
  $('kpi-faults').classList.toggle('bad', faults.length > 0);
  $('kpi-risk').textContent = fmtEur(risk);
  $('kpi-risk').classList.toggle('bad', risk > 0);
  const banner = $('banner');
  banner.className = 'banner ' + (crit ? 'critical' : warn ? 'warning' : 'ok');
  banner.textContent = crit ? `ANOMALY DETECTED · ${crit} UNIT${crit > 1 ? 'S' : ''} CRITICAL`
    : warn ? `EARLY WARNING · ${warn} UNIT${warn > 1 ? 'S' : ''}` : 'ALL UNITS SECURE';
  renderChain();
  renderDetail();
}

setInterval(() => {
  const age = lastIngest ? (Date.now() - lastIngest) / 1000 : Infinity;
  const alive = age < 5;
  $('kpi-link').querySelector('.dot').className = 'dot ' + (alive ? 'live' : lastIngest ? 'dead' : '');
  $('kpi-link-t').textContent = alive ? 'live' : lastIngest ? `silent ${Math.round(age)} s` : 'waiting';
  scene.setEdgeAlive(alive);
  renderChain();
}, 1000);

function renderSim() {
  scene.setSim(sim);
  if (sim.edge_probe_until > Date.now() && sim.edge_probe_until !== toastFor) {
    toastFor = sim.edge_probe_until;
    showToast();
  }
  renderChain();
}

// ---------- who does what ----------
function station(id, cls, d, s) {
  const n = $(id);
  n.className = 'st' + (cls ? ' ' + cls : '');
  n.querySelector('.st-d').textContent = d;
  n.querySelector('.st-s').textContent = s;
}

function renderChain() {
  const now = Date.now();
  const probing = (sim.edge_probe_until || 0) > now;
  const from = (o) => (o ? `from ${o} · ` : '');
  if (sim.attacks.length) {
    const first = sim.attacks.reduce((a, b) => (a.started_at <= b.started_at ? a : b));
    const targets = new Set(sim.attacks.flatMap((a) => a.targets));
    station('st-att', 'bad', sim.attacks.length > 1 ? `${sim.attacks.length} attacks running` : ATTACK_TITLE[first.scenario] || first.scenario,
      `${from(first.origin)}since ${fmtTime(first.started_at)}`);
    station('st-ven', 'bad', `Compromised · ${targets.size} unit${targets.size > 1 ? 's' : ''}`, 'obeying the attacker');
  } else {
    if (probing) station('st-att', 'bad', 'Trying to reach the edge device', `${from(sim.edge_probe_origin)}now`);
    else station('st-att', '', sim.enabled ? 'No hostile traffic' : 'Not visible from here', 'not controlled from this screen');
    station('st-ven', '', 'Normal operation', 'runs the freezers');
  }

  $('st-edge-n').textContent = deviceId ? `Edge AI · ${deviceId}` : sim.enabled ? 'Edge AI device (simulated)' : 'Edge AI device';
  if (faults.length) {
    const open = incidents.filter((i) => i.end === null);
    const lat = open.map((i) => i.latency).filter((v) => v !== null);
    const sms = open.reduce((n, i) => n + i.sms, 0);
    station('st-edge', 'good', `Caught on the device${lat.length ? ` in ${Math.min(...lat).toFixed(1)} s` : ''}`,
      `${faults.length} active detection${faults.length > 1 ? 's' : ''}${sms ? ` · ${sms} SMS sent by the device` : ''}`);
  } else if (probing) {
    station('st-edge', 'good', 'Inbound connection refused', 'no open ports, nothing to break into');
  } else {
    station('st-edge', '', lastIngest ? `Watching ${units.size} units · no anomaly` : 'Waiting for the device', 'decides alone · accepts no connections');
  }

  const age = lastIngest ? (now - lastIngest) / 1000 : null;
  station('st-view', '', 'Read-only view', age === null ? 'nothing received yet' : `last message ${age < 1 ? age.toFixed(1) : Math.round(age)} s ago · sends nothing`);
}

// ---------- incidents ----------
// The device reports one detection per unit and fault type. For reading at a glance they
// are grouped: an episode is one unit from its first detection until all its faults clear,
// and an incident is the episodes that share a cause and started together.
const CAUSE = ['setpoint_tamper', 'sensor_spoofing', 'compressor_short_cycle', 'slow_drift']; // most telling first
const SYMPTOM = ['temp_excursion', 'rapid_temp_rise'];
const weight = (t) => (CAUSE.includes(t) ? CAUSE.indexOf(t) : SYMPTOM.includes(t) ? 100 + SYMPTOM.indexOf(t) : 50);
const JOIN_MS = 20_000;

function buildIncidents() {
  const open = new Map();
  const episodes = [];
  for (let i = alerts.length - 1; i >= 0; i--) { // oldest first
    const a = alerts[i];
    let ep = open.get(a.unit_id);
    if (a.status === 'cleared') {
      if (!ep) continue;
      ep.active.delete(a.type);
      if (!ep.active.size) ep.end = a.ts;
      continue;
    }
    if (!ep || (ep.end !== null && a.ts - ep.end > JOIN_MS)) {
      ep = { unit: a.unit_id, start: a.ts, end: null, active: new Set(), first: new Map(), sms: 0, latency: null, severity: 'warning', model: '' };
      open.set(a.unit_id, ep);
      episodes.push(ep);
    }
    ep.end = null;
    ep.active.add(a.type);
    if (!ep.first.has(a.type)) ep.first.set(a.type, a);
    if (a.sms_sent) ep.sms++;
    if (a.latency_s != null && (ep.latency === null || a.latency_s < ep.latency)) ep.latency = a.latency_s;
    if (a.severity === 'critical') ep.severity = 'critical';
    if (a.model) ep.model = a.model;
  }
  const out = [];
  for (const ep of episodes) {
    const type = [...ep.first.keys()].sort((x, y) => weight(x) - weight(y))[0];
    let inc = out.find((x) => x.type === type && Math.abs(ep.start - x.start) <= JOIN_MS);
    if (!inc) {
      inc = { type, start: ep.start, end: 0, units: [], also: new Set(), sms: 0, latency: null, severity: 'warning', message: ep.first.get(type).message, model: ep.model };
      out.push(inc);
    }
    inc.units.push(ep.unit);
    inc.end = inc.end === null || ep.end === null ? null : Math.max(inc.end, ep.end);
    for (const t of ep.first.keys()) if (t !== type) inc.also.add(t);
    inc.sms += ep.sms;
    if (ep.latency !== null && (inc.latency === null || ep.latency < inc.latency)) inc.latency = ep.latency;
    if (ep.severity === 'critical') inc.severity = 'critical';
  }
  return out.sort((a, b) => b.start - a.start);
}

function incidentNode(inc) {
  const ended = inc.end !== null;
  const n = el('div', `alert ${ended ? 'cleared' : inc.severity}`);
  const h = el('div', 'alert-h');
  h.append(el('span', '', typeName(inc.type)), el('time', '', fmtTime(inc.start)));
  const ids = [...inc.units].sort();
  n.append(h, el('div', 'alert-u', `${ids.length} unit${ids.length > 1 ? 's' : ''} · ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` +${ids.length - 3}` : ''}`));
  if (inc.message) n.append(el('div', 'alert-m', inc.message));
  if (inc.also.size) n.append(el('div', 'alert-u', `also: ${[...inc.also].map((t) => typeName(t).toLowerCase()).join(', ')}`));
  const chips = el('div', 'chips');
  if (inc.latency !== null) chips.append(el('span', 'chip fast', `caught on the device in ${inc.latency.toFixed(1)} s`));
  if (inc.sms) chips.append(el('span', 'chip', `${inc.sms} SMS sent by the device`));
  if (inc.model) chips.append(el('span', 'chip', inc.model));
  chips.append(ended ? el('span', 'chip fast', `over after ${Math.max(1, Math.round((inc.end - inc.start) / 1000))} s`) : el('span', 'chip live', 'ongoing'));
  n.append(chips);
  n.onclick = () => select(ids[0]);
  return n;
}

function alertNode(a) {
  const n = el('div', `alert ${a.status === 'cleared' ? 'cleared' : a.severity}`);
  const h = el('div', 'alert-h');
  h.append(el('span', '', `${a.unit_id} · ${typeName(a.type)}${a.status === 'cleared' ? ' cleared' : ''}`), el('time', '', fmtTime(a.ts)));
  n.append(h);
  if (a.message) n.append(el('div', 'alert-m', a.message));
  const chips = el('div', 'chips');
  if (a.latency_s != null) chips.append(el('span', 'chip fast', `detected in ${a.latency_s.toFixed(1)} s`));
  if (a.confidence != null && a.status !== 'cleared') chips.append(el('span', 'chip', `confidence ${Math.round(a.confidence * 100)}%`));
  if (a.model && a.status !== 'cleared') chips.append(el('span', 'chip', a.model));
  if (a.sms_sent) chips.append(el('span', 'chip', 'SMS sent'));
  if (chips.children.length) n.append(chips);
  return n;
}

function renderAlerts() {
  incidents = buildIncidents();
  $('alert-count').textContent = incidents.length;
  $('alerts').replaceChildren(...(incidents.length
    ? incidents.slice(0, 30).map(incidentNode)
    : [el('div', 'empty', 'Nothing reported by the edge device. Click a unit in the store to inspect it.')]));
}

// ---------- detail ----------
function select(id) {
  selected = id && units.has(id) ? id : null;
  scene.setSelected(selected);
  $('detail').hidden = !selected;
  setCircuit(!!selected);
}

function renderDetail() {
  if (!selected) return;
  const u = units.get(selected);
  const last = u.hist[u.hist.length - 1];
  $('d-id').textContent = u.cfg.id;
  $('d-sub').textContent = `${u.kind.label} · ${u.cfg.contents}`;
  const badge = $('d-badge');
  badge.className = 'badge ' + u.state;
  badge.textContent = { ok: 'SECURE', warning: 'WARNING', critical: 'CRITICAL' }[u.state];
  $('d-temp').textContent = fmtT(last?.temp);
  $('d-rep').textContent = fmtT(last?.rep);
  $('d-rep-box').classList.toggle('lie', !!last && last.rep !== null && Math.abs(last.rep - last.temp) > 1.5);
  $('d-sp').textContent = last?.sp == null ? fmtT(u.kind.setpoint) : fmtT(last.sp);
  $('d-pw').textContent = last?.pw == null ? '–' : `${last.pw} W`;
  $('d-comp').textContent = last?.comp == null ? '–' : last.comp ? 'running' : 'off';
  $('d-stock').textContent = fmtEur(u.cfg.stock_eur);

  drawChart($('chart-temp'), [
    { data: u.hist.map((r) => r.rep), color: '#9aa7c0', dash: [4, 4] },
    { data: u.hist.map((r) => r.temp), color: '#4fc3ff', width: 2 },
  ], { limits: [{ v: u.kind.crit, color: '#ff4d5e' }], include: [u.kind.setpoint - 1, u.kind.crit + 1], suffix: '°' });
  // Units fed by the edge ML model show its live output instead of the power draw.
  const ml = last?.ml;
  $('d-ml').hidden = !ml;
  $('t-temp').textContent = ml ? 'Case air temperature, replayed recording' : 'Temperature, last 2 min';
  $('t-power').textContent = ml ? 'Anomaly score (%) with alert threshold' : 'Power draw (W)';
  if (ml) {
    const pct = (v) => (v === null ? '–' : `${(v * 100).toFixed(1)}%`);
    $('m-score').textContent = `${pct(ml.score)} / ${pct(ml.thr)}`;
    $('m-fault').textContent = ml.fault ? `${ml.fault}${ml.p === null ? '' : ` ${Math.round(ml.p * 100)}%`}` : '–';
    $('m-air').textContent = `${fmtT(ml.sup)} / ${fmtT(ml.ret)}`;
    $('m-gc').textContent = `${fmtT(ml.gin)} / ${fmtT(ml.gout)}`;
    $('m-rec').textContent = ml.rec ? `${ml.rec} · ${ml.at.replace('T', ' ')}` : '–';
    drawChart($('chart-power'), [{ data: u.hist.map((r) => (r.ml?.score == null ? null : r.ml.score * 100)), color: '#fbbf24', width: 1.5 }],
      { limits: ml.thr === null ? [] : [{ v: ml.thr * 100, color: '#ff4d5e' }], include: [0, 100], suffix: '' });
  } else {
    drawChart($('chart-power'), [{ data: u.hist.map((r) => r.pw), color: '#fbbf24', width: 1.5 }], { include: [0, 500], suffix: '' });
  }

  const mine = faults.filter((f) => f.unit_id === selected);
  if (circuitOpen) circuit.update({ unit: u.cfg, kind: u.kind, faults: mine, last });
  $('d-faults').replaceChildren(...mine.map((f) => alertNode({ ...f, ts: f.detected_at, status: 'active' })));
}

function drawChart(cv, series, { limits = [], include = [], suffix = '' }) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  let lo = Infinity, hi = -Infinity;
  for (const v of [...include, ...limits.map((l) => l.v), ...series.flatMap((s) => s.data)]) {
    if (v === null || v === undefined) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return;
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const L = 34, R = 4, T = 4, B = 4;
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 2; i++) {
    const v = lo + pad + ((hi - lo - 2 * pad) * i) / 2;
    ctx.strokeStyle = 'rgba(120,150,200,0.14)'; ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(w - R, y(v)); ctx.stroke();
    ctx.fillStyle = '#8494b2';
    ctx.fillText(`${Math.round(v)}${suffix}`, 2, y(v));
  }
  for (const l of limits) {
    ctx.strokeStyle = l.color; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, y(l.v)); ctx.lineTo(w - R, y(l.v)); ctx.stroke();
  }
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.2; ctx.setLineDash(s.dash || []);
    ctx.beginPath();
    let pen = false;
    s.data.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      const x = L + ((w - L - R) * (WINDOW - s.data.length + i)) / (WINDOW - 1);
      if (pen) ctx.lineTo(x, y(v)); else { ctx.moveTo(x, y(v)); pen = true; }
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
