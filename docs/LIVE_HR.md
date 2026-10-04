# Live heart rate from the Amazfit Helio Strap

**Path:** Helio Strap (Bluetooth LE Heart Rate Service 0x180D / measurement 0x2A37) → `engine/hr_bridge.py` (Python, bleak)
→ `POST /hr` → live calibration in the engine → the web polls `GET /live/state`.

The Live roster and Athlete twin then show the strap's HR and the engine's re-forecast for the mapped athlete, labelled
**"live · Amazfit Helio Strap"**.

With no live session receiving, the web falls back to the HR replay:
- the newest real `fixtures/hr_<date>.csv`, labelled **"replay · <date> · <device>"**;
- or, only if no real recording exists, the synthetic file, labelled **"replay · synthetic HR file (not a real athlete)"**.

The Python bridge is the supported path. The web app has no Bluetooth pairing button.

## Steps

1. **Strap.** Put the Helio Strap on and wake it, so it's on skin and blinking. Then:
   - in the Zepp app open the strap's settings and turn **Heart Rate Push ON**, so the strap advertises the standard BLE Heart Rate Service;
   - keep the phone's Zepp app from holding the connection: close Zepp, or turn the phone's Bluetooth off once push is on. A BLE strap usually serves one central at a time.
2. **macOS Bluetooth permission for your terminal** (once). Open System Settings → Privacy & Security → **Bluetooth** and allow the app you run the bridge from (Terminal, iTerm, VS Code…). Without it, CoreBluetooth kills the process on the first scan with SIGABRT, exit code 134.
3. **Start the engine and the web app** (engine on `HEATTWIN_PORT`, default 8010; web on http://localhost:5173). Use live weather, because a live session runs at the current time and the pinned demo forecast only covers the demo day:
   ```bash
   HEATTWIN_WEATHER=live make dev
   ```
4. **Start a live session, with the plan clock set to now:**
   ```bash
   curl -s -X POST localhost:8010/live/start -H 'content-type: application/json' -d '{"start_now": true}'
   ```
5. **Find the strap:**
   ```bash
   python -m engine.hr_bridge --scan
   ```
   It lists nearby devices advertising 0x180D, with name and address.
6. **Map it to an athlete and stream.** a07 is the roster id the demo watches:
   ```bash
   python -m engine.hr_bridge --map a07=Helio
   ```
   `Helio` is a name substring; an address also works: `--map a07=C8:12:34:56:78:9A`. The bridge:
   - posts every reading to `http://localhost:$HEATTWIN_PORT/hr`;
   - reconnects with backoff after drop-outs;
   - records to `fixtures/hr_<date>.csv`. That recording becomes the default replay afterwards.
7. **Check:**
   ```bash
   curl -s localhost:8010/live/state
   ```
   You should see `receiving: true`, `athletes.a07.hr_bpm`, and `device: "Amazfit Helio Strap"`. Then open the Live roster in the web app.

## Rehearse without the strap
```bash
curl -s -X POST localhost:8010/live/start -H 'content-type: application/json' -d '{"start_now": true}'
python -m engine.hr_bridge --replay fixtures/hr_a07_synthetic.csv --speed 1 --live-clock
```
`--live-clock` stamps each replayed reading with the current time, so the live view behaves as with a strap. The readings stay labelled `replay (hr_bridge) · <device>`, never "live".

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bridge exits with code 134 / "abort" on `--scan` | The terminal app has no Bluetooth permission (step 2). Grant it and restart the terminal. |
| `--scan` lists nothing | Heart Rate Push is off, the strap is asleep or not on skin, or the phone still holds the connection (step 1). Move within a few metres. |
| Found, but no readings | The phone reconnected; close Zepp. Check `sensor_contact` in `fixtures/hr_<date>.csv`: `false` means poor skin contact, so wet the electrodes. |
| `POST /hr` 404 "athlete … is not on this session's roster" | The `--map` id isn't in the roster. Use an id from `fixtures/roster.json`. |
| `/live/state` → `active: false` | No live session: run step 4 (again after every engine restart). |
| `/live/state` → `receiving: false` | No reading newer than `constants.live_hr.stale_after_s`; check the bridge output. |
| Live label says "nearest hours used" | The forecast doesn't cover the current time. Start the engine with `HEATTWIN_WEATHER=live` (step 3). |
| HR shows, gate says "not enough data" | Expected for the first minutes: calibration updates every `calibration.update_interval_s` and needs coverage before it flags. |

## Privacy
Recordings hold a person's heart rate keyed by athlete id. Get consent before committing a `fixtures/hr_<date>.csv`. The
engine never shows a real recording without labelling its date and device.
