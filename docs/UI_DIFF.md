# final-ui: screenshot comparison, docs/ui_before vs docs/ui_after

- **Before:** origin/voice-plan 46a006b ("Version 4.0") with its own engine.
- **After:** final-ui with main's engine (`?demo=1`, pinned forecast).
- **Screens:** 8 screens × 1440x900 and 1280x800, taken with `scripts/ui_screens.mjs` (fresh browser, playback paused, reduced motion).
- **Unchanged everywhere:** layout, colours, fonts, spacing, component structure and navigation. No CSS file or design token was edited.

## Differences, by kind

### 1. Numbers (expected: they now come from the engine)
- **Practice plan:** 16 over the line (was 1, from the stand-in model), hottest p95 41.65 °C, 2 FHSAA issues. After Optimize: 0 / 38.98 °C / 0 / 72.9 % kept. These match `docs/demo_numbers.json`, checked by `make e2e`.
- **Heat strip, per-athlete peaks, Live roster estimates, Athlete twin curve and block peaks:** the engine's p50/p95.
- **Field card:** 86.0 °F, Zone 2 (engine weather; was 88 °F "Red" from the browser's wrong zone table).
- **FHSAA issue chips:** the engine's violation texts.
- **Status pills:** engine statuses, in voice-plan's meanings:
  - "Watch" (amber) = p95 forecast near or over the line;
  - "Over line" (red row) = engine flag;
  - "Steady" = below.
  Most rows are now "Watch", because the engine forecasts every athlete over the line by minute 52.

### 2. Added labels and badges (allowed)
- Provenance lines:
  - "estimate — planning only · synthetic roster" on the Athlete twin;
  - the Live footer lists the site, "synthetic roster" and the replay source;
  - Plan heat-strip caption: "engine p95 … planning only. Synthetic roster.";
  - Settings: "WBGT forecast: NWS, through the HeatTwin engine".
- Field-card chip "NWS fixture" / "NWS forecast" (was "Forecast").
- Demo-bar tag: Replay / Live / Offline.
- Offline mode: "offline fallback" badge with "—" for numbers. Not visible in these screenshots.

### 3. Content that replaced invented data
- **Badges:** athlete position (OL, LB …) instead of invented jersey numbers, in the same badge, on the Live roster, Plan, Athlete picker and Collapse header.
- **Heart rate:** only athletes with HR data show bpm (a07, from the replay); the rest read "No strap · model". The old fake HR for every athlete is gone.
- **Response checklist:** the pre-ticked invented checks ("Probe reads 48.9 °F", "Gate 3 unlocked", "Checked 3:05 PM", "Tub within 1 minute") are now unverified items ("!") with KSI wording from `/sources` ("Tub within 5–10 minutes…") and "check on site".
- **Collapse tub probe:** "—°F · No probe reading · KSI: under 59 °F". It was a synthetic 48.7 °F.
- **Athlete twin plan header:** shows the engine's "Forecast crosses 39.0° at minute 52". This is voice-plan's own text for when it has an engine result.

### 4. Copy changed for the safety guard (CLAUDE.md rule 4)
- The Athlete-twin safety line and the Collapse footer were reworded, because "never decides when to stop cooling" trips `engine/guard.py`. They now read "does not decide when cooling ends".

### 5. Behaviour change driven by the engine's alert semantics (decided: see polish, decision 1)
- **Live roster opens in alert mode.** The alert card, the guidance card and the sidebar badge "1" appear at minute 2–3, because the engine's HR-calibration gate flags a07 ("re-forecast shows crossing" at 44′). In voice-plan, the alert came from the browser loop once the current estimate passed the line, so the demo opened in the plain header mode (next break / zone / roster counts).
- **The alert card text** is now the engine's: "Re-forecast crosses the alert line … from 44′ · peak 41.70° (p95)". It was the browser-computed "for N min · rising X°/min".

### 6. Kept as voice-plan wrote it, but flagged by the earlier audit (decided: see polish, decision 2)
- "Do this now" guidance: "Pull from activity, into shade · Remove helmet and pads · Check: confused, stumbling, collapsed?".
- Collapse 911 script: "Say 'suspected exertional heat stroke.'".
- Neither is generated text, so the guard does not run on them. Main's neutral wording was not ported, because the rule for this branch was no copy changes.

### Bugs found and reverted during the comparison
- Every Live-roster row was red "Over line": engine `over_limit` had been mapped to the alert style. Fixed in 100b7ca, which restores voice-plan's meanings.
- The Athlete twin showed "BSA —". Restored with the engine's DuBois coefficients from `/sources`.
- The demo bar read "Live" while hr_bridge was replaying a file. It now reads "Replay".

---

# polish: docs/ui_after (final-ui) vs docs/ui_polish

The owner's six decisions, Oct 4. Same script and settings: `scripts/ui_screens.mjs`, fresh browser, playback paused,
reduced motion, `?demo=1` pinned forecast. All 16 screenshots were pixel-diffed against docs/ui_after (threshold: summed
RGB difference > 40 per pixel, 32 px grid). docs/ui_polish keeps the changed screens plus two extra states.

| Screen | Changed | Where | Why |
|---|---|---|---|
| Collapse (both sizes) | 0.00 % | — | The 911 script is unchanged (decision 2a keeps "suspected exertional heat stroke"; the guard exception is engine-side) |
| Plan, plan-edit, Response, Settings | 0.03–0.04 % | sidebar "Live roster" badge only | The red "1" is gone: no athlete's estimate is over the line at minute 3 (decision 1) |
| Athlete (Marcus, both sizes) | 0.02 % | sidebar badge; Isaiah's picker dot | Badge as above; Isaiah's dot is amber (heads-up), not red (decision 1) |
| Live roster, dock (both sizes) | 16–18 % | top row; page 80–128 px shorter | The roster no longer opens in alert mode. The top row is voice-plan's plain header again (Now · next break 27′ · Zone 2 · roster 0 / 16 / 0); the alert card and guidance card are absent (decision 1). The footer replay label is "synthetic HR file (not a real athlete)" (decision 3) |

## By decision
1. **Live alerts.** The engine's early warning (gates.flag) is an amber heads-up in existing styles. On the Live row:
   "Re-forecast crosses the planning line at 44′" (title = the gate message). On the Athlete twin: the same text in a
   watch pill, which wraps inside the vitals card. voice-plan's red alert card, red row, sidebar badge and tint appear
   only when the estimate itself is at or over the line. `live-skip-1440x900.png` shows that state after "Skip to heat":
   "Over the alert line · Isaiah 39.2 °C · Est. over 39.0° for 3 min · peak 41.65° (p95)".
2. **Copy.** (a) Collapse 911: no visible change; the guard now blocks "suspected <heat illness>" everywhere except
   source `collapse.911_script` (KSI CWI guide step 1, constants.guard_exceptions; tests show the phrase is blocked for
   every other source and via /guard). (b) The model-triggered "Do this now" card is now "Heads-up" in the same
   layout: "Estimate crosses the planning line · Consider pulling from activity and checking on the athlete · Follow
   your emergency action plan", footer "Estimate — planning only. If an athlete collapses → Collapse response."
   It passes /guard (tested). Visible in `live-skip-1440x900.png`.
3. **Replay / recording.** The demo replay is the synthetic file (Isaiah's HR 87 bpm at minute 3, labelled synthetic).
   `athlete-a07-1440x900.png` shows the new "Recorded Oct 3 · Amazfit Helio Strap" block in the vitals card's empty
   lower area: 1,557 readings · 26.2 min; HR 69 · 116.6 · 185 bpm; calibration met_scale ± sd and update count; the
   engine's label "rest, then burpees — not football drills; not replayed on the demo plan's clock".
4. **Live demo · conditioning** and 5. **forecast snapshot (time-shifted)** appear only during a live session (labels
   in the Live footer, demo bar and field-card chip), so not in these `?demo=1` screenshots. Covered by engine and web
   tests.
