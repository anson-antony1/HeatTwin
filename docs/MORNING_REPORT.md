# Morning report: overnight run, Oct 4

**Main is `v1.0.3`.** Every tag tonight passed all gates and a demo-qa walk, so any of them is a safe rollback:

| Tag | What |
|---|---|
| `v1.0` | polish decisions 1–6, Jack's sensor demo, paid-API kill switch |
| `v1.0.1` | + Render config, live-demo profile and suggestion, Arduino field mode, reproducible optimizer |
| `v1.0.2` | + free voice decision layer |
| `v1.0.3` | + copy says which forecast a number is (HR-calibrated vs plan), test log hygiene; **this report** |

**Paid APIs: 0 sent** all night, and no running engine attempted one (`/health` → `paid_api`). Test runs that deliberately exercise the refusal logged refused attempts (sent: false) until 04:30; tests now log to a temp file. `HEATTWIN_DISABLE_PAID_APIS=1` is the default.

## What merged
- **0. Polish:**
  - merged with Jack's push (0201857: sensor demo plus his "red when over the line now" rule);
  - red only when the p95 estimate at the current minute reaches the line (Jack's rule); the engine flag stays an amber heads-up; voice-plan's "Over the alert line";
  - → `v1.0`.
- **1. Teammates:**
  - Jack's main push was merged (above).
  - `origin/voice-plan` b6f8767 (ehanrsha, "Athletes heat up again") was **not merged**. It's written on the old voice-plan data layer, and 7 of 7 files conflict, including `model.ts`, which main deleted. The bug it fixes (a location change dropping engine curves and falling back to the browser stand-in) can't happen on main. Its feature (Plan/Optimize on the picked location's live NWS) would break "?demo=1 stays pinned". It stays on its branch.
  - No other pushes after 01:45. The fetch ran every 10–30 min.
- **2. Arduino field sensor** (`engine/field_sensor.py`, `node_autostart.py`):
  - **Hot-plug:** Arduino/CH340/FTDI/CP210x ports, rescan every 2 s, survives unplug, replug and a changed port name.
  - **Plugged in:** the reading is the field air temperature; NWS humidity, wind and sun → WBGT, labelled "Field sensor (Arduino) + NWS".
  - **Unplugged:** live NWS → time-shifted snapshot, labelled.
  - **Field card:** the chip shows the source and the reading's age.
  - **Tests:** 24 with a fake serial port.
  - **physio-reviewer fixes:**
    - dewpoint held (a warm reading no longer adds moisture);
    - a reading more than 5 °C from the forecast is not used and the label says so (an indoor bench would have lowered every estimate);
    - the sensor's offset rides the forecast trend from the reading time, and elapsed minutes are never rewritten;
    - the serial thread never blocks on NWS.
- **3. Live profile + jumping-jack demo:**
  - `profiles/local/anson.json` (git-ignored; fill it in, see below).
  - `/live/start {"profile": true, "start_now": true}` puts you on the roster on "live demo · conditioning".
  - While the gate flags, the engine keeps an athlete-only suggestion ready: ≤2 changes, about 0.07 s; rest in shade / rotate out / gear. Its numbers are checked on the whole-roster re-forecast, and every sentence is guarded.
  - It shows in the existing Heads-up card (Live roster) and the Athlete twin, with **Apply**. Apply updates the session and the plan view; Undo works.
  - It works on the HR replay too, so the demo script and Render have it.
  - Rest windows don't count as conditioning evidence.
  - docs/LIVE_DEMO.md: setup, troubleshooting, 60-second script.
- **4. Free decision layer:** `engine/decide.py`, a typed decision layer: `{choice, probabilities, confidence, abstain}`, never free text.
  - **Model:** a fastembed (ONNX, no torch) embedding classifier with a temperature-scaled softmax, fitted on held-out data.
  - **Decisions:** intent, athlete (current roster), drill (current plan), intensity, and a guard assist.
  - **Abstain:** the voice dock asks "Did you mean …?" with the top 2.
  - **Free voice path:** transcript → decide → engine → engine-written sentence → guard (rules + assist) → browser speech. Local Whisper (faster-whisper base, about 0.6 s) works as a laptop fallback; the NLI option adds nothing, so it's off. Gemini/ElevenLabs stay optional and off.
  - **Fixed tonight:** without the model, the fallback assist had redacted an engine sentence. It's now advisory only, and the model cache is shared across checkouts.
- **5. Render (prepared, not deployed):** `render.yaml` (free engine + static site), `requirements.txt`, docs/DEPLOY.md.
  - The build downloads the embedding model and warms the demo cache, so a cold start answers the headline in ~10 ms.
  - CORS comes from env; the fictional profile is used; the HR replay stands in for live HR.
  - **Memory, measured on the Mac:** 64 MB at start, about 150 MB after the first simulate, 222 MB peak cold optimizer, 318 MB with the embedding model. That fits the 512 MB tier, so the numpy integrator flag exists but is off.
  - Production build + engine start were checked locally with exactly those commands: e2e 7/7.
- **Also fixed:** the demo optimizer stopped on a 120 s clock, so a slow or busy machine could change the "pinned" plan. It now ends on its iteration caps. Verified under heavy load: same 72.9 % plan.

## Tests (final main)
- **Gates on the final candidate:** `make test` **430 engine passed (2 skipped) + 65 web passed**; `make numbers-check` OK; `make check-sources` OK; `make e2e` **7/7**.
- **Screenshots** (1280×800 and 1440×900), pixel-diffed against docs/ui_after:
  - Collapse is unchanged.
  - The Live roster has the suggestion card at open and no red alert at open.
  - The sidebar alert badge is gone at open.
  - The dock hint text changed.
  - Everything else is playhead jitter only.
- **demo-qa:** every tag passed its walk. The last full walk of your end-to-end script passed 9/9: Plan → Optimize → Athlete twin → Live (replay) → heads-up → suggestion → Apply/Undo → Skip to heat → Collapse → typed voice what-if (41.09 → 40.87 °C, equal to `/simulate`) → "Did you mean…?".
- **System checks:**
  - **Concurrency:** simulate ×2 + optimize ×2 + 90 `/hr` at once all returned 200. During an 86 s uncached optimize, `/hr` p95 was 11 ms.
  - **Restart:** engine up in 0.5 s, optimize answered from the disk cache in 9 ms.
  - **Offline:** NWS blocked → the live session uses the labelled time-shifted snapshot, `?demo=1` stays pinned, and the browser only loses Fontshare fonts.
  - **Fake-serial Arduino:** 14 tests covering plug, unplug, replug, a new port name, a silent board, unplug during a live session, the gap gate and the trend offset — all pass.
- **physio-reviewer** ran on every engine change: calibration gate and suggestion, numpy integrator, Arduino fusion. Every finding was fixed (see the merge list).

## Headline numbers (docs/demo_numbers.md, unchanged all night)
| | Before | After Optimize (max load) |
|---|---|---|
| Over the 39.0 °C line (p95) | 16 of 16 | 0 of 16 |
| Hottest p95 | 41.65 °C | 38.98 °C |
| FHSAA issues | 2 | 0 |
| Load kept / changes | — | 72.9 % / 12 |

- **First over the line:** Caleb and Isaiah at minute 46; everyone by minute 52.
- **Live-NWS comparison rows** (refreshed 07:21Z): 67.0 % / 13 changes (NWS WBGT) and 55.6 % / 21 changes (our Liljegren, zone 3).

## Live-demo timeline (real time, synthetic rehearsal file, fictional profile)
| Time | What happened |
|---|---|
| 61 s, 121 s | Standing windows skipped ("HR looks like rest") |
| 120 s | HR rise starts |
| **180 s** | Heads-up + suggestion: met_scale 0.98 → 0.88, crosses at 58′; "rotate out of 'Team period'", 40.42 → 38.25 °C, under the line |

That's **about 60 s from HR rise to suggestion**. Apply → the re-forecast matches the card, and the heads-up clears.


## Decision layer (held-out, synthetic text)
| Decision | Accuracy | ECE | Abstain |
|---|---|---|---|
| intent | 82 % | 0.088 | 25 % |
| athlete | 94 % | 0.061 | 18 % |
| drill | 97 % | 0.030 | 9 % |
| intensity (n=35) | 66 % | 0.142 | 43 % |
| guard assist | 97 % | 0.037 | 0 % |

- **Guard on held-out flags:** rules alone 56 %, assist alone 96 %, **either 100 %**, at 6 % false blocks (a blocked voice reply is held, not shown).
- The data is synthetic text (`validation/results.json["voice_decide"]`, docs/VOICE.md); there's no real-speech evaluation yet.

## Render
**Ready to deploy from main** with the Blueprint (`render.yaml`). Not deployed.

- **Engine build:**
  `pip install --upgrade pip && pip install -r requirements.txt && python scripts/fetch_fastembed_model.py && python scripts/warm_build.py`
  (about 5 min, mostly the optimizer, once).
- **Engine start:** `uvicorn engine.api:app --host 0.0.0.0 --port $PORT`; health check `/health`.
- **Engine env:**
  - `HEATTWIN_DISABLE_PAID_APIS=1`
  - `HEATTWIN_NODE=off`
  - `HEATTWIN_CORS_ORIGINS=https://heattwin-web.onrender.com`
  - `HEATTWIN_PROFILE=demo`
  - `HEATTWIN_INTEGRATOR=auto`
  - `FASTEMBED_MODEL=BAAI/bge-small-en-v1.5`
  - `FASTEMBED_CACHE_DIR=.cache/fastembed`
  - `PYTHON_VERSION=3.11.11`
- **Static site:** `cd web && npm ci && npm run build`; publish `web/dist`; rewrite `/*` → `/index.html`; `VITE_ENGINE_URL=https://heattwin-engine.onrender.com`.
- **After deploy:** if Render renames the services, update `HEATTWIN_CORS_ORIGINS` and `VITE_ENGINE_URL` to the real URLs and redeploy the static site.

## Your morning to-dos
1. **Profile.** Fill in `profiles/local/anson.json` in the checkout you demo from:
   - height_m, mass_kg, age_yr, sex, hr_rest_bpm, acclimatization_day.
   - The folder is git-ignored. Until it's complete, the fictional "Demo athlete (live)" is used and labelled.
   - The placeholder file is in `~/Developer/ht-main/profiles/local/`.
2. **Strap test with jumping jacks** (docs/LIVE_DEMO.md):
   - Zepp Heart Rate Push on, iTerm Bluetooth permission;
   - `make dev`;
   - `curl … /live/start -d '{"profile": true, "start_now": true}'`;
   - `python -m engine.hr_bridge --map live1=Helio`.
3. **Arduino outdoor run, 8–11:30:** plug in, then check the field-card chip "Field sensor + NWS · Ns ago". A reading more than 5 °C off the forecast is refused (labelled); shade the thermistor.
4. **Rehearsal:** Plan → Optimize → Athlete twin → Live (replay heads-up → suggestion → Apply) → Collapse → voice what-if.

## Known issues / not verified
- **Not tested on real hardware:** the Helio strap with your profile (my session has no Bluetooth permission), and the Arduino on a real USB unplug (CH340/FTDI).
- **Render is not deployed.** Unverified: a real build, the 0.1 vCPU timing, and whether build output persists to run time. The service URLs are guesses.
- **Voice:** no real microphone or real speech tested. The dataset is synthetic. Intent accuracy-when-answered is 87 % (target 90 %). Intensity is weak (66 %, n=35), so plan entry shows assumptions on the Confirm screen. The guard assist holds about 6 % of good replies (fail-closed).
- **Live demo honesty:** jumping jacks read as max-effort conditioning pull met_scale below 1. The heads-up comes from the plan's heat for your profile, gated by live HR. The model was built for high-school athletes, so an adult profile is an extrapolation.
- **After Apply on the HR replay**, the athlete shows the plan forecast without HR, because the replay was recorded on the default plan. The suggestion's numbers are now labelled "HR-calibrated re-forecast". The minute differs by view too: 44′ in the re-forecast vs 46′ in the plan forecast.
- **Collapse with nobody over the line** pre-selects the first athlete (Caleb).
- **Fonts** come from api.fontshare.com; offline you get system fonts and one console error.
- The live-NWS comparison rows are a 07:21Z snapshot; rerun `make numbers` before slides.
