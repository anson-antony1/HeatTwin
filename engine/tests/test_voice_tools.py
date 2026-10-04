"""Engine voice tools (what_if, athlete_status, field_conditions): numbers + engine-written, guarded sentences."""
from __future__ import annotations

from fastapi.testclient import TestClient

from engine import guard
from engine.api import app

c = TestClient(app)


def test_what_if_remove_gassers_lowers_team_peak():
    r = c.post("/what_if", json={"change": {"drill_id": "d6", "remove": True}}).json()
    assert r["delta_team_mean_p95_c"] < 0
    assert r["after"]["practice_min"] == r["before"]["practice_min"] - 12
    assert guard.check(r["say"], log=False)["ok"] and "estimate — planning only" in r["labels"]


def test_what_if_gear_and_add_break_and_errors():
    g = c.post("/what_if", json={"change": {"drill_id": "d4", "gear": "helmet"}}).json()
    assert g["after"]["team_mean_p95_c"] <= g["before"]["team_mean_p95_c"]
    b = c.post("/what_if", json={"change": {"add_break_after": "d3", "minutes": 8}}).json()
    assert b["after"]["practice_min"] == b["before"]["practice_min"] + 8
    assert c.post("/what_if", json={"change": {"drill_id": "nope", "remove": True}}).status_code == 404


def test_athlete_status_by_name_or_id():
    a = c.get("/athlete_status", params={"athlete_id": "Isaiah"}).json()
    b = c.get("/athlete_status", params={"athlete_id": "a07"}).json()
    assert a["id"] == b["id"] == "a07" and a["peak_p95_c"] >= a["peak_p50_c"]
    assert guard.check(a["say"], log=False)["ok"]
    assert c.get("/athlete_status", params={"athlete_id": "Nobody"}).status_code == 404


def test_field_conditions_hours_and_source(monkeypatch):
    from engine import weather

    def no_network(*_a, **_k):  # with WS1 merged the route would fetch the live NWS forecast
        raise OSError("network disabled in tests")

    monkeypatch.setattr(weather, "get_forecast", no_network)
    f = c.get("/field_conditions").json()
    assert [h["fhsaa_zone"] for h in f["hours"]] == [2, 2, 1]
    assert "forecast is fixture" in f["labels"] and guard.check(f["say"], log=False)["ok"]
