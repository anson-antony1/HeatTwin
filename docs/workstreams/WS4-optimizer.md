# WS4 — Practice-plan optimizer   (owner: A · model: opus)

**Paste into Claude Code:**
> Read CLAUDE.md, CONTRACTS.md. You own `engine/optimizer.py`. It calls WS2's `simulate_roster` and WS1's `fhsaa.violations`.

Problem: given `plan`, `roster`, `weather`, find a plan that
- **hard constraints:** zero FHSAA violations; every athlete's `core_c_p95` stays below `planning_limit_core_c`; priority-1 drills kept at ≥ 90% of their duration; non-movable drills stay in place; total duration doesn't exceed the zone max.
- **objective:** maximize retained training load (Σ met × minutes × priority weight), tie-break on fewest changes (coaches hate big diffs).

Moves: reorder movable drills (hard work into cooler hours), insert a shaded break, lengthen a break, downgrade gear, trim a priority-2/3 drill, split a drill around a break, apply per-athlete substitution (rotate the at-risk subgroup out of one block — store as `participants`).

Method: simulated annealing or beam search over move sequences, with the vectorized sim as the evaluator. Add a cache keyed on the plan hash. Time budget param (default 8 s). Return `OptimizeResult` with a human-readable `changes[]` list and `search` stats. If no feasible plan exists, return `feasible:false` and the least-bad plan, and say so.

Tests: a fixture where only reordering fixes it, one that needs a break, one that's infeasible (zone 5), and determinism with a fixed seed.
