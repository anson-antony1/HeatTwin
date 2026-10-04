"""Warm a running engine with the exact requests the web app makes, so nothing is slow on stage.

    python scripts/warm_demo.py                       # engine at http://127.0.0.1:$HEATTWIN_PORT (default 8010)
    python scripts/warm_demo.py http://127.0.0.1:8100

The engine caches demo-mode results keyed on the request body, so this sends the plan from GET /demo/inputs exactly
as the web does: /simulate, /optimize (both presets; fewest_changes steps its change cap and is slow cold), the HR
replay and the comparison snapshot. Optimizer results also persist on disk (engine/demo_cache.py), so after a restart
this is fast unless the code or inputs changed. Then it checks: a second pass must answer every call within
WARM_MAX_S, else it exits 1 (`make warm` is the pre-demo check).
"""
from __future__ import annotations

import os
import sys
import time

import requests

WARM_MAX_S = 2.0   # demo-qa's bar for a warmed call


def main() -> None:
    base = (sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{os.environ.get('HEATTWIN_PORT', '8010')}").rstrip("/")
    s = requests.Session()
    s.trust_env = False   # localhost only; ignore any proxy settings

    def call(method: str, path: str, body=None) -> float:
        t = time.perf_counter()
        r = s.request(method, base + path, json=body, timeout=900)
        dt = time.perf_counter() - t
        print(f"{r.status_code}  {dt:7.2f} s  {method} {path}")
        if r.status_code >= 500:
            sys.exit(f"engine error on {path}: {r.text[:200]}")
        return dt

    inputs = s.get(base + "/demo/inputs", timeout=60).json()
    body = {"plan": inputs["plan"]}
    calls = [("POST", "/simulate?demo=1", body), ("POST", "/optimize?demo=1&preset=max_load", body),
             ("POST", "/optimize?demo=1&preset=fewest_changes", body), ("POST", "/live/replay?demo=1", body),
             ("GET", "/demo/comparison", None), ("GET", "/node/latest", None)]
    print("warm:")
    for c in calls:
        call(*c)
    print(f"check (every call must answer within {WARM_MAX_S} s):")
    slow = [c[1] for c in calls if call(*c) > WARM_MAX_S]
    if slow:
        sys.exit(f"NOT WARM: {', '.join(slow)} still slow")
    print("warm: every demo call answers from the cache")


if __name__ == "__main__":
    main()
