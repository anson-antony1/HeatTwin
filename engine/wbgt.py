"""Outdoor WBGT from weather (Liljegren et al. 2008) and from the sideline node's globe reading.

Port of J.C. Liljegren's reference code "WBGT, Version 1.1" (© 2008 UChicago Argonne, LLC; Decision &
Information Sciences Division, Argonne National Laboratory) to numpy, as redistributed in pywbgt 3.0.7
(src/liljegren_c.c). Changes from the original, noted per its license: vectorized over arrays; solar
position from engine.physio.radiation (NOAA equations) instead of the bundled ephemeris; sun-distance
factor from constants.irradiance_split; non-convergence returns NaN instead of -9999. Every number is in
constants.yaml (``liljegren_2008``, ``wbgt_inputs``, ``node_globe``).

    WBGT = 0.7·T_nwb + 0.2·T_g + 0.1·T_a                                     (outdoor, ISO 7243 weights)

T_g (2-inch black globe) and T_nwb (natural wet bulb, cylindrical wick) each come from a steady-state energy
balance solved by relaxed fixed-point iteration (T ← 0.9·T + 0.1·T_new until |ΔT| < 0.02 K):

  globe:  ε_g σ T_g⁴ = ε_g σ · ½(ε_a T_a⁴ + ε_sfc T_sfc⁴) − h_sphere (T_g − T_a)
                       + ½ S (1 − α_g) [f_dir (1/(2 cos θ) − 1) + 1 + α_sfc]
          (longwave from sky and ground, convection, direct+diffuse+reflected sunlight on a sphere)

  wick:   T_nwb = T_a − (L_v/ (c_p M_air/M_h2o)) · (e_w − e_a)/(P − e_w) · (Pr/Sc)^0.56 + F_rad / h_cyl
          F_rad = σ ε_w [½(ε_a T_a⁴ + ε_sfc T_sfc⁴) − T_w⁴]
                  + (1 − α_w) S [(1 − f_dir)(1 + ¼ D/L) + f_dir (tan θ/π + ¼ D/L) + α_sfc]
          (evaporative cooling via the heat/mass-transfer analogy, plus net radiation on the wick)

The ground temperature T_sfc is taken equal to air temperature, as in the reference code.
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Optional

import numpy as np

from engine import consts
from engine.physio import radiation


# ── constants ────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _L() -> dict[str, Any]:
    L = dict(consts.get("liljegren_2008"))
    L["r_air"] = L["r_gas_j_kmol_k"] / L["m_air_g_mol"]                       # J/(kg K)
    L["ratio"] = L["cp_j_kg_k"] * L["m_air_g_mol"] / L["m_h2o_g_mol"]
    L["pr"] = L["cp_j_kg_k"] / (L["cp_j_kg_k"] + L["pr_r_coeff"] * L["r_air"])  # Prandtl number
    return L


def _inputs() -> dict[str, Any]:
    return consts.get("wbgt_inputs")


def _c_to_f(c):
    ph = consts.get("physical")
    return np.asarray(c) * ph["f_per_c"] + ph["f_offset"]


# ── thermodynamic and transport properties (liljegren_c.c 228-461) ─────────

def esat_mb(tk):
    """Saturation vapour pressure over water [mb], Buck (1981) with the 1.004 moist-air enhancement."""
    e = _L()["esat"]
    return e["enhancement"] * e["a_mb"] * np.exp(e["b"] * (tk - 273.15) / (tk - e["c_k"]))


def dew_point_k(e_mb):
    """Inverse of esat_mb."""
    L = _L()
    z = np.log(e_mb / (L["esat"]["a_mb"] * L["esat"]["enhancement"]))
    return 273.15 + L["dewpoint"]["c_c"] * z / (L["esat"]["b"] - z)


def emis_atm(tk, rh_frac):
    """Clear-sky atmospheric emissivity from vapour pressure in mb (Oke)."""
    a = _L()["emis_atm"]
    return a["a"] * (rh_frac * esat_mb(tk)) ** a["b"]


def evap_j_kg(tk):
    """Latent heat of vaporisation, linear over 283-313 K."""
    e = _L()["evap"]
    return (e["t_ref_k"] - tk) / e["span_k"] * e["slope_j_kg"] + e["l_ref_j_kg"]


def viscosity(tk):
    """Dynamic viscosity of air [kg/(m s)], Chapman-Enskog with a linearised collision integral."""
    L = _L()
    v = L["viscosity"]
    omega = (tk / v["eps_kappa_k"] - v["omega_tr0"]) / v["omega_scale"] * v["omega_slope"] + v["omega0"]
    return v["coeff"] * np.sqrt(L["m_air_g_mol"] * tk) / (v["sigma_angstrom"] ** 2 * omega)


def thermal_cond(tk):
    """Thermal conductivity of air [W/(m K)] (modified Eucken)."""
    L = _L()
    return (L["cp_j_kg_k"] + L["pr_r_coeff"] * L["r_air"]) * viscosity(tk)


def diffusivity(tk, p_mb):
    """Diffusivity of water vapour in air [m²/s]."""
    L = _L()
    d = L["diffusivity"]
    pcrit13 = (d["pcrit_air_atm"] * d["pcrit_h2o_atm"]) ** (1.0 / 3.0)
    tcrit512 = (d["tcrit_air_k"] * d["tcrit_h2o_k"]) ** (5.0 / 12.0)
    tcrit12 = np.sqrt(d["tcrit_air_k"] * d["tcrit_h2o_k"])
    mmix = np.sqrt(1.0 / L["m_air_g_mol"] + 1.0 / L["m_h2o_g_mol"])
    return d["a"] * (tk / tcrit12) ** d["b"] * pcrit13 * tcrit512 * mmix / (p_mb / d["mb_per_atm"]) * 1e-4


def _reynolds(d_m, tk, p_mb, speed):
    L = _L()
    density = p_mb * 100.0 / (L["r_air"] * tk)
    return speed * density * d_m / viscosity(tk)


def h_sphere(d_m, tk, p_mb, speed):
    """Convective coefficient for a sphere [W/(m² K)]: Nu = 2 + 0.6 Re^½ Pr^⅓."""
    L = _L()
    s = L["sphere_nu"]
    nu = s["a"] + s["b"] * np.sqrt(_reynolds(d_m, tk, p_mb, speed)) * L["pr"] ** s["pr_exp"]
    return nu * thermal_cond(tk) / d_m


def h_cylinder(d_m, tk, p_mb, speed):
    """Convective coefficient for a cylinder in cross-flow [W/(m² K)] (Bedingfield & Drew)."""
    L = _L()
    c = L["cylinder_nu"]
    nu = c["b"] * _reynolds(d_m, tk, p_mb, speed) ** (1.0 - c["c"]) * L["pr"] ** (1.0 - c["a"])
    return nu * thermal_cond(tk) / d_m


# ── sun and wind (liljegren_c.c 315-336, 754-881) ───────────────────────────

def _utc_seconds(time) -> np.ndarray:
    times = time if isinstance(time, (list, tuple, np.ndarray)) else [time]
    out = []
    for t in times:
        if t.tzinfo is None:
            raise ValueError("time must be timezone-aware")
        out.append(t.astimezone(timezone.utc).timestamp())
    return np.asarray(out, dtype=float)


def solar_geometry(t_utc_s, lat, lon):
    """(cos zenith, top-of-atmosphere horizontal irradiance [W/m²]) at UTC epoch seconds."""
    L = _L()
    ir = consts.get("irradiance_split")
    elev = radiation.solar_elevation_deg(t_utc_s, lat, lon)
    cza = np.sin(np.radians(elev))
    doy = np.array([datetime.fromtimestamp(x, tz=timezone.utc).timetuple().tm_yday for x in np.atleast_1d(t_utc_s)])
    sun_dist_factor = 1.0 + ir["eccentricity_amp"] * np.cos(2.0 * np.pi * doy / ir["days_per_year"])
    toa = L["solar_const_w_m2"] * np.maximum(cza, 0.0) * sun_dist_factor
    return cza, np.where(cza < L["cza_min"], 0.0, toa)


def direct_fraction(normsolar):
    """Fraction of global irradiance in the direct beam from normalised irradiance n = S/S_toa."""
    f = _L()["fdir"]
    n = np.asarray(normsolar, dtype=float)
    safe = np.where(n > 0, n, 1.0)
    return np.where(n > 0, np.clip(np.exp(f["a"] - f["b"] * safe - f["c"] / safe), 0.0, f["max"]), 0.0)


def adjust_solar(solar, toa):
    """Cap S at 0.85·S_toa (sensor-error guard) and return (S, f_dir)."""
    L = _L()
    toa = np.asarray(toa, dtype=float)
    norm = np.where(toa > 0, np.minimum(np.asarray(solar, dtype=float) / np.where(toa > 0, toa, 1.0),
                                        L["normsolar_max"]), 0.0)
    return norm * toa, direct_fraction(norm)


def stability_class(daytime, speed, solar, dt_c):
    """Pasquill-Gifford class (1=A … 6=F) from the EPA solar-radiation / ΔT method."""
    L = _L()
    tab = np.asarray(L["stability_table"])
    sb = L["stability_solar_breaks_w_m2"]          # ≥925 → 0, ≥675 → 1, ≥175 → 2, else 3
    dvb = L["stability_day_speed_breaks_m_s"]      # <2 → 0, <3 → 1, <5 → 2, <6 → 3, else 4
    nvb = L["stability_night_speed_breaks_m_s"]    # <2 → 0, <2.5 → 1, else 2
    solar, speed = np.asarray(solar, dtype=float), np.asarray(speed, dtype=float)
    j_day = np.where(solar >= sb[0], 0, np.where(solar >= sb[1], 1, np.where(solar >= sb[2], 2, 3)))
    i_day = np.searchsorted(dvb, speed, side="right")
    j_night = np.where(np.asarray(dt_c) >= 0.0, 6, 5)
    i_night = np.searchsorted(nvb, speed, side="right")
    return np.where(daytime, tab[i_day, j_day], tab[i_night, j_night])


def wind_at_2m(speed, z_m, stab, urban: bool):
    """Power-law reduction of wind measured at z_m to Liljegren's 2 m reference height."""
    L = _L()
    exps = np.asarray(L["wind_exp_urban" if urban else "wind_exp_rural"])
    est = np.asarray(speed, dtype=float) * (L["ref_height_m"] / z_m) ** exps[np.asarray(stab) - 1]
    return np.maximum(est, L["min_speed_m_s"])


# ── energy balances (liljegren_c.c 892-1011) ─────────────────────────────────

def _iterate(step, x0):
    """Liljegren's relaxed fixed point: converged where |x_new − x| < tol; NaN where it never converges."""
    L = _L()
    prev = np.array(x0, dtype=float)
    result = np.full(prev.shape, np.nan)
    done = np.zeros(prev.shape, dtype=bool)
    for _ in range(L["max_iter"]):
        new = step(prev)
        conv = (np.abs(new - prev) < L["convergence_k"]) & ~done
        result[conv] = new[conv]
        done |= conv
        if done.all():
            break
        prev = np.where(done, prev, (1.0 - L["relaxation"]) * prev + L["relaxation"] * new)
    return result


def globe_temp_k(ta_k, rh_frac, p_mb, speed, solar, fdir, cza, d_globe):
    L = _L()
    sb, eg = L["stefan_boltzmann_w_m2_k4"], L["emis_globe"]
    tsfc = ta_k
    lw = 0.5 * (emis_atm(ta_k, rh_frac) * ta_k**4 + L["emis_sfc"] * tsfc**4)
    inv_2cza = np.where(fdir > 0, 1.0 / (2.0 * np.maximum(cza, L["cza_min"])), 0.0)
    sw = solar / (2.0 * sb * eg) * (1.0 - L["alb_globe"]) * (fdir * (inv_2cza - 1.0) + 1.0 + L["alb_sfc"])

    def step(tg):
        h = h_sphere(d_globe, 0.5 * (tg + ta_k), p_mb, speed)
        return np.maximum(lw - h / (sb * eg) * (tg - ta_k) + sw, 0.0) ** 0.25

    return _iterate(step, ta_k)


def wet_bulb_k(ta_k, rh_frac, p_mb, speed, solar, fdir, cza, radiative: bool = True):
    """Natural wet bulb [K] (radiative=True) or psychrometric wet bulb (False)."""
    L = _L()
    sb, ew = L["stefan_boltzmann_w_m2_k4"], L["emis_wick"]
    d, ln, a = L["d_wick_m"], L["l_wick_m"], L["cylinder_nu"]["a"]
    tsfc = ta_k
    eair = rh_frac * esat_mb(ta_k)
    sza = np.arccos(np.clip(cza, -1.0, 1.0))
    tan_sza = np.where(fdir > 0, np.tan(np.minimum(sza, np.arccos(L["cza_min"]))), 0.0)
    lw_in = 0.5 * (emis_atm(ta_k, rh_frac) * ta_k**4 + L["emis_sfc"] * tsfc**4)
    sw = (1.0 - L["alb_wick"]) * solar * ((1.0 - fdir) * (1.0 + 0.25 * d / ln)
                                          + fdir * (tan_sza / np.pi + 0.25 * d / ln) + L["alb_sfc"])

    def step(tw):
        tref = 0.5 * (tw + ta_k)
        heat = (sb * ew * (lw_in - tw**4) + sw) / h_cylinder(d, tref, p_mb, speed) if radiative else 0.0
        ewick = esat_mb(tw)
        density = p_mb * 100.0 / (L["r_air"] * tref)
        sc = viscosity(tref) / (density * diffusivity(tref, p_mb))          # Schmidt number
        return ta_k - evap_j_kg(tref) / L["ratio"] * (ewick - eair) / (p_mb - ewick) * (L["pr"] / sc) ** a + heat

    return _iterate(step, dew_point_k(eair))


# ── public API ───────────────────────────────────────────────────────────────

def wbgt_components(air_c, rh, wind, solar_w_m2, lat, lon, time, *, wind_height_m: Optional[float] = None,
                    pressure_mb: Optional[float] = None, d_globe_m: Optional[float] = None) -> dict[str, np.ndarray]:
    """Liljegren T_g, T_nwb, T_psy and WBGT [°C] plus the 2 m wind and capped solar it used.

    ``wind`` is measured at ``wind_height_m`` (default: the NWS 10 m level) and reduced to 2 m.
    ``time`` is a timezone-aware datetime (or a sequence of them, matching array inputs).
    """
    L, inp = _L(), _inputs()
    p = inp["pressure_mb"] if pressure_mb is None else pressure_mb
    z = inp["wind_height_m"] if wind_height_m is None else wind_height_m
    d_g = L["d_globe_m"] if d_globe_m is None else d_globe_m
    cza, toa = solar_geometry(_utc_seconds(time), lat, lon)
    air_c, rh, wind, solar_w_m2, cza, toa = (np.atleast_1d(np.asarray(x, dtype=float)) for x in
                                            np.broadcast_arrays(air_c, rh, wind, solar_w_m2, cza, toa))
    ta_k = air_c + 273.15
    rh_f = rh / 100.0
    solar, fdir = adjust_solar(solar_w_m2, toa)
    if z == L["ref_height_m"]:
        speed = np.maximum(np.asarray(wind, dtype=float), L["min_speed_m_s"])
    else:
        stab = stability_class(cza > 0, wind, solar, inp["night_dt_c"])
        speed = wind_at_2m(wind, z, stab, inp["urban"])
    tg = globe_temp_k(ta_k, rh_f, p, speed, solar, fdir, cza, d_g) - 273.15
    tnwb = wet_bulb_k(ta_k, rh_f, p, speed, solar, fdir, cza, True) - 273.15
    tpsy = wet_bulb_k(ta_k, rh_f, p, speed, solar, fdir, cza, False) - 273.15
    w = L["weights"]
    return {"tg_c": tg, "tnwb_c": tnwb, "tpsy_c": tpsy, "wbgt_c": w["nwb"] * tnwb + w["globe"] * tg + w["air"] * (ta_k - 273.15),
            "wind_2m_m_s": speed, "solar_w_m2": solar, "fdir": fdir, "cos_zenith": cza}


def wbgt_f(air_c, rh, wind, solar_w_m2, lat, lon, time, **kw) -> float:
    """Outdoor WBGT [°F] from air temperature [°C], RH [%], 10 m wind [m/s], global horizontal solar [W/m²]."""
    out = _c_to_f(wbgt_components(air_c, rh, wind, solar_w_m2, lat, lon, time, **kw)["wbgt_c"])
    return float(out[0]) if np.ndim(air_c) == 0 else out


def solar_from_cloud(lat: float, lon: float, time: datetime, cloud_pct: float) -> float:
    """Global horizontal irradiance [W/m²] from sky cover: Haurwitz clear sky × Kasten-Czeplak cloud factor.

    Same function engine.physio uses (constants.clear_sky_fallback), so forecast WBGT and the physiology model
    see the same sunlight.
    """
    t = _utc_seconds(time)
    elev = radiation.solar_elevation_deg(t, lat, lon)
    return float(radiation.ghi_from_cloud(t, elev, np.asarray([cloud_pct], dtype=float))[0])


def node_components(air_c: float, rh: float, globe_c: float, wind: Optional[float] = None, *,
                    time: Optional[datetime] = None, lat: Optional[float] = None, lon: Optional[float] = None,
                    pressure_mb: Optional[float] = None, d_node_m: Optional[float] = None) -> dict[str, float]:
    """Field WBGT from the sideline node (air T, RH, small black-globe T, optional wind at node height).

    The node has no wet-bulb wick and no pyranometer, and its globe is not the standard one. So:
      1. Invert the globe energy balance above for the node's globe diameter to get the irradiance S that
         explains the measured globe temperature (solve the linear-in-S equation; f_dir iterated from S/S_toa
         when time and site are given, otherwise all sunlight treated as diffuse).
      2. Feed S into Liljegren's natural-wet-bulb and 2-inch-globe balances, so the node's WBGT is on the same
         footing as the forecast WBGT it is compared with.

    Caveat: the node's 40 mm ping-pong-ball globe is not the 150 mm ISO 7243 globe. A small globe tracks air
    temperature and wind more closely and lags sunlight less; step 1 accounts for its size through h_sphere,
    but paint emissivity/albedo and the probe's own mass are assumptions (constants.node_globe). Wind: if the
    node has no anemometer (wind=None) the calm-air minimum is used, which overstates inferred sunlight in a
    breeze; pass the forecast's 2 m wind when available.
    """
    L, inp = _L(), _inputs()
    p = inp["pressure_mb"] if pressure_mb is None else pressure_mb
    d_node = consts.get("node_globe.d_globe_m") if d_node_m is None else d_node_m
    speed = max(float(wind) if wind is not None else 0.0, L["min_speed_m_s"])
    ta_k, tg_k, rh_f = air_c + 273.15, globe_c + 273.15, rh / 100.0
    sb, eg = L["stefan_boltzmann_w_m2_k4"], L["emis_globe"]

    if time is not None and lat is not None and lon is not None:
        cza_a, toa_a = solar_geometry(_utc_seconds(time), lat, lon)
        cza, toa = float(cza_a[0]), float(toa_a[0])
    else:
        cza, toa = 0.0, 0.0
    lw = 0.5 * (float(emis_atm(ta_k, rh_f)) * ta_k**4 + L["emis_sfc"] * ta_k**4)
    h = float(h_sphere(d_node, 0.5 * (tg_k + ta_k), p, speed))
    excess = tg_k**4 - lw + h / (sb * eg) * (tg_k - ta_k)     # = S/(2σε)(1-α_g)[f_dir(1/(2cza)-1)+1+α_sfc]
    fdir, solar = 0.0, 0.0
    for _ in range(20):                                        # f_dir depends on S; converges in a few passes
        geom = fdir * (1.0 / (2.0 * max(cza, L["cza_min"])) - 1.0) + 1.0 + L["alb_sfc"]
        solar = max(excess * 2.0 * sb * eg / ((1.0 - L["alb_globe"]) * geom), 0.0)
        new = float(direct_fraction(solar / toa)) if toa > 0 else 0.0
        if abs(new - fdir) < 1e-4:
            break
        fdir = new
    arr = lambda x: np.asarray([x], dtype=float)  # noqa: E731
    tnwb = float(wet_bulb_k(arr(ta_k), arr(rh_f), p, arr(speed), arr(solar), arr(fdir), arr(cza))[0]) - 273.15
    tg_std = float(globe_temp_k(arr(ta_k), arr(rh_f), p, arr(speed), arr(solar), arr(fdir), arr(cza),
                                L["d_globe_m"])[0]) - 273.15
    w = L["weights"]
    wbgt_c = w["nwb"] * tnwb + w["globe"] * tg_std + w["air"] * air_c
    return {"wbgt_c": wbgt_c, "wbgt_f": float(_c_to_f(wbgt_c)), "tnwb_c": tnwb, "tg_std_c": tg_std,
            "solar_inferred_w_m2": solar, "fdir": fdir, "wind_used_m_s": speed}


def wbgt_from_node(air_c: float, rh: float, globe_c: float, wind: Optional[float] = None, **kw) -> float:
    """Outdoor WBGT [°F] from a node reading (see node_components for method and the 40 mm globe caveat)."""
    return node_components(air_c, rh, globe_c, wind, **kw)["wbgt_f"]
