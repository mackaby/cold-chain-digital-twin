// Attack scenarios of the built-in simulator. Shared by the attacker console
// (which launches them) and the dashboard (which only names them).

export const ATTACKS = [
  { id: 'setpoint_hijack', title: 'Setpoint hijack to +50 °C', desc: 'Wall freezers: setpoint rewritten, defrost heaters forced on.', where: 'FZ-01…06' },
  { id: 'sensor_spoof', title: 'Blind the controller', desc: 'Island freezers: compressors killed while the controller replays healthy readings.', where: 'FZ-07…10' },
  { id: 'short_cycle', title: 'Compressor burn-out', desc: 'Dairy chillers: compressors forced on/off every second to destroy them.', where: 'CH-01…04' },
  { id: 'slow_drift', title: 'Stealth spoilage', desc: 'Pharmacy: insulin and vaccines warmed slowly, under every classic alarm limit.', where: 'PH-01…02' },
  { id: 'coordinated', title: 'Coordinated strike', desc: 'All of the above at once.', where: 'ALL' },
  { id: 'edge_probe', title: 'Attack the edge device', desc: 'Try to reach the last line of defence from the internet.', where: 'EDGE', safe: true },
];

export const ATTACK_TITLE = Object.fromEntries(ATTACKS.map((a) => [a.id, a.title]));
