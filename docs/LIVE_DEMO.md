# Live demo: your strap, your profile, jumping jacks

The strap on your chest streams heart rate (HR) to the engine. The engine reads your HR against the plan's conditioning
drill ("live demo · conditioning") and recalibrates every minute. It then re-forecasts the rest of practice for you. When
the re-forecast crosses the planning line, the app shows the amber heads-up and a suggested change for **you only**: at
most 2 changes, found in well under 3 s, every sentence through the guard. **Apply** puts the change into the plan view
and the live session.

Everything is an estimate for planning. Nothing here diagnoses, and nothing says anyone is OK.

## Once, before the demo

1. **Your profile.** Fill in every `null` in `profiles/local/anson.json`:
   - `height_m`, `mass_kg`, `age_yr`;
   - `sex` ("male" or "female"; the physiology model needs it);
   - `hr_rest_bpm`;
   - `acclimatization_day` (14 or more = fully acclimatized).

   The folder is git-ignored, so it never goes into the repo. Until the profile is complete, the engine uses the
   fictional "Demo athlete (live)" and says so in the labels.
2. **Strap.** In the Zepp app, open the Helio Strap's settings and turn on **Heart Rate Push**. Then close Zepp, or turn
   the phone's Bluetooth off, so the laptop can hold the connection.
3. **iTerm Bluetooth permission.** System Settings → Privacy & Security → **Bluetooth** → allow **iTerm**, then restart
   iTerm. Without it the bridge dies with exit code 134 on its first scan.

## Demo time (about 12:15)

```bash
make dev
```
The engine is on :8010 and the web app on http://localhost:5173. No API keys are needed: paid APIs are off by default
(`HEATTWIN_DISABLE_PAID_APIS=1`). The web shows the engine's numbers only.

1. In the web app, stay on the **default practice plan**. Don't Optimize first: the live athlete's re-forecast needs
   room to cross the line.
2. Start the live session with you on the roster:
   ```bash
   curl -s -X POST localhost:8010/live/start -H 'content-type: application/json' -d '{"profile": true, "start_now": true}'
   ```
   - The plan clock starts now.
   - You join the roster as `live1`, with the name in your local profile.
   - Your HR is read against "Conditioning (gassers)".
   - Weather is live NWS when reachable. Otherwise it's the pinned demo forecast shifted to now, labelled "forecast
     snapshot (time-shifted)". The field sensor joins this chain once the Arduino work is on main.
3. Stream the strap to you:
   ```bash
   python -m engine.hr_bridge --map live1=Helio
   ```
4. Check: `curl -s localhost:8010/live/state` shows `athletes.live1.hr_bpm` and `receiving: true`. In the web app, the
   Live roster has your row, and the footer reads "live · Amazfit Helio Strap · live demo · conditioning".

### What happens, and when
- **Standing:** the gate says "HR looks like rest — not read against the live-demo drill". Standing isn't evidence that
  you're on the drill, so it isn't used.
- **Jumping jacks:** calibration updates once a minute on the last minute of HR. The first update after your HR rises is
  the first informative one, and the gate then judges the re-forecast.
- **Re-forecast crosses the line:** your row turns amber ("Re-forecast crosses the planning line at N′"). The Live roster
  shows **Heads-up · suggested for <your name>**, with the change, the engine's before → after peak, and **Apply**. The same
  suggestion sits under the amber pill on your Athlete twin.
- **Apply:** the live session keeps your calibration and runs the changed plan. The plan view lands it as an edit (Undo
  works). If the change brings you under the line, the heads-up clears.

**Rehearsal timeline** (measured Oct 4, 02:0x. Synthetic file, real time, fictional profile, `hr_bridge --replay
--live-clock --speed 1`):

| t | What happened |
|---|---|
| 0 s | Session starts; standing at about 82 bpm |
| 61 s, 123 s | Both windows skipped: "HR looks like rest" |
| 120 s | HR starts rising (about 162 bpm by 160 s) |
| 182 s | First informative window: met_scale 0.98 → 0.75; re-forecast peak 39.42 °C, crosses at minute 72 → amber heads-up and the suggestion ("rest in the shade for the first 4 min of 'Team period'; helmet + shoulder pads for 'Team period'", 39.42 → 38.79 °C, under the line) in the same poll |

HR rise → heads-up + suggestion: **about 62 s**. The suggestion search takes about 0.07 s; the cap is 3 s. Apply →
the session re-forecasts at the promised 38.79 °C and the heads-up clears.

### Honest notes
- Jumping jacks are read as the conditioning drill (max effort, 11 MET). Below your modelled HR for that effort,
  met_scale goes **under 1** (you're working less than modelled). Above your modelled ceiling it is held. The crossing
  comes from the plan's heat for your profile. Live HR is what lets the engine raise it: no warning until your HR shows
  you're working.
- The model was built for high-school athletes; an adult profile is an extrapolation.
- The suggestion is a suggestion. The coach decides; nothing changes until Apply.

## Rehearse without the strap
```bash
curl -s -X POST localhost:8010/live/start -H 'content-type: application/json' -d '{"profile": true, "start_now": true}'
python -m engine.hr_bridge --replay fixtures/hr_live1_jumping_jacks_synthetic.csv --speed 1 --live-clock
```
The file is synthetic (`fixtures/build_live_demo_hr.py`): 2 min standing at about 82 bpm, a 40 s ramp to about 162 bpm,
then 4 min of jumping jacks. Readings stay labelled `replay (hr_bridge) · synthetic rehearsal`, never live.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `/hr` 404 "athlete live1 is not on this session's roster" | Start the session with `"profile": true` (step 2), again after every engine restart. |
| Labels say "local profile anson.json incomplete" | Fill in every `null` in `profiles/local/anson.json`, then start the session again. |
| Bridge exits with 134 | iTerm has no Bluetooth permission (setup step 3). |
| `--scan` finds nothing | Heart Rate Push is off, the strap is asleep, or the phone holds it (setup step 2). |
| Gate stays "HR looks like rest" | Keep moving. Windows that look like rest aren't read against the conditioning drill. |
| Gate says "HR at or above the model's ceiling — calibration held" | Your HR is above what the model allows you at max effort; met_scale is held (it can't fall). |
| No suggestion while amber | No change within 2 edits lowers your re-forecast, or no block is left in the plan. The heads-up still shows. |
| Live roster says live HR runs "on another plan" | The plan on screen differs from the session's. Reset to the default plan, or start the session again. |

## 60-second script (say it while doing jumping jacks)
> "This strap is streaming my heart rate to HeatTwin right now. It knows my size, my age and my resting heart rate, and
> it's reading me against today's conditioning drill. Standing still doesn't count, so the gate says I look at rest.
> *(start jumping jacks)* Now I'm working. Every minute it recalibrates how hard my body is working and re-forecasts
> the rest of practice for me. *(about a minute in)* There's the amber heads-up: my re-forecast crosses the planning
> line. It's an estimate for planning, not a diagnosis. And it already has a change for me only, found in a fraction of
> a second: rest in the shade at the start of the next block. The coach decides. Apply. The plan updates, the
> re-forecast drops under the line, and the heads-up clears. If anyone actually collapses, it's the emergency action
> plan and the Collapse screen: cool first, transport second."
