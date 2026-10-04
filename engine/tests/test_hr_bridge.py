"""engine/hr_bridge.py: Heart Rate Measurement (0x2A37) parsing, strap mapping, backoff, recording, replay (no BLE)."""
from __future__ import annotations

import struct

import pytest

from engine import hr_bridge as hb


def test_parse_uint8_no_rr():
    assert hb.parse_hrm(bytes([0x00, 72])) == {"hr_bpm": 72, "sensor_contact": None, "energy_kj": None, "rr_ms": []}


def test_parse_uint8_with_contact_and_rr():
    # flags: contact supported (0x04) + detected (0x02) + RR present (0x10); RR 1024 → 1000 ms, 512 → 500 ms
    data = bytes([0x16, 60]) + struct.pack("<HH", 1024, 512)
    p = hb.parse_hrm(data)
    assert p["hr_bpm"] == 60 and p["sensor_contact"] is True and p["rr_ms"] == [1000.0, 500.0]


def test_parse_contact_supported_but_lost():
    assert hb.parse_hrm(bytes([0x04, 80]))["sensor_contact"] is False


def test_parse_uint16_energy_and_rr():
    # flags: uint16 HR (0x01) + energy (0x08) + RR (0x10)
    data = bytes([0x19]) + struct.pack("<H", 301) + struct.pack("<H", 1234) + struct.pack("<H", 410)
    p = hb.parse_hrm(data)
    assert p["hr_bpm"] == 301 and p["energy_kj"] == 1234 and p["rr_ms"] == [pytest.approx(410 / 1024 * 1000, abs=0.1)]


@pytest.mark.parametrize("bad", [b"", bytes([0x00]), bytes([0x01, 0x50]), bytes([0x10, 70, 0x00]), bytes([0x08, 70])])
def test_parse_rejects_malformed(bad):
    with pytest.raises(hb.HrmParseError):
        hb.parse_hrm(bad)


def test_strap_mapping_and_assignment():
    maps = hb.parse_maps(["a07=Helio", "a11=C8:12:34:56:78:9A"])
    devices = [("AA:AA:AA:AA:AA:AA", "Amazfit Helio Strap"), ("C8:12:34:56:78:9A", "Polar H10 1234")]
    got = hb.assign(devices, maps)
    assert got == {"a11": ("C8:12:34:56:78:9A", "Polar H10 1234"), "a07": ("AA:AA:AA:AA:AA:AA", "Amazfit Helio Strap")}
    with pytest.raises(ValueError):
        hb.parse_maps(["a07=Helio", "a07=Polar"])
    with pytest.raises(ValueError):
        hb.parse_maps(["a07"])


def test_one_device_per_athlete():
    maps = hb.parse_maps(["a01=Helio", "a02=Helio"])
    got = hb.assign([("X1", "Helio Strap A"), ("X2", "Helio Strap B")], maps)
    assert {got["a01"][0], got["a02"][0]} == {"X1", "X2"}


def test_backoff_doubles_and_caps():
    assert [hb.backoff_s(k) for k in range(7)] == [1, 2, 4, 8, 16, 30, 30]


def test_recorder_and_replay_roundtrip(tmp_path):
    rec = hb.Recorder(tmp_path, day="2026-10-03")
    for k, hr in enumerate([88, 91, 95]):
        r = hb.reading_from("a07", {"hr_bpm": hr}, "Amazfit Helio Strap", ts=f"2026-10-03T16:00:0{k}-04:00")
        rec.write(r, rr_ms=[680.0], contact=True)
    assert rec.path.name == "hr_2026-10-03.csv" and rec.path.read_text().startswith("# recorded by engine/hr_bridge.py")
    rows = hb.read_csv(rec.path)
    assert [r["hr_bpm"] for r in rows] == [88, 91, 95] and all(r["replay"] for r in rows)
    posted, sleeps = [], []
    n = hb.replay(rows, posted.append, speed=10, sleep=sleeps.append)
    assert n == 3 and all(p["replay"] is True for p in posted)
    assert sleeps == [pytest.approx(0.1), pytest.approx(0.1)]


def test_replay_synthetic_fixture_through_api():
    """--replay path end to end against the app (TestClient), on the labelled synthetic fixture."""
    from fastapi.testclient import TestClient
    from engine import fixtures
    from engine.api import app
    c = TestClient(app)
    assert c.post("/live/start", json={}).json()["ok"]
    rows = hb.read_csv(fixtures.FIXTURES / "hr_a07_synthetic.csv")[:180]
    out = []
    hb.replay(rows, lambda r: out.append(c.post("/hr", json=r).json()), speed=0)
    assert out[-1]["replay"] is True and "met_scale" in out[-1]["calib"]


def test_live_start_now_sets_plan_clock():
    from fastapi.testclient import TestClient
    from engine.api import app
    r = TestClient(app).post("/live/start", json={"start_now": True}).json()
    assert r["ok"] and "plan clock set to now for a live HR session" in r["labels"]


def test_replay_live_clock_stamps_now_and_stays_labelled_replay():
    from engine import hr_bridge
    rows = [{"athlete_id": "a07", "ts": "2026-10-04T15:30:00-04:00", "hr_bpm": 100.0, "device": "x"},
            {"athlete_id": "a07", "ts": "2026-10-04T15:30:01-04:00", "hr_bpm": 101.0, "device": "x"}]
    sent = []
    hr_bridge.replay(rows, sent.append, speed=0, live_clock=True)
    assert all(r["replay"] is True for r in sent)
    assert all(not r["ts"].startswith("2026-10-04T15:30") for r in sent)
