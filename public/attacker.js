// Attacker console. Runs on a different device from the dashboard (a phone is
// ideal). It is the only page that can start an attack; the dashboard has no controls.

import { ATTACKS } from '/attacks.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const post = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// What the attacker "does" to the vendor control system, shown as a terminal log.
const STEPS = {
  setpoint_hijack: ['write FZ-01..06 setpoint = +50 °C', 'write FZ-01..06 defrost heaters = FORCED ON'],
  sensor_spoof: ['write FZ-07..10 compressor = OFF', 'patch FZ-07..10 reported temperature = replay of last healthy hour'],
  short_cycle: ['write CH-01..04 compressor = toggle every 1 s'],
  slow_drift: ['write PH-01..02 setpoint += 0.04 °C/s (below every alarm limit)'],
  coordinated: ['write ALL units: hijack, blind, burn-out, drift'],
  edge_probe: ['scan edge device: 0 open ports', 'connect edge device :22 … timed out', 'connect edge device :443 … timed out'],
};

function log(text, cls) {
  const box = $('log');
  box.append('\n', el('span', cls, `> ${text}`));
  box.scrollTop = box.scrollHeight;
}

async function launch(a) {
  STEPS[a.id].forEach((line, i) => setTimeout(() => log(line), i * 350));
  const done = STEPS[a.id].length * 350;
  try {
    const res = await post('/api/sim/attack', { scenario: a.id });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    setTimeout(() => (a.safe
      ? log('no way in. the edge device only sends, it never listens.', 'fail')
      : log('vendor controller accepted the commands.', 'ok')), done);
  } catch (err) {
    setTimeout(() => log(`failed: ${err.message}`, 'fail'), done);
  }
}

for (const a of ATTACKS) {
  const b = el('button', 'attack');
  b.dataset.id = a.id;
  const t = el('div', 'attack-t', a.title);
  t.append(el('em', '', a.where));
  b.append(t, el('div', 'attack-d', a.desc));
  b.onclick = () => launch(a);
  $('attacks').append(b);
}
$('btn-restore').onclick = () => { post('/api/sim/restore'); log('attacks withdrawn. units recover on their own.'); };
$('btn-reset').onclick = () => { post('/api/sim/reset'); log('demo reset by operator.'); };
$('btn-ml-clear').onclick = () => post('/api/ml/restore');

fetch('/api/layout').then((r) => r.json()).then((l) => { $('store-name').textContent = l.store.name; });

function renderSim(sim) {
  const active = new Set(sim.attacks.map((a) => a.scenario));
  for (const b of $('attacks').children) {
    const id = b.dataset.id;
    b.classList.toggle('active', active.has(id) || (id === 'coordinated' && active.size >= 4));
  }
}

// Lab faults for the ML replay bridge (edge/ml_bridge.py): a recorded equipment
// fault, not an attack. Kept here so the dashboard stays free of controls.
const ML_SHORT = {
  freezer_door_open: 'Door open', evaporator_ice_accumulation: 'Icing', expansion_valve_failure: 'Valve failure',
  chilled_case_evaporator_fan_failure: 'Fan failure', gas_cooler_airflow_blockage: 'Gas cooler blocked',
  chilled_case_evaporator_airflow_blockage: 'Airflow blocked',
};
function renderMl(ml) {
  $('ml-box').hidden = !ml.connected;
  const box = $('ml-faults');
  if (box.children.length !== ml.scenarios.length) {
    box.replaceChildren(...ml.scenarios.map((s) => {
      const slug = s.label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const b = el('button', 'plain', `${ML_SHORT[slug] || s.label} · ${s.units.join('+')}`);
      b.dataset.id = s.id;
      b.onclick = () => post('/api/ml/inject', { scenario: s.id });
      return b;
    }));
  }
  for (const b of box.children) b.classList.toggle('active', b.dataset.id === ml.scenario);
  const wanted = ml.scenarios.find((s) => s.id === ml.scenario);
  $('ml-hint').textContent = !wanted ? 'Lab faults: replay the recording of a real equipment fault. The edge models have to detect it.'
    : ml.playing !== wanted.id ? 'Loading the recording…' : 'Replaying the fault recording; waiting on the models.';
}

const es = new EventSource('/events');
es.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.sim) renderSim(m.sim);
  if (m.ml) renderMl(m.ml);
};
