"""Build-time warm-up for the hosted engine (Render): fill the on-disk demo cache so a cold start answers from disk.

    python scripts/warm_build.py

Runs, in-process through FastAPI's TestClient (no server, no network, no paid API), the exact calls scripts/warm_demo.py
makes against a running engine and the web app makes in demo mode: GET /demo/inputs, POST /simulate?demo=1,
POST /optimize?demo=1 for both presets, POST /live/replay?demo=1 (the synthetic, labelled HR replay) and the stored
GET /demo/comparison. The two optimizer searches are the slow part (about two minutes each, cold, on a laptop); their
results are written to .cache/demo/ (engine/demo_cache.py: keyed by inputs + a hash of the engine code, override the
directory with HEATTWIN_CACHE_DIR). This is also what compiles the numba kernel into engine/physio/__pycache__.

Then it checks the cache the way a cold start sees it: the in-process caches are emptied and every call must answer
within WARM_MAX_S (the optimizer results come back from disk). Exit 1 if not, so a broken warm-up fails the build.

Run it with the same environment variables as the service (a different HEATTWIN_PROFILE, for example, is a different
cache key). Build and start must run from the same checkout, because the cache key hashes the engine source.

The warm-up always uses the numba kernel (HEATTWIN_INTEGRATOR is forced to "auto" here): the numpy integrator agrees to
< 1e-6 °C but is about 6x slower on the optimizer, and the annealing search is sensitive enough that its path, and so
its headline numbers, can differ. It also compares the warmed headline numbers with docs/demo_numbers.json and prints a
WARNING (it does not fail the build) if floating-point differences between machines changed them.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("HEATTWIN_DISABLE_PAID_APIS", "1")   # the build never calls a metered API
os.environ.setdefault("HEATTWIN_NODE", "off")              # no USB sensor bridge on a build or hosted machine
os.environ["HEATTWIN_INTEGRATOR"] = "auto"                 # numba kernel for the warm-up, whatever the service uses

WARM_MAX_S = 1.0   # a cached call after "restart" (in-process caches emptied) must answer well under a second


def headline_differences(got: dict) -> list[str]:
    """Plan-screen headline numbers (what scripts/e2e_headline.mjs reads) in the warmed results vs docs/demo_numbers.json."""
    from engine.voice_tools import _summary   # the same summary validation/demo_numbers.py wrote the snapshot with
    want = json.loads((ROOT / "docs" / "demo_numbers.json").read_text())["demo"]
    out = []
    sim = _summary(got["POST /simulate?demo=1"])
    out += [f"simulate {k}: {sim.get(k)} != {v}" for k, v in want["simulate"].items()
            if k != "athletes_detail" and sim.get(k) != v]
    for preset in ("max_load", "fewest_changes"):
        o, w = got[f"POST /optimize?demo=1&preset={preset}"], want["optimize"][preset]
        have = {"load_kept_pct": o["load_kept_pct"], "changes": len(o["changes"]),
                **{f"after.{k}": v for k, v in _summary(o["optimized"]).items()}}
        exp = {"load_kept_pct": w["load_kept_pct"], "changes": w["changes"],
               **{f"after.{k}": v for k, v in w["after"].items()}}
        out += [f"{preset} {k}: {have.get(k)} != {v}" for k, v in exp.items() if have.get(k) != v]
    return out


def main() -> int:
    from fastapi.testclient import TestClient

    from engine import api, demo_cache

    client = TestClient(api.app)
    print(f"engine code version {demo_cache.code_version()}; cache dir {demo_cache.cache_dir()}")

    def call(method: str, path: str, body=None) -> tuple[dict, float]:
        t = time.perf_counter()
        r = client.request(method, path, json=body)
        dt = time.perf_counter() - t
        print(f"{r.status_code}  {dt:8.2f} s  {method} {path}", flush=True)
        if r.status_code != 200:
            sys.exit(f"warm_build: {method} {path} returned {r.status_code}: {r.text[:300]}")
        return r.json(), dt

    inputs = client.get("/demo/inputs").json()
    body = {"plan": inputs["plan"]}
    calls = [("POST", "/simulate?demo=1", body),
             ("POST", "/optimize?demo=1&preset=max_load", body),
             ("POST", "/optimize?demo=1&preset=fewest_changes", body),
             ("POST", "/live/replay?demo=1", body),
             ("GET", "/demo/comparison", None)]

    from engine.physio import twonode
    print("integrator:", "numba kernel" if twonode._numba_kernel() is not None else
          "numpy (numba is NOT importable here: the searches below take about 6x longer and their numbers may differ)")
    print("warm (the two optimizer searches run once, here):")
    t0 = time.perf_counter()
    got = {f"{m} {p}": call(m, p, b)[0] for m, p, b in calls}
    print(f"warm-up took {time.perf_counter() - t0:.0f} s")
    differs = headline_differences(got)
    print("headline numbers vs docs/demo_numbers.json:",
          "match" if not differs else "WARNING, they DIFFER (floating-point differences between machines can change the "
          "annealing path; compare the Plan screen with docs/demo_numbers.md): " + "; ".join(differs))

    api._DEMO_CACHE.clear()      # what a freshly started engine has in memory: nothing
    api._REPLAY_CACHE.clear()
    print(f"check, as after a restart (in-process caches emptied; every call must answer within {WARM_MAX_S} s):")
    slow = [f"{m} {p}" for m, p, b in calls if call(m, p, b)[1] > WARM_MAX_S]
    n_files = len(list(demo_cache.cache_dir().glob("*.json")))
    print(f"{n_files} optimizer result(s) on disk in {demo_cache.cache_dir()}")
    if slow or n_files < 2:
        print(f"NOT WARM: slow={slow}, optimizer results on disk={n_files} (need 2)", file=sys.stderr)
        return 1
    print("warm_build: a cold-started engine answers every demo call from the cache")
    return 0


if __name__ == "__main__":
    sys.exit(main())
