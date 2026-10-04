"""POST /simulate and POST /optimize on fixtures (FastAPI TestClient, no network)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine import fixtures
from engine.api import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """Keep these tests off the network: with WS1 merged, /simulate would otherwise fetch the live NWS forecast."""
    from engine import weather

    def no_network(*_a, **_k):
        raise OSError("network disabled in tests")

    monkeypatch.setattr(weather, "get_forecast", no_network)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_simulate_defaults_to_fixtures_and_labels_them():
    r = client.post("/simulate", json={})
    assert r.status_code == 200
    res = r.json()
    assert res["plan_id"] == fixtures.plan()["id"]
    assert len(res["athletes"]) == len(fixtures.roster())
    for lab in ("estimate — planning only", "synthetic roster", "forecast is fixture"):
        assert lab in res["labels"]
    assert res["model"]["name"] == "twonode-v1"


def test_simulate_with_explicit_body():
    body = {"plan": fixtures.plan(), "roster": fixtures.roster()[:3], "weather": fixtures.forecast(), "n_ensemble": 10}
    r = client.post("/simulate", json=body)
    assert r.status_code == 200
    res = r.json()
    assert [a["id"] for a in res["athletes"]] == [a["id"] for a in fixtures.roster()[:3]]
    assert "synthetic roster" not in res["labels"]


def test_simulate_rejects_bad_shapes():
    plan = fixtures.plan()
    plan["drills"][0]["intensity"] = "extreme"
    assert client.post("/simulate", json={"plan": plan}).status_code == 422
    plan = fixtures.plan()
    plan["drills"][1]["participants"] = ["nobody"]
    assert client.post("/simulate", json={"plan": plan}).status_code == 422


def test_optimize_endpoint_small_budget():
    body = {"roster": fixtures.roster()[:4], "n_ensemble": 10, "budget_s": 3}
    r = client.post("/optimize", json=body)
    assert r.status_code == 200
    res = r.json()
    for key in ("original", "optimized", "plan", "changes", "load_kept_pct", "feasible", "search"):
        assert key in res
    assert res["search"]["seconds"] <= 3 + 2.0
    assert "estimate — planning only" in res["labels"]


def test_sources_lists_statuses():
    res = client.get("/sources").json()
    assert res["planning_limit_core_c"]["status"] == "VERIFIED"
    assert "gagge_1986" in res


def test_settings_endpoint_and_overrides():
    rows = {r["key"]: r for r in client.get("/settings").json()["settings"]}
    assert rows["planning_limit_core_c"]["default"] == 39.0 and rows["planning_limit_core_c"]["owner"] == "athletic trainer"
    assert rows["clothing_mode"]["value"] == "conservative"
    body = {"roster": fixtures.roster()[:2], "n_ensemble": 5, "settings": {"planning_limit_core_c": 38.5}}
    res = client.post("/simulate", json=body).json()
    assert res["limit_core_c"] == 38.5
    assert any("planning limit 38.5 °C (set by AT" in lab for lab in res["labels"])
    res = client.post("/simulate", json={"roster": fixtures.roster()[:2], "n_ensemble": 5}).json()
    assert any("planning limit 39.0 °C (default" in lab for lab in res["labels"])
    assert client.post("/simulate", json={"settings": {"planning_limit_core_c": 41.0}}).status_code == 422
    assert client.post("/simulate", json={"settings": {"bogus": 1}}).status_code == 422


def test_demo_mode_is_reproducible():
    body = {"roster": fixtures.roster()[:4]}
    a = client.post("/optimize?demo=1", json=body).json()
    b = client.post("/optimize?demo=1", json=body).json()
    assert a["search"]["demo"] is True and a["search"]["stopped_by"] == "iterations"
    assert a["plan"] == b["plan"] and a["changes"] == b["changes"]
    assert any(lab.startswith("demo mode:") for lab in a["labels"])
    s1 = client.post("/simulate?demo=1", json=body).json()
    s2 = client.post("/simulate?demo=1", json=body).json()
    assert s1["athletes"] == s2["athletes"]


def test_demo_mode_pins_the_cached_forecast_even_with_live_weather_on(monkeypatch):
    """Item 7 (docs/AUDIT.md): ?demo=1 never fetches live NWS, so demo numbers are reproducible offline."""
    from engine import api
    monkeypatch.setenv("HEATTWIN_WEATHER", "live")
    calls = []
    import engine.weather as ws1
    monkeypatch.setattr(ws1, "get_forecast", lambda *a, **k: calls.append(a) or [])
    r = client.post("/simulate?demo=1", json={})
    assert r.status_code == 200
    assert calls == []
    labels = r.json()["labels"]
    assert "forecast is fixture" in labels
    assert "demo mode: forecast pinned to the cached NWS fixture" in labels
    assert api.weather_mode(demo_mode=True) == "fixture" and api.weather_mode() == "live"


def test_demo_inputs_match_what_demo_simulate_uses():
    """v1.3 /demo/inputs: the web shows the same plan/roster/weather the engine simulates."""
    d = client.get("/demo/inputs").json()
    sim = client.post("/simulate?demo=1", json={}).json()
    assert d["plan"]["id"] == sim["plan_id"]
    assert [a["id"] for a in d["roster"]] == [a["id"] for a in sim["athletes"]]
    assert d["synthetic"] == {"plan": True, "roster": True, "weather": False}   # cached real NWS forecast
    assert "forecast is fixture" in d["labels"] and "synthetic roster" in d["labels"]
    sim2 = client.post("/simulate?demo=1", json={"plan": d["plan"], "roster": d["roster"], "weather": d["weather"]}).json()
    assert [a["peak_core_c_p95"] for a in sim2["athletes"]] == [a["peak_core_c_p95"] for a in sim["athletes"]]


def test_live_replay_synthetic_fixture_is_labelled_and_deterministic():
    r = client.post("/live/replay?demo=1", json={"file": "hr_a07_synthetic.csv"})
    assert r.status_code == 200
    j = r.json()
    assert j["source"]["synthetic"] is True and j["source"]["file"].endswith("hr_a07_synthetic.csv")
    assert "replay" in j["labels"] and "synthetic HR (not a real athlete)" in j["labels"]
    assert j["frames"] and all(f["athlete_id"] == "a07" for f in j["frames"])
    assert [f["minute"] for f in j["frames"]] == sorted(f["minute"] for f in j["frames"])
    assert j["plan_forecast"]["plan_id"] == "plan-demo-1"
    assert client.post("/live/replay?demo=1", json={"file": "hr_a07_synthetic.csv"}).json()["frames"] == j["frames"]


def test_node_latest_without_recording_has_no_numbers(monkeypatch, tmp_path):
    from engine import demo_data
    monkeypatch.setattr(demo_data, "DATA", tmp_path)
    from engine import node_routes
    node_routes.reset()
    j = client.get("/node/latest").json()
    assert j == {"reading": None, "series": [], "file": None, "labels": ["no field recording yet"]}


def test_node_latest_reads_newest_node_csv(monkeypatch, tmp_path):
    from engine import demo_data, node_bridge
    monkeypatch.setattr(demo_data, "DATA", tmp_path)
    from engine import node_routes
    node_routes.reset()
    rows = [{"ts": "2026-10-04T15:30:05-04:00", "globe_c": 45.0, "globe_ohm": 1, "air_c": 31.0, "rh_pct": 60, "wind_m_s": "",
             "air_source": "KGNV", "node_wbgt_f": 88.1, "forecast_wbgt_f": 86.0, "field_minus_forecast_f": 2.1,
             "fhsaa_zone": 3, "solar_inferred_w_m2": 700, "globe_calibrated": "false", "mode": "live"}]
    import csv
    with open(tmp_path / "node_2026-10-04.csv", "w", newline="") as f:
        w = csv.DictWriter(f, node_bridge.FIELDS)
        w.writeheader()
        w.writerows(rows)
    j = client.get("/node/latest").json()
    assert j["reading"]["node_wbgt_f"] == 88.1 and j["reading"]["field_minus_forecast_f"] == 2.1
    assert "globe thermistor uncalibrated" in j["labels"] and j["file"] == "data/node_2026-10-04.csv"


def test_demo_comparison_serves_the_stored_snapshot():
    """v1.4 GET /demo/comparison: the snapshot written by scripts/demo_numbers.py (no network at request time)."""
    from pathlib import Path
    if not (Path(__file__).resolve().parents[2] / "docs" / "demo_numbers.json").exists():
        assert client.get("/demo/comparison").status_code == 404
        return
    j = client.get("/demo/comparison").json()
    assert j["headline"] == "saved_forecast" and j["rows"][0]["key"] == "saved_forecast"
    assert {"peak_zone", "over_before", "over_after", "load_kept_pct", "changes", "feasible"} <= set(j["rows"][0])


def test_real_hr_recording_wins_and_is_labelled_with_device_and_date(monkeypatch, tmp_path):
    """Decision 7: a real fixtures/hr_<date>.csv (hr_bridge) is replayed instead of the synthetic file, labelled."""
    import shutil
    from engine import demo_data
    shutil.copy(demo_data.FIXTURES / demo_data.SYNTHETIC_HR, tmp_path / demo_data.SYNTHETIC_HR)
    real = tmp_path / "hr_2026-10-04.csv"
    real.write_text("# recorded by engine/hr_bridge.py from BLE heart-rate straps (real data, not synthetic).\n"
                    "ts,athlete_id,hr_bpm,device,replay,synthetic,rr_ms,sensor_contact\n"
                    + "".join(f"2026-10-04T09:{m:02d}:00-04:00,a07,{110 + m},Amazfit Helio Strap,false,false,,true\n"
                              for m in range(30)))
    monkeypatch.setattr(demo_data, "FIXTURES", tmp_path)
    assert demo_data.pick_hr_file() == real and not demo_data.hr_is_synthetic(real)
    r = client.post("/live/replay?demo=1", json={}).json()   # same body as the cached synthetic run: the file is in the key
    assert r["source"]["synthetic"] is False and r["source"]["aligned_to_plan_start"] is True
    assert any("real HR recording — Amazfit Helio Strap, 2026-10-04" in x for x in r["labels"])
    assert not any("synthetic HR" in x for x in r["labels"])


def test_field_node_results_only_from_real_rows(tmp_path):
    from validation import field_node
    from engine import demo_data, node_bridge
    import csv
    orig = demo_data.DATA
    try:
        assert field_node.compute(tmp_path)["status"] == "no field recording yet"
        with open(tmp_path / "node_2026-10-04.csv", "w", newline="") as f:
            w = csv.DictWriter(f, node_bridge.FIELDS)
            w.writeheader()
            for i, (mode, wb) in enumerate([("demo", 95.0), ("live", 84.0), ("live", 86.0)]):
                w.writerow({"ts": f"2026-10-04T09:0{i}:00-04:00", "globe_c": 40, "air_c": 30, "rh_pct": 70,
                            "air_source": "nws_station_KGNV", "node_wbgt_f": wb, "forecast_wbgt_f": 83.0,
                            "field_minus_forecast_f": wb - 83.0, "fhsaa_zone": 2, "globe_calibrated": "False",
                            "mode": mode})
        out = field_node.compute(tmp_path)
        assert out["n_readings"] == 2 and out["by_hour"][0]["node_wbgt_f"] == 85.0          # demo row excluded
        assert out["mean_field_minus_liljegren_f"] == 2.0 and "globe thermistor uncalibrated" in out["labels"]
    finally:
        demo_data.DATA = orig


def test_demo_optimize_result_survives_an_engine_restart_via_the_disk_cache(monkeypatch, tmp_path):
    """Owner decision Oct 3 (item 5): the warmed demo optimizer result is persisted, keyed by inputs + code version."""
    from engine import api, demo_cache, optimizer
    monkeypatch.setenv("HEATTWIN_CACHE_DIR", str(tmp_path))
    calls = []
    real = optimizer.optimize

    def fake(*a, **k):
        calls.append(k.get("preset"))
        return real(*a, **{**k, "demo": False, "budget_s": 2.0, "max_iterations": 20})
    monkeypatch.setattr(optimizer, "optimize", fake)
    body = {"plan": {**fixtures.plan(), "id": "cache-test"}}
    first = client.post("/optimize?demo=1", json=body).json()
    assert calls == ["max_load"] and len(list(tmp_path.glob("*.json"))) == 1
    api._DEMO_CACHE.clear()                       # "restart": the in-memory cache is gone
    second = client.post("/optimize?demo=1", json=body).json()
    assert calls == ["max_load"] and second == first
    monkeypatch.setattr(demo_cache, "code_version", lambda: "different-code")   # a code change misses the cache
    api._DEMO_CACHE.clear()
    client.post("/optimize?demo=1", json=body)
    assert calls == ["max_load", "max_load"]


def test_live_state_shows_the_strap_reading_and_reforecast():
    """final-ui live HR: /live/start (now) → hr_bridge POST /hr → the web polls GET /live/state."""
    from datetime import datetime, timedelta
    assert client.post("/live/start", json={"start_now": True}).status_code == 200
    st = client.get("/live/state").json()
    assert st["active"] is True and st["receiving"] is False and st["reforecast"]["athletes"]
    now = datetime.now().astimezone()
    for k, bpm in enumerate([132, 141]):
        ts = (now - timedelta(seconds=60 * (1 - k))).isoformat()
        r = client.post("/hr", json={"athlete_id": "a07", "ts": ts, "hr_bpm": bpm, "device": "Helio Strap 1A2B"})
        assert r.status_code == 200
    st = client.get("/live/state").json()
    a = st["athletes"]["a07"]
    assert st["receiving"] is True and a["hr_bpm"] == 141 and a["device"] == "Amazfit Helio Strap"
    assert "live · Amazfit Helio Strap" in st["labels"]
    assert a["athlete"]["core_c_p50"] and a["calib"]["met_scale"] > 0


def test_live_replay_source_label_says_what_is_replayed():
    j = client.post("/live/replay?demo=1", json={"file": "hr_a07_synthetic.csv"}).json()
    assert j["source"]["label"] == "replay · synthetic HR file (not a real athlete)" and j["source"]["date"] is None
    from engine import demo_data
    real = sorted(p for p in demo_data.FIXTURES.glob("hr_*.csv") if not demo_data.hr_is_synthetic(p))
    d = client.post("/live/replay?demo=1", json={}).json()["source"]   # default: newest real recording, else synthetic
    if real:
        assert d["synthetic"] is False and d["label"] == f"replay · {d['date']} · {d['device']}"
    else:
        assert d["synthetic"] is True
