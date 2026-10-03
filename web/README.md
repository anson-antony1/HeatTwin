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

The floating **Replay** bar runs the session at 1×/4×/10× (practice minutes per real second). **Skip to heat** jumps to just before the demo lineman crosses the line.

## Where the engine plugs in

Everything under `src/data/` is a stand-in that matches the shapes the UI needs:

- `types.ts` — data contracts. Align these with `CONTRACTS.md` when it lands.
- `constants.ts` — thresholds and FHSAA zones. **Placeholders:** verify against `engine/constants.yaml` and FHSAA policy.
- `model.ts` — a single-node heat balance tuned by eye. Replace `simulate()` with `/simulate`.
- `optimizer.ts` — a greedy pass. Replace `optimize()` with `/optimize`.
- `engine.ts` — the live loop: fake HR → estimate corrected each minute → re-forecast. Replace `advanceMinute()` with a websocket / Web Bluetooth feed.
- `fixtures.ts` — fictional roster, plan, and forecast.

## Motion system

These follow the repo's animation skills (`emil-design-eng`, `apple-design`, `animate`, `review-animations`):

- Tokens live in `styles/tokens.css` and `lib/motion.ts`: strong ease-out / ease-in-out curves and critically damped springs. Bounce is reserved for gestures that carry momentum.
- **Motion blur** (`lib/useMotionBlur.tsx`): a directional SVG blur driven by spring velocity. It's on the rolling digits and the sidebar indicator, and it switches off entirely at rest.
- **Splines** (`lib/spline.ts`): every temperature curve is Catmull-Rom → cubic Bézier.
- Animations use transform, opacity, and clip-path only. Hover motion is gated by `(hover: hover) and (pointer: fine)`. `prefers-reduced-motion`, `prefers-reduced-transparency`, and `prefers-contrast` are all handled.
- Data people are reading never moves for style. Rows re-rank only when a status changes, and live values roll in place.
