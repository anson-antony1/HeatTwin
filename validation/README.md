# validation/

Every number in `results.json` is computed by a script in this folder from real, cited inputs. Synthetic or replayed
data never goes in `results.json`.

| Key | Script | What |
|---|---|---|
| `armstrong_2010` | `armstrong_2010.py` | WS7 item 1. Armstrong et al. 2010 (J Athl Train 45:117) reproduced in twonode-v1 (conservative, ISO-dynamic and Gagge-static clothing) and JOS-3, for control clothing and full uniform. |

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
