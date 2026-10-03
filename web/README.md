# HeatTwin — web app

React + Vite + TypeScript, with [Motion](https://motion.dev) for springs and layout animation.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build
npm run lint
```

## Screens

| Sidebar | What it is | Figma |
| --- | --- | --- |
| **Live roster** | Coach dashboard. Session header (drill, break countdown, FHSAA zone), one row per athlete with HR, estimated core temp, a spline forecast, and status. When someone crosses the alert line, the header splits into an alert card + "do this now" guidance, the row turns red and rises to the top, and the background warms. | `4:9` and `5:29` |
| **Practice plan** | Today's drills, WBGT by hour, and a per-athlete heat strip. **Optimize** reorders, inserts breaks, drops pads, and trims to the zone limit. The drills reflow and the strip sweeps red → green. **Use for today** sends the new plan to the live session. | — |
| **Athlete twin** | One athlete's view: a thermal body figure driven by estimated core temp, vitals, next water break, and the full-session forecast with a p95 band. | `5:45` |
| **Response** | Pre-practice readiness checklist and a one-tap way into Collapse mode. | — |
| **Collapse mode** | Full-screen cold-water-immersion flow: wall-clock timer, voice-guided steps, tub probe, immersion timer, and a copyable EMS handoff timeline. Ending it takes a hold, so it can't be closed by accident. | — |

### Kelvin, the voice assistant (voice → plan → engine)

The assistant's name lives in `src/lib/brand.ts`.

The mic dock at the bottom left (Figma `9:65`) is the coach's way in:

1. **Record.** Tap the mic and describe practice. You get a live waveform, plus instant captions from the browser's speech recognizer (Chrome, Edge and Safari), for display only.
2. **Transcribe and structure.** The audio goes to the engine's `POST /plan/parse_audio` (Jack's Gemini bridge, `engine/llm_plan.py`). Gemini returns the verbatim transcript and a draft `PracticePlan`. The keyboard button sends typed text to `/plan/parse` instead.
3. **Confirm.** The coach checks the drills, the AI's assumptions, and anything unclear. Nothing is modelled until they confirm.
4. **Model.** `POST /simulate` runs the engine's two-node model for every athlete. The result drives the live roster, each athlete's twin page (the *Today's plan* card shows their gear and their p95 peak per block), and the session header.
5. **Optimize** (optional). `POST /optimize` rewrites the plan to keep everyone under the line, and the dock shows the engine's top changes.

The confirmed plan is saved in `localStorage`, so a reload keeps it.

**Memory.** Every request sends the plan in use as `current_plan`. Gemini then edits that plan instead of starting over. For example, "add a 20 minute session at the end for jumping jacks" keeps every other drill and appends one, and the draft lists `changes`. A full new description still replaces the plan. *Start a new plan* in the sheet clears it.

**Practice plan tab.** Click any block to see its details: time, gear, the hottest athletes in that block, and FHSAA issues. **Edit** (left of *Optimize plan*) opens a timeline editor where you drag blocks to reorder, drag a block's right edge to trim it, double-click a block to rename it, and use the inspector for intensity, gear, priority, break and shade. ⌘Z undoes. *Save & model* runs the edited plan through `/simulate`.

**Athlete twin chart.** Hover or drag across it to scrub; the body figure and the big number follow the scrubbed minute. Zoom to 1×, 2× or 4× and pan with the overview strip or a horizontal scroll.

**Setup:** the Gemini key lives only on the engine, in the repo-root `.env` (gitignored; see `.env.example`). Run the engine with `.venv/bin/uvicorn engine.api:app --port 8000`. The web app calls `VITE_ENGINE_URL`, which defaults to `http://localhost:8000`.

The floating **Replay** bar runs the session at 1×/4×/10× (practice minutes per real second). **Skip to heat** jumps to just before the demo lineman crosses the line.

## Where the engine plugs in

Everything under `src/data/` is a stand-in that matches the shapes the UI needs:

- `types.ts` — data contracts. Align these with `CONTRACTS.md` when it lands.
- `constants.ts` — thresholds and FHSAA zones. **Placeholders:** verify against `engine/constants.yaml` and FHSAA policy.
- `model.ts` — a single-node heat balance tuned by eye. Replace `simulate()` with `/simulate`.
- `optimizer.ts` — a greedy pass. Replace `optimize()` with `/optimize`.
- `engine.ts` — the live loop: fake HR → estimate corrected each minute → re-forecast. Replace `advanceMinute()` with a websocket / Web Bluetooth feed.
- `fixtures.ts` — reads the engine's shared `fixtures/roster.json` and `fixtures/plan.json`, so athlete ids match the engine.
- `engineApi.ts` — typed `/simulate` and `/optimize` client. `planStore.ts` holds the confirmed plan and its engine result.
- `llmPlan.ts`, `lib/useVoicePlan.ts` — Jack's Gemini bridge client and recorder hook (from `llm-bridge`).

## Motion system

These follow the repo's animation skills (`emil-design-eng`, `apple-design`, `animate`, `review-animations`):

- Tokens live in `styles/tokens.css` and `lib/motion.ts`: strong ease-out / ease-in-out curves and critically damped springs. Bounce is reserved for gestures that carry momentum.
- **Motion blur** (`lib/useMotionBlur.tsx`): a directional SVG blur driven by spring velocity. It's on the rolling digits and the sidebar indicator, and it switches off entirely at rest.
- **Splines** (`lib/spline.ts`): every temperature curve is Catmull-Rom → cubic Bézier.
- Animations use transform, opacity, and clip-path only. Hover motion is gated by `(hover: hover) and (pointer: fine)`. `prefers-reduced-motion`, `prefers-reduced-transparency`, and `prefers-contrast` are all handled.
- Data people are reading never moves for style. Rows re-rank only when a status changes, and live values roll in place.
