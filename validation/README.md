# validation/

Every number in `results.json` is computed by a script in this folder from real, cited inputs. Synthetic or replayed
data never goes in `results.json` — with one labelled exception: `voice_decide` is measured on developer-written synthetic
text and says so (`synthetic: true`) in the file, in the block and in `docs/VOICE.md`.

| Key | Script | What |
|---|---|---|
| `field_plausibility` | `field_plausibility.py` | Model p50/p95 peaks vs ingestible-pill core temperatures from 5 football-practice studies (NFL, college, high school), plus a sensitivity sweep naming the driver of the gap. |
| `armstrong_2010` | `armstrong_2010.py` | WS7 item 1. Armstrong et al. 2010 (J Athl Train 45:117) reproduced in twonode-v1 (conservative, ISO-dynamic and Gagge-static clothing) and JOS-3, for control clothing and full uniform. |
| `helio_recording` | `helio_recording.py` | The real Oct 3 Amazfit Helio Strap recording (rest, then burpees) as calibration evidence: readings, duration, HR min/mean/max, and how met_scale moves when the HR is read against the plan's conditioning drill (the live-demo mapping; rest-like windows skipped). Real data (`synthetic: false`), fed through calibration as a replay (`replay: true`) with roster athlete a07's synthetic profile (`calibration.profile_synthetic: true`). Not replayed on the demo plan's clock. |
| `voice_decide` | `voice_decide.py` | The free voice decision layer (`engine/decide.py`): accuracy, ECE (10 bins), abstain rate and a reliability table for intent, athlete, drill, drill intensity and the guard assist, with the fitted softmax temperature and abstain threshold (also written to `engine/data/decide_calibration.json`). **Synthetic** (`synthetic: true`): the dataset is developer-written text in `engine/data/voice_decide_dataset.json`, not recorded speech. `python -m validation.voice_decide [--write-doc] [--check]`; protocol in the script's docstring and `docs/VOICE.md`. |
| `wbgt_gap` | `wbgt_gap.py` | Our Liljegren WBGT vs NWS's own WBGT forecast layer for the Gainesville cell, broken down by input (NWS's documented choices swapped in one at a time, Shapley-attributed; nothing tuned). Write-up: `engine/physio/MODEL.md` §12d. |

Run with `python -m validation.armstrong_2010`; `--calibrate` recomputes the conservative mode's gear surcharge.

**What it shows** (reference air speed 0.1 m/s):
- **Conservative (the planning default):**
  - It was calibrated on the full-uniform treadmill rate (0.071 °C/min).
  - It reproduces control clothing (0.035 vs 0.037 ± 0.015).
  - It over-predicts the full-uniform whole-protocol rise (2.80 vs 2.37 ± 0.45 °C), the safe direction.
- **ISO-dynamic and JOS-3:** both under-predict both conditions by about 1 SD.
- **Gagge-static:** fits the whole-protocol rise best (RMSE 0.16 °C).

**Limits, plainly:**
- Only summary values are compared: Table 3 rise and rate, Table 4 treadmill rate.
- Chamber air speed and metabolic rate weren't reported; METs come from the Compendium.
- One deterministic "mean participant" stands in for 10 men.
- The calibration point isn't an independent validation.
- None of this tests field conditions (sun, intermittent drills, adolescents).

**Field plausibility** (`python -m validation.field_plausibility`): our medians are 0.6–0.8 °C above the field group-mean
peaks at matched WBGT, and 0.15–1.4 °C above in the Godek scenarios, depending on sun. The driver is drill intensity (the
Compendium "competitive football" MET applied to practice blocks): −1.5 °C if hard and max drills are run at the moderate MET.
Practice structure and cloud cover are not reported in the studies; both are stated assumptions.

**WBGT gap** (`python -m validation.wbgt_gap`; `--raw FILE` runs it on another raw gridpoint file, print only): over the
demo window (Oct 4, 15–18 h) our WBGT is 2.0–4.4 °F above NWS's (mean 3.1). NWS's documented swaps (solar split, wind log
law, ground albedo, Dimiceli globe, NWB regression, dewpoint) net to −0.5 °F, so the residual (+3.6 °F) is the top contributor.
It vanishes at night, and NWS's values imply roughly a third of our irradiance; we attribute it, by elimination, to NWS's
unpublished clear-sky curve. Ground albedo (0.45 vs 0.2) is the largest swapped factor (+0.8 °F).
