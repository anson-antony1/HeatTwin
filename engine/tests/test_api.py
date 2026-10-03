"""POST /simulate and POST /optimize on fixtures (FastAPI TestClient, no network)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from engine import fixtures
from engine.api import app

client = TestClient(app)


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
    assert api.weather_mode(demo=True) == "fixture" and api.weather_mode() == "live"
