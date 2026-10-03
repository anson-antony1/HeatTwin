"""Activity → metabolic heat (MODEL.md §4). All values from constants.yaml.

* ``drill_met(drill)``: drill intensity → MET (Compendium of Physical Activities), or the
  coach/AT ``met_override``.
* ``met_to_w_m2(met, mass_kg, bsa_m2)``: mass-specific MET (1 MET ≡ 1 kcal·kg⁻¹·h⁻¹) → W/m².
* ``hr_max_bpm(age)`` and ``met_from_hr(...)``: %HR reserve ≈ %VO₂ reserve (Swain & Leutholtz 1997),
  used by WS3 live calibration, not by planning.
"""
from __future__ import annotations

from typing import Any, Mapping

import numpy as np

from engine import consts

INTENSITIES = ("rest", "light", "moderate", "hard", "max")


def intensity_met(intensity: str) -> float:
    entry = consts.get(f"drill_met.values.{intensity}")
    return float(entry["met"] if isinstance(entry, Mapping) else entry)


def drill_met(drill: Mapping[str, Any]) -> float:
    """MET for a drill: ``met_override`` if supplied by coach/AT, else the intensity's Compendium MET."""
    if drill.get("met_override") is not None:
        return float(drill["met_override"])
    return intensity_met(drill["intensity"])


def w_per_kg_per_met() -> float:
    """1 MET ≡ k kcal·kg⁻¹·h⁻¹ (Compendium definition) → W/kg."""
    k = consts.get("metabolic.kcal_per_kg_h_per_met")
    return k * consts.get("physical.j_per_kcal") / consts.get("physical.s_per_h")


def met_to_w_m2(met, mass_kg, bsa_m2):
    """Whole-body metabolic heat per unit DuBois area [W/m²] for a mass-specific MET."""
    return np.asarray(met, dtype=float) * w_per_kg_per_met() * np.asarray(mass_kg, dtype=float) / np.asarray(bsa_m2, dtype=float)


def hr_max_bpm(age_yr: float) -> float:
    f = consts.get("hr_met.hr_max")
    return f["intercept_bpm"] - f["age_coeff_bpm_per_yr"] * age_yr


def met_from_hr(hr_bpm, hr_rest_bpm, hr_max_bpm_, vo2max_ml_kg_min: float | None = None):
    """%HRR ≈ %VO₂R → VO₂ → MET.

    VO₂ = VO₂rest + %HRR·(VO₂max − VO₂rest), with VO₂rest = 1 MET; MET = VO₂ / (mL·kg⁻¹·min⁻¹ per MET).
    Biased high late in hot sessions (cardiovascular drift); WS3 should treat it as a noisy observation.
    """
    ml_per_met = consts.get("hr_met.ml_o2_per_kg_min_per_met")
    vo2max = vo2max_ml_kg_min if vo2max_ml_kg_min is not None else consts.get("hr_met.vo2max_default_ml_kg_min")
    hrr = (np.asarray(hr_bpm, dtype=float) - hr_rest_bpm) / max(hr_max_bpm_ - hr_rest_bpm, 1e-6)
    hrr = np.clip(hrr, 0.0, 1.0)
    vo2 = ml_per_met + hrr * (vo2max - ml_per_met)
    return vo2 / ml_per_met


def body_surface_area_m2(mass_kg, height_m):
    """DuBois & DuBois (1916)."""
    b = consts.get("body_surface_area")
    return b["coeff"] * np.asarray(mass_kg, dtype=float) ** b["mass_exp"] * np.asarray(height_m, dtype=float) ** b["height_exp"]
