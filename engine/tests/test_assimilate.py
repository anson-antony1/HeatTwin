"""weather.assimilate_env / node_hour with synthetic node readings (synthetic: true — not field data)."""
from datetime import datetime

import pytest

from engine import consts, fixtures, weather

LAT, LON = 29.6516, -82.3248


@pytest.fixture
def forecast():
    return fixtures.forecast()          # curated NWS fixture, 10:00-19:00 on 2026-10-04


def reading(ts, air=31.0, rh=70.0, globe=45.0, **kw):
    return {"node_id": "node-1", "ts": ts, "air_temp_c": air, "rh_pct": rh, "globe_temp_c": globe,
            "tub_temp_c": None, "wind_m_s": None, "battery_v": 4.1, "synthetic": True, **kw}


def by_time(hours):
    return {h["time"][11:16]: h for h in hours}


def test_no_readings_is_identity(forecast):
    assert weather.assimilate_env(forecast, [], LAT, LON) == sorted(forecast, key=lambda h: h["time"])


def test_observed_hour_and_decaying_bias(forecast):
    rs = [reading(f"2026-10-04T13:{m:02d}:00-04:00") for m in (5, 20, 35, 50)]
    pts = [weather.node_reading_wbgt(r, forecast, LAT, LON) for r in rs]
    out = by_time(weather.assimilate_env(forecast, rs, LAT, LON))
    orig = by_time(forecast)
    decay_h = consts.get("assimilation.decay_h")

    # hour with readings = what the node measured
    assert out["13:00"]["source"] == "field_node" and out["13:00"]["n_node_readings"] == 4
    assert out["13:00"]["wbgt_f"] == pytest.approx(sum(p["node_wbgt_f"] for p in pts) / 4, abs=0.05)
    assert out["13:00"]["air_temp_c"] == pytest.approx(31.0)

    # later hours: forecast + bias, weight falls linearly to 0 by decay_h after the last reading (13:50)
    bias = sum(p["node_wbgt_f"] - p["forecast_wbgt_f"] for p in pts) / 4
    for hh in ("14:00", "15:00", "16:00"):
        h = out[hh]
        dt_h = (datetime.fromisoformat(h["time"]) - datetime.fromisoformat(rs[-1]["ts"])).total_seconds() / 3600
        w = max(0.0, 1 - dt_h / decay_h)
        assert h["source"] == "assimilated"
        assert h["bias_wbgt_f"] == pytest.approx(bias * w, abs=0.01)
        assert h["wbgt_f"] == pytest.approx(orig[hh]["wbgt_f"] + bias * w, abs=0.06)
    assert abs(out["14:00"]["bias_wbgt_f"]) > abs(out["16:00"]["bias_wbgt_f"])

    # past the horizon, and before the readings: untouched
    for hh in ("17:00", "18:00", "10:00", "12:00"):
        assert out[hh] == orig[hh]


def test_zone_recomputed(forecast):
    hot = [reading(f"2026-10-04T13:{m:02d}:00-04:00", air=34.0, rh=75.0, globe=55.0) for m in (0, 30)]
    out = by_time(weather.assimilate_env(forecast, hot, LAT, LON))
    from engine import fhsaa
    for h in out.values():
        assert h["fhsaa_zone"] == fhsaa.zone(h["wbgt_f"])
    assert out["13:00"]["wbgt_f"] > by_time(forecast)["13:00"]["wbgt_f"]


def test_bad_or_out_of_range_readings_ignored(forecast):
    rs = [reading("2026-10-04T13:00:00-04:00", globe=None), reading("2026-10-05T13:00:00-04:00")]
    assert weather.assimilate_env(forecast, rs, LAT, LON) == sorted(forecast, key=lambda h: h["time"])


def test_node_hour_shape(forecast):
    h = weather.node_hour(reading("2026-10-04T15:02:00-04:00"), forecast, LAT, LON)
    assert h["source"] == "field_node" and h["fhsaa_zone"] in (1, 2, 3, 4, 5)
    assert {"time", "air_temp_c", "rh_pct", "wind_m_s", "cloud_cover_pct", "wbgt_f", "solar_w_m2"} <= set(h)
    assert h["solar_w_m2"] > 0
