"""WBGT gap: our Liljegren WBGT (engine/wbgt.py, as engine/weather.py runs it) vs NWS's own wetBulbGlobeTemperature layer.

Nothing is tuned. Where NWS's documented method differs from ours, the NWS choice is swapped into our calculation one
input at a time and the WBGT change is measured. The swaps are ablations, not model changes: engine/wbgt.py and
engine/weather.py are unchanged and never read the ablation constants (ndfd_wbgt, dimiceli_piltz_globe,
wbgt_gap_ablation in engine/constants.yaml).

What NWS documents for the NDFD WBGT layer (Boyer, MDL; constants.ndfd_wbgt) and what we do instead:

  factor          ours (engine/wbgt.py)                          NWS (documented)
  solar_split     Liljegren f_dir = exp(3 − 1.34n − 1.65/n)       direct = min(1 − sky cover, 0.75), diffuse = the rest
  wind_height     10 m → 2 m, stability-class power law (rural)   10 m → 2 m, log law, z0 from land cover (we use 0.03 m)
  ground_albedo   0.45 (Liljegren's reference code)               AVHRR albedo (TSA tool: 0.2 grass; we use 0.2)
  globe_model     Liljegren globe energy balance (2-inch globe)   Dimiceli-Piltz linear globe, h = 0.228 by day
  nwb_model       Liljegren wick energy balance                   regression on the psychrometric wet bulb
  humidity        relativeHumidity layer                          dewpoint layer

Same on both sides, so not swapped: cloud attenuation (Kasten-Czeplak R0·(1 − 0.75 n^3.4), n = sky fraction), WBGT
weights (0.7/0.2/0.1), the forecast hour at which the sun is evaluated. Not swappable: NWS's clear-sky curve (a daily
maximum at solar noon spread over the day by a Gaussian, parameters not published). Whatever the six swaps leave is the
residual. An implied-irradiance inversion (the scale k on our irradiance at which a model reproduces NWS's value) tests
whether the residual behaves like sunlight.

Attribution. The swaps interact (the ground albedo only matters to whichever globe model is in use), so each factor's Δ
is its Shapley value over all 2⁶ swap combinations: the WBGT change when that factor is swapped, averaged over every
order of applying the swaps. The six Δs sum exactly to ours − (all swaps applied), the residual is (all swaps) − NWS, so
gap = ΣΔ + residual. One-at-a-time Δs (each swap alone on our baseline) are reported as well.
Sign: Δ > 0 means our choice makes our WBGT higher than NWS's documented choice would.

    python -m validation.wbgt_gap                  # prints the tables, writes validation/results.json["wbgt_gap"]
    python -m validation.wbgt_gap --raw FILE.json  # same analysis on another raw gridpoint file (e.g. a live fetch)
"""
from __future__ import annotations

import contextlib
import itertools
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

import numpy as np

from engine import consts, fixtures, weather, wbgt

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "validation" / "results.json"

FACTORS = ("solar_split", "wind_height", "ground_albedo", "globe_model", "nwb_model", "humidity")
INPUT = {"solar_split": "solar (direct/diffuse split)", "wind_height": "wind (10 m → 2 m)",
         "ground_albedo": "MRT/globe (ground albedo)", "globe_model": "MRT/globe (globe equation)",
         "nwb_model": "natural wet bulb (equation)", "humidity": "humidity (RH vs dewpoint)"}
SWAP = {
    "solar_split": "Liljegren f_dir(S/S_toa) → NDFD direct = min(1 − sky, ndfd_wbgt.direct_beam_cap)",
    "wind_height": "stability-class power law → log law, z0 = wbgt_gap_ablation.z0_log_law_m",
    "ground_albedo": "liljegren_2008.alb_sfc → wbgt_gap_ablation.albedo_swap",
    "globe_model": "Liljegren globe → Dimiceli-Piltz Eq. 10 with ndfd_wbgt.h_convective_day (sun up only)",
    "nwb_model": "Liljegren wick → ndfd_wbgt.nwb_regression on the psychrometric wet bulb",
    "humidity": "relativeHumidity layer → RH from the dewpoint layer",
}


# ── inputs ───────────────────────────────────────────────────────────────────

def site() -> tuple[float, float]:
    s = fixtures.plan()["site"]
    return float(s["lat"]), float(s["lon"])


def load_raw(path: Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def hours(raw: dict[str, Any]) -> dict[str, Any]:
    """Every hour with all core layers, NWS WBGT and dewpoint, through the production pipeline (weather.py)."""
    lat, lon = site()
    rows = weather.add_wbgt(weather.hours_from_gridpoint(raw), lat, lon)
    td = weather._expand(raw["properties"]["dewpoint"])
    rows = [r for r in rows if r.get("nws_wbgt_f") is not None
            and datetime.fromisoformat(r["time"]).astimezone(timezone.utc) in td]
    t = [datetime.fromisoformat(r["time"]) for r in rows]
    f = lambda k: np.array([float(r[k]) for r in rows])  # noqa: E731
    return {"time": t, "ta": f("air_temp_c"), "rh": f("rh_pct"), "u10": f("wind_m_s"), "sky": f("cloud_cover_pct"),
            "solar": f("solar_w_m2"), "td": np.array([td[x.astimezone(timezone.utc)] for x in t]),
            "nws_f": f("nws_wbgt_f"), "ours_pipeline_f": f("wbgt_f")}


def subset(h: dict[str, Any], idx) -> dict[str, Any]:
    idx = list(idx)
    return {k: ([v[i] for i in idx] if isinstance(v, list) else v[idx]) for k, v in h.items()}


# ── one evaluation (ours, any combination of swaps, optional sensitivity overrides) ────────────────

def _f(c):
    ph = consts.get("physical")
    return np.asarray(c) * ph["f_per_c"] + ph["f_offset"]


def rh_from_dewpoint(ta_c, td_c):
    k = consts.get("physical.kelvin_offset")
    return np.minimum(100.0 * wbgt.esat_mb(np.asarray(td_c) + k) / wbgt.esat_mb(np.asarray(ta_c) + k), 100.0)


@contextlib.contextmanager
def _liljegren_ground_albedo(albedo: float) -> Iterator[None]:
    """Ablation only: run engine.wbgt's energy balances with another ground albedo; the module is restored on exit."""
    original = wbgt._L
    patched = dict(original())
    patched["alb_sfc"] = albedo
    wbgt._L = lambda: patched
    try:
        yield
    finally:
        wbgt._L = original


def dimiceli_globe_c(ta, ea_mb, speed_m_s, solar, fdir, cza, albedo, h_conv):
    """Dimiceli-Piltz Eq. 10, as published (temperatures in °C; u in m/h). constants.dimiceli_piltz_globe."""
    d = consts.get("dimiceli_piltz_globe")
    eps_a = d["emis_atm"]["a"] * ea_mb ** d["emis_atm"]["b"]
    c = h_conv * (speed_m_s * consts.get("physical.s_per_h")) ** d["wind_exp"] / d["eps_sigma"]
    cz = np.maximum(cza, wbgt._L()["cza_min"])
    b = solar * (fdir / (4.0 * d["sigma"] * cz) + (1.0 + albedo) * (1.0 - fdir) / d["sigma"]) + eps_a * ta**4
    return (b + c * ta + d["tangent_intercept"]) / (c + d["tangent_slope"])


def _ea_mb(ta, rh, td, p_mb, from_dewpoint: bool):
    """Dimiceli Eq. 6 vapour pressure (from Td), or the same saturation curve × RH when the RH layer is in use."""
    v = consts.get("dimiceli_piltz_globe.vapour")
    sat = (v["f0"] + v["f1_per_mb"] * p_mb) * v["e0_mb"] * np.exp(v["c"] * ta / (v["d_c"] + ta))
    if from_dewpoint:
        return np.exp(v["a"] * (td - ta) / (td + v["b_c"])) * sat
    return rh / 100.0 * sat


def evaluate(h: dict[str, Any], swaps=frozenset(), *, solar=None, sun_shift_s: float = 0.0, z0: Optional[float] = None,
             albedo: Optional[float] = None, wind_10m_direct: bool = False, urban: Optional[bool] = None) -> dict[str, Any]:
    """WBGT [°F] and its parts for every hour in ``h`` with the NWS choices in ``swaps`` applied.

    With no swaps and no overrides this is exactly engine.wbgt.wbgt_components on the pipeline's inputs. Overrides are
    sensitivities: ``solar`` replaces the irradiance (before Liljegren's 0.85·S_toa cap), ``sun_shift_s`` moves the
    sun's position, ``z0``/``albedo`` replace the swap values, ``wind_10m_direct`` feeds the 10 m wind as if measured at
    2 m, ``urban`` picks Liljegren's urban power-law exponents.
    """
    L, inp, ab, nd = wbgt._L(), consts.get("wbgt_inputs"), consts.get("wbgt_gap_ablation"), consts.get("ndfd_wbgt")
    lat, lon = site()
    k, p_mb = consts.get("physical.kelvin_offset"), inp["pressure_mb"]
    ta, u10, sky = h["ta"], h["u10"], h["sky"] / 100.0
    rh = rh_from_dewpoint(ta, h["td"]) if "humidity" in swaps else h["rh"]
    cza, toa = wbgt.solar_geometry(wbgt._utc_seconds(h["time"]) + sun_shift_s, lat, lon)
    solar, fdir = wbgt.adjust_solar(h["solar"] if solar is None else solar, toa)
    sun = solar > 0

    if wind_10m_direct:
        speed = np.maximum(u10, L["min_speed_m_s"])
    elif "wind_height" in swaps:
        z = ab["z0_log_law_m"] if z0 is None else z0
        speed = np.maximum(u10 * np.log(L["ref_height_m"] / z) / np.log(inp["wind_height_m"] / z), L["min_speed_m_s"])
    else:
        stab = wbgt.stability_class(cza > 0, u10, solar, inp["night_dt_c"])
        speed = wbgt.wind_at_2m(u10, inp["wind_height_m"], stab, inp["urban"] if urban is None else urban)

    if "solar_split" in swaps:
        fdir = np.where(sun, np.minimum(1.0 - sky, nd["direct_beam_cap"]), 0.0)
    alb = (ab["albedo_swap"] if albedo is None else albedo) if "ground_albedo" in swaps else L["alb_sfc"]

    ta_k, rh_f = ta + k, rh / 100.0
    with _liljegren_ground_albedo(alb):
        tpsy = wbgt.wet_bulb_k(ta_k, rh_f, p_mb, speed, solar, fdir, cza, False) - k
        tnwb = wbgt.wet_bulb_k(ta_k, rh_f, p_mb, speed, solar, fdir, cza, True) - k
        tg = wbgt.globe_temp_k(ta_k, rh_f, p_mb, speed, solar, fdir, cza, L["d_globe_m"]) - k
    if "nwb_model" in swaps:
        r = nd["nwb_regression"]
        tnwb = tpsy + r["s"] * solar + r["u"] * speed + r["twd"] * (ta - tpsy) + r["c"]
    if "globe_model" in swaps:
        ea = _ea_mb(ta, h["rh"], h["td"], p_mb, from_dewpoint="humidity" in swaps)
        tg = np.where(sun, dimiceli_globe_c(ta, ea, speed, solar, fdir, cza, alb, nd["h_convective_day"]), tg)
    w = L["weights"]
    return {"wbgt_f": _f(w["nwb"] * tnwb + w["globe"] * tg + w["air"] * ta), "tg_c": tg, "tnwb_c": tnwb,
            "tpsy_c": tpsy, "wind_2m_m_s": speed, "solar_w_m2": solar, "fdir": fdir, "rh_pct": rh}


# ── attribution ──────────────────────────────────────────────────────────────

def attribute(h: dict[str, Any], **kw) -> dict[str, Any]:
    """Shapley and one-at-a-time Δ for every factor; baseline and all-swaps WBGT [°F]."""
    vals = {frozenset(c): evaluate(h, frozenset(c), **kw)["wbgt_f"]
            for r in range(len(FACTORS) + 1) for c in itertools.combinations(FACTORS, r)}
    n = len(FACTORS)
    shapley = {}
    for f in FACTORS:
        others = [g for g in FACTORS if g != f]
        total = np.zeros_like(vals[frozenset()])
        for r in range(n):
            weight = math.factorial(r) * math.factorial(n - r - 1) / math.factorial(n)
            for c in itertools.combinations(others, r):
                total = total + weight * (vals[frozenset(c)] - vals[frozenset(c) | {f}])
        shapley[f] = total
    base, recon = vals[frozenset()], vals[frozenset(FACTORS)]
    return {"base_f": base, "recon_f": recon, "shapley": shapley,
            "alone": {f: base - vals[frozenset({f})] for f in FACTORS}}


def implied_solar_scale(h: dict[str, Any], swaps, target_f) -> np.ndarray:
    """k such that the model with irradiance k·S reproduces ``target_f`` (vectorized bisection; WBGT rises with S).

    0 where even no sun is above the target; NaN where the bracket fails or the hour's whole sun effect is below
    wbgt_gap_ablation.implied_s_min_sun_effect_f (k is not identifiable there).
    """
    ab = consts.get("wbgt_gap_ablation")
    at = lambda kk: evaluate(h, swaps, solar=h["solar"] * kk)["wbgt_f"]  # noqa: E731
    f0, f1 = at(np.zeros_like(h["solar"])), at(np.ones_like(h["solar"]))
    lo, hi = np.zeros_like(h["solar"]), np.full_like(h["solar"], ab["implied_s_scale_max"])
    fhi = at(hi)
    for _ in range(ab["bisection_iter"]):
        mid = 0.5 * (lo + hi)
        above = at(mid) > target_f
        hi, lo = np.where(above, mid, hi), np.where(above, lo, mid)
    k = 0.5 * (lo + hi)
    k = np.where(f0 >= target_f, 0.0, k)
    k = np.where(fhi < target_f, np.nan, k)
    return np.where((f1 - f0) >= ab["implied_s_min_sun_effect_f"], k, np.nan)


# ── time alignment (data checks, not model swaps) ─────────────────────────────

def time_alignment(raw: dict[str, Any], h: dict[str, Any], window_idx) -> dict[str, Any]:
    p = raw["properties"]
    upd = datetime.fromisoformat(p["updateTime"])
    nd = consts.get("ndfd_wbgt")
    layers = ("temperature", "dewpoint", "relativeHumidity", "windSpeed", "skyCover", "wetBulbGlobeTemperature")
    whole_f = {k: int(sum(abs(float(_f(v["value"])) - round(float(_f(v["value"])))) > 1e-6
                          for v in p[k]["values"] if v["value"] is not None))
               for k in ("temperature", "dewpoint", "wetBulbGlobeTemperature")}
    intervals: dict[str, list[str]] = {}
    w0, w1 = h["time"][window_idx[0]].astimezone(timezone.utc), h["time"][window_idx[-1]].astimezone(timezone.utc)
    for name in layers:
        out = []
        for v in p[name]["values"]:
            start, dur = v["validTime"].split("/")
            s = datetime.fromisoformat(start).astimezone(timezone.utc)
            n_h = len(weather._expand({"uom": p[name]["uom"], "values": [v]})) if v["value"] is not None else 0
            if s <= w1 and s + timedelta(hours=max(n_h, 1)) > w0:
                out.append(f"{s.strftime('%Y-%m-%dT%H:%MZ')}/{dur}")
        intervals[name] = out
    lead = [(t.astimezone(timezone.utc) - upd).total_seconds() / 3600.0 for t in (h["time"][i] for i in window_idx)]
    return {
        "nws_update_time": p["updateTime"],
        "lead_h_window": [round(min(lead), 2), round(max(lead), 2)],
        "within_ndfd_hourly_range": bool(max(lead) <= nd["hourly_resolution_h"]),
        "layer_intervals_in_window": intervals,
        "local_to_utc": [f"{h['time'][i].isoformat()} = {h['time'][i].astimezone(timezone.utc).strftime('%H:%MZ')}"
                         for i in window_idx],
        "values_not_whole_degF": whole_f,
        "reading": ("NDFD is hourly out to 36 h (Boyer p.4), so inside that range a multi-hour validTime (e.g. PT3H) "
                    "is one value repeated for each hour it spans, which is what weather._expand assigns. Every layer "
                    "is keyed in UTC and converted to local time once, so the WBGT layer and the inputs line up hour "
                    "for hour."),
    }


# ── one forecast ─────────────────────────────────────────────────────────────

def _r(x, n=2):
    x = float(x)
    return None if not np.isfinite(x) else round(x, n)


def _stats(a) -> Optional[dict[str, float]]:
    a = np.asarray(a, dtype=float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return None
    return {"mean": _r(a.mean()), "min": _r(a.min()), "max": _r(a.max()), "n": int(a.size)}


def analyse(raw: dict[str, Any], label: str, raw_file: str, all_rows: bool = True) -> dict[str, Any]:
    """Decomposition for the context day of one raw gridpoint file. ``all_rows=False`` keeps only demo-window rows."""
    ab = consts.get("wbgt_gap_ablation")
    lat, lon = site()
    allh = hours(raw)
    day = [i for i, t in enumerate(allh["time"]) if t.date().isoformat() == ab["context_day_local"]]
    h = subset(allh, day)
    w0, w1 = (datetime.fromisoformat(x) for x in ab["demo_window_local"])
    window = [i for i, t in enumerate(h["time"]) if w0 <= t <= w1]

    att = attribute(h)
    base, recon, nws = att["base_f"], att["recon_f"], h["nws_f"]
    gap, residual = base - nws, recon - nws
    pipeline_err = float(np.max(np.abs(np.round(base, 1) - h["ours_pipeline_f"])))

    k_ours = {d: implied_solar_scale(h, frozenset(), nws + d) for d in (-ab["nws_rounding_f"], 0.0, ab["nws_rounding_f"])}
    k_nws = {d: implied_solar_scale(h, frozenset(FACTORS), nws + d) for d in (-ab["nws_rounding_f"], 0.0, ab["nws_rounding_f"])}

    # sensitivities on our model: Δ = ours − variant (same sign as the attribution)
    shift = ab["sun_shift_min"] * 60.0
    s_shift = lambda sec: np.array([wbgt.solar_from_cloud(lat, lon, t + timedelta(seconds=sec), c)  # noqa: E731
                                    for t, c in zip(h["time"], h["sky"])])
    clear = np.array([wbgt.solar_from_cloud(lat, lon, t, 0.0) for t in h["time"]])
    sens_ours = {
        "clear_sky_no_cloud": base - evaluate(h, solar=clear)["wbgt_f"],
        "wind_10m_used_at_2m": base - evaluate(h, wind_10m_direct=True)["wbgt_f"],
        "urban_power_law": base - evaluate(h, urban=True)["wbgt_f"],
        "sun_plus_30min": base - evaluate(h, solar=s_shift(shift), sun_shift_s=shift)["wbgt_f"],
        "sun_minus_30min": base - evaluate(h, solar=s_shift(-shift), sun_shift_s=-shift)["wbgt_f"],
    }
    # sensitivities of the residual to what NWS does not publish for this grid cell
    all_swaps = frozenset(FACTORS)
    sens_resid = {f"z0_{z}m": evaluate(h, all_swaps, z0=z)["wbgt_f"] - nws for z in ab["z0_sensitivity_m"]}
    for name in ("reflectance_turf", "reflectance_grass"):
        a = consts.get(f"solarcal_ground.{name}")
        sens_resid[f"albedo_{a}"] = evaluate(h, all_swaps, albedo=a)["wbgt_f"] - nws
    sens_resid["sun_plus_30min"] = evaluate(h, all_swaps, solar=s_shift(shift), sun_shift_s=shift)["wbgt_f"] - nws
    sens_resid["sun_minus_30min"] = evaluate(h, all_swaps, solar=s_shift(-shift), sun_shift_s=-shift)["wbgt_f"] - nws

    # whole-series lag check: does shifting our hourly WBGT by ±1 h line it up better with NWS?
    lag = {}
    ours_at = dict(zip(allh["time"], allh["ours_pipeline_f"]))
    for shift_h in ab["lag_hours"]:
        d = np.array([ours_at[t + timedelta(hours=shift_h)] - n for t, n, s in zip(h["time"], nws, h["solar"])
                      if s > 0 and t + timedelta(hours=shift_h) in ours_at])
        lag[str(shift_h)] = {"daytime_mean_gap_f": _r(d.mean()), "daytime_rms_gap_f": _r(np.sqrt((d ** 2).mean()))}

    rows = []
    for i, t in enumerate(h["time"]):
        rows.append({
            "time": t.isoformat(), "in_demo_window": i in window,
            "inputs": {"air_temp_c": _r(h["ta"][i]), "rh_pct": _r(h["rh"][i], 1), "rh_from_dewpoint_pct": _r(rh_from_dewpoint(h["ta"][i], h["td"][i]), 1),
                       "wind_10m_m_s": _r(h["u10"][i]), "cloud_cover_pct": _r(h["sky"][i], 1), "solar_w_m2": _r(h["solar"][i], 1)},
            "ours_f": _r(base[i]), "nws_f": _r(nws[i], 1), "gap_f": _r(gap[i]),
            "delta_f": {f: _r(att["shapley"][f][i]) for f in FACTORS},
            "delta_alone_f": {f: _r(att["alone"][f][i]) for f in FACTORS},
            "nws_documented_recon_f": _r(recon[i]), "residual_f": _r(residual[i]),
            "implied_solar_scale": {"our_model": [_r(k_ours[d][i], 3) for d in sorted(k_ours)],
                                    "nws_documented_recon": [_r(k_nws[d][i], 3) for d in sorted(k_nws)]},
        })
        if i in window:   # per-hour sensitivities for the demo window only (summaries cover the rest)
            rows[-1]["sensitivity_ours_f"] = {k_: _r(v[i]) for k_, v in sens_ours.items()}
            rows[-1]["sensitivity_residual_f"] = {k_: _r(v[i]) for k_, v in sens_resid.items()}

    def block(idx):
        idx = list(idx)
        return {"gap_f": _stats(gap[idx]), "residual_f": _stats(residual[idx]),
                "delta_f": {f: _stats(att["shapley"][f][idx]) for f in FACTORS},
                "delta_alone_f": {f: _stats(att["alone"][f][idx]) for f in FACTORS},
                "sum_of_deltas_f": _stats(sum(att["shapley"][f][idx] for f in FACTORS)),
                "implied_solar_scale_our_model": _stats(k_ours[0.0][idx]),
                "implied_solar_scale_nws_recon": _stats(k_nws[0.0][idx]),
                "sensitivity_ours_f": {k_: _stats(v[idx]) for k_, v in sens_ours.items()},
                "sensitivity_residual_f": {k_: _stats(v[idx]) for k_, v in sens_resid.items()}}

    sunny = [i for i in range(len(day)) if h["solar"][i] > 0]
    night = [i for i in range(len(day)) if h["solar"][i] <= 0]
    summary = {"demo_window": block(window), "daytime": block(sunny), "night": block(night)}
    contrib = {f: abs(summary["demo_window"]["delta_f"][f]["mean"]) for f in FACTORS}
    top_swap = max(contrib, key=contrib.get)
    resid = summary["demo_window"]["residual_f"]
    top = ("residual" if abs(resid["mean"]) > contrib[top_swap] else top_swap)
    rh_td = rh_from_dewpoint(h["ta"], h["td"])
    ko, kn = summary["demo_window"]["implied_solar_scale_our_model"], summary["demo_window"]["implied_solar_scale_nws_recon"]
    closes = {k_: v["mean"] for k_, v in summary["demo_window"]["sensitivity_residual_f"].items()}
    return {
        "label": label, "raw_file": raw_file, "nws_update_time": raw["properties"].get("updateTime"),
        "baseline_matches_pipeline_f": round(pipeline_err, 3),
        "time_alignment": time_alignment(raw, h, window),
        "humidity_check": {"rh_layer_minus_rh_from_dewpoint_pct": _stats(h["rh"] - rh_td),
                           "reading": "NWS's relativeHumidity layer minus RH computed from its temperature and dewpoint layers"},
        "lag_check": lag,
        "summary": summary,
        "top_contributor": {
            "name": top,
            "mean_f": resid["mean"] if top == "residual" else summary["demo_window"]["delta_f"][top]["mean"],
            "range_f": ([resid["min"], resid["max"]] if top == "residual" else
                        [summary["demo_window"]["delta_f"][top]["min"], summary["demo_window"]["delta_f"][top]["max"]]),
            "attributed_to": ("solar irradiance — NWS's clear-sky curve (daily maximum at solar noon × Gaussian), the "
                              "one documented NWS input we cannot reproduce" if top == "residual" else INPUT[top]),
            "evidence": {
                "night_residual_f": summary["night"]["residual_f"],
                "implied_solar_scale_our_model": ko,
                "implied_solar_scale_nws_recon": kn,
                "residual_mean_under_unpublished_nws_choices_f": closes,
            } if top == "residual" else None,
        },
        "top_swapped_factor": {"name": top_swap, "input": INPUT[top_swap], **summary["demo_window"]["delta_f"][top_swap]},
        "rows": rows if all_rows else [r for r in rows if r["in_demo_window"]],
    }


def compute() -> dict[str, Any]:
    ab = consts.get("wbgt_gap_ablation")
    out = {
        "computed_by": "validation/wbgt_gap.py",
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "synthetic": False,
        "inputs_note": "Cached real NWS gridpoint forecasts (fixtures/); no network. Our WBGT is engine/wbgt.py as "
                       "engine/weather.py runs it; NWS's is its wetBulbGlobeTemperature layer.",
        "site": dict(zip(("lat", "lon"), site())),
        "sign": "delta > 0: our choice makes our WBGT higher than NWS's documented choice. gap = ours − NWS = "
                "Σ delta + residual; residual = (all swaps) − NWS.",
        "attribution": "Shapley value over all 2^6 swap combinations (order-independent; sums exactly). delta_alone_f: "
                       "each swap alone on our baseline.",
        "factors": {f: {"input": INPUT[f], "swap": SWAP[f]} for f in FACTORS},
        "not_swapped": {
            "cloud_attenuation": "same formula both sides: R0·(1 − 0.75 n^3.4), n = sky fraction (Boyer p.5; "
                                 "constants.clear_sky_fallback)",
            "clear_sky_curve": "NWS: daily max at solar noon (f(latitude, day of year)) × Gaussian (Boyer p.3); "
                               "parameters not published → not reproducible; tested via implied_solar_scale",
            "sun_time": "both evaluate the sun at the forecast hour (Boyer p.4 SOLPOS 'date/time of the forecast hour'); "
                        "±30 min is a sensitivity",
        },
        "nws_method_read": [
            "Boyer TR (MDL/NWS), NDFD Wet Bulb Globe Temperature Algorithm and Software Design (constants.ndfd_wbgt)",
            "Dimiceli VE, Piltz SF, Estimation of Black Globe Temperature for Calculation of the WBGT Index "
            "(constants.dimiceli_piltz_globe)",
            "Hunter CH, Minyard CO (1999) WSRC-MS-99-00757 (units of the NWB regression that NDFD's replaces)",
        ],
        "not_verified": [
            "NWS's clear-sky curve: the daily maximum formula and the Gaussian's width are not published in what we read",
            "which NDFD WBGT software version produced these layers (Boyer lists several updates; no version in the API)",
            "units/inputs of the NDFD NWB regression (assumed °C, W/m², m/s, 2 m wind, cloud-adjusted S)",
            "NDFD's surface albedo (AVHRR) and roughness length (MODIS) at grid cell JAX/43,32",
            "NDFD's night-time globe branch (Boyer's 'H = 0 at night' cannot be applied literally; see "
            "constants.ndfd_wbgt.assumptions)",
            "station pressure: NDFD reduces NBM sea-level pressure to the station; we use 1013.25 mb (not tested)",
        ],
        "forecasts": {
            "pinned": analyse(load_raw(fixtures.FIXTURES / ab["raw_pinned"]), "pinned saved forecast (demo headline)",
                              ab["raw_pinned"]),
            "context": analyse(load_raw(fixtures.FIXTURES / ab["raw_context"]), "later cached forecast (context)",
                               ab["raw_context"], all_rows=False),
        },
    }
    return out


# ── printing ─────────────────────────────────────────────────────────────────

SHORT = {"solar_split": "split", "wind_height": "wind", "ground_albedo": "albedo", "globe_model": "globe",
         "nwb_model": "NWB", "humidity": "humid"}


def table(res: dict[str, Any]) -> str:
    head = (f"{'time':>5} {'ours':>5} {'NWS':>4} {'gap':>5} | " + " ".join(f"{SHORT[f]:>6}" for f in FACTORS)
            + f" | {'resid':>5} | {'k(S) ours':>9} {'k(S) NWS':>8}")
    lines = [f"{res['label']} — {res['raw_file']} (NWS update {res['nws_update_time']})", head, "-" * len(head)]
    for r in res["rows"]:
        k1, k2 = r["implied_solar_scale"]["our_model"][1], r["implied_solar_scale"]["nws_documented_recon"][1]
        fmt = lambda k: "   —" if k is None else f"{k:4.2f}"  # noqa: E731
        lines.append(f"{r['time'][11:16]:>5}{'*' if r['in_demo_window'] else ' '}{r['ours_f']:5.1f} {r['nws_f']:4.0f} "
                     f"{r['gap_f']:+5.1f} | " + " ".join(f"{r['delta_f'][f]:+6.2f}" for f in FACTORS)
                     + f" | {r['residual_f']:+5.2f} | {fmt(k1):>9} {fmt(k2):>8}")
    return "\n".join(lines)


def summary_text(res: dict[str, Any]) -> str:
    s = res["summary"]
    out = []
    for key in ("demo_window", "daytime", "night"):
        b = s[key]
        g, rs = b["gap_f"], b["residual_f"]
        out.append(f"{key:>11}: gap {g['mean']:+.2f} [{g['min']:+.2f}, {g['max']:+.2f}]  residual {rs['mean']:+.2f} "
                   f"[{rs['min']:+.2f}, {rs['max']:+.2f}]  " + "  ".join(
                       f"{SHORT[f]} {b['delta_f'][f]['mean']:+.2f}" for f in FACTORS))
    w = s["demo_window"]
    out.append("demo-window sensitivities of ours (ours − variant, mean [min, max]): " + "; ".join(
        f"{k} {v['mean']:+.2f} [{v['min']:+.2f}, {v['max']:+.2f}]" for k, v in w["sensitivity_ours_f"].items()))
    out.append("demo-window residual under NWS unknowns (mean [min, max]): " + "; ".join(
        f"{k} {v['mean']:+.2f} [{v['min']:+.2f}, {v['max']:+.2f}]" for k, v in w["sensitivity_residual_f"].items()))
    ko, kn = w["implied_solar_scale_our_model"], w["implied_solar_scale_nws_recon"]
    out.append(f"implied irradiance scale in the window: our model {ko['mean']:.2f} [{ko['min']:.2f}, {ko['max']:.2f}], "
               f"NWS-documented recon {kn['mean']:.2f} [{kn['min']:.2f}, {kn['max']:.2f}]")
    out.append("lag check (our series shifted by h hours vs NWS, daytime): " + "; ".join(
        f"{k:>2} h mean {v['daytime_mean_gap_f']:+.2f} rms {v['daytime_rms_gap_f']:.2f}" for k, v in res["lag_check"].items()))
    t = res["top_contributor"]
    out.append(f"top contributor: {t['name']} mean {t['mean_f']:+.2f} °F, range [{t['range_f'][0]:+.2f}, "
               f"{t['range_f'][1]:+.2f}]; top swapped factor: {res['top_swapped_factor']['name']} "
               f"mean {res['top_swapped_factor']['mean']:+.2f} [{res['top_swapped_factor']['min']:+.2f}, "
               f"{res['top_swapped_factor']['max']:+.2f}]")
    ta = res["time_alignment"]
    out.append(f"time alignment: lead {ta['lead_h_window']} h, within NDFD hourly range {ta['within_ndfd_hourly_range']}, "
               f"non-whole-°F values {ta['values_not_whole_degF']}, baseline vs pipeline max |Δ| "
               f"{res['baseline_matches_pipeline_f']} °F")
    return "\n".join(out)


def main() -> None:
    if "--raw" in sys.argv:
        path = Path(sys.argv[sys.argv.index("--raw") + 1])
        res = analyse(load_raw(path), "other raw gridpoint file (not written to results.json)", str(path))
        print(table(res))
        print(summary_text(res))
        return
    new = compute()
    for res in new["forecasts"].values():
        print(table(res))
        print(summary_text(res))
        print()
    results = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    results["wbgt_gap"] = new
    RESULTS.write_text(json.dumps(results, indent=2) + "\n")
    print(f"wrote {RESULTS.relative_to(ROOT)}[\"wbgt_gap\"]")


if __name__ == "__main__":
    main()
