# KICKOFF — first 30 minutes

## 1. Repo (one person, 5 min)
```bash
git init heattwin && cd heattwin
# copy this kit in (including the hidden .claude/ folder), then:
git add -A && git commit -m "kit: plan, contracts, constants, workstream briefs"
gh repo create heattwin --private --source=. --push   # make public before submitting
```

## 2. Everyone: own worktree + own Claude Code session
```bash
git worktree add ../ht-ws2 -b ws2-physio        # A
git worktree add ../ht-ws1 -b ws1-weather       # B
git worktree add ../ht-ws5 -b ws5-web           # C
git worktree add ../ht-ws6 -b ws6-firmware      # D
cd ../ht-wsN && claude
```
First message in each session:
> Read CLAUDE.md, PLAN.md, CONTRACTS.md, engine/constants.yaml, then docs/workstreams/WS<N>-*.md. Restate the plan for my workstream in 5 bullets, list what you'll stub, then start. Commit after each numbered step.

A also starts WS4 after WS2 step 1 lands; B starts WS3 after WS1 step 3. B and D share WS7 from 10 PM.

## 3. Background agents (kick off immediately, run in parallel)
- In any session: `/check-sources` → the source-checker fills the TODO constants (drill METs, gear clo/Re, HR max formula, planning limit, globe height, Buller coefficients).
- D: parts run (PLAN.md §4). Post in the DTE Discord first.

## 4. Integration rhythm
- `/integrate` at **4:00 PM, 6:00 PM (M1), 10:00 PM (M2), 2:00 AM, 9:00 AM, 10:45 AM**.
- Contract changes: post in team chat first, additive only.

## 5. Non-code tasks to hand to Claude (chat or Code)
- "Draft the Devpost write-up from PLAN.md §9 using only SOURCES.md and validation/results.json."
- "Generate the ElevenLabs script for the 7 Collapse-mode steps, ≤12 words each, KSI wording, no diagnosis language."
- "Make a 6-slide deck following PLAN.md §7."
