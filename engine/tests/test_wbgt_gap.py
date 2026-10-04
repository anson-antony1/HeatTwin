"""validation/wbgt_gap.py: runs offline on the pinned NWS fixture, is deterministic, and the decomposition adds up."""
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from engine import consts, fixtures, wbgt
from validation import wbgt_gap

ROOT = Path(__file__).resolve().parents[2]
RAW = fixtures.FIXTURES / consts.get("wbgt_gap_ablation.raw_pinned")


@pytest.fixture(scope="module")
def raw():
    return wbgt_gap.load_raw(RAW)


@pytest.fixture(scope="module")
def result(raw):
    return wbgt_gap.analyse(raw, "pinned", RAW.name)


def test_deterministic(raw, result):
    assert wbgt_gap.analyse(raw, "pinned", RAW.name) == result


def test_deltas_plus_residual_sum_to_gap(result):
    """Per hour, the six attributed Δs plus the residual reproduce ours − NWS (reported values, 2-dp rounding)."""
    assert len(result["rows"]) == 24
    for r in result["rows"]:
        assert sum(r["delta_f"].values()) + r["residual_f"] == pytest.approx(r["gap_f"], abs=0.05), r["time"]


def test_attribution_is_exact_before_rounding(raw):
    h = wbgt_gap.hours(raw)
    att = wbgt_gap.attribute(h)
    total = sum(att["shapley"].values()) + (att["recon_f"] - h["nws_f"])
    np.testing.assert_allclose(total, att["base_f"] - h["nws_f"], atol=1e-9)


def test_baseline_is_the_production_wbgt(raw, result):
    """No swaps = engine/wbgt.py exactly as engine/weather.py runs it."""
    assert result["baseline_matches_pipeline_f"] <= 0.05
    h = wbgt_gap.hours(raw)
    i = 15
    lat, lon = wbgt_gap.site()
    c = wbgt.wbgt_components(h["ta"][i], h["rh"][i], h["u10"][i], h["solar"][i], lat, lon, h["time"][i])
    k = consts.get("physical")
    assert wbgt_gap.evaluate(h)["wbgt_f"][i] == pytest.approx(float(c["wbgt_c"][0]) * k["f_per_c"] + k["f_offset"], abs=1e-9)


def test_demo_window_and_night(result):
    window = [r for r in result["rows"] if r["in_demo_window"]]
    assert [datetime.fromisoformat(r["time"]).hour for r in window] == [15, 16, 17, 18]
    for r in result["rows"]:
        if r["inputs"]["solar_w_m2"] == 0:       # the Dimiceli globe swap is applied only while the sun is up
            assert r["delta_f"]["globe_model"] == 0 and r["delta_f"]["solar_split"] == 0


def test_engine_left_untouched(raw):
    """The ground-albedo ablation patches engine.wbgt only inside its context manager."""
    original = wbgt._L
    wbgt_gap.evaluate(wbgt_gap.hours(raw), frozenset(wbgt_gap.FACTORS))
    assert wbgt._L is original and wbgt._L()["alb_sfc"] == consts.get("liljegren_2008.alb_sfc")


def test_ablation_constants_stay_out_of_the_engine():
    for path in ("engine/wbgt.py", "engine/weather.py"):
        text = (ROOT / path).read_text()
        for block in ("ndfd_wbgt", "dimiceli_piltz_globe", "wbgt_gap_ablation"):
            assert block not in text, (path, block)


def test_results_json_block_is_computed_by_the_script():
    res = json.loads((ROOT / "validation" / "results.json").read_text())["wbgt_gap"]
    assert res["computed_by"] == "validation/wbgt_gap.py" and res["synthetic"] is False
    assert set(res["forecasts"]) == {"pinned", "context"}
