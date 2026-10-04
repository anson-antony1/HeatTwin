"""Run the sideline-node bridge inside the engine: find the Arduino, stream its readings, survive hot-plugging.

Started by engine/api.py at startup (set HEATTWIN_NODE=off to disable). Every SCAN_S seconds it lists the USB serial
ports and picks the Arduino (Arduino USB vendor ids first, then the common USB-serial bridges CH340/CH341, FTDI and
CP210x, then device names /dev/cu.usbmodem*, /dev/cu.usbserial*, /dev/ttyACM*, /dev/ttyUSB*). It opens the first port
that is free, reads the sketch's lines and posts each reading in-process to node_routes. Unplug the board (or let it go
silent, or have another program take the port) and the reading loop ends at once, the field reading is marked gone so
the weather falls back to live NWS / the snapshot, and scanning resumes — the board may come back on the same port or
under a different name (macOS renumbers /dev/cu.usbmodem*), with no restart. GET /node/status reports what it is doing.

Mode (HEATTWIN_NODE_MODE): "field" (default) reads the thermistor as the field AIR temperature and takes humidity, wind
and sunlight from NWS (engine/field_sensor.py); "demo" runs the indoor globe-as-sun scenario (node_bridge.DemoScenario,
what `make sensor-demo` sets).
"""
from __future__ import annotations

import fnmatch
import os
import threading
import time
from datetime import datetime
from typing import Any, Optional

from engine import consts, field_sensor

SCAN_S = float(consts.get("field_node.scan_every_s"))
ARDUINO_VIDS = {0x2341, 0x2A03}          # Arduino LLC / Arduino SRL (Uno R3 enumerates as 2341:0043)
USB_SERIAL_VIDS = {0x1A86, 0x0403, 0x10C4}   # WCH CH340/CH341, FTDI, Silicon Labs CP210x: bridges on Uno clones / ESP32 boards
PORT_GLOBS = ("/dev/cu.usbmodem*", "/dev/cu.usbserial*", "/dev/ttyACM*", "/dev/ttyUSB*")

_status: dict[str, Any] = {"enabled": False, "state": "off", "port": None, "since": None, "detail": None,
                           "readings": 0, "mode": None}
_connected_at = 0.0
_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def status() -> dict[str, Any]:
    out = dict(_status)
    out["mode"] = field_sensor.node_mode()
    if (out["state"] == "connected" and out["mode"] == "field" and out["readings"] == 0
            and time.monotonic() - _connected_at > consts.get("field_node.stale_after_s")):
        out["detail"] = "board is connected but sends no valid thermistor reading — check the A0 wiring"
    return out


def _set(state: str, port: Optional[str] = None, detail: Optional[str] = None) -> None:
    if state != _status["state"] or port != _status["port"]:
        print(f"[node] {state}{f' on {port}' if port else ''}{f': {detail}' if detail else ''}", flush=True)
        _status.update(state=state, port=port, since=datetime.now().astimezone().isoformat(timespec="seconds"))
    _status["detail"] = detail


def candidate_ports() -> list[str]:
    """USB serial ports that look like the node, best first: Arduino vendor id, then the common USB-serial bridges, then
    the device-name globs; each group sorted by name so the choice is stable. Everything else (Bluetooth, debug console)
    is ignored."""
    from serial.tools import list_ports

    ranked: list[tuple[int, str]] = []
    for p in list_ports.comports():
        if p.vid in ARDUINO_VIDS:
            ranked.append((0, p.device))
        elif p.vid in USB_SERIAL_VIDS:
            ranked.append((1, p.device))
        elif any(fnmatch.fnmatch(p.device, g) for g in PORT_GLOBS):
            ranked.append((2, p.device))
    return [dev for _, dev in sorted(ranked)]


def find_arduino() -> Optional[str]:
    ports = candidate_ports()
    return ports[0] if ports else None


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    from engine import node_routes

    _status["readings"] += 1
    if _status["readings"] == 1:
        _status["detail"] = "streaming readings"
    return node_routes.post_node(node_routes.NodeReading(**payload))


def _open_first_free(ports: list[str]):
    """(SerialNode, port) for the first port that opens, else (None, (port, error)) for the last failure."""
    from engine import node_bridge

    last = None
    for port in ports:
        try:
            return node_bridge.SerialNode(port, timeout=SCAN_S), port
        except Exception as e:  # noqa: BLE001 — permission denied, or the port is busy (Arduino IDE Serial Monitor)
            last = (port, e)
    return None, last


def _loop() -> None:
    global _connected_at
    from engine import node_bridge, node_routes

    while not _stop.is_set():
        mode = field_sensor.node_mode()
        ports = candidate_ports()
        if not ports:
            _set("waiting", detail="no Arduino on USB")
            _stop.wait(SCAN_S)
            continue
        node, port = _open_first_free(ports)
        if node is None:
            _set("port_unavailable", port[0], f"{type(port[1]).__name__}: {port[1]}")
            _stop.wait(SCAN_S)
            continue
        _status["readings"] = 0
        _connected_at = time.monotonic()
        _set("connected", port, "zeroing on the room — keep hands off the thermistor for ~5 s" if mode == "demo"
             else "reading the thermistor as the field air temperature")
        try:
            node_bridge.run(node.lines(_stop, silent_after_s=consts.get("field_node.stale_after_s")), "live",
                            demo=mode == "demo", field=mode == "field", post_fn=_post, send_zone=node.send_zone,
                            stop=_stop)
        except Exception as e:  # noqa: BLE001 — unplugged mid-read raises SerialException
            _set("disconnected", port, f"{type(e).__name__}: {e}")
        finally:
            node.close()
            node_routes.end_demo()          # the web drops the sensor weather on its next poll
            node_routes.end_field()         # a live session falls back to live NWS / the snapshot now
        _stop.wait(SCAN_S)
    _set("off")


def start() -> None:
    global _thread
    _status["mode"] = field_sensor.node_mode()
    if os.environ.get("HEATTWIN_NODE", "auto").lower() in ("off", "0", "false"):
        _set("off", detail="HEATTWIN_NODE=off")
        return
    try:
        import serial  # noqa: F401  (pyserial; `make setup` installs it)
        from serial.tools import list_ports  # noqa: F401
    except ImportError:
        _set("off", detail="pyserial not installed (pip install pyserial) — sensor bridge disabled")
        return
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _status["enabled"] = True
    if field_sensor.node_mode() == "field":
        from engine import node_routes
        field_sensor.nws_hours(node_routes.SITE["lat"], node_routes.SITE["lon"])   # warm the NWS cache in the background
    _thread = threading.Thread(target=_loop, name="heattwin-node", daemon=True)
    _thread.start()


def stop(wait_s: float = 0.0) -> None:
    """End the scan loop (at the next line or read timeout); ``wait_s`` > 0 waits for the thread (tests)."""
    _stop.set()
    if wait_s and _thread is not None:
        _thread.join(wait_s)
