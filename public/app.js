import { createScene } from '/scene.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ATTACKS = [
  { id: 'setpoint_hijack', title: 'Setpoint hijack to +50 °C', desc: 'Wall freezers: setpoint rewritten, defrost heaters forced on.', where: 'FZ-01…06' },
  { id: 'sensor_spoof', title: 'Blind the controller', desc: 'Island freezers: compressors killed while the controller replays healthy readings.', where: 'FZ-07…10' },
  { id: 'short_cycle', title: 'Compressor burn-out', desc: 'Dairy chillers: compressors forced on/off every second to destroy them.', where: 'CH-01…04' },
  { id: 'slow_drift', title: 'Stealth spoilage', desc: 'Pharmacy: insulin and vaccines warmed slowly, under every classic alarm limit.', where: 'PH-01…02' },
  { id: 'coordinated', title: 'Coordinated strike', desc: 'All of the above at once.', where: 'ALL' },
  { id: 'edge_probe', title: 'Attack the edge device', desc: 'Try to reach the last line of defence from the internet.', where: 'EDGE', safe: true },
];
const TYPE = {
  rapid_temp_rise: 'Rapid temperature rise',
  temp_excursion: 'Temperature excursion',
  sensor_spoofing: 'Controller reading spoofed',
  setpoint_tamper: 'Setpoint tampering',
  compressor_short_cycle: 'Compressor short-cycling',
  slow_drift: 'Slow drift',
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
let sim = { enabled: false, attacks: [], edge_probe_until: 0 };
let selected = null;
let lastIngest = 0;

$('store-name').textContent = layout.store.name;
$('kpi-units').textContent = units.size;

const scene = createScene($('stage'), layout, { onSelect: select });

// ---------- attack simulator ----------
const post = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
for (const a of ATTACKS) {
  const b = el('button', 'attack' + (a.safe ? ' safe' : ''));
  b.dataset.id = a.id;
  const t = el('div', 'attack-t', a.title);
  t.append(el('em', '', a.where));
  b.append(t, el('div', 'attack-d', a.desc));
  b.onclick = () => {
    post('/api/sim/attack', { scenario: a.id });
    if (a.id === 'edge_probe') showToast();
  };
  $('attacks').append(b);
}
$('btn-restore').onclick = () => post('/api/sim/restore');
$('btn-reset').onclick = () => post('/api/sim/reset');
$('detail-close').onclick = () => select(null);

let toastTimer;
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
    faults = m.faults; alerts = m.alerts; sim = m.sim;
    renderAlerts(); renderSim(); refresh();
  } else if (m.type === 'ingest') {
    lastIngest = Date.now();
    for (const r of m.readings) {
      const u = units.get(r.unit_id);
      if (!u) continue;
      u.hist.push(r);
      if (u.hist.length > WINDOW) u.hist.shift();
    }
    faults = m.faults;
    if (m.alerts.length) { alerts = [...m.alerts.slice().reverse(), ...alerts].slice(0, 150); renderAlerts(); }
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
  renderDetail();
}

setInterval(() => {
  const age = lastIngest ? (Date.now() - lastIngest) / 1000 : Infinity;
  const alive = age < 5;
  $('kpi-link').querySelector('.dot').className = 'dot ' + (alive ? 'live' : lastIngest ? 'dead' : '');
  $('kpi-link-t').textContent = alive ? 'live' : lastIngest ? `silent ${Math.round(age)} s` : 'waiting';
  scene.setEdgeAlive(alive);
}, 1000);

function renderSim() {
  $('sim-panel').hidden = !sim.enabled;
  const active = new Set(sim.attacks.map((a) => a.scenario));
  for (const b of $('attacks').children) {
    const id = b.dataset.id;
    b.classList.toggle('active', active.has(id) || (id === 'coordinated' && active.size >= 4));
  }
  scene.setSim(sim);
}

// ---------- alerts + sms ----------
function alertNode(a) {
  const n = el('div', `alert ${a.status === 'cleared' ? 'cleared' : a.severity}`);
  const h = el('div', 'alert-h');
  h.append(el('span', '', `${a.unit_id} · ${typeName(a.type)}${a.status === 'cleared' ? ' cleared' : ''}`), el('time', '', fmtTime(a.ts)));
  n.append(h);
  if (a.message) n.append(el('div', 'alert-m', a.message));
  const chips = el('div', 'chips');
  if (a.latency_s != null) chips.append(el('span', 'chip fast', `detected in ${a.latency_s.toFixed(1)} s`));
  if (a.confidence != null && a.status !== 'cleared') chips.append(el('span', 'chip', `confidence ${Math.round(a.confidence * 100)}%`));
  if (a.sms_sent) chips.append(el('span', 'chip', 'SMS sent'));
  if (chips.children.length) n.append(chips);
  return n;
}

function renderAlerts() {
  const box = $('alerts');
  $('alert-count').textContent = alerts.length;
  if (!alerts.length) {
    box.replaceChildren(el('div', 'empty', 'No anomalies detected. Click a unit in the store to inspect it.'));
  } else {
    box.replaceChildren(...alerts.slice(0, 60).map((a) => {
      const n = alertNode(a);
      n.onclick = () => select(a.unit_id);
      return n;
    }));
  }
  const sms = alerts.filter((a) => a.sms_sent && a.status === 'active');
  $('sms-count').textContent = sms.length;
  if (!sms.length) {
    $('sms-list').replaceChildren(el('div', 'empty', 'No messages yet. The device texts the on-call staff on every critical detection.'));
  } else {
    $('sms-list').replaceChildren(...sms.slice(0, 30).map((a) => {
      const u = units.get(a.unit_id);
      const b = el('div', 'bubble');
      b.append(el('b', '', 'COLD CHAIN ALERT '), `${layout.store.name}: ${a.unit_id} (${u ? u.cfg.contents : ''}). ${typeName(a.type)}. ${a.message}`);
      b.append(el('time', '', `${fmtTime(a.ts)} · to on-call store manager`));
      return b;
    }));
  }
}

// ---------- detail ----------
function select(id) {
  selected = id && units.has(id) ? id : null;
  scene.setSelected(selected);
  $('detail').hidden = !selected;
  renderDetail();
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
  drawChart($('chart-power'), [{ data: u.hist.map((r) => r.pw), color: '#fbbf24', width: 1.5 }], { include: [0, 500], suffix: '' });

  const mine = faults.filter((f) => f.unit_id === selected);
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
