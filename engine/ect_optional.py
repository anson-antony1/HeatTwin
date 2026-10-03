"""RESEARCH MODE — method appears patented; see SOURCES.md.

HR → core-temperature Kalman filter of Buller et al. 2013 (Physiol Meas 34:781). US patent "Method and System for
Indirectly Determining Core Body Temperature Using Heart Rate" (priority Dec 2012) appears to cover it, so this module
is OFF by default, never feeds planning or the optimizer, and every output is labelled. HeatTwin's core predictions
come from the public two-node physics model (engine/physio/twonode.py).

Coefficients come from constants.ect_buller_2013 (status TODO — from memory, unverified against the paper/MATLAB code).
"""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np

from engine import consts

LABELS = ["research mode — method appears patented", "coefficients unverified (constants status TODO)",
          "estimate — planning only", "not a diagnosis; rectal temperature is the only basis for treatment"]


class ResearchModeDisabled(RuntimeError):
    pass


def estimate_core(hr_bpm: Sequence[float], *, research_mode: bool = False) -> dict[str, Any]:
    """Buller 2013 extended Kalman filter, one HR sample per minute → estimated core temperature series."""
    if not research_mode:
        raise ResearchModeDisabled("ect_optional is off by default (method appears patented); pass research_mode=True")
    c = consts.get("ect_buller_2013")
    a, gamma, b0, b1, b2, sigma = c["a"], c["gamma"], c["b0"], c["b1"], c["b2"], c["sigma"]
    ct, v = float(c["ct0_c"]), float(c["v0"])
    out = []
    for hr in hr_bpm:
        ct_p, v_p = a * ct, a * a * v + gamma               # time update
        c_vc = 2.0 * b2 * ct_p + b1                        # d(HR)/d(CT) of the quadratic observation model
        k = v_p * c_vc / (c_vc * c_vc * v_p + sigma)
        ct = ct_p + k * (float(hr) - (b2 * ct_p * ct_p + b1 * ct_p + b0))
        v = (1.0 - k * c_vc) * v_p
        out.append(ct)
    return {"core_c": np.round(out, 3).tolist(), "status": consts.status("ect_buller_2013"), "labels": LABELS}
