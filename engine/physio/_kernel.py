"""numba-compiled twonode-v1 step loop — the same equations and update order as ``twonode.integrate`` (numpy).

``twonode.integrate`` dispatches here when numba is importable; the numpy loop stays the reference implementation and
``tests/test_physio_modules.py::test_numba_kernel_matches_numpy`` checks they agree. Parameters arrive as flat float
arrays packed by ``twonode`` from constants.yaml, so no physical constant is written in this file.
"""
from __future__ import annotations

import math

import numpy as np
from numba import njit, prange

# indices into the packed Gagge parameter vector (see twonode._pack_gagge)
(G_TSK_N, G_SKBF_N, G_SKBF_MIN, G_SKBF_MAX, G_C_DIL, G_C_STR, G_C_SW, G_MRSW_MAX, G_SWEAT_EXP, G_K_CS, G_C_BL,
 G_LATENT, G_SHIVER, G_A0, G_A1, G_A2, G_MET_FACTOR, G_W_EXT, G_LR, G_RESP_S, G_RESP_S_REF, G_RESP_L, G_RESP_L_REF,
 G_HC_NAT, G_HC_FORCED, G_HC_P_EXP, G_P_ATM, G_HC_ACT, G_HC_ACT_OFF, G_HC_ACT_EXP, G_SB4, G_KELVIN, G_WC_C_COEFF,
 G_WC_C_EXP, G_WC_N_COEFF, G_WC_N_EXP, G_W_DIFF, G_V_MIN, G_PSAT_A, G_PSAT_B, G_PSAT_C, G_TCL_TOL, G_ESK0,
 G_HR_INIT, G_ALPHA0) = range(45)
N_GAGGE = 45

(Q_WALK_K, Q_WALK_OFF, Q_WALK_CAP, Q_V_CAP, Q_W_CAP, Q_CL_SCALE, Q_CL_V2, Q_CL_V1, Q_CL_W2, Q_CL_W1, Q_IA_V2, Q_IA_V1,
 Q_IA_W2, Q_IA_W1, Q_BLEND, Q_CE_A, Q_CE_B, Q_CE_C, Q_IM_MAX, Q_LEWIS, Q_IA_ST, Q_MMHG_PER_KPA) = range(22)
N_ISO = 22


@njit(cache=True, fastmath=False, parallel=True)
def run(met_wm2, met_scale, ta, pa, v, tr, r_cl, r_ecl, f_cl, clothed, mass, bsa, dt_s, s_per_h, c_body,
        theta_sw, theta_dil, tcr_n, tbn, tcr0, met_cap, has_cap, record_every, prsw_cap_off,
        use_iso, i_t, i_m, i_cl_clo, w_max, fraction, walk_credit, max_iter, work, G, Q):
    E, N = met_scale.shape
    S = met_wm2.shape[1]
    T = S // record_every
    core = np.empty((E, N, T))
    skin = np.empty((E, N, T))
    worst_res_e = np.zeros(E)
    worst_it_e = np.zeros(E, dtype=np.int64)
    lr = G[G_LR] / G[G_P_ATM]
    hc_nat = G[G_HC_NAT] * G[G_P_ATM] ** G[G_HC_P_EXP]
    for e in prange(E):  # ensemble members are independent → parallel
        for n in range(N):
            cap = bsa[n] * dt_s / (c_body * mass[n] * s_per_h)
            tcr = tcr0[n]
            tsk = G[G_TSK_N]
            skbf = G[G_SKBF_N]
            alpha = G[G_ALPHA0]
            hr = G[G_HR_INIT]
            m0 = met_wm2[n, 0] * met_scale[e, n]
            if has_cap and m0 > met_cap[n]:
                m0 = met_cap[n]
            esk = G[G_ESK0] * m0 / G[G_MET_FACTOR]
            mshiv = 0.0
            for s in range(S):
                m_act = met_wm2[n, s] * met_scale[e, n]
                if has_cap and m_act > met_cap[n]:
                    m_act = met_cap[n]
                met_a = m_act / G[G_MET_FACTOR]
                ta_s = ta[s]
                pa_s = pa[s]
                v_s = max(v[s], G[G_V_MIN])
                tr_s = tr[n, s]
                rcl = r_cl[n, s]
                fcl = f_cl[n, s]
                resp = (G[G_RESP_S] * m_act * (G[G_RESP_S_REF] - ta_s)
                        + G[G_RESP_L] * m_act * (G[G_RESP_L_REF] - pa_s))
                hc = max(hc_nat, G[G_HC_FORCED] * (v_s * G[G_P_ATM]) ** G[G_HC_P_EXP])
                if met_a > G[G_HC_ACT_OFF]:
                    hc = max(hc, G[G_HC_ACT] * (met_a - G[G_HC_ACT_OFF]) ** G[G_HC_ACT_EXP])
                r_et = 0.0
                if use_iso:
                    wa = walk_credit * min(Q[Q_WALK_K] * max(m_act - Q[Q_WALK_OFF], 0.0), Q[Q_WALK_CAP])
                    v_ux = min(v_s, Q[Q_V_CAP])
                    w_ux = min(wa, Q[Q_W_CAP])
                    corr_cl = min(Q[Q_CL_SCALE] * math.exp((Q[Q_CL_V2] * v_ux + Q[Q_CL_V1]) * v_ux
                                                           + (Q[Q_CL_W2] * w_ux + Q[Q_CL_W1]) * w_ux), 1.0)
                    corr_ia = min(math.exp((Q[Q_IA_V2] * v_s + Q[Q_IA_V1]) * v_s
                                           + (Q[Q_IA_W2] * w_ux + Q[Q_IA_W1]) * w_ux), 1.0)
                    icl = i_cl_clo[n, s]
                    if icl <= Q[Q_BLEND]:
                        corr_tot = ((Q[Q_BLEND] - icl) * corr_ia + icl * corr_cl) / Q[Q_BLEND]
                    else:
                        corr_tot = corr_cl
                    if fraction != 1.0:
                        corr_tot = 1.0 - fraction * (1.0 - corr_tot)
                        corr_ia = 1.0 - fraction * (1.0 - corr_ia)
                    it_dyn = i_t[n, s] * corr_tot
                    im_dyn = min(i_m[n, s] * ((Q[Q_CE_A] * corr_tot + Q[Q_CE_B]) * corr_tot + Q[Q_CE_C]), Q[Q_IM_MAX])
                    r_et = it_dyn / (im_dyn * Q[Q_LEWIS]) * Q[Q_MMHG_PER_KPA]
                    rcl = max(it_dyn - Q[Q_IA_ST] * corr_ia / fcl, 0.0)

                ht = hr + hc
                ra = 1.0 / (fcl * ht)
                top = (hr * tr_s + hc * ta_s) / ht
                tcl = (ra * tsk + rcl * top) / (ra + rcl)
                it = 0
                res = 0.0
                for it in range(1, max_iter + 1):
                    hr = G[G_SB4] * ((tcl + tr_s) / 2.0 + G[G_KELVIN]) ** 3
                    ht = hr + hc
                    ra = 1.0 / (fcl * ht)
                    top = (hr * tr_s + hc * ta_s) / ht
                    tcl_new = (ra * tsk + rcl * top) / (ra + rcl)
                    res = abs(tcl_new - tcl)
                    tcl = tcl_new
                    if res <= G[G_TCL_TOL]:
                        break
                if res > worst_res_e[e]:
                    worst_res_e[e] = res
                if it > worst_it_e[e]:
                    worst_it_e[e] = it

                dry = (tsk - top) / (ra + rcl)
                qcs = (G[G_K_CS] + G[G_C_BL] * skbf) * (tcr - tsk)
                s_cr = m_act + mshiv - work[n, s] - resp - qcs
                s_sk = qcs - dry - esk
                tcr = tcr + s_cr * cap / (1.0 - alpha)
                tsk = tsk + s_sk * cap / alpha

                tb = alpha * tsk + (1.0 - alpha) * tcr
                sk_sig = tsk - G[G_TSK_N]
                warm_sk = max(sk_sig, 0.0)
                cold_sk = max(-sk_sig, 0.0)
                cr_sig = tcr - tcr_n[n]
                warm_cr = max(cr_sig, 0.0)
                cold_cr = max(-cr_sig, 0.0)
                warm_b = max(tb - tbn[n], 0.0)

                skbf = (G[G_SKBF_N] + theta_dil[e, n] * G[G_C_DIL] * warm_cr) / (1.0 + G[G_C_STR] * cold_sk)
                skbf = min(max(skbf, G[G_SKBF_MIN]), G[G_SKBF_MAX])
                mrsw = min(theta_sw[e, n] * G[G_C_SW] * warm_b * math.exp(warm_sk / G[G_SWEAT_EXP]), G[G_MRSW_MAX])
                ersw = G[G_LATENT] * mrsw

                if not use_iso:
                    r_et = 1.0 / (lr * fcl * hc) + r_ecl[n, s]
                psk = math.exp(G[G_PSAT_A] - G[G_PSAT_B] / (tsk + G[G_PSAT_C]))
                emax = (psk - pa_s) / r_et
                if emax == 0.0:
                    emax = 1e-3
                prsw = ersw / emax
                w = G[G_W_DIFF] + (1.0 - G[G_W_DIFF]) * prsw
                ediff = w * emax - ersw
                if use_iso:
                    wcrit = w_max[n]
                elif clothed[n, s]:
                    wcrit = G[G_WC_C_COEFF] * v_s ** G[G_WC_C_EXP]
                else:
                    wcrit = G[G_WC_N_COEFF] * v_s ** G[G_WC_N_EXP]
                if w > wcrit:
                    prsw_c = (wcrit - prsw_cap_off) / (1.0 - G[G_W_DIFF])
                    ersw = prsw_c * emax
                    ediff = G[G_W_DIFF] * (1.0 - prsw_c) * emax
                if emax < 0.0:
                    ersw = 0.0
                    ediff = 0.0
                esk = ersw + ediff

                mshiv = G[G_SHIVER] * cold_sk * cold_cr
                alpha = G[G_A0] + G[G_A1] / (skbf + G[G_A2])

                if (s + 1) % record_every == 0:
                    k = (s + 1) // record_every - 1
                    core[e, n, k] = tcr
                    skin[e, n, k] = tsk
    return core, skin, worst_res_e.max(), worst_it_e.max()
