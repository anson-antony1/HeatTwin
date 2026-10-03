"""twonode-v1 — transient Gagge two-node model, vectorized over ensemble × athletes.

Equations, units and sources: engine/physio/MODEL.md. Every coefficient is read from
engine/constants.yaml (block ``gagge_1986`` and friends); none is written here.

Layers:
  ``GaggeParams``        constants resolved once into floats.
  ``integrate``          the numerical core: state arrays [E, N], inputs [N, S] / [S].
  ``build_timeline``     plan + roster + weather → per-step input arrays.
  ``simulate_arrays``    timeline + ensemble draws → core temperature [E, N, T].
  ``simulate_roster``    the public entry point → CONTRACTS.md ``SimulationResult`` dict.

Output: estimate — planning only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Mapping, Sequence

import numpy as np

from engine import consts
from engine.physio import clothing, metabolic, radiation

MODEL_NAME = "twonode-v1"
PARAMS_REF = "engine/physio/MODEL.md; engine/constants.yaml#gagge_1986"
ESTIMATE_LABEL = "estimate — planning only"

# constants.yaml blocks a planning simulation depends on (for "uses unverified constants" labels)
MODEL_BLOCKS = (
    "gagge_1986", "physical", "body_surface_area", "metabolic", "drill_met", "gear_clothing",
    "solar_position", "solarcal", "solarcal_ground", "irradiance_split", "wind_profile", "shade_model",
    "non_participant", "acclimatization", "ensemble_priors", "planning_limit_core_c", "iso7933_dynamic",
    "model_options", "hr_met", "nata_gear_phasing", "clothing_conservative",
)


# ─────────────────────────────────────────────────────────────────────────────
# Parameters
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GaggeParams:
    tsk_n: float
    tcr_n: float
    alpha0: float
    skbf_n: float
    skbf_min: float
    skbf_max: float
    c_dil: float
    c_str: float
    c_sw: float
    mrsw_max: float
    sweat_skin_exp: float
    c_body: float
    k_cs: float
    c_bl: float
    latent: float
    shiver: float
    alpha_a0: float
    alpha_a1: float
    alpha_a2: float
    met_factor: float
    external_work_met: float
    lr: float
    p_atm: float
    resp_s: float
    resp_s_ref: float
    resp_l: float
    resp_l_ref: float
    hc_nat: float
    hc_forced: float
    hc_p_exp: float
    hc_act: float
    hc_act_off: float
    hc_act_exp: float
    hr_init: float
    emissivity: float
    ar_ad: float
    sigma: float
    kelvin: float
    wcrit_c_coeff: float
    wcrit_c_exp: float
    wcrit_n_coeff: float
    wcrit_n_exp: float
    w_diff: float
    v_min: float
    psat_a: float
    psat_b: float
    psat_c: float
    tcl_tol: float
    esk0_per_met: float
    s_per_h: float

    @property
    def tbn(self) -> float:
        return self.alpha0 * self.tsk_n + (1.0 - self.alpha0) * self.tcr_n


@lru_cache(maxsize=1)
def gagge_params() -> GaggeParams:
    g = consts.get("gagge_1986")
    ph = consts.get("physical")
    return GaggeParams(
        tsk_n=g["t_sk_neutral_c"], tcr_n=g["t_cr_neutral_c"], alpha0=g["alpha0"],
        skbf_n=g["skbf_neutral_l_m2_h"], skbf_min=g["skbf_min_l_m2_h"], skbf_max=g["skbf_max_l_m2_h"],
        c_dil=g["c_dil_l_m2_h_k"], c_str=g["c_str_per_k"], c_sw=g["c_sw_g_m2_h_k"],
        mrsw_max=g["m_rsw_max_g_m2_h"], sweat_skin_exp=g["sweat_skin_exp_k"], c_body=g["c_body_wh_kg_k"],
        k_cs=g["k_cs_w_m2_k"], c_bl=g["c_blood_wh_l_k"], latent=g["latent_sweat_wh_g"],
        shiver=g["shiver_w_m2_k2"], alpha_a0=g["alpha_a0"], alpha_a1=g["alpha_a1"], alpha_a2=g["alpha_a2"],
        met_factor=g["met_factor_w_m2"], external_work_met=g["external_work_met"],
        lr=g["lewis_ratio_k_mmhg"], p_atm=g["p_atm_atm"],
        resp_s=g["resp_sensible_coeff"], resp_s_ref=g["resp_sensible_ref_c"],
        resp_l=g["resp_latent_coeff"], resp_l_ref=g["resp_latent_ref_mmhg"],
        hc_nat=g["hc_natural_coeff"], hc_forced=g["hc_forced_coeff"], hc_p_exp=g["hc_pressure_exp"],
        hc_act=g["hc_act_coeff"], hc_act_off=g["hc_act_met_offset"], hc_act_exp=g["hc_act_exp"],
        hr_init=g["hr_initial_w_m2_k"], emissivity=g["emissivity_clothing"], ar_ad=g["ar_ad_standing"],
        sigma=ph["stefan_boltzmann_w_m2_k4"], kelvin=ph["kelvin_offset"],
        wcrit_c_coeff=g["wcrit_clothed_coeff"], wcrit_c_exp=g["wcrit_clothed_exp"],
        wcrit_n_coeff=g["wcrit_nude_coeff"], wcrit_n_exp=g["wcrit_nude_exp"],
        w_diff=g["w_diffusion"], v_min=g["min_air_speed_m_s"],
        psat_a=g["psat_a"], psat_b=g["psat_b"], psat_c=g["psat_c"],
        tcl_tol=g["tcl_tolerance_k"], esk0_per_met=g["initial_esk_per_met"], s_per_h=ph["s_per_h"],
    )


@dataclass(frozen=True)
class IsoDynamic:
    """ISO 7933 dynamic clothing correction coefficients (constants.iso7933_dynamic)."""
    walk_k: float
    walk_off: float
    walk_cap: float
    v_cap: float
    w_cap: float
    cl_scale: float
    cl_v2: float
    cl_v1: float
    cl_w2: float
    cl_w1: float
    ia_v2: float
    ia_v1: float
    ia_w2: float
    ia_w1: float
    blend_clo: float
    ce_a: float
    ce_b: float
    ce_c: float
    im_max: float
    lewis_kpa: float
    ia_st: float          # still-air layer contained in the static I_T (McCullough & Kenney's manikin)
    mmhg_per_kpa: float


@lru_cache(maxsize=1)
def iso_params() -> IsoDynamic:
    d = consts.get("iso7933_dynamic")
    cl, ia, ce = d["corr_cl"], d["corr_ia"], d["corr_e"]
    return IsoDynamic(
        walk_k=d["walk_coeff_m_s_per_w_m2"], walk_off=d["walk_met_offset_w_m2"], walk_cap=d["walk_cap_m_s"],
        v_cap=d["v_cap_m_s"], w_cap=d["w_cap_m_s"],
        cl_scale=cl["scale"], cl_v2=cl["v2"], cl_v1=cl["v1"], cl_w2=cl["w2"], cl_w1=cl["w1"],
        ia_v2=ia["v2"], ia_v1=ia["v1"], ia_w2=ia["w2"], ia_w1=ia["w1"],
        blend_clo=d["blend_below_clo"], ce_a=ce[0], ce_b=ce[1], ce_c=ce[2], im_max=d["im_dyn_max"],
        lewis_kpa=d["lewis_k_per_kpa"], ia_st=consts.get("gear_clothing.i_a_static_m2k_w"),
        mmhg_per_kpa=1000.0 / consts.get("physical.pa_per_mmhg"),
    )


@dataclass
class IsoClothing:
    """Per-step static clothing inputs for the ISO 7933 dynamic mode."""
    i_t: np.ndarray       # [N, S] static total insulation m²K/W
    i_m: np.ndarray       # [N, S] static permeability index
    i_cl_clo: np.ndarray  # [N, S] intrinsic insulation (clo) — selects the low-clo blend
    w_max: np.ndarray     # [N] maximum skin wettedness
    fraction: float = 1.0  # share of the ISO dynamic correction applied (1 = ISO 7933, 0 = static manikin)
    walk_credit: float = 1.0  # share of ISO's walking-speed (pumping) term kept; wind term unaffected


def iso_dynamic_resistances(m_act, v, i_t, i_m, i_cl_clo, f_cl, Q: IsoDynamic, fraction: float = 1.0,
                            walk_credit: float = 1.0):
    """ISO 7933 dynamic correction → (dynamic intrinsic dry insulation R_cl [m²K/W],
    dynamic total evaporative resistance R_e,T [m²·mmHg/W]). Broadcasts over [E, N].

    ``fraction`` λ applies part of the correction: corr_eff = 1 − λ·(1 − corr) for both corr_tot and corr_ia
    (λ = 1 → ISO 7933; λ = 0 → static manikin values). ``walk_credit`` scales ISO's walking-speed term; the
    conservative mode keeps λ = 1 (wind credit) and sets walk_credit = 0 (constants.clothing_conservative)."""
    wa = walk_credit * np.minimum(Q.walk_k * np.maximum(m_act - Q.walk_off, 0.0), Q.walk_cap)
    v_ux = min(v, Q.v_cap)
    w_ux = np.minimum(wa, Q.w_cap)
    corr_cl = np.minimum(Q.cl_scale * np.exp((Q.cl_v2 * v_ux + Q.cl_v1) * v_ux + (Q.cl_w2 * w_ux + Q.cl_w1) * w_ux), 1.0)
    corr_ia = np.minimum(np.exp((Q.ia_v2 * v + Q.ia_v1) * v + (Q.ia_w2 * w_ux + Q.ia_w1) * w_ux), 1.0)
    corr_tot = np.where(i_cl_clo <= Q.blend_clo,
                        ((Q.blend_clo - i_cl_clo) * corr_ia + i_cl_clo * corr_cl) / Q.blend_clo, corr_cl)
    if fraction != 1.0:
        corr_tot = 1.0 - fraction * (1.0 - corr_tot)
        corr_ia = 1.0 - fraction * (1.0 - corr_ia)
    i_t_dyn = i_t * corr_tot
    im_dyn = np.minimum(i_m * ((Q.ce_a * corr_tot + Q.ce_b) * corr_tot + Q.ce_c), Q.im_max)
    r_et = i_t_dyn / (im_dyn * Q.lewis_kpa) * Q.mmhg_per_kpa
    r_cl = np.maximum(i_t_dyn - Q.ia_st * corr_ia / f_cl, 0.0)
    return r_cl, r_et


def psat_mmhg(t_c, P: GaggeParams | None = None):
    P = P or gagge_params()
    return np.exp(P.psat_a - P.psat_b / (np.asarray(t_c, dtype=float) + P.psat_c))


# ─────────────────────────────────────────────────────────────────────────────
# Numerical core
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class IntegrateOut:
    core: np.ndarray          # [E, N, T_out]  °C
    skin: np.ndarray          # [E, N, T_out]  °C
    tcl_max_residual: float   # largest |ΔT_cl| accepted by the clothing-temperature fixed point (K)
    tcl_iterations_max: int


def integrate(
    *,
    met_wm2: np.ndarray,       # [N, S] metabolic heat W/m² before met_scale
    met_scale: np.ndarray,     # [E, N]
    ta: np.ndarray,            # [S] °C
    pa: np.ndarray,            # [S] mmHg
    v: np.ndarray,             # [S] m/s at body height
    tr: np.ndarray,            # [N, S] °C mean radiant temperature (sun or shade)
    r_cl: np.ndarray,          # [N, S] m²K/W
    r_ecl: np.ndarray,         # [N, S] m²·mmHg/W
    f_cl: np.ndarray,          # [N, S]
    clothed: np.ndarray,       # [N, S] bool
    mass_kg: np.ndarray,       # [N]
    bsa_m2: np.ndarray,        # [N]
    dt_s: float,
    theta_sw: np.ndarray | float = 1.0,   # [E, N] sweat-gain multiplier
    theta_dil: np.ndarray | float = 1.0,  # [E, N] vasodilation-gain multiplier
    setpoint_shift: np.ndarray | float = 0.0,  # [N] °C, acclimatization: lowers T_cr,n (and T_b,n, resting core)
    tcr0: np.ndarray | float | None = None,  # [N] initial core temperature (default: shifted T_cr,n)
    met_cap_wm2: np.ndarray | None = None,  # [N] aerobic ceiling (VO₂max) in W/m²; M is clipped to it
    record_every: int = 1,
    cap_mode: str = "consistent",
    iso: IsoClothing | None = None,
    max_tcl_iter: int = 150,
    P: GaggeParams | None = None,
    backend: str = "auto",
) -> IntegrateOut:
    """Explicit-Euler two-node integration in the reference's update order (MODEL.md §9.1).

    ``iso=None`` → Gagge static clothing (intrinsic R_cl, R_e,cl; Gagge w_crit), the mode used for the
    pythermalcomfort agreement test. ``iso=IsoClothing(...)`` → ISO 7933 dynamic clothing (MODEL.md §5).
    """
    P = P or gagge_params()
    if backend in ("auto", "numba") and _numba_kernel() is not None:
        return _integrate_numba(met_wm2, met_scale, ta, pa, v, tr, r_cl, r_ecl, f_cl, clothed, mass_kg, bsa_m2, dt_s,
                                theta_sw, theta_dil, setpoint_shift, tcr0, met_cap_wm2, record_every, cap_mode, iso,
                                max_tcl_iter, P)
    if backend == "numba":
        raise RuntimeError("numba backend requested but numba is not importable")
    Q = iso_params() if iso is not None else None
    E, N = met_scale.shape
    S = met_wm2.shape[1]
    if cap_mode not in ("consistent", "ashrae55_reference"):
        raise ValueError(cap_mode)
    lr = P.lr / P.p_atm
    cap_core_fac = bsa_m2 * dt_s / (P.c_body * mass_kg * P.s_per_h)  # [N] K per (W/m²) of whole body capacity
    shift = np.broadcast_to(np.asarray(setpoint_shift, dtype=float), (N,))
    tcr_n = P.tcr_n - shift                                  # [N]
    tbn = P.alpha0 * P.tsk_n + (1.0 - P.alpha0) * tcr_n      # [N]

    tcr = np.empty((E, N))
    tcr[:] = tcr_n if tcr0 is None else np.broadcast_to(np.asarray(tcr0, dtype=float), (N,))
    tsk = np.full((E, N), P.tsk_n)
    skbf = np.full((E, N), P.skbf_n)
    alpha = np.full((E, N), P.alpha0)
    hr = np.full((E, N), P.hr_init)
    m0 = met_wm2[:, 0] * met_scale
    if met_cap_wm2 is not None:
        m0 = np.minimum(m0, met_cap_wm2)
    esk = P.esk0_per_met * m0 / P.met_factor
    mshiv = np.zeros((E, N))
    w_ext = P.external_work_met * P.met_factor
    prsw_cap_off = P.w_diff if cap_mode == "consistent" else 0.0
    sb4 = 4.0 * P.emissivity * P.sigma * P.ar_ad
    hc_nat = P.hc_nat * P.p_atm ** P.hc_p_exp

    T_out = S // record_every
    core = np.empty((E, N, T_out))
    skin = np.empty((E, N, T_out))
    worst_res = 0.0
    worst_it = 0

    for s in range(S):
        m_act = met_wm2[:, s] * met_scale                       # [E, N]
        if met_cap_wm2 is not None:
            m_act = np.minimum(m_act, met_cap_wm2)
        met_a = m_act / P.met_factor
        ta_s, pa_s = ta[s], pa[s]
        v_s = max(v[s], P.v_min)
        tr_s, rcl, recl, fcl = tr[:, s], r_cl[:, s], r_ecl[:, s], f_cl[:, s]
        if iso is not None:
            rcl, r_et = iso_dynamic_resistances(m_act, v_s, iso.i_t[:, s], iso.i_m[:, s], iso.i_cl_clo[:, s], fcl, Q,
                                                iso.fraction, iso.walk_credit)

        # respiration (MODEL §7.2)
        resp = P.resp_s * m_act * (P.resp_s_ref - ta_s) + P.resp_l * m_act * (P.resp_l_ref - pa_s)

        # convection (MODEL §7.1)
        hc = max(hc_nat, P.hc_forced * (v_s * P.p_atm) ** P.hc_p_exp)
        hc_act = np.where(met_a > P.hc_act_off,
                          P.hc_act * np.maximum(met_a - P.hc_act_off, 0.0) ** P.hc_act_exp, 0.0)
        hc = np.maximum(hc, hc_act)

        # clothing-surface temperature fixed point with linear radiative coefficient
        ht = hr + hc
        ra = 1.0 / (fcl * ht)
        top = (hr * tr_s + hc * ta_s) / ht
        tcl = (ra * tsk + rcl * top) / (ra + rcl)
        for it in range(1, max_tcl_iter + 1):
            hr = sb4 * ((tcl + tr_s) / 2.0 + P.kelvin) ** 3
            ht = hr + hc
            ra = 1.0 / (fcl * ht)
            top = (hr * tr_s + hc * ta_s) / ht
            tcl_new = (ra * tsk + rcl * top) / (ra + rcl)
            res = float(np.max(np.abs(tcl_new - tcl)))
            tcl = tcl_new
            if res <= P.tcl_tol:
                break
        else:
            raise RuntimeError("clothing temperature did not converge")
        worst_res = max(worst_res, res)
        worst_it = max(worst_it, it)

        dry = (tsk - top) / (ra + rcl)
        qcs = (P.k_cs + P.c_bl * skbf) * (tcr - tsk)
        s_cr = m_act + mshiv - w_ext - resp - qcs
        s_sk = qcs - dry - esk
        tcr = tcr + s_cr * cap_core_fac / (1.0 - alpha)
        tsk = tsk + s_sk * cap_core_fac / alpha

        # control signals (MODEL §8), using the pre-update alpha for mean body temperature
        tb = alpha * tsk + (1.0 - alpha) * tcr
        sk_sig = tsk - P.tsk_n
        warm_sk = np.maximum(sk_sig, 0.0)
        cold_sk = np.maximum(-sk_sig, 0.0)
        cr_sig = tcr - tcr_n
        warm_cr = np.maximum(cr_sig, 0.0)
        cold_cr = np.maximum(-cr_sig, 0.0)
        warm_b = np.maximum(tb - tbn, 0.0)

        skbf = (P.skbf_n + theta_dil * P.c_dil * warm_cr) / (1.0 + P.c_str * cold_sk)
        skbf = np.clip(skbf, P.skbf_min, P.skbf_max)
        mrsw = np.minimum(theta_sw * P.c_sw * warm_b * np.exp(warm_sk / P.sweat_skin_exp), P.mrsw_max)
        ersw = P.latent * mrsw

        # evaporation capped by E_max and critical wettedness (MODEL §7.3)
        if iso is None:
            r_et = 1.0 / (lr * fcl * hc) + recl
        emax = (psat_mmhg(tsk, P) - pa_s) / r_et
        emax = np.where(emax == 0.0, 1e-3, emax)
        prsw = ersw / emax
        w = P.w_diff + (1.0 - P.w_diff) * prsw
        ediff = w * emax - ersw
        if iso is None:
            wcrit = np.where(clothed[:, s], P.wcrit_c_coeff * v_s ** P.wcrit_c_exp,
                             P.wcrit_n_coeff * v_s ** P.wcrit_n_exp)
        else:
            wcrit = iso.w_max
        capped = w > wcrit
        prsw_c = (wcrit - prsw_cap_off) / (1.0 - P.w_diff)
        ersw = np.where(capped, prsw_c * emax, ersw)
        ediff = np.where(capped, P.w_diff * (1.0 - prsw_c) * emax, ediff)
        neg = emax < 0.0
        ersw = np.where(neg, 0.0, ersw)
        ediff = np.where(neg, 0.0, ediff)
        esk = ersw + ediff

        mshiv = P.shiver * cold_sk * cold_cr
        alpha = P.alpha_a0 + P.alpha_a1 / (skbf + P.alpha_a2)

        if (s + 1) % record_every == 0:
            k = (s + 1) // record_every - 1
            core[:, :, k] = tcr
            skin[:, :, k] = tsk

    return IntegrateOut(core=core, skin=skin, tcl_max_residual=worst_res, tcl_iterations_max=worst_it)


@lru_cache(maxsize=1)
def _numba_kernel():
    try:
        from engine.physio import _kernel
        return _kernel
    except Exception:  # noqa: BLE001 — numba missing or failing to compile → numpy reference path
        return None


@lru_cache(maxsize=1)
def _pack_gagge(P: GaggeParams) -> np.ndarray:
    K = _numba_kernel()
    g = np.empty(K.N_GAGGE)
    vals = {
        K.G_TSK_N: P.tsk_n, K.G_SKBF_N: P.skbf_n, K.G_SKBF_MIN: P.skbf_min, K.G_SKBF_MAX: P.skbf_max,
        K.G_C_DIL: P.c_dil, K.G_C_STR: P.c_str, K.G_C_SW: P.c_sw, K.G_MRSW_MAX: P.mrsw_max,
        K.G_SWEAT_EXP: P.sweat_skin_exp, K.G_K_CS: P.k_cs, K.G_C_BL: P.c_bl, K.G_LATENT: P.latent,
        K.G_SHIVER: P.shiver, K.G_A0: P.alpha_a0, K.G_A1: P.alpha_a1, K.G_A2: P.alpha_a2,
        K.G_MET_FACTOR: P.met_factor, K.G_W_EXT: P.external_work_met * P.met_factor, K.G_LR: P.lr,
        K.G_RESP_S: P.resp_s, K.G_RESP_S_REF: P.resp_s_ref, K.G_RESP_L: P.resp_l, K.G_RESP_L_REF: P.resp_l_ref,
        K.G_HC_NAT: P.hc_nat, K.G_HC_FORCED: P.hc_forced, K.G_HC_P_EXP: P.hc_p_exp, K.G_P_ATM: P.p_atm,
        K.G_HC_ACT: P.hc_act, K.G_HC_ACT_OFF: P.hc_act_off, K.G_HC_ACT_EXP: P.hc_act_exp,
        K.G_SB4: 4.0 * P.emissivity * P.sigma * P.ar_ad, K.G_KELVIN: P.kelvin,
        K.G_WC_C_COEFF: P.wcrit_c_coeff, K.G_WC_C_EXP: P.wcrit_c_exp, K.G_WC_N_COEFF: P.wcrit_n_coeff,
        K.G_WC_N_EXP: P.wcrit_n_exp, K.G_W_DIFF: P.w_diff, K.G_V_MIN: P.v_min, K.G_PSAT_A: P.psat_a,
        K.G_PSAT_B: P.psat_b, K.G_PSAT_C: P.psat_c, K.G_TCL_TOL: P.tcl_tol, K.G_ESK0: P.esk0_per_met,
        K.G_HR_INIT: P.hr_init, K.G_ALPHA0: P.alpha0,
    }
    for k, val in vals.items():
        g[k] = val
    return g


@lru_cache(maxsize=1)
def _pack_iso() -> np.ndarray:
    K = _numba_kernel()
    Q = iso_params()
    q = np.empty(K.N_ISO)
    vals = {K.Q_WALK_K: Q.walk_k, K.Q_WALK_OFF: Q.walk_off, K.Q_WALK_CAP: Q.walk_cap, K.Q_V_CAP: Q.v_cap,
            K.Q_W_CAP: Q.w_cap, K.Q_CL_SCALE: Q.cl_scale, K.Q_CL_V2: Q.cl_v2, K.Q_CL_V1: Q.cl_v1, K.Q_CL_W2: Q.cl_w2,
            K.Q_CL_W1: Q.cl_w1, K.Q_IA_V2: Q.ia_v2, K.Q_IA_V1: Q.ia_v1, K.Q_IA_W2: Q.ia_w2, K.Q_IA_W1: Q.ia_w1,
            K.Q_BLEND: Q.blend_clo, K.Q_CE_A: Q.ce_a, K.Q_CE_B: Q.ce_b, K.Q_CE_C: Q.ce_c, K.Q_IM_MAX: Q.im_max,
            K.Q_LEWIS: Q.lewis_kpa, K.Q_IA_ST: Q.ia_st, K.Q_MMHG_PER_KPA: Q.mmhg_per_kpa}
    for k, val in vals.items():
        q[k] = val
    return q


def _integrate_numba(met_wm2, met_scale, ta, pa, v, tr, r_cl, r_ecl, f_cl, clothed, mass_kg, bsa_m2, dt_s,
                     theta_sw, theta_dil, setpoint_shift, tcr0, met_cap_wm2, record_every, cap_mode, iso,
                     max_tcl_iter, P) -> IntegrateOut:
    K = _numba_kernel()
    if cap_mode not in ("consistent", "ashrae55_reference"):
        raise ValueError(cap_mode)
    E, N = met_scale.shape
    S = met_wm2.shape[1]
    f64 = lambda x, shape: np.ascontiguousarray(np.broadcast_to(np.asarray(x, dtype=float), shape))  # noqa: E731
    shift = f64(setpoint_shift, (N,))
    tcr_n = P.tcr_n - shift
    tbn = P.alpha0 * P.tsk_n + (1.0 - P.alpha0) * tcr_n
    t0 = tcr_n.copy() if tcr0 is None else f64(tcr0, (N,))
    has_cap = met_cap_wm2 is not None
    cap = f64(met_cap_wm2 if has_cap else 0.0, (N,))
    use_iso = iso is not None
    z = np.zeros((N, S))
    core, skin, res, it = K.run(
        f64(met_wm2, (N, S)), f64(met_scale, (E, N)), f64(ta, (S,)), f64(pa, (S,)), f64(v, (S,)), f64(tr, (N, S)),
        f64(r_cl, (N, S)), f64(r_ecl, (N, S)), f64(f_cl, (N, S)),
        np.ascontiguousarray(np.broadcast_to(np.asarray(clothed, dtype=np.bool_), (N, S))),
        f64(mass_kg, (N,)), f64(bsa_m2, (N,)), float(dt_s), float(P.s_per_h), float(P.c_body),
        f64(theta_sw, (E, N)), f64(theta_dil, (E, N)), tcr_n, tbn, t0, cap, has_cap, int(record_every),
        float(P.w_diff if cap_mode == "consistent" else 0.0),
        use_iso, f64(iso.i_t, (N, S)) if use_iso else z, f64(iso.i_m, (N, S)) if use_iso else z,
        f64(iso.i_cl_clo, (N, S)) if use_iso else z, f64(iso.w_max, (N,)) if use_iso else np.zeros(N),
        float(iso.fraction) if use_iso else 1.0, float(iso.walk_credit) if use_iso else 1.0,
        int(max_tcl_iter), _pack_gagge(P), _pack_iso())
    if res > P.tcl_tol:
        raise RuntimeError("clothing temperature did not converge")
    return IntegrateOut(core=core, skin=skin, tcl_max_residual=float(res), tcl_iterations_max=int(it))


# ─────────────────────────────────────────────────────────────────────────────
# Inputs: weather on a step grid, plan timeline, roster arrays, ensemble draws
# ─────────────────────────────────────────────────────────────────────────────

def parse_time(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@dataclass
class Environment:
    """Weather resolved onto the step grid starting at ``t0`` (MODEL.md §6). Plan-independent, so cacheable."""
    t0: datetime
    step_min: float
    t_utc_s: np.ndarray        # [S] step-start epoch seconds
    ta: np.ndarray             # [S] °C
    rh: np.ndarray             # [S] %
    pa: np.ndarray             # [S] mmHg
    v_body: np.ndarray         # [S] m/s
    ghi: np.ndarray            # [S] W/m²
    sun_elev_deg: np.ndarray   # [S]
    tr_sun: np.ndarray         # [S] °C MRT in sun
    labels: list[str] = field(default_factory=list)
    blocks: set[str] = field(default_factory=set)

    @property
    def n_steps(self) -> int:
        return len(self.t_utc_s)


def build_environment(weather: Sequence[Mapping[str, Any]], site: Mapping[str, Any], t0: datetime,
                      step_min: float, n_steps: int) -> Environment:
    if not weather:
        raise ValueError("weather is empty")
    hours = sorted(weather, key=lambda h: parse_time(h["time"]))
    th = np.array([parse_time(h["time"]).timestamp() for h in hours])
    ts = t0.timestamp() + np.arange(n_steps) * step_min * 60.0
    interp = lambda key: np.interp(ts, th, np.array([float(h[key]) for h in hours]))  # noqa: E731
    ta, rh, v10, cloud = interp("air_temp_c"), interp("rh_pct"), interp("wind_m_s"), interp("cloud_cover_pct")
    P = gagge_params()
    pa = rh / 100.0 * psat_mmhg(ta, P)
    elev = radiation.solar_elevation_deg(ts, site["lat"], site["lon"])
    labels: list[str] = []
    blocks = {"solar_position", "solarcal", "solarcal_ground", "irradiance_split", "wind_profile", "physical", "gagge_1986"}
    if all(h.get("solar_w_m2") is not None for h in hours):
        ghi = interp("solar_w_m2")
    else:
        ghi = _ghi_fallback(hours, site, ts, elev, cloud, labels, blocks)
    ghi = np.where(elev > 0, ghi, 0.0)
    surface = site.get("surface", "grass")
    d_mrt_lin = radiation.solar_delta_mrt(ghi, ts, elev, radiation.ground_reflectance(surface))
    if any(h.get("source") == "fixture" for h in hours):
        labels.append("forecast is fixture")
    return Environment(t0=t0, step_min=step_min, t_utc_s=ts, ta=ta, rh=rh, pa=pa,
                       v_body=radiation.wind_at_body(v10), ghi=ghi, sun_elev_deg=elev,
                       tr_sun=radiation.mrt_from_linear_delta(ta, d_mrt_lin), labels=labels, blocks=blocks)


def _ghi_fallback(hours, site, ts, elev, cloud, labels, blocks):
    """GHI when the forecast has none: WS1's wbgt.solar_from_cloud if present, else Haurwitz × Kasten–Czeplak."""
    try:
        from engine import wbgt  # WS1, may not exist yet
        hourly = []
        for h in hours:
            if h.get("solar_w_m2") is not None:
                hourly.append(float(h["solar_w_m2"]))
            else:
                hourly.append(float(wbgt.solar_from_cloud(site["lat"], site["lon"], parse_time(h["time"]), h["cloud_cover_pct"])))
        th = np.array([parse_time(h["time"]).timestamp() for h in hours])
        labels.append("solar irradiance estimated from cloud cover (wbgt.solar_from_cloud)")
        return np.interp(ts, th, np.array(hourly))
    except (ImportError, AttributeError):
        labels.append("solar irradiance estimated from cloud cover (clear-sky fallback)")
        blocks.add("clear_sky_fallback")
        return radiation.ghi_from_cloud(ts, elev, cloud)


@dataclass
class RosterArrays:
    ids: list[str]
    names: list[str]
    mass_kg: np.ndarray
    bsa_m2: np.ndarray
    setpoint_shift: np.ndarray  # acclimatization: lowers T_cr,n, T_b,n and resting core [°C]
    sw_gain: np.ndarray         # acclimatization sweat-gain multiplier
    accl_frac: np.ndarray       # fraction of full adaptation
    met_cap: np.ndarray         # sustained aerobic ceiling: fraction × VO₂max / (mL·kg⁻¹·min⁻¹ per MET) [MET]
    met_mu: np.ndarray
    met_sd: np.ndarray
    thermo_mu: np.ndarray
    thermo_sd: np.ndarray
    labels: list[str] = field(default_factory=list)


def acclimatization_fraction(day: float, days_since_last_heat: float | None = None) -> float:
    """Fraction of full heat adaptation on preseason ``day`` (constants.acclimatization.fraction_curve_*),
    reduced by the per-day decay for each day beyond the first since the last heat session."""
    A = consts.get("acclimatization", {})
    if not A.get("enabled", False):
        return 0.0
    frac = float(np.interp(day, A["fraction_curve_day"], A["fraction_curve_value"]))
    if days_since_last_heat is not None:
        frac *= max(0.0, 1.0 - A["decay_per_day_without_heat"] * max(float(days_since_last_heat) - 1.0, 0.0))
    return frac


def acclimatization_effects(day: float, days_since_last_heat: float | None = None) -> tuple[float, float]:
    """(sweat-gain multiplier, set-point shift °C) — MODEL.md §8. No effect unless enabled in constants."""
    A = consts.get("acclimatization", {})
    frac = acclimatization_fraction(day, days_since_last_heat)
    if frac == 0.0:
        return 1.0, 0.0
    return 1.0 + frac * A["full_sweat_gain_increase"], frac * A["full_setpoint_shift_c"]


def gear_caps(roster: Sequence[Mapping[str, Any]]) -> list[str]:
    """Per-athlete NATA gear limit (engine.gear_rules), used for athletes rotated out of a drill."""
    from engine import gear_rules
    return [gear_rules.athlete_gear_limit(a) for a in roster]


def vo2max_ml_kg_min(a: Mapping[str, Any]) -> float:
    """Athlete VO₂max if given, else the position-group default (constants.hr_met; Boden et al. 2022)."""
    if a.get("vo2max_ml_kg_min") is not None:
        return float(a["vo2max_ml_kg_min"])
    h = consts.get("hr_met")
    pos = a.get("position")
    if pos is None:
        return float(h["vo2max_default_ml_kg_min"])
    grp = "linemen" if pos in h["linemen_positions"] else "non_linemen"
    return float(h["vo2max_by_group_ml_kg_min"][grp])


def build_roster(roster: Sequence[Mapping[str, Any]]) -> RosterArrays:
    pri = consts.get("ensemble_priors")
    n = len(roster)
    mass = np.array([float(a["mass_kg"]) for a in roster])
    height = np.array([float(a["height_m"]) for a in roster])
    days = [(float(a.get("acclimatization_day", 1)), a.get("days_since_last_heat_session")) for a in roster]
    eff = [acclimatization_effects(d, s) for d, s in days]
    met_mu, met_sd, th_mu, th_sd = (np.empty(n) for _ in range(4))
    for i, a in enumerate(roster):
        c = a.get("calib") or {}
        met_mu[i] = c.get("met_scale", 1.0)
        met_sd[i] = c.get("met_scale_sd", pri["met_scale_sd"])
        th_mu[i] = c.get("thermo_scale", 1.0)
        th_sd[i] = c.get("thermo_scale_sd", pri["thermo_scale_sd"])
    labels = []
    if not consts.get("acclimatization.enabled", False):
        labels.append("acclimatization not modelled (constants pending source)")
    return RosterArrays(
        ids=[a["id"] for a in roster], names=[a.get("name", a["id"]) for a in roster],
        mass_kg=mass, bsa_m2=metabolic.body_surface_area_m2(mass, height),
        sw_gain=np.array([e[0] for e in eff]), setpoint_shift=np.array([e[1] for e in eff]),
        accl_frac=np.array([acclimatization_fraction(d, s) for d, s in days]),
        met_cap=np.array([vo2max_ml_kg_min(a) for a in roster]) * consts.get("hr_met.sustained_vo2max_fraction")
        / consts.get("hr_met.ml_o2_per_kg_min_per_met"),
        met_mu=met_mu, met_sd=met_sd, thermo_mu=th_mu, thermo_sd=th_sd, labels=labels,
    )


@dataclass
class Draws:
    """Common random numbers: standard-normal z reused for every candidate plan (optimizer fairness)."""
    z_met: np.ndarray      # [E, N]
    z_thermo: np.ndarray   # [E, N]


def make_draws(n_ensemble: int, n_athletes: int, seed: int = 0) -> Draws:
    k = consts.get("ensemble_defaults.truncate_sd")
    rng = np.random.default_rng(seed)
    z = np.clip(rng.standard_normal((2, n_ensemble, n_athletes)), -k, k)
    return Draws(z_met=z[0], z_thermo=z[1])


def scales(R: RosterArrays, D: Draws) -> tuple[np.ndarray, np.ndarray]:
    lo = consts.get("ensemble_defaults.min_scale")
    met = np.maximum(R.met_mu + R.met_sd * D.z_met, lo)
    thermo = np.maximum(R.thermo_mu + R.thermo_sd * D.z_thermo, lo)
    return met, thermo


@dataclass
class Timeline:
    """A plan resolved onto the step grid (MODEL.md §4–§6)."""
    n_steps: int
    drill_of_step: np.ndarray   # [S] index into plan drills
    met: np.ndarray             # [N, S] MET (before met_scale)
    part: np.ndarray            # [N, S] bool participating
    shade: np.ndarray           # [N, S] bool
    gear: np.ndarray            # [N, S] int index into clothing.GEAR_LEVELS
    is_break: np.ndarray        # [S] bool


def build_timeline(drills: Sequence[Mapping[str, Any]], athlete_ids: Sequence[str], step_min: float,
                   rest_shade: bool | None = None, gear_cap: Sequence[str] | None = None) -> Timeline:
    """``gear_cap`` (per athlete, e.g. NATA limits): athletes rotated out of a drill wear at most this gear."""
    rest_met = metabolic.intensity_met(consts.get("non_participant.intensity"))
    rest_shade = bool(consts.get("non_participant.shade")) if rest_shade is None else rest_shade
    steps_per = [int(round(float(d["duration_min"]) / step_min)) for d in drills]
    S = int(sum(steps_per))
    N = len(athlete_ids)
    idx = {a: i for i, a in enumerate(athlete_ids)}
    drill_of_step = np.repeat(np.arange(len(drills)), steps_per)
    cap_idx = np.array([clothing.gear_index(g) for g in gear_cap]) if gear_cap is not None else None
    met = np.empty((N, S))
    part = np.ones((N, S), dtype=bool)
    shade = np.empty((N, S), dtype=bool)
    gear = np.empty((N, S), dtype=np.int64)
    is_break = np.empty(S, dtype=bool)
    s0 = 0
    for d, n in zip(drills, steps_per):
        sl = slice(s0, s0 + n)
        mask = np.ones(N, dtype=bool)
        if d.get("participants") is not None:
            mask[:] = False
            for a in d["participants"]:
                if a in idx:
                    mask[idx[a]] = True
        dm = metabolic.drill_met(d)
        met[:, sl] = np.where(mask, dm, rest_met)[:, None]
        part[:, sl] = mask[:, None]
        shade[:, sl] = np.where(mask, bool(d.get("shade", False)), rest_shade)[:, None]
        per = d.get("gear_by_athlete") or {}
        gi = np.array([clothing.gear_index(per.get(a, d["gear"])) for a in athlete_ids])
        if cap_idx is not None:
            gi = np.where(mask, gi, np.minimum(gi, cap_idx))
        gear[:, sl] = gi[:, None]
        is_break[sl] = bool(d.get("is_break", False))
        s0 += n
    return Timeline(S, drill_of_step, met, part, shade, gear, is_break)


def simulate_arrays(tl: Timeline, env: Environment, R: RosterArrays, D: Draws,
                    cap_mode: str | None = None, clothing_mode: str | None = None) -> IntegrateOut:
    """Core temperature [E, N, S] for a timeline (all athletes × ensemble members)."""
    clothing_mode = clothing_mode or consts.get("model_options.clothing_mode")
    if clothing_mode not in CLOTHING_MODES:
        raise ValueError(clothing_mode)
    if tl.n_steps > env.n_steps:
        raise ValueError(f"plan needs {tl.n_steps} steps but environment covers {env.n_steps}")
    S = tl.n_steps
    met_scale, thermo = scales(R, D)
    met_wm2 = metabolic.met_to_w_m2(tl.met, R.mass_kg[:, None], R.bsa_m2[:, None])
    gt = clothing.gear_table()
    if clothing_mode == "conservative":
        met_wm2 = met_wm2 * (1.0 + gear_met_surcharge()[tl.gear])
    tr = np.where(tl.shade, env.ta[None, :S], env.tr_sun[None, :S])
    iso = None
    if clothing_mode in ("iso7933_dynamic", "conservative"):
        d = consts.get("iso7933_dynamic")
        w_max = d["w_max_unacclimatized"] + R.accl_frac * (d["w_max_acclimatized"] - d["w_max_unacclimatized"])
        iso = IsoClothing(i_t=gt["i_t"][tl.gear], i_m=gt["i_m"][tl.gear], i_cl_clo=gt["i_cl_clo"][tl.gear], w_max=w_max,
                          fraction=iso_fraction(clothing_mode), walk_credit=walk_credit(clothing_mode))
    return integrate(
        met_wm2=met_wm2, met_scale=met_scale,
        ta=env.ta[:S], pa=env.pa[:S], v=env.v_body[:S], tr=tr,
        r_cl=gt["r_cl"][tl.gear], r_ecl=gt["r_ecl"][tl.gear], f_cl=gt["f_cl"][tl.gear], clothed=gt["clothed"][tl.gear],
        mass_kg=R.mass_kg, bsa_m2=R.bsa_m2, dt_s=env.step_min * 60.0,
        theta_sw=thermo * R.sw_gain[None, :], theta_dil=thermo, setpoint_shift=R.setpoint_shift,
        met_cap_wm2=metabolic.met_to_w_m2(R.met_cap, R.mass_kg, R.bsa_m2),
        cap_mode=cap_mode or consts.get("model_options.cap_mode"), iso=iso,
    )


CLOTHING_MODES = ("conservative", "iso7933_dynamic", "gagge_static")


def iso_fraction(clothing_mode: str) -> float:
    """λ for the ISO-structured clothing modes: 1 for iso7933_dynamic, calibrated value for conservative."""
    if clothing_mode == "conservative":
        return float(consts.get("clothing_conservative.iso_correction_fraction"))
    return 1.0


def walk_credit(clothing_mode: str) -> float:
    if clothing_mode == "conservative":
        return float(consts.get("clothing_conservative.walk_credit_fraction"))
    return 1.0


def gear_met_surcharge() -> np.ndarray:
    """Conservative mode: δ·w(gear) per gear level (w from constants.clothing_conservative.surcharge_weight_by_gear)."""
    d = float(consts.get("clothing_conservative.gear_met_surcharge_full_pads"))
    w = consts.get("clothing_conservative.surcharge_weight_by_gear")
    return d * np.array([float(w[g]) for g in clothing.GEAR_LEVELS])


def percentiles(core: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(p50, p95) over the ensemble axis → [N, T]."""
    p = np.percentile(core, [50.0, 95.0], axis=0)
    return p[0], p[1]


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point → CONTRACTS.md SimulationResult
# ─────────────────────────────────────────────────────────────────────────────

def planning_limit_c() -> float:
    return float(consts.get("planning_limit_core_c.value"))


def athlete_status(peak_p95: float, limit: float, near_margin: float | None = None) -> str:
    if peak_p95 >= limit:
        return "over_limit"
    near = float(consts.get("near_limit_margin_c.value")) if near_margin is None else near_margin
    if peak_p95 >= limit - near:
        return "near_limit"
    return "below_limit"


def plan_duration_min(drills: Sequence[Mapping[str, Any]]) -> float:
    return float(sum(float(d["duration_min"]) for d in drills))


def training_load_met_min(tl: Timeline, step_min: float) -> float:
    """Team-mean Σ MET × minutes over non-break drill minutes each athlete takes part in."""
    active = tl.part & ~tl.is_break[None, :]
    return float(np.mean(np.sum(tl.met * active, axis=1)) * step_min)


def simulate_roster(
    roster: Sequence[Mapping[str, Any]],
    plan: Mapping[str, Any],
    weather: Sequence[Mapping[str, Any]],
    step_min: float = 1,
    n_ensemble: int = 30,
    seed: int = 0,
    params: Mapping[str, Any] | None = None,
    *,
    extra_labels: Sequence[str] = (),
    settings=None,
) -> dict[str, Any]:
    """Simulate every athlete through ``plan`` → CONTRACTS.md ``SimulationResult`` (dict).

    ``settings`` (engine.settings.AtSettings) carries the athletic trainer's choices (limit, clothing mode, …);
    defaults come from constants.yaml. ``params`` may set ``cap_mode`` or ``clothing_mode`` (overrides settings).
    Output is an estimate for planning only; status is never "safe".
    """
    from engine import settings as at_settings

    S = settings or at_settings.resolve()
    params = dict(params or {})
    if "clothing_mode" in params:
        S = S.with_overrides({"clothing_mode": params["clothing_mode"]})
    t0 = parse_time(plan["start"])
    R = build_roster(roster)
    tl = build_timeline(plan["drills"], R.ids, step_min, rest_shade=S.non_participant_shade,
                        gear_cap=gear_caps(roster))
    env = build_environment(weather, plan["site"], t0, step_min, max(tl.n_steps, 1))
    D = make_draws(n_ensemble, len(R.ids), seed)
    out = simulate_arrays(tl, env, R, D, cap_mode=params.get("cap_mode"), clothing_mode=S.clothing_mode)
    return assemble_result(plan, roster, weather, tl, env, R, out.core, step_min, extra_labels=extra_labels, settings=S)


def assemble_result(plan, roster, weather, tl: Timeline, env: Environment, R: RosterArrays, core: np.ndarray,
                    step_min: float, *, extra_labels: Sequence[str] = (), settings=None) -> dict[str, Any]:
    from engine import fhsaa_adapter
    from engine import settings as at_settings

    S = settings or at_settings.resolve()
    limit = S.planning_limit_core_c
    p50, p95 = percentiles(core)
    T = core.shape[2]
    times = [(env.t0 + timedelta(minutes=(k + 1) * step_min)).isoformat() for k in range(T)]
    athletes = []
    for i, aid in enumerate(R.ids):
        over = np.nonzero(p95[i] >= limit)[0]
        peak = float(p95[i].max()) if T else float("nan")
        athletes.append({
            "id": aid,
            "name": R.names[i],
            "core_c_p50": np.round(p50[i], 3).tolist(),
            "core_c_p95": np.round(p95[i], 3).tolist(),
            "first_cross_min": float((over[0] + 1) * step_min) if over.size else None,
            "peak_core_c_p95": round(peak, 3),
            "status": athlete_status(peak, limit, S.near_limit_margin_c),
        })
    blocks = set(MODEL_BLOCKS) | env.blocks
    blocks |= {f"gear_clothing.levels.{clothing.GEAR_LEVELS[g]}" for g in np.unique(tl.gear)}
    labels = [ESTIMATE_LABEL, *env.labels, *R.labels, *extra_labels, *S.labels()]
    unv = consts.unverified(blocks)
    if unv:
        labels.append("uses unverified constants: " + ", ".join(unv))
    return {
        "plan_id": plan["id"],
        "step_min": step_min,
        "times": times,
        "weather": [h for h in weather if _hour_overlaps(h, env.t0, T * step_min)],
        "athletes": athletes,
        "limit_core_c": limit,
        "fhsaa_violations": fhsaa_adapter.violations(plan, weather, roster if S.enforce_nata_gear_phasing else None),
        "training_load_met_min": round(training_load_met_min(tl, step_min), 1),
        "model": {"name": MODEL_NAME, "params_ref": PARAMS_REF, "clothing_mode": S.clothing_mode},
        "settings": S.as_dict(),
        "labels": labels,
    }


def _hour_overlaps(h: Mapping[str, Any], t0: datetime, minutes: float) -> bool:
    th = parse_time(h["time"])
    return th < t0 + timedelta(minutes=minutes) and th + timedelta(hours=1) > t0
