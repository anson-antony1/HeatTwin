"""Kill switch for metered APIs (Gemini, ElevenLabs).

``HEATTWIN_DISABLE_PAID_APIS`` defaults to ON ("1"): every call raises before any network I/O and the caller falls back
to its local path (rules, browser speech). Set it to "0" only for a real demo with keys in .env. Every attempt is
counted, in memory (GET /health → ``paid_api``) and in ``engine/logs/paid_api.jsonl`` (git-ignored), so a night of
tests can prove it made none.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOG_PATH = Path(__file__).resolve().parent / "logs" / "paid_api.jsonl"
_LOCK = threading.Lock()
_ATTEMPTS: dict[str, int] = {}
_SENT: dict[str, int] = {}


class PaidAPIDisabled(RuntimeError):
    """A metered API was called while HEATTWIN_DISABLE_PAID_APIS is on."""


def disabled() -> bool:
    return os.environ.get("HEATTWIN_DISABLE_PAID_APIS", "1").strip().lower() not in ("0", "false", "no", "off")


def gate(api: str) -> None:
    """Call right before a metered request. Counts the attempt; raises PaidAPIDisabled when the switch is on."""
    blocked = disabled()
    with _LOCK:
        _ATTEMPTS[api] = _ATTEMPTS.get(api, 0) + 1
        if not blocked:
            _SENT[api] = _SENT.get(api, 0) + 1
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as f:
            f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "api": api,
                                "sent": not blocked, "pid": os.getpid()}) + "\n")
    except OSError:
        pass  # logging must never block the gate
    if blocked:
        raise PaidAPIDisabled(f"{api}: paid APIs are disabled (HEATTWIN_DISABLE_PAID_APIS=1); using the local path")


def counts() -> dict[str, Any]:
    with _LOCK:
        return {"disabled": disabled(), "attempted": sum(_ATTEMPTS.values()), "sent": sum(_SENT.values()),
                "by_api": {k: {"attempted": v, "sent": _SENT.get(k, 0)} for k, v in sorted(_ATTEMPTS.items())}}


def reset() -> None:
    """Tests only."""
    with _LOCK:
        _ATTEMPTS.clear()
        _SENT.clear()
