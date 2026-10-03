---
description: Merge workstream branches into main, run all tests and the demo-qa agent, and report what's broken
---
1. `git fetch --all` and list ws* branches with commits ahead of main.
2. Merge each into an `integrate` branch one at a time; stop and report on conflicts (don't resolve CONTRACTS.md conflicts yourself, ask the human).
3. Run `make test`, then `make dev` in the background and run the `demo-qa` agent.
4. If green, fast-forward main and tag `m<N>-<HHMM>`. Report what merged, test results and demo-qa findings.
