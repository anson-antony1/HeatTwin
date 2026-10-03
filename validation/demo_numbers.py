"""Demo-mode numbers the app shows and speaks, computed by the engine API on the fixture inputs.

    python -m validation.demo_numbers            # prints, and writes validation/results.json["demo"]
    python -m validation.demo_numbers --check    # exit 1 if the engine no longer reproduces results.json["demo"]

These are NOT validation against measurements: the plan and roster are synthetic fixtures, the forecast is a cached NWS
forecast, and the HR replay is the synthetic a07 file unless a real recording is in fixtures/. The block is labelled
``synthetic: true``. The end-to-end test (web + voice) compares what the app displays and says with these numbers.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "validation" / "results.json"


def compute() -> dict[str, Any]:
    from fastapi.testclient import TestClient

    from engine.api import app
    from engine.voice_tools import _summary

    c = TestClient(app)
    inputs = c.get("/demo/inputs").json()
    sim = c.post("/simulate?demo=1", json={}).json()
    out: dict[str, Any] = {
        "computed_by": "validation/demo_numbers.py via the engine API with ?demo=1",
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "synthetic": True,
        "inputs": {"plan_id": inputs["plan"]["id"], "athletes": len(inputs["roster"]), "synthetic": inputs["synthetic"],
                   "labels": inputs["labels"]},
        "simulate": {**_summary(sim), "athletes_detail": {
            a["id"]: {"peak_p95_c": round(a["peak_core_c_p95"], 2), "peak_p50_c": round(max(a["core_c_p50"]), 2),
                      "status": a["status"], "first_cross_min": a["first_cross_min"]} for a in sim["athletes"]}},
        "optimize": {},
    }
    for preset in ("max_load", "fewest_changes"):
        o = c.post(f"/optimize?demo=1&preset={preset}", json={}).json()
        out["optimize"][preset] = {"feasible": o["feasible"], "load_kept_pct": o["load_kept_pct"],
                                   "changes": len(o["changes"]), "after": _summary(o["optimized"]),
                                   "top_changes_text": o.get("top_changes_text", ""),
                                   "notes": [x for x in o.get("labels", []) if x.startswith("fewest_changes:")]}
    r = c.post("/live/replay?demo=1", json={}).json()
    last = r["frames"][-1] if r["frames"] else None
    out["replay"] = {**r["source"], "frames": len(r["frames"]), "labels": r["labels"],
                     "last_frame": None if last is None else {
                         "minute": last["minute"], "athlete_id": last["athlete_id"], "met_scale": last["calib"]["met_scale"],
                         "peak_p95_c": round(last["athlete"]["peak_core_c_p95"], 2), "status": last["athlete"]["status"],
                         "gate_message": last["gates"].get("message")}}
    f = c.get("/field_conditions").json()
    out["field_conditions"] = {"hours": f["hours"], "sources": f["sources"]}
    out["node_latest"] = c.get("/node/latest").json()
    return out


def _comparable(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if k not in ("computed_at",)}


def main() -> None:
    new = compute()
    results = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    if "--check" in sys.argv:
        old = results.get("demo")
        same = old is not None and _comparable(old) == _comparable(new)
        print("demo numbers reproduce results.json" if same else "demo numbers DIFFER from results.json")
        sys.exit(0 if same else 1)
    results["demo"] = new
    RESULTS.write_text(json.dumps(results, indent=2) + "\n")
    s, m = new["simulate"], new["optimize"]["max_load"]
    print(f"plan: {s['over_limit']}/{s['athletes']} over {s['limit_c']} °C (p95), max p95 {s['max_p95_c']} °C, "
          f"{s['fhsaa_violations']} FHSAA issues")
    print(f"optimize max_load: feasible={m['feasible']} load {m['load_kept_pct']}% changes {m['changes']} "
          f"over after {m['after']['over_limit']} max p95 {m['after']['max_p95_c']} practice {m['after']['practice_min']} min")
    print(f"replay: {new['replay']['file']} synthetic={new['replay']['synthetic']} frames={new['replay']['frames']}")
    print(f"node: {new['node_latest']['labels']}")


if __name__ == "__main__":
    main()
