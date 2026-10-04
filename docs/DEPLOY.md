# Deploying HeatTwin on Render (prepared, not deployed)

Nothing here has been deployed. `render.yaml` (repo root) is a Blueprint for two free services. Every command below was
run locally, from a fresh clone of this branch and a throwaway venv (results at the end).

| Service | Type | What it is |
|---|---|---|
| `heattwin-engine` | free web service, Python | FastAPI engine (`engine/api.py`), health check `/health` |
| `heattwin-web` | free static site | React + Vite build (`web/dist`), calls the engine at `VITE_ENGINE_URL` |

No API key goes anywhere. The engine runs with the paid-API kill switch on (no Gemini, no ElevenLabs: coach text entry
falls back to the local rules, voice to the browser's speech), no USB sensor bridge, the pinned demo forecast and the
labelled synthetic HR replay.

## Engine service

Run from the repo root (Render: no root directory).

```bash
# build (once per deploy; ~5 min here, mostly the optimizer search, see "Cold start")
pip install --upgrade pip && pip install -r requirements.txt && python scripts/fetch_fastembed_model.py && python scripts/warm_build.py
# start
uvicorn engine.api:app --host 0.0.0.0 --port $PORT
```

- `requirements.txt`: runtime deps only, pinned from the project venv (fastapi, uvicorn, pydantic, numpy, numba, pyyaml,
  requests, httpx, fastembed + their pinned closure). Not on the server: pytest, pythermalcomfort (JOS-3 cross-check
  only), scipy (never imported), bleak and pyserial (laptop bridges; the engine starts without them, checked).
  Resolved for Linux x86_64 and arm64, CPython 3.11, wheels only (`uv pip install --dry-run --only-binary :all:`).
- `scripts/fetch_fastembed_model.py`: downloads `FASTEMBED_MODEL` into `FASTEMBED_CACHE_DIR` (64 MB, ~5 s) and proves it
  loads from that directory alone. At run time fastembed finds the files there and does not touch the network.
- `scripts/warm_build.py`: fills the on-disk demo cache (below) and compiles the numba kernel into
  `engine/physio/__pycache__`. It exits 1 if a cold-started engine would not answer from the cache.

| Env var (engine) | Value | Why |
|---|---|---|
| `PYTHON_VERSION` | `3.11.11` | Render needs the full x.y.z. The pins and the tests are on 3.11. |
| `HEATTWIN_DISABLE_PAID_APIS` | `1` | Kill switch ON (`engine/paid_api.py`). Also the engine's default; set explicitly. `/health` reports the counter. |
| `HEATTWIN_NODE` | `off` | No USB on Render: skips the Arduino bridge. |
| `HEATTWIN_CORS_ORIGINS` | `https://heattwin-web.onrender.com` | The static site's origin (scheme + host, no path or trailing slash). Comma-separate several; `*` allows any. Unset = today's `http://localhost:5173,http://127.0.0.1:5173`. |
| `HEATTWIN_PROFILE` | `demo` | The live-demo athlete is always the fictional "Demo athlete (live)" (`fixtures/profiles/demo_athlete_live.json`, synthetic). `engine/profiles.py`; personal profiles live only in git-ignored `profiles/local/` on the laptop. |
| `HEATTWIN_INTEGRATOR` | `auto` | `auto` = numba kernel (what the pinned numbers come from). `numpy` = never import numba; see "Memory". `warm_build.py` always uses numba. |
| `FASTEMBED_MODEL` | `BAAI/bge-small-en-v1.5` | Embedding model for `engine/decide.py` (another workstream). |
| `FASTEMBED_CACHE_DIR` | `.cache/fastembed` | Inside the project dir, so the build's download survives to run time. Relative to the repo root, where both commands run. |
| `PORT` | set by Render | Used by the start command. Do not set it. |

Deliberately not set: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `ELEVENLABS_API_KEY` (never on a hosted demo),
`HEATTWIN_WEATHER` (stays on the cached forecast; `?demo=1` never uses live NWS anyway), `HEATTWIN_CACHE_DIR` (default
`.cache/demo` inside the project dir; it must stay there or the build's cache is lost).

## Static site

```bash
cd web && npm ci && npm run build      # tsc -b && vite build; publish directory: web/dist
```

| Setting | Value |
|---|---|
| Publish path | `web/dist` |
| Rewrite | `/*` to `/index.html` (single-page app) |
| `NODE_VERSION` | `22.21.0` (what it was built with here) |
| `VITE_ENGINE_URL` | `https://heattwin-engine.onrender.com`, no trailing slash. Read by `web/src/data/engineApi.ts` and `llmPlan.ts`; baked in at build time, so change it, then redeploy the site. Unset (dev) = the Vite proxy `/engine`, which does not exist on a static host. |

The web build imports `../fixtures` from the repo root, so build from the repo root as above, not with a root directory.

If Render appends a suffix to a service name (name taken), edit `HEATTWIN_CORS_ORIGINS` and `VITE_ENGINE_URL` to the real
URLs; the symptom of a mismatch is a CORS error in the browser console and an empty Plan screen.

## Cold start

1. **Build (once per deploy).** `warm_build.py` runs, in-process, the demo calls the web makes: `/simulate?demo=1`,
   `/optimize?demo=1` for both presets, `/live/replay?demo=1`, `/demo/comparison`. The two optimizer searches take the
   time they take (98 s + 121 s on an M-series laptop; a Render build machine may differ) and are written to
   `.cache/demo/*.json`, keyed by inputs plus a hash of the engine code (`engine/demo_cache.py`). It then empties the
   in-process caches and re-asks, as after a restart.
2. **Start.** `import engine.api` takes 0.5 s here (numba loads at the first simulate, not at start). `/optimize?demo=1`
   answers from disk (8 ms and 3 ms measured on a freshly started engine); the first `/simulate` loads the numba kernel
   from the build's cache (0.5 s).
   The first `/live/replay` per process recomputes (1.4 s here; not disk-cached).
3. **Free-tier sleep.** Render spins a free service down after about 15 minutes idle and starts it again on the next
   request (about a minute, per Render's docs); a restart returns to step 2, not to a search. Open the site once before a
   demo. The engine's in-memory state (live sessions) is lost on sleep.

Limits to know:
- **An edited plan (voice or plan editor) is not in the cache.** `?demo=1` then runs the full search, which the
  iteration caps end: about 100–120 s per preset on an unloaded laptop, much longer on a 0.1 vCPU free instance (the
  web gives up after 60 s). `constants.yaml: demo_mode.hard_stop_s` is only a runaway guard. On the hosted demo, show
  the pinned plan; simulating an edited plan is fast.
- **The cache key hashes the engine source**, so build and start must run from the same checkout (Render does this) and
  with the same env (a different `HEATTWIN_PROFILE` is a different key).
- **Machine differences.** Until Oct 4 the demo search also stopped on a clock (a 120 s budget), so a slow or busy
  machine could land on a different plan. That, not the integrator, was the cause of the earlier 70.7 % (the numpy
  path is slower, so its searches were cut short; with no clock it reproduces 72.9 %). The demo search is now ended by
  its iteration caps alone, and `search.cut_short` plus a label say if the runaway guard ever ends it.
  `warm_build.py` prints whether the warmed headline numbers match `docs/demo_numbers.json` ("match" here). If it
  prints WARNING on Render, the numbers are still valid, labelled estimates but differ from the slides. To pin the laptop's numbers instead: on the laptop run
  `HEATTWIN_CACHE_DIR=deploy/demo_cache python scripts/warm_build.py`, commit `deploy/demo_cache/*.json` after code
  freeze (any engine change invalidates them), and set `HEATTWIN_CACHE_DIR=deploy/demo_cache` on the engine service. The
  build then finds the entries and takes seconds (checked locally with a copied cache).

## Memory (512 MB free tier)

`ps -o rss`, macOS arm64, CPython 3.11, numba 0.68 (Linux RSS differs somewhat; check Render's Metrics tab).

| Moment | RSS |
|---|---|
| uvicorn up, nothing called | 64 to 67 MB |
| after the first `/simulate`, numba cache from the build | 141 to 149 MB |
| after the first `/simulate`, numba compiling (no cache) | 226 MB; the compile took 8.1 s first time, about 3 s in a fresh clone |
| during the cold optimizer search | 222 MB peak (flat) |
| engine + fastembed model loaded and used | 318 MB (model alone: about +170 MB) |

Peak is about 320 MB, 400 MB if the numba cache is unusable and the model is loaded as well: under 512 MB, so
`HEATTWIN_INTEGRATOR=numpy` is **not needed** and stays off. It exists as a safety valve: numpy gives 77 MB engine only,
251 MB with the model, at a cost: the cold optimizer search takes 688 s instead of 113 s (6x), the first replay 7.6 s
instead of 1.4 s; under the old 120 s clock its cut-short search landed on a different plan (70.7 % vs 72.9 %). Cached demo answers are
unaffected. Numba's cache depends on the CPU: if Render's runtime CPU differs from the build's, the first `/simulate`
recompiles (about 8 s, once). Not measured: Render's 0.1 vCPU.

## What the hosted demo labels

- Forecast: "demo mode: forecast pinned to the cached NWS fixture" (`/demo/inputs` labels; `?demo=1` never goes live).
- Plan and roster: "synthetic plan (fixture)", "synthetic roster".
- Live heart rate: no Bluetooth on Render, so the web shows the replay, "replay · synthetic HR file (not a real athlete)".
- Every core-temperature number: "estimate — planning only". Guarded text only (`engine/guard.py`).

## Verify after deploy

1. `curl -s https://heattwin-engine.onrender.com/health` returns `"ok":true`, `"paid_api":{"disabled":true,"attempted":0,...}`
   (first call may take a minute while the instance wakes).
2. The first optimizer call must come from disk. Use the body the web sends (the plan from `/demo/inputs`; an empty `{}`
   body is a different cache key and would run the search):
   ```bash
   E=https://heattwin-engine.onrender.com
   curl -s $E/demo/inputs | python3 -c 'import json,sys; print(json.dumps({"plan": json.load(sys.stdin)["plan"]}))' > /tmp/plan_body.json
   curl -s -o /dev/null -w '%{time_total}s\n' -X POST "$E/optimize?demo=1&preset=max_load" -H 'content-type: application/json' -d @/tmp/plan_body.json
   ```
   Well under a second (a few seconds on the 0.1 vCPU instance is fine). About 100 s or more means the cache did not
   survive the build: look for `warm_build: after a cold start the optimizer answers from the on-disk cache` in the build log.
3. `curl -s -i -H 'Origin: https://heattwin-web.onrender.com' https://heattwin-engine.onrender.com/health | grep -i access-control-allow-origin`
   echoes that origin.
4. Open `https://heattwin-web.onrender.com`, go to Plan, press Optimize. Expect (from `docs/demo_numbers.json`):
   athletes over the line 16 to 0, hottest p95 41.65 to 38.98 deg C, FHSAA issues 2 to 0, training load kept 72.9 %.
   The same check, scripted: `PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node scripts/e2e_headline.mjs https://heattwin-web.onrender.com`.
5. Live view shows the replay label above; the weather chip says the forecast is the cached fixture.

## Local rehearsal (exactly the commands above)

Fresh clone of this branch, fresh venv (`uv venv --seed --python 3.11`), render.yaml's env vars with
`HEATTWIN_CORS_ORIGINS=http://localhost:5176` and `PORT=8013`; the build and start strings were read out of
`render.yaml` and run verbatim.

- Engine build: 4 min 39 s in total (pip install, model download 4.3 s, warm-up 223 s: simulate 3.1 s, max_load 98 s,
  fewest_changes 121 s, replay 0.7 s). "headline numbers vs docs/demo_numbers.json: match".
- Fresh `uvicorn` start: `/optimize?demo=1` 8.7 ms (max_load), 3.3 ms (fewest_changes); `scripts/warm_demo.py` passes.
- Static build with `VITE_ENGINE_URL=http://127.0.0.1:8013`, served with `npx vite preview --port 5176`:
  `scripts/e2e_headline.mjs http://localhost:5176` printed 7 of 7 "ok" against `docs/demo_numbers.json`. The Live view
  loaded with no page or console errors and showed "replay · synthetic HR file (not a real athlete)" and "estimate —
  planning only". The `curl` in "Verify" step 2 answered in 9.9 ms.
- CORS: the allowed origin is echoed on GET and on the preflight; another origin gets no `access-control-allow-origin`.
- Engine starts with pyserial, bleak, scipy and pythermalcomfort not installed, and with `HEATTWIN_NODE` unset.

Not verified: a real Render build (Linux x86_64, 0.1 vCPU, Render's Python and Node images), that Render keeps files
written during the build in the project directory at run time (documented practice; step 2 of "Verify" catches it), and
that Render's build machine reproduces the laptop's headline numbers (`warm_build.py` reports it).
