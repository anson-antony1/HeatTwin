"""Compile J.C. Liljegren's reference WBGT code and tabulate its output for engine/wbgt.py's tests.

liljegren_c.c is "WBGT, Version 1.1" (© 2008 UChicago Argonne, LLC — license and acknowledgment in the file
header; "This product includes software produced by UChicago Argonne, LLC under Contract No. DE-AC02-06CH11357
with the Department of Energy."), copied unmodified from pywbgt 3.0.7 (src/liljegren_c.c).

    python validation/wbgt_reference/build_reference.py     # needs a C compiler; writes reference_cases.json
"""
from __future__ import annotations

import ctypes
import json
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
LAT, LON = 29.6516, -82.3248   # Gainesville demo site
SEED = 20261004
N = 300


def load_lib() -> ctypes.CDLL:
    so = Path(tempfile.mkdtemp()) / "liljegren.so"
    subprocess.run(["cc", "-O2", "-shared", "-fPIC", "-o", str(so), str(HERE / "liljegren_c.c"), "-lm"], check=True)
    lib = ctypes.CDLL(str(so))
    f, i, fp = ctypes.c_float, ctypes.c_int, ctypes.POINTER(ctypes.c_float)
    lib.calc_wbgt.argtypes = [i] * 8 + [f] * 9 + [i, f, f] + [fp] * 6
    lib.calc_wbgt.restype = i
    return lib


def run(lib, t_utc: datetime, solar, tair, rh, speed, zspeed):
    outs = [ctypes.c_float() for _ in range(6)]
    rc = lib.calc_wbgt(t_utc.year, t_utc.month, t_utc.day, t_utc.hour, t_utc.minute, t_utc.second,
                       0, 0,                         # gmt offset 0 (times passed in UTC), no averaging window
                       LAT, LON, solar, 1013.25, tair, rh, speed, zspeed, 0.0,
                       0, 0.0, 0.0,                  # rural, default min speed, default 2-inch globe
                       *[ctypes.byref(o) for o in outs])
    est_speed, solar_adj, tg, tnwb, tpsy, twbg = (o.value for o in outs)
    return rc, {"est_speed": est_speed, "solar_adj": solar_adj, "tg_c": tg, "tnwb_c": tnwb, "tpsy_c": tpsy,
                "wbgt_c": twbg}


def main() -> None:
    lib = load_lib()
    rng = np.random.default_rng(SEED)
    t0 = datetime(2026, 10, 4, 11, 0, tzinfo=timezone.utc)   # 07:00 EDT
    cases = []
    while len(cases) < N:
        t = t0 + timedelta(minutes=int(rng.integers(0, 13 * 60)))   # 07:00-20:00 EDT
        inp = {"time": t.isoformat(), "air_c": round(float(rng.uniform(18, 39)), 2),
               "rh": round(float(rng.uniform(25, 98)), 1), "wind": round(float(rng.uniform(0.0, 9.0)), 2),
               "solar_w_m2": round(float(rng.uniform(0, 1000)), 1), "zspeed_m": float(rng.choice([10.0, 2.0]))}
        rc, out = run(lib, t, inp["solar_w_m2"], inp["air_c"], inp["rh"], inp["wind"], inp["zspeed_m"])
        if rc == 0:
            cases.append({"input": inp, "reference": out})
    doc = {"source": "Liljegren 'WBGT, Version 1.1' C code (liljegren_c.c), compiled by build_reference.py",
           "site": {"lat": LAT, "lon": LON}, "pressure_mb": 1013.25, "seed": SEED, "cases": cases}
    (HERE / "reference_cases.json").write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {len(cases)} cases")


if __name__ == "__main__":
    main()
