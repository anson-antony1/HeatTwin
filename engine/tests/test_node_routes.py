"""node_routes with the cached fixture forecast (no network); readings are synthetic."""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from engine import fixtures, node_routes


@pytest.fixture
def client(monkeypatch, tmp_path):
    from engine import demo_data
    hours = fixtures.forecast()
    monkeypatch.setattr(node_routes, "_forecast_hours", lambda: hours)
    monkeypatch.setattr(node_routes, "_forecast", {"hours": hours, "at": 0.0})
    monkeypatch.setattr(demo_data, "DATA", tmp_path)   # no data/node_*.csv fallback in tests
    node_routes.reset()
    return TestClient(node_routes.standalone_app()), hours


def reading(t, globe):
    return {"node_id": "node-1", "ts": t.isoformat(), "air_temp_c": 30.0, "rh_pct": 70.0, "globe_temp_c": globe,
            "tub_temp_c": None, "wind_m_s": None, "battery_v": None, "air_source": "nws_station_KGNV",
            "globe_calibrated": False, "synthetic": True}


def test_post_latest_history(client):
    c, hours = client
    # no readings and no data/node_*.csv: 200 with no numbers (the web says "no field recording yet")
    empty = c.get("/node/latest").json()
    assert empty.pop("source")["reading_age_s"] is None                 # v1.7 additive: no Arduino reading yet
    assert empty == {"reading": None, "series": [], "file": None, "labels": ["no field recording yet"]}
    t0 = datetime.fromisoformat(hours[3]["time"])
    for i, g in enumerate([35.0, 45.0, 50.0]):
        r = c.post("/node", json=reading(t0 + timedelta(minutes=i), g))
        assert r.status_code == 200 and r.json()["field"]["source"] == "field_node"
    latest = c.get("/node/latest").json()
    assert latest["reading"]["globe_temp_c"] == 50.0 and latest["reading"]["air_source"] == "nws_station_KGNV"
    assert latest["field"]["fhsaa_zone"] in (1, 2, 3, 4, 5) and "wbgt_f" in latest["field"]
    assert any(h["source"] == "field_node" for h in latest["assimilated"])
    # CONTRACTS v1.3 fields the web reads, alongside the raw reading
    v = latest["reading"]
    assert v["node_wbgt_f"] == latest["field"]["wbgt_f"] and v["globe_c"] == 50.0 and v["globe_calibrated"] is False
    assert v["field_minus_forecast_f"] == round(v["node_wbgt_f"] - v["forecast_wbgt_f"], 1)
    assert any("uncalibrated" in x for x in latest["labels"]) and any("not measured at the field" in x for x in latest["labels"])
    hist = c.get("/node/history", params={"minutes": 1.5}).json()["readings"]
    assert [h["globe_temp_c"] for h in hist] == [45.0, 50.0]
    assert hist[0]["wbgt_f"] < hist[1]["wbgt_f"]


def test_bad_readings_rejected(client):
    c, hours = client
    t0 = datetime.fromisoformat(hours[3]["time"])
    assert c.post("/node", json={**reading(t0, 40.0), "ts": "yesterday"}).status_code == 422
    assert c.post("/node", json={**reading(t0, 40.0), "globe_temp_c": None}).status_code == 422
    assert c.post("/node", json=reading(t0 + timedelta(days=30), 40.0)).status_code == 422
