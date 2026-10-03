"""Radiant and wind environment at the athlete — MODEL.md §6.

* Solar position: NOAA General Solar Position equations (constants.solar_position).
* Global horizontal → direct + diffuse: Erbs et al. 1982 (constants.irradiance_split).
* Solar ΔMRT for a standing person outdoors: ASHRAE 55 Appendix C SolarCal (constants.solarcal),
  with the projected-area factor averaged over body azimuth.
* 10 m wind → body-height wind: neutral log profile (constants.wind_profile).

Everything is vectorized over a 1-D array of step times.
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache

import numpy as np

from engine import consts


# ── solar geometry ───────────────────────────────────────────────────────────

def solar_elevation_deg(t_utc_s: np.ndarray, lat_deg: float, lon_deg: float) -> np.ndarray:
    """Solar elevation angle β (degrees above horizon) at UTC epoch seconds ``t_utc_s``.

    NOAA GMD 'General Solar Position Calculations': fractional year γ, equation of time,
    declination, true solar time (UTC, so timezone = 0), hour angle, cos(zenith).
    """
    sp = consts.get("solar_position")
    t = np.atleast_1d(np.asarray(t_utc_s, dtype=float))
    dts = [datetime.fromtimestamp(x, tz=timezone.utc) for x in t]
    doy = np.array([d.timetuple().tm_yday for d in dts], dtype=float)
    year_len = np.array([366.0 if _is_leap(d.year) else 365.0 for d in dts])
    hour = np.array([d.hour + d.minute / 60.0 + d.second / 3600.0 for d in dts])

    g = 2.0 * np.pi / year_len * (doy - 1.0 + (hour - 12.0) / 24.0)
    e = sp["eqtime_coeffs"]
    eqtime = sp["eqtime_scale_min"] * (
        e[0] + e[1] * np.cos(g) + e[2] * np.sin(g) + e[3] * np.cos(2 * g) + e[4] * np.sin(2 * g)
    )
    c = sp["decl_coeffs"]
    decl = (
        c[0] + c[1] * np.cos(g) + c[2] * np.sin(g) + c[3] * np.cos(2 * g) + c[4] * np.sin(2 * g)
        + c[5] * np.cos(3 * g) + c[6] * np.sin(3 * g)
    )
    time_offset = eqtime + sp["minutes_per_degree_longitude"] * lon_deg  # timezone 0 (UTC)
    tst = hour * 60.0 + time_offset
    ha = np.radians(tst / sp["minutes_per_degree_longitude"] - 180.0)
    lat = np.radians(lat_deg)
    cos_zen = np.sin(lat) * np.sin(decl) + np.cos(lat) * np.cos(decl) * np.cos(ha)
    return np.degrees(np.arcsin(np.clip(cos_zen, -1.0, 1.0)))


def _is_leap(y: int) -> bool:
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def extraterrestrial_horizontal(t_utc_s: np.ndarray, elev_deg: np.ndarray) -> np.ndarray:
    """Extraterrestrial irradiance on a horizontal surface I_0·sin β [W/m²] (constants.irradiance_split)."""
    ir = consts.get("irradiance_split")
    t = np.atleast_1d(np.asarray(t_utc_s, dtype=float))
    doy = np.array([datetime.fromtimestamp(x, tz=timezone.utc).timetuple().tm_yday for x in t], dtype=float)
    i0 = ir["solar_constant_w_m2"] * (1.0 + ir["eccentricity_amp"] * np.cos(2.0 * np.pi * doy / ir["days_per_year"]))
    return i0 * np.maximum(np.sin(np.radians(elev_deg)), 0.0)


def split_direct_diffuse(ghi: np.ndarray, t_utc_s: np.ndarray, elev_deg: np.ndarray):
    """Erbs et al. (1982) diffuse fraction → (direct-normal I_dir, diffuse horizontal I_diff) [W/m²]."""
    ir = consts.get("irradiance_split")
    ghi = np.maximum(np.asarray(ghi, dtype=float), 0.0)
    elev = np.asarray(elev_deg, dtype=float)
    sun_up = elev > ir["min_sun_elevation_deg"]
    i0h = extraterrestrial_horizontal(t_utc_s, elev)
    kt = np.where(sun_up & (i0h > 0), ghi / np.where(i0h > 0, i0h, 1.0), 0.0)
    kt = np.clip(kt, 0.0, ir["kt_max"])
    lo, hi = ir["erbs_kt_breaks"]
    a_lo = ir["erbs_low"]            # kd = a0 + a1·kt          for kt ≤ lo
    poly = ir["erbs_mid"]            # kd = Σ p_j kt^j          for lo < kt ≤ hi
    kd_hi = ir["erbs_high"]          # kd = const               for kt > hi
    kd_mid = sum(p * kt**j for j, p in enumerate(poly))
    kd = np.where(kt <= lo, a_lo[0] + a_lo[1] * kt, np.where(kt <= hi, kd_mid, kd_hi))
    kd = np.clip(kd, 0.0, 1.0)
    i_diff = np.where(sun_up, kd * ghi, ghi)
    sin_b = np.sin(np.radians(np.maximum(elev, ir["min_sun_elevation_deg"])))
    i_dir = np.where(sun_up, (ghi - i_diff) / sin_b, 0.0)
    return np.maximum(i_dir, 0.0), i_diff


@lru_cache(maxsize=1)
def _fp_azimuth_mean() -> tuple[np.ndarray, np.ndarray]:
    """Projected-area factor f_p(β) averaged uniformly over SHARP 0–180° (players face every way)."""
    sc = consts.get("solarcal")
    az = np.asarray(sc["fp_az_grid_deg"], dtype=float)
    tab = np.asarray(sc["fp_table_standing"], dtype=float)  # [az, alt]
    mean = np.trapezoid(tab, az, axis=0) / (az[-1] - az[0])
    return np.asarray(sc["fp_alt_grid_deg"], dtype=float), mean


def solar_delta_mrt(ghi: np.ndarray, t_utc_s: np.ndarray, elev_deg: np.ndarray,
                    ground_reflectance: float) -> np.ndarray:
    """SolarCal ΔMRT [K] for a standing person on an open field (MODEL.md §6.3)."""
    ghi = np.maximum(np.asarray(ghi, dtype=float), 0.0)
    i_dir, i_diff = split_direct_diffuse(ghi, t_utc_s, elev_deg)
    alt_grid, fp_mean = _fp_azimuth_mean()
    fp = np.interp(np.clip(elev_deg, 0.0, 90.0), alt_grid, fp_mean)
    return solarcal_delta_mrt(i_dir, i_diff, ghi, fp, ground_reflectance)


def solarcal_delta_mrt(i_dir, i_diff, ghi, fp, ground_reflectance: float):
    """Arens et al. 2015 Eq. 6 with f_svv = τ = f_bes = 1 (open field) → ΔMRT = ERF / (f_eff·h_r)."""
    sc = consts.get("solarcal")
    f_eff, f_svv, tau, f_bes = sc["f_eff_standing"], sc["f_svv_open_field"], sc["transmittance_open"], sc["f_bes_open"]
    half = sc["sky_hemisphere_fraction"]
    e_diff = f_eff * f_svv * half * tau * np.asarray(i_diff, dtype=float)
    e_dir = f_eff * np.asarray(fp, dtype=float) * tau * f_bes * np.asarray(i_dir, dtype=float)
    e_refl = f_eff * f_svv * half * tau * np.asarray(ghi, dtype=float) * ground_reflectance
    erf = (e_diff + e_dir + e_refl) * sc["alpha_sw"] / sc["alpha_lw"]
    return erf / (f_eff * sc["h_r_w_m2_k"])


def mrt_from_linear_delta(ta_c, d_mrt_lin):
    """Mean radiant temperature whose exact longwave exchange carries the SolarCal radiant field.

    SolarCal's ΔMRT = ERF/(f_eff·h_r) is linearised (h_r ≈ 6 W/m²K near room temperature). The two-node model
    evaluates radiation with T⁴ at the clothing/MRT mean, so feeding it T_a + ΔMRT would over-deliver the field.
    Solve f_eff·ε·σ·(T_r⁴ − T_a⁴) = ε·ERF, i.e. T_r⁴ = T_a⁴ + h_r·ΔMRT/σ (temperatures in K).
    """
    sc = consts.get("solarcal")
    ph = consts.get("physical")
    k = ph["kelvin_offset"]
    ta_k = np.asarray(ta_c, dtype=float) + k
    tr4 = ta_k ** 4 + sc["h_r_w_m2_k"] * np.asarray(d_mrt_lin, dtype=float) / ph["stefan_boltzmann_w_m2_k4"]
    return tr4 ** 0.25 - k


def ground_reflectance(surface: str) -> float:
    return float(consts.get(f"solarcal_ground.reflectance_{surface}"))


# ── wind ─────────────────────────────────────────────────────────────────────

def wind_at_body(v10: np.ndarray) -> np.ndarray:
    """10 m forecast wind → wind at standing body height (neutral log profile), floored at Gagge's v_min."""
    wp = consts.get("wind_profile")
    z0 = wp["z0_open_grass_m"]
    factor = np.log(wp["z_body_m"] / z0) / np.log(wp["z_ref_m"] / z0)
    return np.maximum(np.asarray(v10, dtype=float) * factor, consts.get("gagge_1986.min_air_speed_m_s"))


# ── fallback GHI when the weather source gives none ─────────────────────────

def ghi_from_cloud(t_utc_s: np.ndarray, elev_deg: np.ndarray, cloud_pct: np.ndarray) -> np.ndarray:
    """Clear-sky GHI (Haurwitz) × cloud attenuation (Kasten & Czeplak) [W/m²].

    Used only when neither the weather source nor engine.wbgt provides solar irradiance; the
    simulation output is labelled when this path runs (constants.clear_sky_fallback).
    """
    cs = consts.get("clear_sky_fallback")
    cos_z = np.maximum(np.sin(np.radians(np.asarray(elev_deg, dtype=float))), 0.0)
    clear = np.where(cos_z > 0, cs["haurwitz_a"] * cos_z * np.exp(-cs["haurwitz_b"] / np.where(cos_z > 0, cos_z, 1.0)), 0.0)
    octas = np.clip(np.asarray(cloud_pct, dtype=float), 0, 100) / 100.0 * 8.0
    return clear * (1.0 - cs["kc_a"] * (octas / 8.0) ** cs["kc_b"])
