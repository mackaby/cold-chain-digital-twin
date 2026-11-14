import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const COL = { ok: 0x34d399, warning: 0xfbbf24, critical: 0xff4d5e, cold: 0x4fc3ff, edge: 0x34d399, attack: 0xff3b4e };
const CSS = { ok: '#34d399', warning: '#fbbf24', critical: '#ff4d5e' };
const DIMS = { upright: [2, 2.3, 0.9], chest: [2.4, 0.95, 1.15], multideck: [2.5, 2.1, 1.0], pharma: [1.5, 2.0, 0.8] };
const CEIL = 3.7;

const unitBox = new THREE.BoxGeometry(1, 1, 1);
function box(parent, mat, w, h, d, x, y, z, shadow = true) {
  const m = new THREE.Mesh(unitBox, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function textSprite(lines, { color = '#cfe3ff', border = null, w = 420, h = 96, scale = 3 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(7,12,22,0.86)';
  ctx.beginPath(); ctx.roundRect(2, 2, w - 4, h - 4, 14); ctx.fill();
  ctx.strokeStyle = border || color; ctx.lineWidth = 3; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color; ctx.font = '700 30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(lines[0], w / 2, lines[1] ? h * 0.34 : h / 2);
  if (lines[1]) {
    ctx.fillStyle = 'rgba(207,227,255,0.75)'; ctx.font = '500 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(lines[1], w / 2, h * 0.7);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(scale, scale * h / w, 1);
  sp.renderOrder = 10;
  return sp;
}

class Flow {
  constructor(scene, pts, color, count, speed, stopAt = 1) {
    this.pts = pts; this.speed = speed; this.stopAt = stopAt; this.scene = scene;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.total = this.cum[this.cum.length - 1];
    const mat = new THREE.MeshBasicMaterial({ color });
    this.dots = Array.from({ length: count }, (_, i) => {
      const m = new THREE.Mesh(Flow.geo, mat);
      m.userData.t = i / count;
      scene.add(m);
      return m;
    });
  }
  update(dt) {
    for (const m of this.dots) {
      m.userData.t = (m.userData.t + dt * this.speed / this.total) % 1;
      const dist = m.userData.t * this.stopAt * this.total;
      let i = 1;
      while (i < this.cum.length - 1 && this.cum[i] < dist) i++;
      const seg = this.cum[i] - this.cum[i - 1] || 1;
      m.position.lerpVectors(this.pts[i - 1], this.pts[i], (dist - this.cum[i - 1]) / seg);
    }
  }
  dispose() { for (const m of this.dots) this.scene.remove(m); }
}
Flow.geo = new THREE.SphereGeometry(0.1, 10, 10);

function buildUnit(u) {
  const [w, h, d] = DIMS[u.model];
  const g = new THREE.Group();
  g.position.set(u.x, 0, u.z);
  g.rotation.y = (u.rot * Math.PI) / 180;

  const body = new THREE.MeshStandardMaterial({ color: u.model === 'pharma' ? 0xd6dee8 : 0x3a4a6e, roughness: 0.55, metalness: 0.35 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x05080d, emissive: COL.cold, emissiveIntensity: 0.9 });
  const status = new THREE.MeshBasicMaterial({ color: COL.ok });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, depthWrite: false });
  const shelf = new THREE.MeshStandardMaterial({ color: 0x3a4660, roughness: 0.6, metalness: 0.4 });

  if (u.model === 'chest') {
    box(g, body, w, 0.22, d, 0, 0.11, 0);
    box(g, body, w, h, 0.07, 0, h / 2, -d / 2 + 0.035);
    box(g, body, w, h, 0.07, 0, h / 2, d / 2 - 0.035);
    box(g, body, 0.07, h, d, -w / 2 + 0.035, h / 2, 0);
    box(g, body, 0.07, h, d, w / 2 - 0.035, h / 2, 0);
    box(g, glow, w - 0.14, 0.03, d - 0.14, 0, 0.25, 0, false);
    box(g, glass, w - 0.1, 0.03, d - 0.1, 0, h - 0.02, 0, false);
    box(g, status, w, 0.06, 0.03, 0, h - 0.1, d / 2 + 0.012, false);
  } else {
    const open = u.model === 'multideck';
    const base = open ? 0.38 : 0.25;
    const head = 0.26;
    box(g, body, w, h, 0.07, 0, h / 2, -d / 2 + 0.035);
    box(g, body, 0.07, h, d, -w / 2 + 0.035, h / 2, 0);
    box(g, body, 0.07, h, d, w / 2 - 0.035, h / 2, 0);
    box(g, body, w, base, d, 0, base / 2, 0);
    box(g, body, w, head, d, 0, h - head / 2, 0);
    box(g, glow, w - 0.14, h - base - head, 0.03, 0, base + (h - base - head) / 2, -d / 2 + 0.09, false);
    const shelves = 4;
    const gap = (h - base - head) / shelves;
    for (let i = 0; i < shelves; i++) {
      const y = base + i * gap;
      const sd = open ? d - 0.35 - i * 0.08 : d - 0.2;
      const zc = -d / 2 + 0.1 + sd / 2;
      if (i > 0) box(g, shelf, w - 0.14, 0.03, sd, 0, y, zc, false);
    }
    if (!open) {
      const doors = u.model === 'pharma' ? 1 : 2;
      const dw = (w - 0.1) / doors;
      for (let i = 0; i < doors; i++) {
        const x = -w / 2 + 0.05 + dw / 2 + i * dw;
        box(g, glass, dw - 0.04, h - base - head, 0.03, x, base + (h - base - head) / 2, d / 2 - 0.02, false);
        box(g, shelf, 0.03, 0.6, 0.05, x + (i === 0 && doors === 2 ? dw / 2 - 0.1 : -dw / 2 + 0.1), h / 2, d / 2 + 0.02, false);
      }
    }
    box(g, status, w - 0.1, 0.07, 0.03, 0, h - head / 2, d / 2 + 0.012, false);
    if (u.model === 'pharma') {
      const cross = new THREE.MeshBasicMaterial({ color: 0x22e08a });
      box(g, cross, 0.42, 0.13, 0.05, 0, h + 0.3, 0, false);
      box(g, cross, 0.13, 0.42, 0.05, 0, h + 0.3, 0, false);
    }
  }

  const hit = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ visible: false }));
  hit.scale.set(w, h, d); hit.position.y = h / 2; hit.userData.unitId = u.id;
  g.add(hit);

  const r = Math.max(w, d) * 0.72;
  const ringGeo = new THREE.RingGeometry(r, r + 0.09, 56);
  const mkRing = (color) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.04; m.visible = false;
    g.add(m);
    return m;
  };

  // live label
  const cv = document.createElement('canvas');
  cv.width = 300; cv.height = 96;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  label.scale.set(1.9, 0.61, 1);
  label.position.set(0, h + (u.model === 'pharma' ? 1.05 : 0.6), 0);
  label.renderOrder = 10;
  g.add(label);

  return { cfg: u, group: g, hit, glow, status, label, cv, tex, critRing: mkRing(COL.critical), selRing: mkRing(0xffffff), h, state: 'ok', key: '' };
}

function drawLabel(unit, temp, state) {
  const key = `${temp === null ? '' : temp.toFixed(1)}|${state}`;
  if (key === unit.key) return;
  unit.key = key;
  const ctx = unit.cv.getContext('2d');
  const { width: w, height: h } = unit.cv;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = state === 'critical' ? 'rgba(60,8,16,0.92)' : 'rgba(7,12,22,0.86)';
  ctx.beginPath(); ctx.roundRect(3, 3, w - 6, h - 6, 16); ctx.fill();
  ctx.strokeStyle = CSS[state]; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = CSS[state];
  ctx.beginPath(); ctx.arc(30, h / 2, 9, 0, Math.PI * 2); ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(207,227,255,0.8)'; ctx.font = '600 24px ui-monospace, Menlo, monospace';
  ctx.fillText(unit.cfg.id, 50, h / 2 + 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff'; ctx.font = '700 34px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(temp === null ? '--' : `${temp.toFixed(1)}°`, w - 20, h / 2 + 1);
  ctx.textAlign = 'left';
  unit.tex.needsUpdate = true;
}

export function createScene(container, layout, { onSelect }) {
  const [FW, FD] = layout.store.floor;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060a13);
  scene.fog = new THREE.Fog(0x060a13, 45, 95);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  camera.position.set(5, 17, 27);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(1, 0.5, -2.5);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
  controls.minDistance = 6; controls.maxDistance = 55;

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a2540, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(8, 18, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 16, bottom: -16, near: 1, far: 50 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // floor + surroundings
  const tile = document.createElement('canvas');
  tile.width = tile.height = 128;
  const tctx = tile.getContext('2d');
  tctx.fillStyle = '#33425f'; tctx.fillRect(0, 0, 128, 128);
  tctx.strokeStyle = '#41527a'; tctx.lineWidth = 3; tctx.strokeRect(0, 0, 128, 128);
  const tileTex = new THREE.CanvasTexture(tile);
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  tileTex.repeat.set(FW / 2, FD / 2);
  tileTex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FW, FD), new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.55, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ color: 0x070b14, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02;
  scene.add(ground);
  const grid = new THREE.GridHelper(120, 60, 0x13203a, 0x0e1729);
  grid.position.y = -0.01;
  scene.add(grid);

  // walls: single-sided so they vanish when the camera is behind them
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b3a5c, roughness: 0.9 });
  const wall = (w, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 4.2), wallMat);
    m.position.set(x, 2.1, z); m.rotation.y = ry; m.receiveShadow = true;
    scene.add(m);
  };
  wall(FW, 0, -FD / 2, 0);
  wall(FD, -FW / 2, 0, Math.PI / 2);
  wall(FD, FW / 2, 0, -Math.PI / 2);
  wall(FW, 0, FD / 2, Math.PI);

  // ambient furniture
  const furn = new THREE.MeshStandardMaterial({ color: 0x46557a, roughness: 0.8 });
  const furnLight = new THREE.MeshStandardMaterial({ color: 0x8a97ad, roughness: 0.7 });
  for (const z of [-2.6, 0.4, 3.4]) {
    const g = new THREE.Group(); g.position.set(5.8, 0, z); scene.add(g);
    box(g, furn, 6, 1.5, 0.12, 0, 0.75, 0);
    box(g, furn, 6, 0.15, 0.9, 0, 0.075, 0);
    for (const y of [0.15, 0.6, 1.05]) {
      box(g, furn, 6, 0.03, 0.8, 0, y, 0, false);
    }
  }
  for (const x of [-7.5, -4]) {
    box(scene, furn, 0.9, 0.9, 2.4, x, 0.45, 6.4);
    box(scene, furnLight, 0.8, 0.04, 1.4, x, 0.92, 6.1, false);
  }
  box(scene, furnLight, 4, 1.0, 0.7, 9.1, 0.5, -6.3); // pharmacy counter
  const pharmSign = textSprite(['PHARMACY'], { color: '#22e08a', w: 300, h: 70, scale: 2.2 });
  pharmSign.position.set(9.1, 3.9, -8.7); scene.add(pharmSign);

  // units
  const units = new Map();
  const hits = [];
  layout.units.forEach((cfg, i) => {
    const u = buildUnit(cfg);
    scene.add(u.group);
    units.set(cfg.id, u);
    hits.push(u.hit);
    drawLabel(u, null, 'ok');
  });

  // network nodes
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const N = { edge: V(layout.nodes.edge), vendor: V(layout.nodes.vendor), internet: V(layout.nodes.internet), dashboard: V(layout.nodes.dashboard) };

  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x0c1a18, emissive: COL.edge, emissiveIntensity: 0.9 });
  const edgeBox = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.5, 0.2), edgeMat);
  edgeBox.position.copy(N.edge); scene.add(edgeBox);
  const shieldMat = new THREE.MeshBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.12, wireframe: true });
  const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), shieldMat);
  shield.position.copy(N.edge); scene.add(shield);
  const edgeLabel = textSprite(['EDGE AI DEVICE', 'independent · outbound only'], { color: '#34d399', scale: 3.1 });
  edgeLabel.position.copy(N.edge).add(new THREE.Vector3(0, 1.45, 0.3)); scene.add(edgeLabel);
  const blockedLabel = textSprite(['BLOCKED', 'no inbound ports'], { color: '#ffffff', border: '#ff4d5e', w: 320, scale: 2.4 });
  blockedLabel.position.copy(N.edge).add(new THREE.Vector3(2.2, 0.1, 0.6)); blockedLabel.visible = false; scene.add(blockedLabel);

  const vendorMat = new THREE.MeshStandardMaterial({ color: 0x1a2233, emissive: 0x5b6b8a, emissiveIntensity: 0.5 });
  const vendorBox = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.9, 1.3), vendorMat);
  vendorBox.position.copy(N.vendor); scene.add(vendorBox);
  const vendorLabel = textSprite(['VENDOR CONTROL SYSTEM', 'refrigeration controller · online'], { color: '#9fb2d4', w: 460, scale: 3.4 });
  vendorLabel.position.copy(N.vendor).add(new THREE.Vector3(-0.6, 1.3, 0)); scene.add(vendorLabel);

  const netMat = new THREE.MeshBasicMaterial({ color: 0x6b7c9c, wireframe: true });
  const netNode = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 1), netMat);
  netNode.position.copy(N.internet); scene.add(netNode);
  const netLabel = textSprite(['INTERNET'], { color: '#9fb2d4', w: 240, h: 70, scale: 1.9 });
  netLabel.position.copy(N.internet).add(new THREE.Vector3(0, 1.5, 0)); scene.add(netLabel);
  const attackerLabel = textSprite(['ATTACKER'], { color: '#ff4d5e', w: 240, h: 70, scale: 1.9 });
  attackerLabel.position.copy(netLabel.position); attackerLabel.visible = false; scene.add(attackerLabel);

  const dashLabel = textSprite(['DASHBOARD + SMS', 'one-way data out'], { color: '#34d399', w: 360, scale: 2.7 });
  dashLabel.position.copy(N.dashboard); scene.add(dashLabel);

  const line = (pts, color, opacity) => {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    scene.add(l);
    return l;
  };
  line([N.internet, N.vendor], 0x6b7c9c, 0.35);
  const uplink = [N.edge, N.edge.clone().setY(CEIL + 0.6), N.dashboard.clone().add(new THREE.Vector3(0, -0.6, 0))];
  line(uplink, COL.edge, 0.5);
  const flows = [new Flow(scene, uplink, COL.edge, 4, 2.2)];

  for (const u of units.values()) {
    const top = new THREE.Vector3(u.cfg.x, u.h, u.cfg.z);
    u.ctrlPath = [N.internet, N.vendor, new THREE.Vector3(N.vendor.x - 0.4, CEIL, N.vendor.z), new THREE.Vector3(u.cfg.x, CEIL, u.cfg.z), top];
    u.ctrlLine = line(u.ctrlPath.slice(1), 0x7f8fb0, 0.13);
    line([N.edge, new THREE.Vector3(N.edge.x, CEIL - 0.35, N.edge.z + 0.4), new THREE.Vector3(u.cfg.x, CEIL - 0.35, u.cfg.z), top], COL.edge, 0.2);
  }

  // post
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  // picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(hits, false)[0]?.object.userData.unitId ?? null;
  };
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) onSelect(pick(e));
    down = null;
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.buttons === 0) renderer.domElement.style.cursor = pick(e) ? 'pointer' : 'grab';
  });

  let attackFlows = [];
  let probeFlow = null;
  let probeUntil = 0;
  let attackActive = false;
  let focus = null;
  const cold = new THREE.Color(COL.cold), amber = new THREE.Color(0xffa02e), hot = new THREE.Color(0xff2a1a);

  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    if (focus) {
      controls.target.lerp(focus, 0.08);
      if (controls.target.distanceTo(focus) < 0.02) focus = null;
    }
    controls.update();
    for (const f of flows) f.update(dt);
    for (const f of attackFlows) f.update(dt);

    const probing = Date.now() < probeUntil;
    if (probing && !probeFlow) probeFlow = new Flow(scene, [N.internet, new THREE.Vector3(N.internet.x - 4, CEIL + 1.2, N.edge.z + 3), N.edge], COL.attack, 7, 7, 0.93);
    if (!probing && probeFlow) { probeFlow.dispose(); probeFlow = null; }
    if (probeFlow) probeFlow.update(dt);
    blockedLabel.visible = probing;
    shieldMat.opacity = probing ? 0.45 + 0.3 * Math.sin(t * 14) : 0.12;
    shield.rotation.y = t * 0.3;
    netNode.rotation.y = t * 0.2;
    const hostile = attackActive || probing;
    netMat.color.setHex(hostile ? COL.attack : 0x6b7c9c);
    attackerLabel.visible = hostile; netLabel.visible = !hostile;

    const pulse = (t * 1.1) % 1;
    for (const u of units.values()) {
      if (u.state === 'critical') {
        u.critRing.visible = true;
        u.critRing.scale.setScalar(1 + pulse * 0.7);
        u.critRing.material.opacity = 0.9 * (1 - pulse);
        u.status.color.setHex(Math.sin(t * 10) > 0 ? COL.critical : 0x5a0f18);
      } else {
        u.critRing.visible = false;
      }
    }
    composer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    updateUnit(id, temp, state, heat) {
      const u = units.get(id);
      if (!u) return;
      u.state = state;
      if (state !== 'critical') u.status.color.setHex(COL[state]);
      if (heat < 0.4) u.glow.emissive.lerpColors(cold, amber, heat / 0.4);
      else u.glow.emissive.lerpColors(amber, hot, Math.min(1, (heat - 0.4) / 0.6));
      u.glow.emissiveIntensity = 0.9 + heat * 1.2;
      drawLabel(u, temp, state);
    },
    setSelected(id) {
      for (const u of units.values()) u.selRing.visible = u.cfg.id === id;
      const u = units.get(id);
      if (u) focus = new THREE.Vector3(u.cfg.x, 0.9, u.cfg.z);
    },
    setSim(sim) {
      for (const f of attackFlows) f.dispose();
      attackFlows = [];
      const targets = new Set(sim.attacks.flatMap((a) => a.targets));
      attackActive = targets.size > 0;
      probeUntil = sim.edge_probe_until || 0;
      for (const u of units.values()) {
        const hit = targets.has(u.cfg.id);
        u.ctrlLine.material.color.setHex(hit ? COL.attack : 0x7f8fb0);
        u.ctrlLine.material.opacity = hit ? 0.75 : 0.13;
        if (hit) attackFlows.push(new Flow(scene, u.ctrlPath, COL.attack, 3, 6));
      }
      vendorMat.emissive.setHex(attackActive ? COL.attack : 0x5b6b8a);
      vendorMat.emissiveIntensity = attackActive ? 1.4 : 0.5;
    },
    setEdgeAlive(alive) {
      edgeMat.emissive.setHex(alive ? COL.edge : 0x555f70);
    },
  };
}
