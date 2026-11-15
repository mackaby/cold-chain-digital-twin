// Refrigeration circuit overlay. A simplified schematic of the shared CO2 rack,
// redrawn after Fig. 1 of Sun et al. (2021), Scientific Data,
// doi:10.1038/s41597-021-00927-6 (the lab rig behind the edge ML models).
// The selected unit's case is drawn on the freezer (LT) or chilled (MT) branch,
// and each active fault is pinned to the component it points at.

const NS = 'http://www.w3.org/2000/svg';

// One case branch. dy shifts it down for the MT case.
const branch = (id, dy) => `
  <g id="${id}">
    <rect class="case" x="150" y="${186 + dy}" width="282" height="82" rx="8"><title>Display case</title></rect>
    <text class="case-label" id="${id}-label" x="152" y="${181 + dy}"></text>
    <path class="pipe" d="M110 ${206 + dy} H176" />
    <path class="valve" d="M176 ${197 + dy} L194 ${215 + dy} L194 ${197 + dy} L176 ${215 + dy} Z"><title>Expansion valve</title></path>
    <text class="lbl" x="185" y="${230 + dy}" text-anchor="middle">${dy ? 'MP' : 'LP'} valve</text>
    <path class="pipe" d="M194 ${206 + dy} H212" />
    <g class="coil"><title>Evaporator coil</title>
      <rect x="212" y="${194 + dy}" width="110" height="24" rx="3" />
      <path d="M220 ${206 + dy} l6 -7 l6 14 l6 -14 l6 14 l6 -14 l6 14 l6 -14 l6 14 l6 -14 l6 14 l6 -14 l6 14 l6 -14 l6 14 l6 -7" />
      <text x="267" y="${210 + dy}" text-anchor="middle">Evaporator</text>
    </g>
    <g class="fan"><title>Evaporator fan</title>
      <circle cx="250" cy="${246 + dy}" r="9" />
      <path d="M250 ${246 + dy} l0 -7 M250 ${246 + dy} l6 4 M250 ${246 + dy} l-6 4" />
    </g>
    <text class="lbl" x="263" y="${250 + dy}">Fan</text>
    <path class="air" d="M290 ${252 + dy} V${224 + dy} M304 ${252 + dy} V${224 + dy}" marker-end="url(#arrow)"><title>Air path through the coil</title></path>
    <g class="sensor"><title>Case air temperature probe</title>
      <circle cx="345" cy="${246 + dy}" r="8" />
      <text x="345" y="${249.5 + dy}" text-anchor="middle">T</text>
    </g>
    <text class="read" id="${id}-read" x="345" y="${232 + dy}" text-anchor="middle"></text>
    <g class="ctrl"><title>Vendor case controller (setpoint, defrost)</title>
      <rect x="366" y="${236 + dy}" width="58" height="20" rx="4" />
      <text x="395" y="${249.5 + dy}" text-anchor="middle">Controller</text>
    </g>
  </g>`;

const SVG = `
<svg viewBox="0 0 720 378" role="img" aria-label="Refrigeration circuit">
  <defs>
    <marker id="arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0 L8 4 L0 8 Z" class="arrowhead" />
    </marker>
  </defs>

  <g id="shared">
    <text class="lbl" x="390" y="16" text-anchor="middle">Air-cooled gas cooler &amp; fan</text>
    <path class="pipe" d="M110 112 V43 H280" />
    <path class="pipe" d="M500 43 H690 V72 M580 72 H690 M580 72 V86 M620 72 V86 M660 72 V86" />
    <g class="gc"><title>Gas cooler</title>
      <rect x="280" y="24" width="220" height="38" rx="6" />
      <path d="M292 43 l6 -8 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -16 l6 16 l6 -8" />
    </g>
    <g class="fan"><title>Gas cooler fan</title>
      <circle cx="476" cy="43" r="11" />
      <path d="M476 43 l0 -8 M476 43 l7 5 M476 43 l-7 5" />
    </g>
    <text class="read" id="gc-read" x="390" y="78" text-anchor="middle"></text>

    <path class="valve" d="M101 73 L119 91 L101 91 L119 73 Z"><title>High-pressure expansion valve</title></path>
    <text class="lbl" x="94" y="80" text-anchor="end">High-pressure</text>
    <text class="lbl" x="94" y="91" text-anchor="end">valve</text>

    <rect class="tank" x="96" y="112" width="28" height="86" rx="12"><title>Flash tank</title></rect>
    <text class="lbl" x="88" y="152" text-anchor="end">Flash</text>
    <text class="lbl" x="88" y="163" text-anchor="end">tank</text>

    <path class="pipe" d="M124 128 H700" />
    <path class="valve" d="M221 119 L239 137 L239 119 L221 137 Z"><title>Flash gas control valve</title></path>
    <text class="lbl" x="230" y="114" text-anchor="middle">Flash gas valve</text>

    <path class="pipe" d="M110 198 V306" />
  </g>

  <g id="mt-comps">
    <path class="pipe" d="M580 114 V128 M620 114 V128 M660 114 V128 M322 306 H700 V128" />
    <g class="comp"><title>Medium-temperature compressors</title>
      <circle cx="580" cy="100" r="14" /><path d="M572 108 L580 91 L588 108" />
      <circle cx="620" cy="100" r="14" /><path d="M612 108 L620 91 L628 108" />
      <circle cx="660" cy="100" r="14" /><path d="M652 108 L660 91 L668 108" />
    </g>
    <text class="lbl" id="mt-comp-label" x="620" y="146" text-anchor="middle">MT compressors</text>
  </g>

  <g id="lt-comps">
    <path class="pipe" d="M450 157 V128 M490 157 V128 M322 206 H490 M450 183 V206 M490 183 V206" />
    <g class="comp"><title>Low-temperature compressors</title>
      <circle cx="450" cy="170" r="13" /><path d="M443 177 L450 161 L457 177" />
      <circle cx="490" cy="170" r="13" /><path d="M483 177 L490 161 L497 177" />
    </g>
    <text class="lbl" id="lt-comp-label" x="512" y="174">LT compressors</text>
  </g>

  ${branch('lt', 0)}
  ${branch('mt', 100)}
  <g id="pins"></g>
</svg>`;

// Where each component sits; dy applies to the selected case branch.
const ANCHORS = {
  gc: [390, 43], gcfan: [476, 43],
  valve: [185, 206], coil: [267, 206], fan: [250, 246], air: [297, 238],
  sensor: [345, 246], ctrl: [395, 246], case: [432, 227],
};
const PART = {
  gc: 'Gas cooler', gcfan: 'Gas cooler fan', valve: 'Expansion valve', coil: 'Evaporator coil',
  fan: 'Evaporator fan', air: 'Evaporator air path', sensor: 'Case temperature probe',
  ctrl: 'Case controller', case: 'Display case', comps: 'Compressors',
};
// Fault type -> component it points at.
const WHERE = {
  freezer_door_open: 'case', evaporator_ice_accumulation: 'coil', expansion_valve_failure: 'valve',
  chilled_case_evaporator_fan_failure: 'fan', gas_cooler_airflow_blockage: 'gc',
  chilled_case_evaporator_airflow_blockage: 'air', unclassified_anomaly: 'case',
  temp_excursion: 'case', rapid_temp_rise: 'case', slow_drift: 'case',
  sensor_spoofing: 'sensor', setpoint_tamper: 'ctrl', compressor_short_cycle: 'comps',
};
const SHARED = new Set(['gc', 'gcfan']);

export function createCircuit(root, { typeName, onClose }) {
  root.innerHTML = `
    <div class="circuit-head">
      <div><div class="circuit-title" id="cx-title"></div>
      <div class="circuit-sub">Shared CO₂ rack · schematic redrawn after Sun et al. (2021), Fig. 1</div></div>
      <button class="close" aria-label="Close circuit diagram">×</button>
    </div>
    ${SVG}
    <ol class="circuit-faults" id="cx-faults"></ol>`;
  root.querySelector('.close').onclick = onClose;
  const svg = root.querySelector('svg');
  const q = (sel) => root.querySelector(sel);

  function pin(x, y, n, severity) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `pin ${severity}`);
    for (const [cls, r] of [['halo', 16], ['dot', 8]]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', r);
      g.append(c);
    }
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y + 3.5); t.setAttribute('text-anchor', 'middle');
    t.textContent = n;
    g.append(t);
    return g;
  }

  return {
    update({ unit, kind, faults, last }) {
      const lt = unit.kind === 'freezer';
      const side = lt ? 'lt' : 'mt';
      const dy = lt ? 0 : 100;
      svg.classList.toggle('on-lt', lt);
      svg.classList.toggle('on-mt', !lt);
      q('#cx-title').textContent = `${unit.id} · ${lt ? 'freezer (LT)' : 'chilled (MT)'} circuit`;
      q('#lt-label').textContent = lt ? `${unit.id} · ${unit.contents}` : 'Other freezer cases';
      q('#mt-label').textContent = lt ? 'Other chilled cases' : `${unit.id} · ${unit.contents}`;

      // Live values from the latest reading.
      for (const s of ['lt', 'mt']) q(`#${s}-read`).textContent = '';
      if (last) q(`#${side}-read`).textContent = `${last.temp.toFixed(1)} °C`;
      const ml = last?.ml;
      q('#gc-read').textContent = ml && ml.gin !== null && ml.gout !== null
        ? `air in ${ml.gin.toFixed(1)} °C · out ${ml.gout.toFixed(1)} °C` : '';
      const comp = last?.comp == null ? '' : last.comp ? ' · running' : ' · off';
      q('#lt-comp-label').textContent = `LT compressors${lt ? comp : ''}`;
      q('#mt-comp-label').textContent = `MT compressors${lt ? '' : comp}`;

      // Pin each active fault to its component, numbered to match the list.
      const pins = q('#pins');
      pins.replaceChildren();
      const used = new Map();
      const rows = faults.map((f, i) => {
        const part = WHERE[f.type] || 'case';
        let [x, y] = part === 'comps' ? (lt ? [470, 170] : [620, 100]) : ANCHORS[part];
        if (part !== 'comps' && !SHARED.has(part)) y += dy;
        const k = `${x},${y}`;
        const stack = used.get(k) || 0;
        used.set(k, stack + 1);
        pins.append(pin(x + stack * 18, y - stack * 6, i + 1, f.severity));
        const li = el('li', f.severity);
        li.append(el('b', '', String(i + 1)), el('span', 'part', PART[part]), el('span', '', typeName(f.type)));
        return li;
      });
      const list = q('#cx-faults');
      if (rows.length) list.replaceChildren(...rows);
      else list.replaceChildren(el('li', 'none', `No active faults. Highlighted: ${lt ? 'freezer' : 'chilled'} branch.`));
      svg.classList.toggle('faulty', rows.length > 0);
    },
  };
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
