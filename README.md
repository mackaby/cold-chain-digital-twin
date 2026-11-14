# Cold chain digital twin

3D dashboard for the edge AI device. Visualisation only: it receives data, it never talks back to the device.

```bash
npm install
npm start          # http://localhost:4310, with the built-in simulator
npm run start:live # no simulator, waits for the real device
```

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

## Files

- `store-layout.json`: units, positions, thresholds, stock value. Unit ids must match what the device sends.
- `simulator.js`: fake edge device plus attack scenarios (demo only).
- `public/scene.js`: the 3D store. `public/app.js`: panels, alerts, charts.
