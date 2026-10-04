"""BLE heart-rate bridge: chest straps → POST /hr (WS3 live calibration) + a CSV recording.

Reads the standard Bluetooth Heart Rate Service (0x180D), Heart Rate Measurement characteristic (0x2A37), from one or
more straps. Each strap is mapped to an athlete id. The bridge reconnects on its own after drop-outs and records every
reading to ``fixtures/hr_<date>.csv``.
Tested target: Amazfit Helio Strap with Zepp "Heart Rate Push" turned on (it then advertises the standard service). Any
strap that broadcasts standard BLE HR (Polar H10, Garmin "Broadcast HR", Coospo …) should work the same way.

    python -m engine.hr_bridge --scan                                  # list nearby HR straps
    python -m engine.hr_bridge --map a07=Helio                          # name substring → athlete a07
    python -m engine.hr_bridge --map a07=C8:12:34:56:78:9A --map a11=Polar --engine http://localhost:8010
    python -m engine.hr_bridge --replay fixtures/hr_a07_synthetic.csv --speed 10   # no BLE; replay → /hr

macOS: run it from Terminal/iTerm and allow that app under System Settings → Privacy & Security → Bluetooth.
Without that permission CoreBluetooth aborts the process (SIGABRT) on the first scan.

Privacy: recordings hold teammates' heart rate keyed by athlete id. Get consent before committing them.
Real recordings are written with ``replay=false``; replays are always posted with ``replay=true``.
"""
from __future__ import annotations

import argparse
import os
import asyncio
import csv
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

# Bluetooth SIG assigned numbers (Heart Rate Service 1.0 / GATT Specification Supplement): protocol identifiers.
HRS_UUID = "0000180d-0000-1000-8000-00805f9b34fb"
HRM_UUID = "00002a37-0000-1000-8000-00805f9b34fb"
RR_UNITS_PER_S = 1024.0  # RR-interval resolution defined by the Heart Rate Measurement characteristic (1/1024 s)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
CSV_FIELDS = ["ts", "athlete_id", "hr_bpm", "device", "replay", "synthetic", "rr_ms", "sensor_contact"]


# ── Heart Rate Measurement parsing (0x2A37) ─────────────────────────────────

class HrmParseError(ValueError):
    pass


def parse_hrm(data: bytes | bytearray) -> dict[str, Any]:
    """Decode one Heart Rate Measurement notification.

    Flags byte: bit0 = HR value format (0 → uint8, 1 → uint16 LE); bits1–2 = sensor-contact status (bit2 = feature
    supported, bit1 = contact detected); bit3 = Energy Expended present (uint16 LE, kJ); bit4 = RR-intervals present
    (one or more uint16 LE, units of 1/1024 s).
    """
    b = bytes(data)
    if len(b) < 2:
        raise HrmParseError(f"too short ({len(b)} bytes)")
    flags = b[0]
    i = 1
    if flags & 0x01:
        if len(b) < 3:
            raise HrmParseError("uint16 HR flagged but payload too short")
        hr = struct.unpack_from("<H", b, i)[0]
        i += 2
    else:
        hr = b[i]
        i += 1
    contact = bool(flags & 0x02) if flags & 0x04 else None
    energy = None
    if flags & 0x08:
        if len(b) < i + 2:
            raise HrmParseError("energy expended flagged but missing")
        energy = struct.unpack_from("<H", b, i)[0]
        i += 2
    rr: list[float] = []
    if flags & 0x10:
        if (len(b) - i) % 2:
            raise HrmParseError("odd number of RR bytes")
        while i + 1 < len(b):
            rr.append(round(struct.unpack_from("<H", b, i)[0] / RR_UNITS_PER_S * 1000.0, 1))
            i += 2
    return {"hr_bpm": int(hr), "sensor_contact": contact, "energy_kj": energy, "rr_ms": rr}


# ── strap → athlete mapping ─────────────────────────────────────────────────

@dataclass(frozen=True)
class StrapMap:
    athlete_id: str
    match: str            # BLE address (AA:BB:… or macOS UUID) or a case-insensitive name substring

    def matches(self, address: str, name: str | None) -> bool:
        m = self.match.lower()
        return address.lower() == m or (bool(name) and m in (name or "").lower())


def parse_maps(items: Sequence[str]) -> list[StrapMap]:
    """``["a07=Helio", "a11=C8:12:…"]`` → StrapMap list. Athlete ids must be unique."""
    out, seen = [], set()
    for it in items:
        if "=" not in it:
            raise ValueError(f"--map expects athlete_id=address_or_name, got {it!r}")
        aid, match = (x.strip() for x in it.split("=", 1))
        if not aid or not match:
            raise ValueError(f"--map entry incomplete: {it!r}")
        if aid in seen:
            raise ValueError(f"athlete {aid} mapped twice")
        seen.add(aid)
        out.append(StrapMap(aid, match))
    return out


def assign(devices: Iterable[tuple[str, str | None]], maps: Sequence[StrapMap]) -> dict[str, tuple[str, str | None]]:
    """athlete_id → (address, name). Address matches win over name matches; each device is used once."""
    devices = list(devices)
    used: set[str] = set()
    out: dict[str, tuple[str, str | None]] = {}
    for exact in (True, False):
        for m in maps:
            if m.athlete_id in out:
                continue
            for addr, name in devices:
                if addr in used:
                    continue
                hit = addr.lower() == m.match.lower() if exact else m.matches(addr, name)
                if hit:
                    out[m.athlete_id] = (addr, name)
                    used.add(addr)
                    break
    return out


def backoff_s(attempt: int, base: float = 1.0, cap: float = 30.0) -> float:
    """Reconnect delay: 1, 2, 4, 8 … seconds, capped."""
    return min(cap, base * (2 ** max(attempt, 0)))


# ── recording ───────────────────────────────────────────────────────────────

class Recorder:
    """Appends readings to fixtures/hr_<YYYY-MM-DD>.csv (one header per new file)."""

    def __init__(self, directory: Path = FIXTURES, day: str | None = None):
        self.path = Path(directory) / f"hr_{day or datetime.now().date().isoformat()}.csv"
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("w") as f:
                f.write("# recorded by engine/hr_bridge.py from BLE heart-rate straps (real data, not synthetic). "
                        "Keyed by athlete id; get consent before committing.\n")
                csv.DictWriter(f, CSV_FIELDS).writeheader()

    def write(self, reading: dict[str, Any], rr_ms: Sequence[float] = (), contact: bool | None = None) -> None:
        with self.path.open("a") as f:
            csv.DictWriter(f, CSV_FIELDS).writerow({
                "ts": reading["ts"], "athlete_id": reading["athlete_id"], "hr_bpm": reading["hr_bpm"],
                "device": reading.get("device", ""), "replay": str(bool(reading.get("replay", False))).lower(),
                "synthetic": "false", "rr_ms": ";".join(f"{x:g}" for x in rr_ms),
                "sensor_contact": "" if contact is None else str(contact).lower()})


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def reading_from(athlete_id: str, parsed: dict[str, Any], device: str, ts: str | None = None) -> dict[str, Any]:
    return {"athlete_id": athlete_id, "ts": ts or now_iso(), "hr_bpm": parsed["hr_bpm"], "device": device,
            "replay": False}


# ── posting ─────────────────────────────────────────────────────────────────

class Poster:
    """Posts readings to the engine from a queue so BLE callbacks never block on HTTP."""

    def __init__(self, engine_url: str | None, dry_run: bool = False):
        self.url = (engine_url or "").rstrip("/") + "/hr"
        self.dry_run = dry_run or not engine_url
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.sent = 0
        self.failed = 0

    async def run(self) -> None:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                r = await self.queue.get()
                if self.dry_run:
                    print(f"[dry-run] {r['athlete_id']} {r['hr_bpm']} bpm {r['ts']}")
                    continue
                try:
                    resp = await client.post(self.url, json=r)
                    resp.raise_for_status()
                    self.sent += 1
                    g = resp.json().get("gates") or {}
                    if g:
                        print(f"{r['athlete_id']} {r['hr_bpm']} bpm → met_scale {resp.json()['calib']['met_scale']:.3f} "
                              f"| {g.get('message')}")
                except Exception as e:  # noqa: BLE001 — keep streaming; the CSV still has the reading
                    self.failed += 1
                    print(f"POST /hr failed ({e.__class__.__name__}: {e}); reading kept in CSV")


# ── BLE ─────────────────────────────────────────────────────────────────────

async def scan(timeout: float = 8.0) -> list[tuple[str, str | None]]:
    from bleak import BleakScanner
    found = await BleakScanner.discover(timeout=timeout, service_uuids=[HRS_UUID])
    return [(d.address, d.name) for d in found]


async def stream_strap(athlete_id: str, address: str, name: str | None, poster: Poster, recorder: Recorder | None,
                       stop: asyncio.Event, max_attempts: int | None = None) -> None:
    """Connect, subscribe to 0x2A37, forward readings; reconnect with backoff until ``stop`` is set."""
    from bleak import BleakClient
    attempt = 0
    label = name or address
    while not stop.is_set() and (max_attempts is None or attempt < max_attempts):
        disconnected = asyncio.Event()

        def on_notify(_handle, data: bytearray) -> None:
            try:
                p = parse_hrm(data)
            except HrmParseError as e:
                print(f"{athlete_id}: bad packet ({e})")
                return
            r = reading_from(athlete_id, p, label)
            if recorder:
                recorder.write(r, p["rr_ms"], p["sensor_contact"])
            poster.queue.put_nowait(r)

        try:
            async with BleakClient(address, disconnected_callback=lambda _c: disconnected.set()) as client:
                await client.start_notify(HRM_UUID, on_notify)
                print(f"{athlete_id}: streaming from {label}")
                attempt = 0
                done = asyncio.create_task(disconnected.wait())
                halt = asyncio.create_task(stop.wait())
                await asyncio.wait({done, halt}, return_when=asyncio.FIRST_COMPLETED)
                for t in (done, halt):
                    t.cancel()
        except Exception as e:  # noqa: BLE001 — radio drop-outs are expected on a field
            print(f"{athlete_id}: connection error ({e.__class__.__name__}: {e})")
        if stop.is_set():
            break
        delay = backoff_s(attempt)
        attempt += 1
        print(f"{athlete_id}: reconnecting in {delay:.0f} s (attempt {attempt})")
        await asyncio.sleep(delay)


async def run_live(maps: Sequence[StrapMap], engine_url: str | None, record: bool, dry_run: bool,
                   scan_timeout: float) -> None:
    poster = Poster(engine_url, dry_run)
    recorder = Recorder() if record else None
    stop = asyncio.Event()
    devices = await scan(scan_timeout)
    assigned = assign(devices, maps)
    missing = [m.athlete_id for m in maps if m.athlete_id not in assigned]
    if missing:
        print(f"not found yet (Zepp 'Heart Rate Push' on? strap worn?): {missing}")
    if not assigned:
        return
    tasks = [asyncio.create_task(poster.run())]
    tasks += [asyncio.create_task(stream_strap(aid, addr, name, poster, recorder, stop))
              for aid, (addr, name) in assigned.items()]
    try:
        await asyncio.gather(*tasks)
    finally:
        stop.set()


# ── replay ──────────────────────────────────────────────────────────────────

def read_csv(path: str | Path) -> list[dict[str, Any]]:
    with open(path) as f:
        rows = list(csv.DictReader(line for line in f if not line.startswith("#")))
    return [{"athlete_id": r["athlete_id"], "ts": r["ts"], "hr_bpm": float(r["hr_bpm"]),
             "device": r.get("device") or "replay", "replay": True} for r in rows]


def replay(rows: Sequence[dict[str, Any]], post: Callable[[dict[str, Any]], Any], speed: float,
           sleep: Callable[[float], None] = time.sleep) -> int:
    """Post rows in order with (Δt / speed) pauses. Every posted reading has replay=True."""
    prev = None
    n = 0
    for r in rows:
        t = datetime.fromisoformat(r["ts"]).timestamp()
        if prev is not None and speed > 0:
            sleep(max(t - prev, 0.0) / speed)
        prev = t
        post({**r, "replay": True})
        n += 1
    return n


def _http_post(engine_url: str) -> Callable[[dict[str, Any]], Any]:
    import httpx
    client = httpx.Client(timeout=5.0)
    url = engine_url.rstrip("/") + "/hr"

    def post(r):
        resp = client.post(url, json=r)
        resp.raise_for_status()
        return resp.json()
    return post


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="BLE heart-rate straps → HeatTwin POST /hr")
    ap.add_argument("--scan", action="store_true", help="list nearby straps advertising the Heart Rate Service")
    ap.add_argument("--map", action="append", default=[], help="athlete_id=address_or_name_substring (repeatable)")
    ap.add_argument("--engine", default=f"http://localhost:{os.environ.get('HEATTWIN_PORT', '8010')}",
                    help="engine base URL ('' = don't post); default port HEATTWIN_PORT (8010)")
    ap.add_argument("--no-record", action="store_true", help="don't write fixtures/hr_<date>.csv")
    ap.add_argument("--dry-run", action="store_true", help="print readings instead of posting")
    ap.add_argument("--scan-timeout", type=float, default=8.0)
    ap.add_argument("--replay", default=None, help="CSV to replay to /hr instead of BLE")
    ap.add_argument("--speed", type=float, default=None, help="replay speed-up (default constants.calibration.replay_speed)")
    a = ap.parse_args(argv)

    if a.replay:
        from engine import consts
        speed = a.speed if a.speed is not None else float(consts.get("calibration.replay_speed"))
        rows = read_csv(a.replay)
        post = (lambda r: print(f"[replay] {r['athlete_id']} {r['hr_bpm']} {r['ts']}")) if (a.dry_run or not a.engine) \
            else _http_post(a.engine)
        n = replay(rows, post, speed)
        print(f"replayed {n} readings at {speed}× (replay=true)")
        return
    if a.scan:
        for addr, name in asyncio.run(scan(a.scan_timeout)):
            print(f"{addr}  {name}")
        return
    maps = parse_maps(a.map)
    if not maps:
        ap.error("give at least one --map athlete_id=address_or_name (use --scan to find straps)")
    asyncio.run(run_live(maps, a.engine or None, record=not a.no_record, dry_run=a.dry_run,
                         scan_timeout=a.scan_timeout))


if __name__ == "__main__":
    main()
