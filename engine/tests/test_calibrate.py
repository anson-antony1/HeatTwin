"""WS3: live calibration converges on synthetic HR with a known met_scale; gates suppress spikes; /hr; ect_optional."""
from __future__ import annotations

from datetime import timedelta

import numpy as np
import pytest

from engine import fixtures
from engine.calibrate import LiveSession, hr_from_met, personal_baseline, read_hr_csv, replay
from engine.physio import twonode

TRUE = 1.25  # fixtures/hr_a07_synthetic.csv was generated with this met_scale


def _session():
    return LiveSession(fixtures.plan(), fixtures.roster(), fixtures.forecast())


def test_converges_to_known_met_scale():
    s = _session()
    outs = replay(s, read_hr_csv(fixtures.FIXTURES / "hr_a07_synthetic.csv"), reforecast=False)
    c = outs[-1]["calib"]
    assert abs(c["met_scale"] - TRUE) < 2 * c["met_scale_sd"] + 0.02
    assert c["met_scale_sd"] < 0.06  # prior SD 0.20 shrinks
    assert all("replay: true" in o["labels"] for o in outs)


def test_single_spike_is_suppressed():
    """One 220-bpm artefact (and one 260-bpm impossible value) must not move calibration or raise a flag."""
    s1, s2 = _session(), _session()
    rows = read_hr_csv(fixtures.FIXTURES / "hr_a07_synthetic.csv")[:300]
    spiky = [dict(r) for r in rows]
    spiky[150]["hr_bpm"] = 220.0
    spiky[151]["hr_bpm"] = 260.0
    a = replay(s1, rows, reforecast=False)[-1]["calib"]["met_scale"]
    b = replay(s2, spiky, reforecast=False)[-1]["calib"]["met_scale"]
    assert abs(a - b) < 0.02
    assert s2.state["a07"].dropped == 1


def test_gates_hold_without_enough_data():
    s = _session()
    t0 = twonode.parse_time(fixtures.plan()["start"])
    out = s.add_reading({"athlete_id": "a07", "ts": (t0 + timedelta(minutes=20)).isoformat(), "hr_bpm": 150})
    assert out["gates"]["flag"] is False
    assert out["gates"]["message"] == "not enough data" and "coverage_ok" in out["gates"]["held_by"]


def test_persistence_gate():
    s = _session()
    ref = s.reforecast()
    lim = ref["limit_core_c"]
    ath = next(a for a in ref["athletes"] if a["id"] == "a07")
    blip = [lim - 0.5] * len(ath["core_c_p95"])
    blip[40] = lim + 0.1                       # one minute over → not persistent
    ath["core_c_p95"] = blip
    s.state["a07"].last_coverage, s.state["a07"].n_updates = 1.0, 5
    g = s.gates("a07", ref)
    assert g["crossing"] and not g["persistent"] and g["flag"] is False and g["held_by"] == ["persistent"]


def test_observation_model_endpoints():
    assert hr_from_met(1.0, 60, 200, 42.0) == pytest.approx(60)
    assert hr_from_met(12.0, 60, 200, 42.0) == pytest.approx(200)


def test_personal_baseline_median_mad():
    b = personal_baseline([60, 62, 58, 61, 90], [150, 152, 149])
    assert b["hr_rest_median_bpm"] == 61 and b["hr_rest_mad_bpm"] == 1


def test_hr_endpoint_returns_reforecast():
    from fastapi.testclient import TestClient
    from engine.api import app
    c = TestClient(app)
    assert c.post("/live/start", json={"roster": fixtures.roster()[:3], "n_ensemble": 5}).json()["ok"]
    t0 = twonode.parse_time(fixtures.plan()["start"])
    r = c.post("/hr", json={"athlete_id": "a01", "ts": (t0 + timedelta(minutes=5)).isoformat(), "hr_bpm": 120,
                            "device": "Polar H10", "replay": True}).json()
    assert r["athlete_id"] == "a01" and "met_scale" in r["calib"]
    assert "replay: true — heart rate is replayed, not live" in r["reforecast"]["labels"]
    assert c.post("/hr", json={"athlete_id": "zz", "ts": t0.isoformat(), "hr_bpm": 100}).status_code == 404


def test_ect_optional_is_off_by_default():
    from engine import ect_optional
    with pytest.raises(ect_optional.ResearchModeDisabled):
        ect_optional.estimate_core([100, 120])
    out = ect_optional.estimate_core([90, 120, 150, 160], research_mode=True)
    assert len(out["core_c"]) == 4 and out["labels"][0] == "research mode — method appears patented"
    assert np.all(np.diff(out["core_c"]) > 0)
