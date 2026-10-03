"""Use WS1's engine/fhsaa.py when it exists, otherwise the local stub with the same signatures."""
from __future__ import annotations

try:  # WS1
    from engine import fhsaa as _impl  # type: ignore[attr-defined]
    USING_STUB = False
except ImportError:  # pragma: no cover - depends on merge state
    from engine import fhsaa_stub as _impl
    USING_STUB = True

from engine import gear_rules  # noqa: E402

zone = _impl.zone
required_breaks = getattr(_impl, "required_breaks", None)


def violations(plan, weather, roster=None):
    """FHSAA zone rules (WS1 or stub) + NATA 2009 per-athlete gear phasing when a roster is given."""
    out = list(_impl.violations(plan, weather))
    if roster is not None:
        out += gear_rules.phasing_violations(plan, roster)
    return out
