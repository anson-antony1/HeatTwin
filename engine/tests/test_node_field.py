"""Arduino field mode: hot-plug with a fake serial device, field fusion against engine/wbgt.py, fallback labels, the
live-session weather chain, and ?demo=1 staying pinned. No hardware and no network (conftest blocks NWS; tests that need
a reachable NWS patch field_sensor._fetch with synthetic hourly rows labelled as such)."""
import math
import threading
import time
from datetime import datetime, timedelta

import pytest
import serial
from fastapi.testclient import TestClient

from engine import (api, consts, demo_data, field_sensor, fhsaa, fixtures, node_autostart, node_bridge, node_routes,
                    weather, wbgt)
from engine.api import app

c = TestClient(app)
SITE = node_routes.SITE
PORT_A, PORT_B = "/dev/cu.usbmodem1101", "/dev/cu.usbmodem2301"
RH, WIND, CLOUD = 61.0, 2.2, 35.0           # the synthetic "NWS" values: constant, so interpolation is exact


def now():
    return datetime.now().astimezone()


def nws_rows(**over):
    """Synthetic hourly NWS rows around now (36 h), constant weather. Stands in for field_sensor._fetch."""
    t0 = now().replace(minute=0, second=0, microsecond=0) - timedelta(hours=6)
    row = {"air_temp_c": 27.0, "rh_pct": RH, "wind_m_s": WIND, "cloud_cover_pct": CLOUD, "source": "nws_forecast", **over}
    return [{**row, "time": (t0 + timedelta(hours=k)).isoformat()} for k in range(36)]


@pytest.fixture
def nws_up(monkeypatch):
    rows = nws_rows()
    monkeypatch.setattr(field_sensor, "_fetch", lambda lat, lon: [dict(r) for r in rows])
    return rows


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    node_routes.reset()
    monkeypatch.setattr(node_bridge, "DATA_DIR", tmp_path)       # CSV / raw logs never land in the repo's data/
    monkeypatch.setattr(demo_data, "DATA", tmp_path)
    yield
    node_autostart.stop(wait_s=3)
    node_autostart._status.update(state="off", port=None, readings=0, detail=None)
    node_routes.reset()


def post_field(air_c, ts=None):
    return c.post("/node", json={"node_id": "node-1", "ts": (ts or now()).isoformat(timespec="seconds"),
                                 "air_temp_c": air_c, "mode": "field", "air_source": "arduino_a0"})


def latest():
    return c.get("/node/latest").json()


def wait_for(cond, timeout=5.0, what="condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}; status={node_autostart.status()} source={node_routes.source_info()}")


# ── a fake USB bus: ports come and go, serial.Serial talks to a fake Uno ──────────────────────────────────────────

def sketch_line(temp_c, ms):
    """node_leds.ino / thermistor_test.ino line: ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c (A1 not wired)."""
    r = 10000 * math.exp(3950 * (1 / (temp_c + 273.15) - 1 / 298.15))
    return f"{ms},{1023 * 10000 / (r + 10000):.1f},{r:.0f},{temp_c:.2f},0.0,nan,nan"


class FakeBoard:
    def __init__(self, temp_c):
        self.temp_c, self.gone, self.silent, self.n, self.zones, self.serials = temp_c, False, False, 0, [], []
        self.no_thermistor = False                 # the sketch prints "nan" for an open A0


class FakeSerial:
    def __init__(self, board, timeout):
        self.board, self.timeout, self.closed = board, timeout or 0.05, False
        board.serials.append(self)

    def readline(self):
        if self.board.gone:
            raise serial.SerialException("device reports readiness to read but returned no data")
        if self.board.silent:                      # a hung board: still listed, never sends
            time.sleep(min(self.timeout, 0.05))
            return b""
        time.sleep(0.02)                           # the sketch's period, sped up
        self.board.n += 1
        if self.board.no_thermistor:
            return f"{self.board.n * 1000},1020.0,nan,nan,0.0,nan,nan\n".encode()
        return (sketch_line(self.board.temp_c, self.board.n * 1000) + "\n").encode()

    def write(self, data):
        self.board.zones.append(data.decode().strip())

    def close(self):
        self.closed = True


class FakePort:
    def __init__(self, device, vid=None):
        self.device, self.vid = device, vid


class FakeUSB:
    def __init__(self, monkeypatch):
        from serial.tools import list_ports
        self.boards, self.others = {}, [FakePort("/dev/cu.Bluetooth-Incoming-Port"), FakePort("/dev/cu.debug-console")]
        self.busy: set[str] = set()
        monkeypatch.setattr(list_ports, "comports", lambda *a, **k: [FakePort(d, 0x2341) for d in sorted(self.boards)] + self.others)
        monkeypatch.setattr(serial, "Serial", self._open)

    def plug(self, port, temp_c=26.0):
        self.boards[port] = FakeBoard(temp_c)
        return self.boards[port]

    def unplug(self, port):
        self.boards.pop(port).gone = True

    def _open(self, port, baud=9600, timeout=None, **kw):
        if port in self.busy:
            raise serial.SerialException(f"[Errno 16] Resource busy: {port!r}")
        if port not in self.boards:
            raise serial.SerialException(f"[Errno 2] could not open port {port}: No such file or directory")
        return FakeSerial(self.boards[port], timeout)


@pytest.fixture
def usb(monkeypatch):
    monkeypatch.setenv("HEATTWIN_NODE", "auto")
    monkeypatch.delenv("HEATTWIN_NODE_MODE", raising=False)           # field mode is the default
    monkeypatch.setattr(node_autostart, "SCAN_S", 0.05)
    monkeypatch.setitem(consts.load()["field_node"], "stale_after_s", 1.0)
    return FakeUSB(monkeypatch)


def fresh_field():
    return node_routes.source_info()["sensor_fresh"] and node_routes.source_info()["id"].startswith("field_sensor")


# ── port detection ───────────────────────────────────────────────────────────────────────────────────────────────

def test_candidate_ports_rank_arduino_then_usb_serial_bridges_then_names(monkeypatch):
    from serial.tools import list_ports
    ports = [FakePort("/dev/cu.Bluetooth-Incoming-Port"), FakePort("/dev/cu.debug-console", 0x05AC),
             FakePort("/dev/ttyUSB0", 0x10C4), FakePort("/dev/cu.usbserial-1410", 0x1A86),
             FakePort("/dev/cu.usbmodem1101", 0x2341), FakePort("/dev/ttyACM0", 0x0403),
             FakePort("/dev/cu.usbserial-FT1", None), FakePort("/dev/ttyS0", None), FakePort("/dev/cu.usbmodem9", None)]
    monkeypatch.setattr(list_ports, "comports", lambda *a, **k: ports)
    assert node_autostart.candidate_ports() == [
        "/dev/cu.usbmodem1101",                                    # Arduino vendor id
        "/dev/cu.usbserial-1410", "/dev/ttyACM0", "/dev/ttyUSB0",  # CH340, FTDI, CP210x
        "/dev/cu.usbmodem9", "/dev/cu.usbserial-FT1"]              # only the device name matches
    assert node_autostart.find_arduino() == "/dev/cu.usbmodem1101"
    monkeypatch.setattr(list_ports, "comports", lambda *a, **k: ports[:2] + [ports[7]])
    assert node_autostart.candidate_ports() == [] and node_autostart.find_arduino() is None


# ── field fusion: Arduino air temperature + NWS humidity / wind / sunlight → WBGT (engine/wbgt.py) ────────────────

def test_field_reading_is_arduino_air_temperature_plus_nws_wbgt_from_wbgt_module(nws_up):
    field_sensor.nws_hours(SITE["lat"], SITE["lon"], wait=True)
    t = now()
    r = post_field(33.4, t).json()
    f = r["field"]
    solar = wbgt.solar_from_cloud(SITE["lat"], SITE["lon"], t.replace(microsecond=0), CLOUD)
    want = round(wbgt.wbgt_f(33.4, RH, WIND, solar, SITE["lat"], SITE["lon"], t.replace(microsecond=0)), 1)
    assert f["wbgt_f"] == want and f["fhsaa_zone"] == fhsaa.zone(want)
    assert (f["air_temp_c"], f["rh_pct"], f["wind_m_s"], f["cloud_cover_pct"]) == (33.4, RH, WIND, CLOUD)
    assert f["solar_w_m2"] == pytest.approx(solar, abs=0.06)
    assert f["source"] == "field_node" and f["weather_from"] == "nws" and f["field_mode"] is True
    assert field_sensor.FIELD_NWS_LABEL == "Field sensor (Arduino) + NWS" and field_sensor.FIELD_NWS_LABEL in r["labels"]
    assert any("uncalibrated thermistor" in x for x in r["labels"]) and any("not a certified WBGT meter" in x for x in r["labels"])
    # the reference is the same model on NWS's own air temperature: a hotter Arduino reading → a higher WBGT
    assert f["forecast_air_c"] == 27.0 and f["wbgt_f"] > f["forecast_wbgt_f"]
    assert post_field(20.0, t).json()["field"]["wbgt_f"] < post_field(30.0, t).json()["field"]["wbgt_f"]


def test_field_reading_uses_time_shifted_snapshot_when_nws_is_unreachable():
    t = now().replace(microsecond=0)
    r = post_field(31.0, t).json()                                        # conftest: NWS unreachable
    f = r["field"]
    assert f["weather_from"] == "snapshot" and field_sensor.FIELD_SNAPSHOT_LABEL in r["labels"]
    assert field_sensor.FIELD_SNAPSHOT_LABEL == "Field sensor (Arduino) + forecast snapshot (time-shifted)"
    # the pinned plan start lands on now: RH / wind / cloud are the fixture's at the pinned plan start
    pinned = fixtures.forecast()
    p0 = datetime.fromisoformat(fixtures.plan()["start"])
    assert f["rh_pct"] == pytest.approx(weather._interp(pinned, "rh_pct", p0), abs=0.05)
    assert f["wind_m_s"] == pytest.approx(weather._interp(pinned, "wind_m_s", p0), abs=0.005)
    assert f["cloud_cover_pct"] == pytest.approx(weather._interp(pinned, "cloud_cover_pct", p0), abs=0.05)
    solar = wbgt.solar_from_cloud(SITE["lat"], SITE["lon"], t, f["cloud_cover_pct"])
    assert f["wbgt_f"] == pytest.approx(wbgt.wbgt_f(31.0, f["rh_pct"], f["wind_m_s"], solar, SITE["lat"], SITE["lon"], t), abs=0.11)
    assert any("NWS unreachable" in x for x in r["labels"])


def test_implausible_temperature_is_rejected_as_a_wiring_fault():
    lo, hi = consts.get("field_node.air_c_min"), consts.get("field_node.air_c_max")
    assert post_field(hi + 5).status_code == 422 and post_field(lo - 5).status_code == 422
    assert not field_sensor.plausible(float("nan")) and not field_sensor.plausible(None) and field_sensor.plausible(30.0)
    assert node_routes.field_reading() is None and node_routes.field_age_s() is None


def test_source_and_age_in_node_latest_and_status(nws_up):
    field_sensor.nws_hours(SITE["lat"], SITE["lon"], wait=True)
    assert post_field(30.0).status_code == 200
    for j in (latest(), c.get("/node/status").json()):
        s = j["source"]
        assert s["id"] == "field_sensor_nws" and s["label"] == "Field sensor (Arduino) + NWS"
        assert s["sensor_fresh"] is True and 0 <= s["reading_age_s"] < 2 and s["mode"] == "field"
        assert s["stale_after_s"] == consts.get("field_node.stale_after_s")
    j = latest()
    assert j["reading"]["air_c"] == 30.0 and j["reading"]["globe_c"] is None and j["field"]["source"] == "field_node"
    assert j["reading"]["node_wbgt_f"] == j["field"]["wbgt_f"] and j["reading"]["globe_calibrated"] is False
    assert j["assimilated"] and all(h["air_temp_c"] == 30.0 and h["field_mode"] for h in j["assimilated"])
    assert j["reading"]["field_minus_forecast_f"] == round(j["field"]["wbgt_f"] - j["field"]["forecast_wbgt_f"], 1)
    # no recent reading → live NWS (reachable) and the age keeps counting
    node_routes._field["received"] -= 60
    s = latest()["source"]
    assert s["id"] == "nws" and s["label"] == "live NWS forecast" and s["sensor_fresh"] is False and s["reading_age_s"] >= 60


def test_stale_reading_falls_back_to_snapshot_when_offline():
    assert post_field(30.0).status_code == 200
    assert latest()["source"]["id"] == "field_sensor_snapshot"
    assert latest()["source"]["label"] == "Field sensor (Arduino) + forecast snapshot (time-shifted)"
    node_routes._field["received"] -= consts.get("field_node.stale_after_s") + 1      # no recent reading
    s = latest()["source"]
    assert s["id"] == "snapshot" and s["label"] == "forecast snapshot (time-shifted)" and s["sensor_fresh"] is False
    assert node_routes.field_reading() is None


# ── hot-plug: plug, unplug, replug on the same port, replug under a different name ────────────────────────────────

def test_plug_streams_readings_and_leds_follow_the_zone(usb, nws_up):
    board = usb.plug(PORT_A, 28.0)
    node_autostart.start()
    wait_for(fresh_field, what="a fresh field reading")
    s = latest()["source"]
    assert s["label"] == "Field sensor (Arduino) + NWS" and s["reading_age_s"] < 1.0
    assert node_autostart.status()["state"] == "connected" and node_autostart.status()["port"] == PORT_A
    assert latest()["reading"]["air_c"] == pytest.approx(28.0, abs=0.01)
    wait_for(lambda: board.zones, what="a zone sent to the LEDs")
    assert set(board.zones) <= {f"Z{z}" for z in range(1, 6)}
    assert list((node_bridge.DATA_DIR).glob("node_field_*.csv")) and not list(node_bridge.DATA_DIR.glob("node_2*.csv"))


def test_unplug_falls_back_within_one_scan_and_replug_recovers_on_the_same_port(usb, nws_up):
    board = usb.plug(PORT_A, 28.0)
    node_autostart.start()
    wait_for(fresh_field, what="plugged in")
    usb.unplug(PORT_A)
    t0 = time.monotonic()
    wait_for(lambda: latest()["source"]["id"] == "nws", timeout=1.0, what="fallback to live NWS after the unplug")
    assert time.monotonic() - t0 < 1.0 and latest()["source"]["label"] == "live NWS forecast"
    assert latest()["source"]["sensor_fresh"] is False and latest()["source"]["reading_age_s"] is not None
    assert board.serials[0].closed is True                               # the dead port was released
    wait_for(lambda: node_autostart.status()["state"] == "waiting", what="scanning again")
    usb.plug(PORT_A, 30.0)
    wait_for(fresh_field, what="back on the same port, no restart")
    assert node_autostart.status()["port"] == PORT_A and latest()["reading"]["air_c"] == pytest.approx(30.0, abs=0.01)


def test_replug_under_a_different_port_name_is_picked_up_on_the_next_scan(usb, nws_up):
    usb.plug(PORT_A, 28.0)
    node_autostart.start()
    wait_for(fresh_field, what="plugged in on port A")
    usb.unplug(PORT_A)
    wait_for(lambda: not node_routes.source_info()["sensor_fresh"], timeout=1.0, what="unplugged")
    usb.plug(PORT_B, 31.5)                                               # macOS renumbers: usbmodem1101 → usbmodem2301
    wait_for(fresh_field, what="found under the new name")
    assert node_autostart.status()["port"] == PORT_B
    wait_for(lambda: latest()["reading"]["air_c"] == pytest.approx(31.5, abs=0.01), what="readings from the new port")
    assert latest()["source"]["label"] == "Field sensor (Arduino) + NWS"


def test_unplug_with_nws_unreachable_falls_back_to_the_labelled_snapshot(usb):
    usb.plug(PORT_A, 28.0)
    node_autostart.start()
    wait_for(lambda: node_routes.source_info()["id"] == "field_sensor_snapshot", what="field + snapshot while offline")
    usb.unplug(PORT_A)
    wait_for(lambda: latest()["source"]["id"] == "snapshot", timeout=1.0, what="snapshot fallback")
    assert latest()["source"]["label"] == "forecast snapshot (time-shifted)"


def test_a_busy_port_is_reported_and_the_next_candidate_is_tried(usb, nws_up):
    usb.plug(PORT_A, 28.0)
    usb.plug(PORT_B, 29.0)
    usb.busy.add(PORT_A)                                                 # e.g. the Arduino IDE's Serial Monitor
    node_autostart.start()
    wait_for(fresh_field, what="reading from the free port")
    assert node_autostart.status()["port"] == PORT_B


def test_only_a_busy_port_shows_port_unavailable_then_recovers(usb, nws_up):
    usb.plug(PORT_A, 28.0)
    usb.busy.add(PORT_A)
    node_autostart.start()
    wait_for(lambda: node_autostart.status()["state"] == "port_unavailable", what="port_unavailable")
    assert node_autostart.status()["port"] == PORT_A and "Resource busy" in node_autostart.status()["detail"]
    usb.busy.clear()
    wait_for(fresh_field, what="recovered once the port is free")


def test_a_silent_board_stops_counting_and_streaming_resumes_without_restart(usb, nws_up):
    board = usb.plug(PORT_A, 28.0)
    node_autostart.start()
    wait_for(fresh_field, what="plugged in")
    board.silent = True                                                  # still listed, sends nothing
    wait_for(lambda: latest()["source"]["id"] == "nws", timeout=4.0, what="no recent reading → live NWS")
    assert latest()["source"]["sensor_fresh"] is False
    board.silent = False
    wait_for(fresh_field, timeout=5.0, what="streaming again")


def test_a_board_with_no_thermistor_posts_nothing_and_says_so(usb, nws_up):
    usb.plug(PORT_A, 28.0).no_thermistor = True
    node_autostart.start()
    wait_for(lambda: node_autostart.status()["state"] == "connected", what="connected")
    time.sleep(consts.get("field_node.stale_after_s") + 0.3)
    st = node_autostart.status()
    assert st["readings"] == 0 and "check the A0 wiring" in st["detail"] and node_routes.field_reading() is None


# ── the live-session weather chain: Arduino field reading → live NWS → snapshot ───────────────────────────────────

def start_live():
    return c.post("/live/start", json={"start_now": True}).json()


def test_live_session_uses_the_fresh_arduino_reading_with_nws_humidity_wind_sun(nws_up):
    assert post_field(33.0).status_code == 200
    r = start_live()
    assert field_sensor.FIELD_NWS_LABEL in r["labels"] and api.LIVE_NWS_LABEL in r["labels"]
    assert field_sensor.THERMISTOR_LABEL in r["labels"]
    s = api._LIVE["session"]
    t0 = datetime.fromisoformat(r["start"])
    window = [h for h in s.weather if h.get("field_mode")]
    assert window and all(h["air_temp_c"] == 33.0 and h["source"] == "field_node" and h["weather_from"] == "nws" for h in window)
    assert all(h["rh_pct"] == RH and h["wind_m_s"] == WIND and h["cloud_cover_pct"] == CLOUD for h in window)
    for h in window:                                                     # WBGT from engine/wbgt.py on each hour's own inputs
        t = datetime.fromisoformat(h["time"])
        want = wbgt.wbgt_f(33.0, RH, WIND, h["solar_w_m2"], SITE["lat"], SITE["lon"], t)
        assert h["wbgt_f"] == pytest.approx(want, abs=0.06) and h["fhsaa_zone"] == fhsaa.zone(h["wbgt_f"])
    assert min(datetime.fromisoformat(h["time"]) for h in window) <= t0 + timedelta(hours=1)
    assert any(h.get("field_mode") is None for h in s.weather)           # hours outside the plan window are NWS's own
    assert field_sensor.FIELD_NWS_LABEL in c.get("/live/state").json()["labels"]


def test_live_session_with_arduino_and_unreachable_nws_uses_the_labelled_snapshot():
    assert post_field(33.0).status_code == 200
    r = start_live()
    assert field_sensor.FIELD_SNAPSHOT_LABEL in r["labels"] and api.SNAPSHOT_LABEL in r["labels"]
    assert "live NWS unreachable" in r["labels"] and field_sensor.FIELD_NWS_LABEL not in r["labels"]
    window = [h for h in api._LIVE["session"].weather if h.get("field_mode")]
    assert window and all(h["air_temp_c"] == 33.0 and h["weather_from"] == "snapshot" and "time_shifted_min" in h for h in window)


def test_live_session_without_a_fresh_reading_is_unchanged_nws_then_snapshot(nws_up, monkeypatch):
    assert post_field(33.0).status_code == 200
    node_routes._field["received"] -= consts.get("field_node.stale_after_s") + 1
    r = start_live()
    assert api.LIVE_NWS_LABEL in r["labels"] and not any("Field sensor" in x for x in r["labels"])
    assert not any(h.get("field_mode") for h in api._LIVE["session"].weather)
    def offline(lat, lon):
        raise ConnectionError("offline")
    monkeypatch.setattr(field_sensor, "_fetch", offline)
    field_sensor.reset()                                                 # NWS gone as well → the snapshot
    r = start_live()
    assert api.SNAPSHOT_LABEL in r["labels"] and not any("Field sensor" in x for x in r["labels"])


def test_running_live_session_falls_back_when_the_board_is_unplugged_and_follows_the_air_temperature(nws_up):
    field_sensor.nws_hours(SITE["lat"], SITE["lon"], wait=True)
    assert post_field(30.0).status_code == 200
    start_live()
    s = api._LIVE["session"]
    assert field_sensor.FIELD_NWS_LABEL in s.extra_labels
    v0 = node_routes._field["version"]
    small = post_field(30.0 + consts.get("field_node.reforecast_min_change_c") / 2).json()
    assert "reforecast" not in small and node_routes._field["version"] == v0          # sensor noise: no re-forecast
    moved = 30.0 + 2 * consts.get("field_node.reforecast_min_change_c") + 1
    big = post_field(moved).json()
    assert "reforecast" in big and field_sensor.FIELD_NWS_LABEL in big["reforecast"]["labels"]
    assert {h["air_temp_c"] for h in s.weather if h.get("field_mode")} == {moved}
    node_routes.end_field()                                              # unplugged
    assert not any(h.get("field_mode") for h in s.weather) and api.LIVE_NWS_LABEL in s.extra_labels
    assert not any("Field sensor" in x for x in s.extra_labels)
    live = c.get("/live/state").json()
    assert api.LIVE_NWS_LABEL in live["labels"] and not any("Field sensor" in x for x in live["labels"])
    assert not any(h.get("field_mode") for h in live["reforecast"]["weather"])


def test_a_reading_that_just_stops_arriving_also_drops_the_session_back_to_nws(nws_up):
    """No unplug event (e.g. an external `--post` bridge died): the next poll of /node/latest notices the stale reading."""
    field_sensor.nws_hours(SITE["lat"], SITE["lon"], wait=True)
    assert post_field(31.0).status_code == 200
    start_live()
    s = api._LIVE["session"]
    assert any(h.get("field_mode") for h in s.weather)
    node_routes._field["received"] -= consts.get("field_node.stale_after_s") + 1
    assert latest()["source"]["id"] == "nws"
    assert not any(h.get("field_mode") for h in s.weather) and not any("Field sensor" in x for x in s.extra_labels)
    v = node_routes._field["version"]
    latest()
    assert node_routes._field["version"] == v                            # the fallback runs once, not on every poll


# ── ?demo=1 never uses the sensor ───────────────────────────────────────────────────────────────────────────────────

def test_demo_mode_plan_and_optimize_stay_pinned_while_the_sensor_is_fresh(nws_up, monkeypatch, tmp_path):
    from engine import optimizer
    monkeypatch.setenv("HEATTWIN_CACHE_DIR", str(tmp_path))
    real = optimizer.optimize
    seen = []

    def short(plan, roster, weather_hours, **k):                          # a short search; the weather it gets is what matters
        seen.append(weather_hours)
        return real(plan, roster, weather_hours, **{**k, "demo": False, "budget_s": 1.0, "max_iterations": 3})
    monkeypatch.setattr(optimizer, "optimize", short)
    before = c.post("/simulate?demo=1", json={}).json()
    field_sensor.nws_hours(SITE["lat"], SITE["lon"], wait=True)
    assert post_field(38.0).status_code == 200 and node_routes.field_active()
    start_live()                                                         # a live session on the sensor exists too
    assert any(h.get("field_mode") for h in api._LIVE["session"].weather)
    for url in ("/simulate?demo=1", "/simulate?demo=1&source=node"):
        sim = c.post(url, json={}).json()
        assert sim["weather"] == before["weather"] and not any("Field sensor" in x for x in sim["labels"])
        assert "demo mode: forecast pinned to the cached NWS fixture" in sim["labels"]
        assert [a["peak_core_c_p95"] for a in sim["athletes"]] == [a["peak_core_c_p95"] for a in before["athletes"]]
    body = {"roster": fixtures.roster()[:3]}
    api._DEMO_CACHE.clear()
    opt = c.post("/optimize?demo=1", json=body).json()
    assert "demo mode: forecast pinned to the cached NWS fixture" in opt["labels"]
    assert not any("Field sensor" in x for x in opt["labels"])
    assert seen and seen[-1] == fixtures.forecast()                      # /optimize?demo=1 was handed the pinned forecast
    plan, roster, weather_hours, labels = api._inputs(api.OptimizeRequest(), demo_mode=True, node_scenario=True)
    assert weather_hours == fixtures.forecast() and not any("Field sensor" in x for x in labels)
    # plain Plan / Optimize requests (no ?demo, no live session) are not changed by a plugged-in sensor either
    plain = c.post("/simulate", json={}).json()
    assert not any("Field sensor" in x for x in plain["labels"]) and not any(h["source"] == "field_node" for h in plain["weather"])


# ── the bridge itself: field mode logs, never fetches/caches a forecast, is kept apart from globe recordings ───────

def test_bridge_field_mode_logs_rows_without_touching_the_weather_cache(tmp_path, nws_up):
    import csv
    field_sensor.nws_hours(SITE["lat"], SITE["lon"], wait=True)
    cache_before = sorted(p.name for p in weather.CACHE_DIR.glob("*"))
    repo_cache = sorted(p.name for p in (fixtures.FIXTURES / "weather_cache").glob("*"))
    lines = ["ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c", sketch_line(29.0, 1000), "garbage",
             "2000,1020.0,nan,nan,0.0,nan,nan", sketch_line(35.0, 3000), "", sketch_line(95.0, 4000)]   # 95 °C: wiring fault
    sent = []
    path = node_bridge.run(lines, "replay", out_dir=tmp_path, field=True, send_zone=sent.append,
                           post_fn=lambda p: node_routes.post_node(node_routes.NodeReading(**p)))
    rows = list(csv.DictReader(path.open()))
    assert path.name.startswith("node_field_") and len(rows) == 2 and sent and set(sent) <= {1, 2, 3, 4, 5}
    assert [float(r["air_c"]) for r in rows] == [29.0, 35.0] and all(r["mode"] == "field" and r["globe_c"] == "" for r in rows)
    assert all(r["air_source"] == "arduino_a0 + nws" and r["globe_calibrated"] == "False" for r in rows)
    assert float(rows[0]["node_wbgt_f"]) < float(rows[1]["node_wbgt_f"])
    assert sorted(p.name for p in weather.CACHE_DIR.glob("*")) == cache_before
    assert sorted(p.name for p in (fixtures.FIXTURES / "weather_cache").glob("*")) == repo_cache
    # an air-temperature log is not a globe recording: it never becomes the "newest field recording"
    assert demo_data.newest_node_csv() is None and demo_data.newest_node_csv(real_only=True) is None


def test_demo_scenario_is_still_available_behind_the_env_var(monkeypatch):
    assert field_sensor.node_mode() == "field"
    monkeypatch.setenv("HEATTWIN_NODE_MODE", "demo")
    assert field_sensor.node_mode() == "demo" and node_autostart.status()["mode"] == "demo"
    monkeypatch.setenv("HEATTWIN_NODE_MODE", "nonsense")
    assert field_sensor.node_mode() == "field"


def test_demo_mode_still_runs_through_the_hot_plug_loop(usb, monkeypatch):
    """HEATTWIN_NODE_MODE=demo: Jack's globe-as-sun scenario, now behind the env var — zero on the room, heat → sun, unplug → gone."""
    monkeypatch.setenv("HEATTWIN_NODE_MODE", "demo")
    board = usb.plug(PORT_A, 25.0)
    node_autostart.start()
    wait_for(lambda: node_autostart.status()["readings"] >= 1, timeout=8, what="demo readings after the room baseline")
    assert node_autostart.status()["mode"] == "demo" and node_routes.demo_active() and not node_routes.field_active()
    board.temp_c = 45.0                                                  # heat the globe
    wait_for(lambda: latest()["field"]["wbgt_f"] > 85.0, what="the heated globe raising WBGT")
    j = latest()
    assert node_routes.DEMO_LABEL in j["labels"] and j["field"]["synthetic"] is True and j["source"]["id"] == "demo_scenario"
    usb.unplug(PORT_A)
    wait_for(lambda: not node_routes.demo_active(), timeout=1.0, what="the demo ending on unplug")


def test_nws_fetch_is_cached_retried_slowly_and_never_blocks_the_reader(monkeypatch):
    calls = []
    clock = [1000.0]
    monkeypatch.setattr(field_sensor, "_mono", lambda: clock[0])
    rows = nws_rows()

    def fetch(lat, lon):
        calls.append(clock[0])
        if len(calls) == 1:
            raise ConnectionError("offline")
        return rows
    monkeypatch.setattr(field_sensor, "_fetch", fetch)
    lat, lon = SITE["lat"], SITE["lon"]
    assert field_sensor.nws_hours(lat, lon, wait=True) is None and len(calls) == 1          # offline
    assert field_sensor.nws_hours(lat, lon, wait=True) is None and len(calls) == 1          # no hammering
    assert field_sensor.nws_status(lat, lon) == "unreachable"
    clock[0] += consts.get("field_node.nws_retry_s") + 1
    assert field_sensor.nws_hours(lat, lon, wait=True) == rows and len(calls) == 2          # back online
    clock[0] += consts.get("field_node.nws_cache_ttl_s") - 5
    assert field_sensor.nws_hours(lat, lon) == rows and len(calls) == 2                     # cached, in memory
    clock[0] += 10                                                                           # TTL over: refresh in the background
    stale = field_sensor.nws_hours(lat, lon)
    assert stale == rows                                                                     # old rows served while it runs
    end = time.monotonic() + 3
    while len(calls) < 3 and time.monotonic() < end:
        time.sleep(0.01)
    assert len(calls) == 3
