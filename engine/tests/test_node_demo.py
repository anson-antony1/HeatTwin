"""Indoor node demo (constants.demo_node, synthetic): heating the globe raises field WBGT and athletes' estimates."""
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from engine import consts, node_bridge, node_routes
from engine.api import app

c = TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    node_routes.reset()
    yield
    node_routes.reset()


def feed(sc, globe_c):
    row = sc.row({"globe_c": globe_c, "globe_ohm": 9000.0}, datetime.now().astimezone())
    return c.post("/node", json=node_bridge.node_payload(row)).json() if row else None


def warmed():
    sc = node_bridge.DemoScenario()
    for _ in range(consts.get("demo_node.baseline_samples")):
        assert feed(sc, 25.9) is None                       # zeroing on the room
    return sc


def test_baseline_is_configured_wbgt_and_labelled():
    sc = warmed()
    r = feed(sc, 25.9)
    assert r["field"]["wbgt_f"] == pytest.approx(consts.get("demo_node.baseline_wbgt_f"), abs=0.2)
    assert node_routes.DEMO_LABEL in r["labels"] and r["field"]["synthetic"] is True


def test_heat_raises_wbgt_zone_and_core_estimates():
    sc = warmed()
    peaks, wbgts = [], []
    for g in (25.9, 38.0, 50.0):
        r = feed(sc, g)
        wbgts.append(r["field"]["wbgt_f"])
        sim = c.post("/simulate?source=node", json={}).json()   # explicit: the node demo's scenario weather
        assert node_routes.DEMO_LABEL in sim["labels"]
        peaks.append(max(a["peak_core_c_p95"] for a in sim["athletes"]))
    assert wbgts[0] < wbgts[1] < wbgts[2]
    assert peaks[0] < peaks[1] < peaks[2]


def test_live_session_reforecast_on_change():
    sc = warmed()
    feed(sc, 25.9)
    c.post("/live/start", json={})
    r = feed(sc, 45.0)                                      # big change → reforecast returned
    assert "reforecast" in r and node_routes.DEMO_LABEL in r["reforecast"]["labels"]
    for _ in range(3):                                      # let the 3-reading smoothing settle
        feed(sc, 45.0)
    r2 = feed(sc, 45.1)                                     # tiny change → no recompute
    assert "reforecast" not in r2


def test_demo_stops_when_readings_stop(monkeypatch):
    sc = warmed()
    feed(sc, 40.0)
    assert node_routes.demo_active()
    monkeypatch.setattr(node_routes, "_demo", {**node_routes._demo, "received": 0.0})
    assert not node_routes.demo_active() and node_routes.demo_version() == 0
    sim = c.post("/simulate?source=node", json={}).json()
    assert node_routes.DEMO_LABEL not in sim["labels"]


def test_demo_mode_stays_pinned_while_the_node_demo_runs():
    """?demo=1 always uses the pinned saved forecast; plain requests without ?source=node ignore the scenario."""
    sc = warmed()
    feed(sc, 50.0)
    assert node_routes.demo_active()
    pinned = c.post("/simulate?demo=1", json={}).json()
    also_pinned = c.post("/simulate?demo=1&source=node", json={}).json()
    plain = c.post("/simulate", json={}).json()
    for sim in (pinned, also_pinned, plain):
        assert node_routes.DEMO_LABEL not in sim["labels"] and "forecast is fixture" in sim["labels"]
    assert [a["peak_core_c_p95"] for a in pinned["athletes"]] == [a["peak_core_c_p95"] for a in also_pinned["athletes"]]


class _FakeStation:
    """Stands in for AirSource: a fixed station observation (no network)."""
    station = "KGNV"

    def _station_obs(self):
        return {"air_c": 26.0, "rh_pct": 89.0, "wind_m_s": 2.0, "observed_at": "2026-10-03T23:00:00+00:00"}


def test_station_air_mode_uses_real_air_and_only_sun_from_globe():
    sc = node_bridge.DemoScenario(_FakeStation(), "station")
    for _ in range(consts.get("demo_node.baseline_samples")):
        sc.row({"globe_c": 22.0, "globe_ohm": 12000.0}, datetime.now().astimezone())
    cool = sc.row({"globe_c": 22.0, "globe_ohm": 12000.0}, datetime.now().astimezone())
    hot = sc.row({"globe_c": 40.0, "globe_ohm": 5000.0}, datetime.now().astimezone())
    assert cool["air_c"] == 26.0 and cool["rh_pct"] == 89.0 and cool["air_source"] == "nws_station_KGNV"
    assert cool["globe_c"] == 26.0                          # room baseline maps to "globe = air" (no sun)
    assert hot["node_wbgt_f"] > cool["node_wbgt_f"] + 5 and hot["solar_inferred_w_m2"] > cool["solar_inferred_w_m2"]
    assert node_bridge.node_payload(hot)["wind_10m_m_s"] == 2.0


def test_web_sensor_path_uses_sensor_weather():
    """The web's sensor path (/simulate?source=node, no ?demo=1): same seed/ensemble as demo mode, sensor weather."""
    sc = warmed()
    feed(sc, 45.0)
    pinned = c.post("/simulate?demo=1", json={}).json()
    sensor = c.post("/simulate?source=node", json={}).json()
    assert node_routes.DEMO_LABEL in sensor["labels"] and node_routes.DEMO_LABEL not in pinned["labels"]
    assert {h["source"] for h in sensor["weather"]} == {"field_node"}


def test_bridge_sends_engine_zone_to_leds(tmp_path, monkeypatch):
    sent = []

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"ok": True, "field": {"fhsaa_zone": 4}}
    import requests
    monkeypatch.setattr(requests, "post", lambda *a, **k: Resp())
    lines = [f"{i},500.0,10000,25.00,0.0,nan,nan" for i in range(8)]
    node_bridge.run(lines, "replay", post_url="http://x/node", out_dir=tmp_path, offline=True, demo=True,
                    air_mode="scenario", send_zone=sent.append)
    assert sent and set(sent) == {4}                        # LEDs follow the engine's zone, not the local one
