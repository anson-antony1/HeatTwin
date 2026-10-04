"""Run the sideline-node bridge inside the engine: find the Arduino, stream its readings, survive unplugging.

Started by engine/api.py at startup (set HEATTWIN_NODE=off to disable). Every SCAN_S seconds it looks for an Arduino
on USB (Arduino's USB vendor id, or any /dev/ttyACM*); when one appears it runs engine/node_bridge.run in --demo mode
with readings posted in-process to node_routes and the engine's FHSAA zone sent back to the Uno's LEDs. When the board
is unplugged (or the port is taken, e.g. by the Arduino IDE's Serial Monitor) the demo ends at once — the web goes
back to the forecast — and scanning resumes. GET /node/status reports what it is doing.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime
from typing import Any, Optional

SCAN_S = 2.0
ARDUINO_VIDS = {0x2341, 0x2A03}          # Arduino LLC / Arduino SRL (Uno R3 enumerates as 2341:0043)

_status: dict[str, Any] = {"enabled": False, "state": "off", "port": None, "since": None, "detail": None,
                           "readings": 0}
_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def status() -> dict[str, Any]:
    return dict(_status)


def _set(state: str, port: Optional[str] = None, detail: Optional[str] = None) -> None:
    if state != _status["state"] or port != _status["port"]:
        print(f"[node] {state}{f' on {port}' if port else ''}{f': {detail}' if detail else ''}", flush=True)
        _status.update(state=state, port=port, since=datetime.now().astimezone().isoformat(timespec="seconds"))
    _status["detail"] = detail


def find_arduino() -> Optional[str]:
    from serial.tools import list_ports

    ports = list(list_ports.comports())
    for p in ports:
        if p.vid in ARDUINO_VIDS:
            return p.device
    for p in ports:
        if p.device.startswith("/dev/ttyACM") or p.device.startswith("/dev/cu.usbmodem"):
            return p.device
    return None


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    from engine import node_routes

    _status["readings"] += 1
    if _status["readings"] == 1:
        _status["detail"] = "streaming readings"
    return node_routes.post_node(node_routes.NodeReading(**payload))


def _loop() -> None:
    from engine import node_bridge, node_routes

    while not _stop.is_set():
        port = find_arduino()
        if port is None:
            _set("waiting", detail="no Arduino on USB")
            _stop.wait(SCAN_S)
            continue
        try:
            node = node_bridge.SerialNode(port)
        except Exception as e:  # noqa: BLE001 — permission denied, or the port is busy (Arduino IDE Serial Monitor)
            _set("port_unavailable", port, f"{type(e).__name__}: {e}")
            _stop.wait(SCAN_S)
            continue
        _status["readings"] = 0
        _set("connected", port, "zeroing on the room — keep hands off the thermistor for ~5 s")
        try:
            node_bridge.run(node.lines(), "live", demo=True, post_fn=_post, send_zone=node.send_zone, stop=_stop)
        except Exception as e:  # noqa: BLE001 — unplugged mid-read raises SerialException
            _set("disconnected", port, f"{type(e).__name__}")
        finally:
            try:
                node.s.close()
            except Exception:  # noqa: BLE001
                pass
            node_routes.end_demo()          # the web drops the sensor weather on its next poll
        _stop.wait(SCAN_S)
    _set("off")


def start() -> None:
    global _thread
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
    _thread = threading.Thread(target=_loop, name="heattwin-node", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()
