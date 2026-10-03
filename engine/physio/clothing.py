"""Gear level → clothing heat- and vapour-transfer properties (MODEL.md §5).

``gear_props(gear)`` returns intrinsic insulation R_cl [m²K/W], intrinsic evaporative resistance
R_e,cl [m²·mmHg/W, Gagge units], area factor f_cl and whether the ensemble counts as clothed (selects
Gagge's clothed/nude critical-wettedness law). Values come from constants.gear_clothing (football-uniform
sweating-manikin data).
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from engine import consts

GEAR_LEVELS = ("none", "helmet", "helmet_shoulder_pads", "full_pads")


@dataclass(frozen=True)
class GearProps:
    gear: str
    i_cl_clo: float
    r_cl_m2k_w: float        # static intrinsic dry insulation
    r_ecl_m2mmhg_w: float    # static intrinsic evaporative resistance (gagge_static mode)
    f_cl: float
    clothed: bool
    i_t_m2k_w: float         # static total insulation incl. still-air layer (iso7933_dynamic mode)
    i_m: float               # static permeability index (iso7933_dynamic mode)


def gear_props(gear: str) -> GearProps:
    g = consts.get("gagge_1986")
    lvl = consts.get(f"gear_clothing.levels.{gear}")
    i_cl = float(lvl["i_cl_clo"])
    r_cl = g["clo_to_m2k_w"] * i_cl
    f_cl = float(lvl["f_cl"]) if lvl.get("f_cl") is not None else 1.0 + g["fcl_per_clo"] * i_cl
    clothed = i_cl > 0
    if lvl.get("r_ecl_m2kpa_w") is not None:
        mmhg_per_kpa = 1000.0 / consts.get("physical.pa_per_mmhg")
        r_ecl = float(lvl["r_ecl_m2kpa_w"]) * mmhg_per_kpa
    else:
        # Gagge fallback: R_e,cl = R_cl / (LR · i_cl)
        i_perm = g["icl_clothed"] if clothed else g["icl_nude"]
        lr = g["lewis_ratio_k_mmhg"] / g["p_atm_atm"]
        r_ecl = r_cl / (lr * i_perm)
    i_t = g["clo_to_m2k_w"] * float(lvl["i_t_clo"])
    return GearProps(gear, i_cl, r_cl, r_ecl, f_cl, clothed, i_t, float(lvl["i_m"]))


@lru_cache(maxsize=1)
def gear_table() -> dict[str, np.ndarray]:
    """Arrays indexed by ``GEAR_LEVELS`` position, for vectorized lookup in the integrator."""
    props = [gear_props(g) for g in GEAR_LEVELS]
    return {
        "r_cl": np.array([p.r_cl_m2k_w for p in props]),
        "r_ecl": np.array([p.r_ecl_m2mmhg_w for p in props]),
        "f_cl": np.array([p.f_cl for p in props]),
        "clothed": np.array([p.clothed for p in props]),
        "i_t": np.array([p.i_t_m2k_w for p in props]),
        "i_m": np.array([p.i_m for p in props]),
        "i_cl_clo": np.array([p.i_cl_clo for p in props]),
    }


def gear_index(gear: str) -> int:
    return GEAR_LEVELS.index(gear)
