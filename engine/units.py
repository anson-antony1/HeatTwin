"""Display only: temperatures the engine writes into sentences and labels, in °F.

The engine models in °C (its equations and sources do); people read °F (FHSAA WBGT, NATA/KSI thresholds). Conversion uses
constants.physical (T/°F = 1.8·t/°C + 32, NIST SP 811 B.9). The web formats with the same formula (web/src/lib/format.ts).
"""
from __future__ import annotations

from engine import consts


def c_to_f(c: float) -> float:
    ph = consts.get("physical")
    return c * ph["f_per_c"] + ph["f_offset"]


def f(c: float, decimals: int = 2) -> str:
    """A temperature, e.g. 39.0 °C → '102.20'."""
    return f"{round(c_to_f(float(c)), decimals):.{decimals}f}"


def df(dc: float, decimals: int = 1, sign: bool = False) -> str:
    """A temperature DIFFERENCE (no offset), e.g. 1.0 °C → '1.8' (sign=True → '+1.8')."""
    v = round(float(dc) * consts.get("physical.f_per_c"), decimals)
    return f"{v:+.{decimals}f}" if sign else f"{v:.{decimals}f}"
