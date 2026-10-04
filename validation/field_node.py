"""Field node vs forecast WBGT, from the newest real recording in data/node_<date>.csv (engine/node_bridge.py).

    python -m validation.field_node      # prints, and writes validation/results.json["field_node"]

Only field readings count (node_bridge mode "live" or "replay"); the indoor DEMO scenario (mode "demo") is synthetic
and ignored. For each clock hour: mean node WBGT, the forecast WBGT node_bridge logged next to it (our Liljegren on the
NWS forecast at logging time), and — when a cached NWS forecast for that date carries NWS's own WBGT layer — NWS's value
too. The globe thermistor is uncalibrated and air/RH may come from the KGNV airport station; both are labelled. With no
recording, the block says so and holds no numbers.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "validation" / "results.json"


def _nws_wbgt_by_hour(date: str) -> dict[str, float]:
    """NWS's own WBGT layer for that date from any cached NWS forecast in fixtures/ (hour 'HH' → °F)."""
    out: dict[str, float] = {}
    for p in sorted((ROOT / "fixtures").glob("**/forecast_*.json")):
        try:
            d = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        hours = d.get("hours", d if isinstance(d, list) else [])
        for h in hours:
            if not isinstance(h, dict) or not str(h.get("time", "")).startswith(date):
                continue
            v = h.get("nws_wbgt_f")
            if v is None and "NWS wetBulbGlobeTemperature" in str(d.get("note", "")):
                v = h.get("wbgt_f")      # the pinned fixture stores NWS's layer as wbgt_f
            if v is not None:
                out[h["time"][11:13]] = float(v)
    return out


def compute(data_dir: Optional[Path] = None) -> dict[str, Any]:
    from engine import demo_data
    if data_dir is not None:
        demo_data.DATA = data_dir
    path = demo_data.newest_node_csv(real_only=True)
    if path is None:
        return {"status": demo_data.NO_FIELD, "synthetic": False}
    rows = demo_data.field_rows(demo_data._read_node_csv(path))
    date = str(rows[0]["ts"])[:10]
    nws = _nws_wbgt_by_hour(date)
    by_h: dict[str, list] = defaultdict(list)
    for r in rows:
        node, fc = demo_data._num(r.get("node_wbgt_f")), demo_data._num(r.get("forecast_wbgt_f"))
        if node is not None:
            by_h[str(r["ts"])[11:13]].append((node, fc))
    table = []
    for h in sorted(by_h):
        node = round(mean(x[0] for x in by_h[h]), 1)
        fcs = [x[1] for x in by_h[h] if x[1] is not None]
        fc = round(mean(fcs), 1) if fcs else None
        table.append({"hour": f"{h}:00", "n": len(by_h[h]), "node_wbgt_f": node, "forecast_liljegren_f": fc,
                      "field_minus_liljegren_f": round(node - fc, 1) if fc is not None else None,
                      "nws_wbgt_f": nws.get(h), "field_minus_nws_f": round(node - nws[h], 1) if h in nws else None})
    diffs = lambda k: [t[k] for t in table if t[k] is not None]  # noqa: E731
    sources = sorted({str(r.get("air_source")) for r in rows if r.get("air_source")})
    labels = [f"field node recording — {date}, node-1 black-globe node (data/{path.name})",
              "not a certified WBGT meter"]
    if any(str(r.get("globe_calibrated", "")).lower() != "true" for r in rows):
        labels.append("globe thermistor uncalibrated")
    if sources:
        labels.append(f"air temperature / humidity from {', '.join(sources)}")
    if any(str(r.get("mode")) == "replay" for r in rows):
        labels.append("replay of saved serial output")
    return {"computed_by": "validation/field_node.py", "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "synthetic": False, "file": f"data/{path.name}", "date": date, "n_readings": len(rows), "by_hour": table,
            "mean_field_minus_liljegren_f": round(mean(diffs("field_minus_liljegren_f")), 2) if diffs("field_minus_liljegren_f") else None,
            "mean_field_minus_nws_f": round(mean(diffs("field_minus_nws_f")), 2) if diffs("field_minus_nws_f") else None,
            "labels": labels}


def main() -> None:
    out = compute()
    results = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    results["field_node"] = out
    RESULTS.write_text(json.dumps(results, indent=2) + "\n")
    if "status" in out:
        print(out["status"])
        return
    for t in out["by_hour"]:
        print(t)
    print(f"field − Liljegren {out['mean_field_minus_liljegren_f']} °F, field − NWS {out['mean_field_minus_nws_f']} °F")


if __name__ == "__main__":
    main()
