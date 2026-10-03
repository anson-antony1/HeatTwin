"""wbgt.py: agreement with Liljegren's reference C code, physical sanity, node inversion round trip."""
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from engine import consts, wbgt

REF = Path(__file__).resolve().parents[2] / "validation" / "wbgt_reference" / "reference_cases.json"
LAT, LON = 29.6516, -82.3248
NOON = datetime.fromisoformat("2026-10-04T13:30:00-04:00")   # near solar noon in Gainesville
NIGHT = datetime.fromisoformat("2026-10-04T23:00:00-04:00")


@pytest.fixture(scope="module")
def ref():
    return json.loads(REF.read_text())


def test_matches_liljegren_reference_code(ref):
    """300 random cases tabulated from the compiled original C code (validation/wbgt_reference)."""
    errs = {"wbgt_c": [], "tnwb_c": [], "tg_c": [], "tpsy_c": []}
    for c in ref["cases"]:
        i, r = c["input"], c["reference"]
        o = wbgt.wbgt_components(i["air_c"], i["rh"], i["wind"], i["solar_w_m2"], ref["site"]["lat"],
                                 ref["site"]["lon"], datetime.fromisoformat(i["time"]), wind_height_m=i["zspeed_m"],
                                 pressure_mb=ref["pressure_mb"])
        for k in errs:
            errs[k].append(float(o[k][0]) - r[k])
    worst = {k: float(np.max(np.abs(v))) for k, v in errs.items()}
    # residuals come from the solar-position routine (NOAA vs the bundled almanac) and float32 in the C code
    assert worst["wbgt_c"] < 0.1, worst
    assert worst["tnwb_c"] < 0.05, worst
    assert worst["tpsy_c"] < 0.05, worst
    assert worst["tg_c"] < 0.3, worst


def test_wbgt_weights_and_vector_input():
    o = wbgt.wbgt_components([25.0, 32.0], [60.0, 60.0], [2.0, 2.0], [600.0, 600.0], LAT, LON, [NOON, NOON])
    w = consts.get("liljegren_2008.weights")
    assert o["wbgt_c"] == pytest.approx(w["nwb"] * o["tnwb_c"] + w["globe"] * o["tg_c"] + w["air"] * np.array([25.0, 32.0]))
    assert o["wbgt_c"][1] > o["wbgt_c"][0]


@pytest.mark.parametrize("vary,values", [("air_c", [24, 28, 32, 36]), ("rh", [30, 50, 70, 90]), ("solar", [0, 300, 600, 900])])
def test_monotonic(vary, values):
    base = {"air_c": 30.0, "rh": 60.0, "solar": 600.0}
    out = []
    for v in values:
        b = dict(base, **{vary: v})
        out.append(wbgt.wbgt_f(b["air_c"], b["rh"], 2.0, b["solar"], LAT, LON, NOON))
    assert all(b > a for a, b in zip(out, out[1:])), out


def test_more_wind_cools_in_sun():
    still = wbgt.wbgt_f(32.0, 60.0, 0.5, 800.0, LAT, LON, NOON)
    breezy = wbgt.wbgt_f(32.0, 60.0, 6.0, 800.0, LAT, LON, NOON)
    assert breezy < still


def test_night_globe_near_air_and_wbgt_below_air():
    o = wbgt.wbgt_components(27.0, 80.0, 2.0, 0.0, LAT, LON, NIGHT)
    assert o["solar_w_m2"][0] == 0.0
    assert abs(o["tg_c"][0] - 27.0) < 1.5           # only longwave exchange with sky/ground
    assert o["tpsy_c"][0] <= o["tnwb_c"][0] + 0.5 and o["wbgt_c"][0] < 27.0


def test_solar_from_cloud():
    clear = wbgt.solar_from_cloud(LAT, LON, NOON, 0)
    cloudy = wbgt.solar_from_cloud(LAT, LON, NOON, 90)
    assert 700 < clear < 1100 and 0 < cloudy < clear
    assert wbgt.solar_from_cloud(LAT, LON, NIGHT, 0) == 0.0


def test_node_inversion_round_trip():
    """Synthesize what the 40 mm node globe would read under known sun, then recover Liljegren WBGT from it."""
    air, rh, wind2m, solar = 31.0, 65.0, 1.5, 650.0
    fwd = wbgt.wbgt_components(air, rh, wind2m, solar, LAT, LON, NOON, wind_height_m=2.0)
    d_node = consts.get("node_globe.d_globe_m")
    tg_node = float(wbgt.globe_temp_k(np.array([air + 273.15]), np.array([rh / 100]), consts.get("wbgt_inputs.pressure_mb"),
                                      fwd["wind_2m_m_s"], fwd["solar_w_m2"], fwd["fdir"], fwd["cos_zenith"], d_node)[0]) - 273.15
    assert tg_node > air + 3                       # sanity: a sunlit black globe reads well above air
    node = wbgt.node_components(air, rh, tg_node, wind2m, time=NOON, lat=LAT, lon=LON)
    assert node["solar_inferred_w_m2"] == pytest.approx(solar, rel=0.05)
    assert node["wbgt_c"] == pytest.approx(float(fwd["wbgt_c"][0]), abs=0.15)


def test_node_shade_and_no_time():
    """Globe at air temperature → ~no inferred sun; works without time/site (all-diffuse assumption)."""
    node = wbgt.node_components(29.0, 70.0, 29.0, None)
    assert node["solar_inferred_w_m2"] < 60
    assert wbgt.wbgt_from_node(29.0, 70.0, 29.0) < wbgt.wbgt_from_node(29.0, 70.0, 40.0)
