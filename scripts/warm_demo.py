"""Warm a running engine with the exact requests the web app makes, so nothing is slow on stage.

    python scripts/warm_demo.py                       # engine at http://127.0.0.1:8000
    python scripts/warm_demo.py http://127.0.0.1:8100

The engine caches demo-mode results keyed on the request body, so this sends the plan from GET /demo/inputs exactly
as the web does: /simulate, /optimize (both presets; fewest_changes steps its change cap and is slow cold), the HR
replay and the comparison snapshot. Run it after every engine restart (`make demo` starts the engine without
auto-reload so a file save doesn't empty the cache).
"""
from __future__ import annotations

import sys
import time

import requests


def main() -> None:
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
    s = requests.Session()
    s.trust_env = False   # localhost only; ignore any proxy settings

    def call(method: str, path: str, body=None) -> None:
        t = time.perf_counter()
        r = s.request(method, base + path, json=body, timeout=600)
        print(f"{r.status_code}  {time.perf_counter() - t:7.2f} s  {method} {path}")
        if r.status_code >= 500:
            sys.exit(f"engine error on {path}: {r.text[:200]}")

    inputs = s.get(base + "/demo/inputs", timeout=60).json()
    body = {"plan": inputs["plan"]}
    call("POST", "/simulate?demo=1", body)
    call("POST", "/optimize?demo=1&preset=max_load", body)
    call("POST", "/optimize?demo=1&preset=fewest_changes", body)
    call("POST", "/live/replay?demo=1", body)
    call("GET", "/demo/comparison")
    call("GET", "/node/latest")
    print("warm: repeat calls with the same bodies now return from the demo cache")


if __name__ == "__main__":
    main()
