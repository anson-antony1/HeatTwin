# Coach plan entry by voice or text (Gemini bridge)

The coach says or types today's practice → Gemini returns a **draft** `PracticePlan` (CONTRACTS.md shape) → the
coach reviews and confirms → the app sends `plan` to `/simulate` or `/optimize` as usual.

One model handles both speech and structuring: Gemini takes the audio directly and returns the transcript and the
drills in one call (~3–4 s). No separate speech-to-text model is needed.

**Cost:** default model `gemini-3.1-flash-lite`, about **$0.0015 per call** (measured: ~1,000 input tokens for a 22 s
clip incl. 540 audio tokens, ~650 output; prices from ai.google.dev/gemini-api/docs/pricing on 2026-10-03). Output is
capped at 2,048 tokens and recordings at 3 min, so one call stays under ~$0.005. `gemini-3.8-flash` gave identical
drills on the same tests at ~$0.006/call; set `GEMINI_MODEL` to switch.

```
browser mic ─MediaRecorder─▶ toWav() 16 kHz mono ─▶ POST /plan/parse_audio ─▶ engine/llm_plan.py ─▶ Gemini
typed text ───────────────────────────────────────▶ POST /plan/parse ─────────┘        (JSON schema-constrained)
                                       ◀── PlanDraft {plan, transcript, assumptions, unclear, labels} ──┘
```

## Setup (engine machine only)
```bash
cp .env.example .env        # then paste the key: GEMINI_API_KEY=...
uvicorn engine.api:app --reload --port 8000
curl localhost:8000/plan/llm_status     # → {"configured": true, ...}
```
`.env` is gitignored. The key never goes to the browser; the web app only talks to the engine.

## Web: drop-in files
| File | What it gives you |
|---|---|
| `web/src/data/llmPlan.ts` | `parsePlanText(text)`, `parsePlanAudio(wavBlob)`, `llmStatus()`, types (`PlanDraft`, `PracticePlan`, `ContractDrill`), `toUiDrills(plan, metFor)` to map into the current UI `Drill` shape |
| `web/src/lib/useVoicePlan.ts` | `useVoicePlan()` hook: `start()`, `stop()`, `submitText(text)`, `state` (`idle/recording/processing/done/error`), `seconds`, `draft`, `error`, `reset()` |

Engine URL: `VITE_ENGINE_URL` (default `http://localhost:8000`). Microphone needs https or localhost.

Minimal component:
```tsx
const v = useVoicePlan()               // optional: useVoicePlan({ date: '2026-10-04' })
<button onClick={v.recording ? v.stop : v.start}>{v.recording ? `Stop (${v.seconds}s)` : '🎙 Describe practice'}</button>
{v.state === 'processing' && <p>Building the plan…</p>}
{v.error && <p role="alert">{v.error}</p>}
{v.draft && (
  <section>
    <small>{v.draft.labels[0]}</small>
    <blockquote>{v.draft.transcript}</blockquote>
    <ol>{v.draft.plan.drills.map(d => <li key={d.id}>{d.name} · {d.duration_min} min · {d.gear}</li>)}</ol>
    {v.draft.assumptions.map(a => <p key={a}>Check: {a}</p>)}
    {v.draft.unclear.map(u => <p key={u}>Needs input: {u}</p>)}
    <button onClick={() => confirmPlan(v.draft!.plan)}>Looks right</button>
  </section>
)}
```

## UI rules (from CLAUDE.md / PLAN.md)
- Always show the draft and require the coach to confirm; show `labels[0]` ("parsed by AI … coach must confirm").
- Show `transcript` so a mishearing is visible, `assumptions` as things to check, `unclear` as things to fill in.
  Drills with no stated duration are **left out** of `plan.drills` and named in `unclear`.
- The AI only structures the coach's words. It doesn't add or reorder drills or comment on heat or safety. Heat
  estimates come from the engine. Generated sentences pass `engine/guard.py`.
- Keep the text box: sidelines are loud, and typing is the fallback.

## Errors
`503` no key on the engine · `502` Gemini failed or timed out (retry or type it) · `422` bad input (non-WAV audio, empty).

## Tested
- `engine/tests/test_llm_plan.py`: 11 tests with Gemini mocked (contract shape, ids, guard, routes, errors).
- Model comparison 2026-10-03: `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` returned identical
  drills for the typed and spoken test cases; flash-lite was fastest (~3–3.5 s) and cheapest.
- Live, 2026-10-03, `gemini-3.8-flash`: typed description → 7 drills, 6.9 s. A 22 s spoken description (generated
  with Gemini TTS) → verbatim transcript and 5 correct drills (gear, priority and must-keep/optional all right), 5.3 s.
- Web files type-check under the app's `tsconfig.app.json` (checked against `main`). Not yet run in a browser.
