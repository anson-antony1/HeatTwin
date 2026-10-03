"""Use WS1's engine/fhsaa.py when it exists, otherwise the local stub with the same signatures."""
from __future__ import annotations

try:  # WS1
    from engine import fhsaa as _impl  # type: ignore[attr-defined]
    USING_STUB = False
except ImportError:  # pragma: no cover - depends on merge state
    from engine import fhsaa_stub as _impl
    USING_STUB = True

zone = _impl.zone
violations = _impl.violations
required_breaks = getattr(_impl, "required_breaks", None)
