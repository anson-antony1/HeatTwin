# Live heart rate from the Amazfit Helio Strap

**Path:** Helio Strap (Bluetooth LE Heart Rate Service 0x180D / measurement 0x2A37) → `engine/hr_bridge.py` (Python, bleak)
→ `POST /hr` → live calibration in the engine → the web polls `GET /live/state`.

The Live roster and Athlete twin then show the strap's HR and the engine's re-forecast for the mapped athlete, labelled
**"live · Amazfit Helio Strap"**.

With no live session receiving, the web falls back to the HR replay of the demo plan: the synthetic file, labelled
**"replay · synthetic HR file (not a real athlete)"**.

Real recordings (`fixtures/hr_<date>.csv`) are calibration evidence, not demo-plan replays. The Oct 3 Helio recording
(rest, then burpees) is summarised in `validation/results.json` → `helio_recording` and on the Athlete twin's
"Recorded Oct 3 · Amazfit Helio Strap" panel. Projecting it onto the football plan would compare burpee heart rate
with warm-up intensity, which is how it earlier produced met_scale 1.63 and a 42.25 °C peak. A real file is replayed
only when named: `POST /live/replay {"file": "hr_<date>.csv"}`. It is then labelled **"replay · <date> · <device>"**.

The Python bridge is the supported path. The web app has no Bluetooth pairing button.

## Steps

1. **Strap.** Put the Helio Strap on and wake it, so it's on skin and blinking. Then:
   - in the Zepp app open the strap's settings and turn **Heart Rate Push ON**, so the strap advertises the standard BLE Heart Rate Service;
   - keep the phone's Zepp app from holding the connection: close Zepp, or turn the phone's Bluetooth off once push is on. A BLE strap usually serves one central at a time.
2. **macOS Bluetooth permission for your terminal** (once). Open System Settings → Privacy & Security → **Bluetooth** and allow the app you run the bridge from (Terminal, iTerm, VS Code…). Without it, CoreBluetooth kills the process on the first scan with SIGABRT, exit code 134.
3. **Start the engine and the web app** (engine on `HEATTWIN_PORT`, default 8010; web on http://localhost:5173):
   ```bash
   make dev
   ```
   A live session runs at the current time, so it chooses its own weather:
   - **live NWS** when reachable, labelled "live NWS forecast" (not written to the weather cache);
   - otherwise the **pinned demo forecast shifted to now**, so the session sees the demo afternoon's air temperature,
     humidity, wind and cloud, labelled **"forecast snapshot (time-shifted)"**. The field-card chip says the same.
     The sun angle is still computed for the real clock.

   `?demo=1` Plan and Optimize always stay on the pinned forecast.
4. **Start a live session, with the plan clock set to now and the strap wearer on the conditioning drill:**
   ```bash
   curl -s -X POST localhost:8010/live/start -H 'content-type: application/json' -d '{"start_now": true, "live_demo": {"a07": "conditioning"}}'
   ```
   `live_demo` maps the strap's athlete to the plan drill they are actually doing. Burpees match the plan's
   conditioning intensity ("Conditioning (gassers)", intensity max). Their heart rate is then read against that
   intensity, not against whatever drill the plan clock is on (at the start that's the warm-up). That keeps the
   calibration honest: a steady 165 bpm calibrates to met_scale ≈ 1.04 with the mapping, and to ≈ 3.0 without it.
   Minutes when the wearer stands or rests are skipped rather than read as conditioning: a window whose HR is nearer
   the model's resting HR than its conditioning HR teaches nothing (gate: "HR looks like rest — not read against the
   live-demo drill"). Above the model's HR ceiling for a07 (its aerobic cap, about 166 bpm at conditioning), HR can't
   say more, and the gate reads "HR at or above the model's ceiling — calibration held".
   The re-forecast still runs the practice plan as written with that calibration. Labelled **"live demo · conditioning"**
   (Live footer and demo bar: "live · Amazfit Helio Strap · live demo · conditioning"). Without `live_demo`, the
   athlete is read against the plan drill at the clock.
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
   - records to `fixtures/hr_<date>.csv`, which you can later add to the validation evidence. It does not replace the synthetic demo replay.
7. **Check:**
   ```bash
   curl -s localhost:8010/live/state
   ```
   You should see `receiving: true`, `athletes.a07.hr_bpm`, and `device: "Amazfit Helio Strap"`. Then open the Live roster in the web app.

## Rehearse without the strap
```bash
curl -s -X POST localhost:8010/live/start -H 'content-type: application/json' -d '{"start_now": true, "live_demo": {"a07": "conditioning"}}'
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
| Field card says "Forecast snapshot (time-shifted)" | NWS was unreachable at `/live/start`, so the pinned forecast was shifted to now (step 3). Restart the session when online for live NWS. |
| Live label says "nearest hours used" | The session runs past the end of the weather it has (a very late start). Restart the session earlier, or when NWS is reachable. |
| met_scale far above 1 with a steady, hard effort | The session has no `live_demo` mapping, so HR is read against the plan drill at the clock (step 4). |
| Gate says "HR looks like rest" | The wearer is standing still: rest windows aren't read against the conditioning drill. Start the burpees. |
| Gate says "calibration held" at the model's ceiling | HR is above what the model allows a07 at conditioning; met_scale stays where it is (it doesn't fall). |
| HR shows, gate says "not enough data" | Expected for the first minutes: calibration updates every `calibration.update_interval_s` and needs coverage before it flags. |

## Privacy
Recordings hold a person's heart rate keyed by athlete id. Get consent before committing a `fixtures/hr_<date>.csv`. The
engine never shows a real recording without labelling its date and device.
