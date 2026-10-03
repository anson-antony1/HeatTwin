"""node_bridge: sketch-line parsing and offline replay (synthetic globe ramp — not field data)."""
import csv
import math
from datetime import datetime, timedelta

from engine import fixtures, node_bridge


def line(g_c, ms=0, air="nan"):
    r = 10000 * math.exp(3950 * (1 / (g_c + 273.15) - 1 / 298.15))
    return f"{ms},{1023 * 10000 / (r + 10000):.1f},{r:.0f},{g_c:.2f},0.0,nan,{air}"


def test_parse_line():
    assert node_bridge.parse_line("# comment") is None
    assert node_bridge.parse_line("ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c") is None
    assert node_bridge.parse_line("12,1020.0,nan,nan,0.0,nan,nan") is None        # globe unplugged
    assert node_bridge.parse_line("garbage") is None
    r = node_bridge.parse_line(line(40.0))
    assert abs(r["globe_c"] - 40.0) < 0.01 and math.isnan(r["air_c"])


def test_offline_replay_writes_labelled_rows(tmp_path):
    t0 = datetime.fromisoformat(fixtures.forecast()[3]["time"])                  # inside the cached forecast
    ticks = iter(t0 + timedelta(seconds=2 * i) for i in range(100))
    lines = ["ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c"] + [line(g, 2000 * i) for i, g in enumerate([30, 45, 55])]
    path = node_bridge.run(lines, "replay", out_dir=tmp_path, offline=True, clock=lambda: next(ticks))
    rows = list(csv.DictReader(path.open()))
    assert len(rows) == 3
    assert all(r["globe_calibrated"] == "False" and r["mode"] == "replay" and r["air_source"] == "nws_forecast" for r in rows)
    wbgt = [float(r["node_wbgt_f"]) for r in rows]
    assert wbgt[0] < wbgt[1] < wbgt[2]                                             # hotter globe → higher WBGT


def test_shaded_air_channel_preferred(tmp_path):
    t0 = datetime.fromisoformat(fixtures.forecast()[3]["time"])
    ticks = iter(t0 + timedelta(seconds=2 * i) for i in range(100))
    path = node_bridge.run([line(40, air="29.50")], "replay", out_dir=tmp_path, offline=True, clock=lambda: next(ticks))
    (row,) = csv.DictReader(path.open())
    assert row["air_source"] == "node_a1" and float(row["air_c"]) == 29.5
