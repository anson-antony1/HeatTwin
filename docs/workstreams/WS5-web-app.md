# WS5 — Coach web app   (owner: C · model: sonnet; opus for Web Bluetooth + Collapse state machine)

**Paste into Claude Code:**
> Read CLAUDE.md, CONTRACTS.md. You own `web/`. Build against `fixtures/*.json` first (mock API layer), then switch to the real API at M1. Use the `frontend-design` approach: a calm, high-contrast sideline UI readable in sunlight, large type, colorblind-safe (pair color with icon + text).

Screens:
1. **Plan** — forecast strip (hourly WBGT + FHSAA zone band), drill timeline, and a **heat strip per athlete** (rows = athletes, columns = minutes, color = p95 core estimate vs limit). Click a row → that athlete's curve with p50/p95 band. **Optimize** button → animate red→green, show the `changes[]` diff and `load_kept_pct`. Free-text plan entry (optional Claude API parse, schema-validated, coach confirms).
2. **Live** — roster cards; "Pair HR strap" via Web Bluetooth (`navigator.bluetooth.requestDevice({filters:[{services:['heart_rate']}]})`, parse characteristic 0x2A37 flags for 8/16-bit HR); POST `/hr`; card shows HR, estimate, gate status ("not enough data" is a valid state). Node panel: field WBGT vs forecast.
3. **Collapse mode** — full-screen. Big clock from tap. Steps as a state machine: Call 911 → To tub → Immerse → Stir → cooling timer (10–15 min per KSI if no rectal thermometer) → EMS handoff. Pre-generated ElevenLabs clips per step (files in `web/public/audio/`, no network needed). Live tub temp from `/node/latest` with a warning above 15 °C. Generates a CollapseLog timeline, labelled "times entered by coach — not a diagnosis".
4. **Sources** — renders `/sources` (constants with VERIFIED/SECONDARY/TODO badges) and SOURCES.md.

Every estimate shows "estimate — planning only". Replay/fixture data shows a visible badge. Never render "safe"/"fine".
