# Cold chain digital twin

3D dashboard for the edge AI device. Visualisation only: it receives data, it never talks back to the device.

```bash
npm install
npm start          # http://localhost:4310, with the built-in simulator
npm run start:live # no simulator, waits for the real device
```

## Three roles, three places

The demo keeps the three actors apart so nobody mistakes the screen for the system:

- **Dashboard** (`/`): read-only. It listens on `/events`, has no buttons that change anything and sends nothing. The strip along the bottom shows who is doing what: attacker, vendor control system, edge device, this screen.
- **Attacker console** (`/attacker`): the only page that starts attacks. Open it on a different device, ideally a visitor's phone; the server prints the LAN address at start-up. The dashboard shows the address the attack came from. Reset and the lab-fault buttons sit under "Demo operator" on the same page.
- **Edge device**: the real one POSTs to `/ingest`. Until it is connected, `simulator.js` stands in for it and the dashboard labels it "(simulated)".

## Hosting on Cloudflare

`worker/index.js` runs the same dashboard as a Worker plus one Durable Object (state is in memory; the simulator only ticks while a browser is connected).

```bash
npx wrangler login
npm run deploy
```

Optional settings: `npx wrangler secret put INGEST_TOKEN` to protect `/ingest`, and a `SIM` variable set to `0` to turn the simulator off.

## Data contract

The edge device POSTs JSON to `/ingest` (set `INGEST_TOKEN` to require `Authorization: Bearer <token>`).

```json
{
  "device_id": "edge-01",
  "ts": 1794670000000,
  "readings": [
    { "unit_id": "FZ-01", "temp_c": -17.9, "reported_temp_c": -18.0, "setpoint_c": -18, "power_w": 380, "compressor_on": true }
  ],
  "faults": [
    { "unit_id": "FZ-01", "type": "sensor_spoofing", "status": "active", "severity": "critical",
      "confidence": 0.97, "message": "Controller reports -18.0 °C but probe reads -9.4 °C", "sms_sent": true }
  ]
}
```

- Only `unit_id` and `temp_c` are required per reading. `reported_temp_c` is what the vendor controller claims.
- A fault stays active until the device sends the same `unit_id` + `type` with `"status": "cleared"`.
- `severity`: `warning` or `critical`. Any `type` string works.
- If the real device uses other field names, adapt `ingest()` in `server.js`; it is the only place that reads the payload.

## Edge ML model (hackJunction2026)

`edge/ml_bridge.py` connects the LightGBM models in the `hackJunction2026` repo to this dashboard. It imports that repo's `demo_gui/inference.py` as it is, replays a recorded CSV through the binary and fault-type models, and POSTs the result to `/ingest`. Nothing in the ML repo is changed. It expects the two repos side by side; otherwise set `ML_REPO`.

```bash
uv venv edge/.venv
uv pip install --python edge/.venv/bin/python -r edge/requirements.txt
npm start        # dashboard, in one terminal
npm run ml       # bridge, in another: the lab-fault buttons on /attacker choose the fault
```

With no recordings named, the bridge plays `BaselineTestE` and the attacker console (`/attacker`, under "Demo operator") shows the six lab faults. A button switches the replay to that fault's recording at the same time of day; the models then have to detect it (about 10 s at the default speed). **Clear fault** switches back to the baseline. The requested fault travels in the response to the bridge's own POST, so the bridge still accepts no inbound connections. Run only one bridge per dashboard.

A fixed playlist is also possible: `npm run ml -- BaselineTestE Fault1_DisplayCaseDoorOpen --minutes 40 --loop`.

- The lab rig has one freezer case, one chilled case and a shared gas cooler, so the bridge drives two units: `FZ-01` and `CH-01` (`--lt-unit`, `--mt-unit`). The simulator keeps the other units and takes these two back 10 s after the bridge stops.
- The models work in degrees Fahrenheit and the bridge converts to Celsius for the dashboard. The unit temperature shown is the case supply air.
- `--speed 60` (default) plays one recorded minute per second. `--url` or `TWIN_URL` points it at a hosted dashboard, with `INGEST_TOKEN` if one is set.
- An alert is shown after `--confirm` consecutive minutes over the model's threshold (default 10), because the saved threshold also flags short runs of normal minutes. It clears once at least 80% of the last `--confirm` minutes are under it.
- Of the baseline recordings only `BaselineTestE` stays quiet with the saved threshold, and only after its first 2.5 hours, so replays start at 03:00 (`--start 180`). A to D score above the threshold for much or all of the day.
- Scored recordings are cached in `edge/.cache` and rebuilt when a CSV or model file changes.
- A reading may carry an optional `ml` object (anomaly score, threshold, fault label, air temperatures, recording), which the unit panel shows in place of the power chart. A fault may carry `model`, shown as a chip.

## Files

- `store-layout.json`: units, positions, thresholds, stock value. Unit ids must match what the device sends.
- `simulator.js`: fake edge device plus attack scenarios (demo only).
- `edge/ml_bridge.py`: replays the ML repo's recordings through its models into `/ingest`.
- `public/scene.js`: the 3D store. `public/app.js`: who-does-what strip, incidents, charts.
- `public/attacker.html`, `public/attacker.js`: attacker console. `public/attacks.js`: scenario list shared by both pages.
- `public/circuit.js`: circuit overlay shown when a unit is selected. A simplified schematic of the shared CO₂ rack, redrawn after Fig. 1 of Sun et al. (2021), with each active fault pinned to its component (`WHERE` maps fault types to components). Freezers sit on the low-temperature branch; chillers and pharmacy fridges on the medium-temperature branch.

## License

MIT, see [LICENSE](LICENSE).
