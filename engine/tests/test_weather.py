"""weather.py: NWS gridpoint parsing (offline, against the cached raw fixture) and fixture fallback."""
import json
from datetime import datetime

import pytest

from engine import fixtures, weather

RAW = fixtures.FIXTURES / "nws_raw" / "JAX_43_32_update_2026-10-03T1207Z.json"
LAT, LON = 29.6516, -82.3248


@pytest.fixture(scope="module")
def raw():
    return json.loads(RAW.read_text())


def test_parse_matches_curated_fixture(raw):
    """Same raw file, same unit conversions → same values as Anson's curated forecast fixture."""
    ours = {h["time"]: h for h in weather.hours_from_gridpoint(raw, "America/New_York")}
    for h in fixtures.forecast():
        o = ours[h["time"]]
        assert o["air_temp_c"] == pytest.approx(h["air_temp_c"], abs=0.01)
        assert o["rh_pct"] == pytest.approx(h["rh_pct"])
        assert o["wind_m_s"] == pytest.approx(h["wind_m_s"], abs=0.01)
        assert o["cloud_cover_pct"] == pytest.approx(h["cloud_cover_pct"])
        assert o["nws_wbgt_f"] == pytest.approx(h["wbgt_f"], abs=0.05)


def test_hours_are_contract_shaped_and_hourly(raw):
    hours = weather.add_wbgt(weather.hours_from_gridpoint(raw, "America/New_York"), LAT, LON)
    assert len(hours) > 24
    ts = [datetime.fromisoformat(h["time"]) for h in hours]
    assert all((b - a).total_seconds() == 3600 for a, b in zip(ts, ts[1:]))
    for h in hours:
        assert {"time", "air_temp_c", "rh_pct", "wind_m_s", "cloud_cover_pct", "wbgt_f", "fhsaa_zone", "source"} <= set(h)
        assert h["fhsaa_zone"] in (1, 2, 3, 4, 5)
        assert h["source"] == "nws_forecast"
        assert 0 <= h["rh_pct"] <= 100 and 0 <= h["cloud_cover_pct"] <= 100 and h["wind_m_s"] >= 0
        assert datetime.fromisoformat(h["time"]).utcoffset() is not None


def test_window(raw):
    start = datetime.fromisoformat("2026-10-04T10:00:00-04:00")
    end = datetime.fromisoformat("2026-10-04T13:00:00-04:00")
    hours = weather.hours_from_gridpoint(raw, "America/New_York", start, end)
    assert [h["time"] for h in hours] == ["2026-10-04T10:00:00-04:00", "2026-10-04T11:00:00-04:00",
                                          "2026-10-04T12:00:00-04:00"]


def test_duration_expansion():
    layer = {"uom": "wmoUnit:degC", "values": [
        {"validTime": "2026-10-03T06:00:00+00:00/P1DT2H", "value": 20.0},
        {"validTime": "2026-10-04T08:00:00+00:00/PT1H", "value": None},
    ]}
    assert len(weather._expand(layer)) == 26


def test_fixture_fallback_when_network_fails(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise ConnectionError("offline")
    monkeypatch.setattr(weather, "fetch_gridpoint", boom)
    monkeypatch.setattr(weather, "CACHE_DIR", tmp_path)  # no cached live forecasts → curated fixture
    hours = weather.get_forecast(LAT, LON)
    assert hours and all(h["source"] == "fixture" for h in hours)
    assert hours[0]["time"] == fixtures.forecast()[0]["time"]


def test_fallback_prefers_newest_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(weather, "CACHE_DIR", tmp_path)
    for day, temp in (("2026-10-01", 20.0), ("2026-10-02", 25.0)):
        (tmp_path / f"forecast_{day}.json").write_text(json.dumps({"hours": [
            {"time": f"{day}T12:00:00-04:00", "air_temp_c": temp, "rh_pct": 50, "wind_m_s": 1, "cloud_cover_pct": 0,
             "wbgt_f": 80.0, "fhsaa_zone": 1, "source": "nws_forecast"}]}))
    hours = weather.get_forecast(LAT, LON, offline=True)
    assert hours[0]["air_temp_c"] == 25.0 and hours[0]["source"] == "fixture"
