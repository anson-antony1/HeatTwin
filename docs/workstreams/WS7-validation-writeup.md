# WS7 — Validation, write-up, deck   (owners: B for validation, D for write-up · model: opus for analysis, sonnet for prose)

**Paste into Claude Code (validation):**
> Read CLAUDE.md. You own `validation/`. Produce `validation/results.json` with only computed numbers, each with the script that made it.

1. **Published-study reproduction:** find a published football-uniform heat-strain study with reported conditions (temp/RH, protocol, uniform) and measured core temperature over time (start with Armstrong et al. 2010, J Athl Train). Reproduce the conditions in our model and JOS-3; report the error vs measured (RMSE/max error at reported time points). If the paper only gives summary values, compare those and say so.
2. **Field vs forecast:** from the node's afternoon log, report node-WBGT minus forecast-WBGT per hour (mean, range, n hours) and how often the FHSAA zone differs.
3. **Teammate HR session:** 2–3 teammates, HR strap, a structured protocol (rest 5 min → stairs/burpees intervals → rest). Show calibration convergence and the gate log. No core-temp ground truth: say so plainly.
4. **Optimizer stats:** across 10 fixture plans × 3 forecast days: feasible %, mean load kept, mean runtime.
5. **Limitations** section in plain words.

**Write-up (D):** follow PLAN.md §9; pull numbers only from results.json and SOURCES.md; 1–4 pages; include the architecture diagram and screenshots. Run the `source-checker` agent over the final draft.
