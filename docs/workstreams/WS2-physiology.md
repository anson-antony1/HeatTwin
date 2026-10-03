# WS2 — Transient two-node physiology model   (owner: A · model: opus)

**Paste into Claude Code:**
> Read CLAUDE.md, CONTRACTS.md, engine/constants.yaml. You own `engine/physio/`. Before writing code, write out the equations you'll implement in `engine/physio/MODEL.md` (heat balance of core and skin compartments, metabolic heat, work, respiratory loss, convective/radiative exchange through clothing, evaporative exchange limited by E_max with clothing evaporative resistance, sweating and skin blood flow control signals). Base it on the Gagge two-node model and cite it; use pythermalcomfort's `two_nodes_gagge` source as a reference implementation.

Build:
1. **twonode.py** — `simulate_roster(roster, plan, weather, step_min=1, params=None) -> arrays` that integrates core/skin temperature **minute by minute** while activity, gear, shade and weather change. Vectorize across athletes with numpy (shape `[n_athletes, T]`). Must run a 40-athlete × 150-minute plan in < 50 ms so the optimizer can call it hundreds of times.
   - Inputs per minute: met (from metabolic.py), clo + evaporative resistance (from clothing.py), air temp, mean radiant temp (from globe/solar — shade drills use reduced radiant load), RH, wind.
   - Per-athlete: body surface area (cite formula), mass, `calib.met_scale`, `calib.thermo_scale`, acclimatization day (reduce sweat onset/gain early in acclimatization — cite or mark TODO).
   - Uncertainty: run an ensemble (e.g. 30 draws) from calib means/SDs → `core_c_p50`, `core_c_p95`.
2. **metabolic.py** — intensity → MET from constants (Compendium); `met_from_hr(hr, hr_rest, hr_max)` via %HR reserve ≈ %VO2 reserve (cite).
3. **clothing.py** — gear level → (clo, Re) from constants (TODO values must be sourced by the `source-checker` agent).
4. **jos3_ref.py** — run the same scenario through pythermalcomfort `JOS3` (change `par`, `clo`, `tdb`, `tr`, `rh`, `v` between `simulate()` calls) and return core temp, for cross-checking.
5. Tests: sanity (rises with met, falls at rest in shade, monotonic in WBGT, bounded 36–42 °C), steady-state agreement with pythermalcomfort two-node within a stated tolerance, and a performance test.

Then ask the `physio-reviewer` sub-agent to review MODEL.md against the code.
