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

### 5. Behaviour change driven by the engine's alert semantics (decision for the owner)
- **Live roster opens in alert mode.** The alert card, the guidance card and the sidebar badge "1" appear at minute 2–3, because the engine's HR-calibration gate flags a07 ("re-forecast shows crossing" at 44′). In voice-plan, the alert came from the browser loop once the current estimate passed the line, so the demo opened in the plain header mode (next break / zone / roster counts).
- **The alert card text** is now the engine's: "Re-forecast crosses the alert line … from 44′ · peak 41.70° (p95)". It was the browser-computed "for N min · rising X°/min".

### 6. Kept as voice-plan wrote it, but flagged by the earlier audit (owner decision)
- "Do this now" guidance: "Pull from activity, into shade · Remove helmet and pads · Check: confused, stumbling, collapsed?".
- Collapse 911 script: "Say 'suspected exertional heat stroke.'".
- Neither is generated text, so the guard does not run on them. Main's neutral wording was not ported, because the rule for this branch was no copy changes.

### Bugs found and reverted during the comparison
- Every Live-roster row was red "Over line": engine `over_limit` had been mapped to the alert style. Fixed in 100b7ca, which restores voice-plan's meanings.
- The Athlete twin showed "BSA —". Restored with the engine's DuBois coefficients from `/sources`.
- The demo bar read "Live" while hr_bridge was replaying a file. It now reads "Replay".
