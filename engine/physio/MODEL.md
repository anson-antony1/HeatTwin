# twonode-v1 — transient two-node heat-balance model (WS2)

> **Estimate — planning only.** This model predicts *estimated* core temperature for
> practice planning and early warning. It never diagnoses, never says an athlete is
> fine, and never decides treatment. Rectal temperature is the only basis for treatment
> (KSI / MHSAA). Every number below lives in `engine/constants.yaml`; this file names the
> key, the code reads the key. Keys marked **TODO** have no verified source yet and are
> listed in §11.

---

## 1. What the model is

A per-athlete **two-compartment** (core + skin shell) heat balance, after
**Gagge, Fobelets & Berglund (1986)**, *A standard predictive index of human response to
the thermal environment*, ASHRAE Transactions 92(2B):709–731 — the model behind
ASHRAE 55 SET. Our reference implementation is `pythermalcomfort.models.two_nodes_gagge`
(pythermalcomfort v3.8.0; Tartarini & Schiavon 2020, *SoftwareX* 12:100578). Every
Gagge coefficient in `constants.yaml → gagge_1986` was read from that source file. The 1986
paper itself was **not** read, so those entries are `status: SECONDARY`.

What we change relative to the reference (each change is listed in §10):

| # | Reference `two_nodes_gagge` | twonode-v1 |
|---|---|---|
| 1 | Fixed 70 kg body and 1.8258 m² skin area | Per-athlete mass; DuBois body surface area |
| 2 | Constant conditions for 60 min, starting from neutral each call | Inputs change every step (drill, gear, shade, weather); state carries across steps |
| 3 | Activity in ASHRAE met (per m²) | Compendium METs (per kg) → W → W/m² for each athlete (§4) |
| 4 | Clothing vapour permeation efficiency i_cl = 0.45 for all clothing | Evaporative resistance per gear level, from football-uniform manikin data (§5) |
| 5 | Mean radiant temperature (MRT) is an input | MRT = air temp + solar ΔMRT (ASHRAE 55 SolarCal) in sun; MRT = air temp in shade (§6) |
| 6 | Wind is an input | 10 m forecast wind → wind at body height (log profile) (§6.4) |
| 7 | Sweat and blood-flow gains fixed | Gains scaled by calibration `thermo_scale` and by acclimatization day (§8) |
| 8 | One deterministic run | Ensemble of N draws per athlete → p50 / p95 (§9) |
| 9 | At the wettedness cap, skin evaporation = (w_crit + 0.06)·E_max (quirk) | Default: skin evaporation = w_crit·E_max, consistent with the definition w = E_sk/E_max; the reference behaviour is available as a mode (§7.3) |

Vectorization: the state arrays have shape `[n_ensemble, n_athletes]` and are stepped
together. Time-varying inputs are precomputed as `[T]` (weather) and `[n_athletes, T]`
(activity, gear, shade).

---

## 2. Notation and units

All heat flows are **per m² of DuBois body surface area A_D** (W/m²) unless stated otherwise.

| Symbol | Meaning | Unit |
|---|---|---|
| T_cr, T_sk | core and mean skin temperature (state) | °C |
| α | skin-shell fraction of body mass (state; varies with skin blood flow) | – |
| T_b = α·T_sk + (1−α)·T_cr | mean body temperature | °C |
| m, A_D | body mass, DuBois surface area | kg, m² |
| M, W | metabolic heat production, external work | W/m² |
| met_A | M expressed in ASHRAE met (M / 58.15) — used only by Gagge's activity-convection term | met |
| T_a, T_r | air temperature, mean radiant temperature | °C |
| p_a | ambient water-vapour partial pressure | mmHg (Torr) — Gagge works in mmHg |
| p_sk,s | saturated vapour pressure at skin temperature | mmHg |
| v | air speed at body height | m/s |
| I_cl, R_cl | intrinsic clothing insulation; R_cl = 0.155·I_cl | clo; m²·K/W |
| R_e,cl | intrinsic clothing evaporative resistance | m²·mmHg/W (inputs in m²·kPa/W × 7.50062) |
| f_cl | clothing area factor | – |
| h_c, h_r | convective and linear radiative heat-transfer coefficients | W/(m²·K) |
| SKBF | skin blood flow | L/(m²·h) |
| m_rsw | regulatory sweat rate | g/(m²·h) |
| E_sk, E_max | actual and maximum skin evaporative heat loss | W/m² |
| w | skin wettedness | – |
| dt | integration step | s |

Conversions in `constants.yaml → physical` (CODATA/NIST): σ, 273.15 K, 1 kPa = 7.50062 mmHg, 1 kcal = 4184 J.

---

## 3. Body

* **Surface area** (DuBois & DuBois 1916, Arch Intern Med 17:863):
  `A_D = 0.202 · m^0.425 · H^0.725`   [m², m in kg, H in m]  → `constants.body_surface_area`
* **Heat capacity**: `C_body = c_b · m` with c_b = 0.97 W·h/(kg·K) (Gagge) → `gagge_1986.c_body_wh_kg_k`
* **Compartment split**: core capacity `(1−α)·c_b·m`, skin `α·c_b·m`, where
  `α = a0 + a1 / (SKBF + a2)` (Gagge; α = 0.1 at start) → `gagge_1986.alpha_*`
  *Note (inherited from Gagge):* α moves mass between compartments as skin blood flow changes, so
  `Σ capacity × ΔT` doesn't exactly match the integrated net heat when α changes. We keep this
  and report it as a known property, not a bug we fixed.

---

## 4. Metabolic heat (metabolic.py)

1. Drill → MET: `met = drill.met_override` if given, otherwise `drill_met[intensity]`
   (Compendium of Physical Activities codes in `constants.drill_met`, **TODO until sourced**).
   Athletes not in `drill.participants` get `non_participant.intensity` (rest) in the shade
   cooling area (`constants.non_participant`, **DESIGN** assumption).
2. Compendium METs are **mass-specific**: 1 MET ≡ 1 kcal·kg⁻¹·h⁻¹ (≈ 3.5 mL O₂·kg⁻¹·min⁻¹).
   An athlete's whole-body metabolic power is therefore
   `M_W = met · met_scale · k_MET · m`, with k_MET = 4184/3600 = 1.1622 W/kg → `metabolic.w_per_kg_per_met`
3. Per unit area: `M = M_W / A_D`  [W/m²].
   *Consequence:* a 125 kg lineman (A_D ≈ 2.5 m²) at the same MET produces ≈ 58 W/m² per MET, while a
   70 kg / 1.8 m² athlete produces ≈ 45 W/m² per MET. The large-athlete heat burden falls out of the
   physics. It isn't a fudge factor.
4. `met_scale` is the per-athlete calibration (CONTRACTS `AthleteCalibration.met_scale`; prior mean 1).
5. External work `W = 0` (the reference default; ASHRAE treats W as negligible for most activities).
   → `gagge_1986.external_work_fraction` (0).
6. Shivering (Gagge): `M_shiv = k_shiv · cold_sk · cold_cr` is added to M. It never activates in heat but is kept for correctness.

**HR → met** (live HR from WS3, not used for planning):
`%HRR = (HR − HR_rest)/(HR_max − HR_rest)`; %HRR ≈ %VO₂R (Swain & Leutholtz 1997);
`VO₂ = VO₂_rest + %HRR·(VO₂max − VO₂_rest)`; `met = VO₂ / 3.5`.
`HR_max = 208 − 0.7·age` (Tanaka et al. 2001) unless the roster has `hr_max_bpm`.
VO₂max default by population → `constants.hr_met` (**TODO until sourced**).
*Caveat:* cardiovascular drift in heat raises HR at fixed VO₂, so HR-derived met is biased high late in
hot sessions. WS3 should treat it as an observation with inflated error. We don't correct it here.

---

## 5. Clothing / gear (clothing.py)

Each `GearLevel` (`none | helmet | helmet_shoulder_pads | full_pads`) maps to
`(I_cl [clo], R_e,cl [m²·kPa/W], f_cl)` in `constants.gear_clothing` — football-uniform sweating-manikin
data (McCullough & Kenney 2003), **TODO until sourced**.

* Dry: `R_cl = 0.155 · I_cl`  [m²·K/W]  (1 clo = 0.155 m²·K/W)
* Area factor: `f_cl` from the manikin data if reported, otherwise Gagge's `f_cl = 1 + 0.15·I_cl`
* Evaporative: `R_e,cl` [m²·mmHg/W] = manikin `R_e,cl` [m²·kPa/W] × 7.50062.
  If a gear level has only an insulation value, it falls back to Gagge's `R_e,cl = R_cl / (LR · i_cl)` with
  i_cl = 0.45.
* Gear changes between drills take effect at the next step. There is no clothing heat or moisture storage (a limitation).

---

## 6. Environment at the athlete (per step)

Weather arrives as hourly `WeatherHour` (CONTRACTS). Air temperature, relative humidity, wind, cloud cover
and solar are **linearly interpolated** to each step time. Values are held constant past the first and last hour.

### 6.1 Humidity
`p_a = RH/100 · p_sat(T_a)` with `p_sat(T) = exp(18.6686 − 4030.183/(T + 235))` [mmHg]
(the Antoine form used by Gagge / pythermalcomfort `p_sat_torr`) → `gagge_1986.psat_*`.

### 6.2 Solar position and irradiance split
* Sun elevation β per step: NOAA General Solar Position equations (Spencer 1971 Fourier series)
  → `constants.solar_position` (status per entry). When WS1's `engine/wbgt.py` lands, we can share its
  solar geometry.
* Global horizontal irradiance `I_TH = weather.solar_w_m2`. If that's missing, we call
  `engine.wbgt.solar_from_cloud` when it exists, otherwise a fallback: Haurwitz clear-sky × Kasten–Czeplak
  cloud factor (`constants.clear_sky_fallback`, **TODO/SECONDARY**). Any fallback use is labelled in the output.
* Direct/diffuse split: Erbs et al. (1982) diffuse fraction from clearness index
  `k_t = I_TH / (I_0 · sin β)` → `I_diff = f_d(k_t)·I_TH`, direct normal `I_dir = (I_TH − I_diff)/sin β`
  → `constants.irradiance_split`.

### 6.3 Mean radiant temperature: sun vs shade
**Sun** (drill `shade: false`): ASHRAE 55 Normative Appendix C "SolarCal" (Arens et al. 2015,
Building and Environment 88:3–9), applied outdoors with sky-view fraction f_svv = 1, transmittance τ = 1 and
exposed-body fraction f_bes = 1:

```
E_diff  = f_eff · f_svv · 0.5 · τ · I_diff                      [W/m²]  sky hemisphere
E_dir   = f_eff · f_p(β) · τ · f_bes · I_dir                    [W/m²]  beam
E_refl  = f_eff · f_svv · 0.5 · τ · I_TH · ρ_ground             [W/m²]  ground-reflected
ERF     = (E_diff + E_dir + E_refl) · α_sw / α_lw               [W/m²]
ΔMRT    = ERF / (f_eff · h_r,solarcal)                          [K]
T_r     = T_a + ΔMRT
```
`f_p(β)` is the projected-area factor for a standing person (ASHRAE 55 table, as in pythermalcomfort
`solar_gain`), **averaged over body azimuth** because players face every direction during practice.
f_eff, α_sw, α_lw, h_r and the f_p table → `constants.solarcal`. Ground reflectance ρ (grass/turf) →
`constants.solarcal.ground_reflectance_*`, **TODO until sourced**.

**Shade** (drill `shade: true`, or a non-participant in the cooling area): `T_r = T_a`.
*Assumption:* the canopy blocks direct, diffuse and reflected shortwave. The model ignores extra longwave from
sun-heated ground and canopy. This underestimates the radiant load in shade, so in-shade predictions run slightly
low. → `constants.shade_model` (DESIGN assumption).

*Also ignored in sun:* longwave from sun-heated turf above air temperature. That makes sun-exposed predictions
low too, worst on artificial turf. Listed in §10.

### 6.4 Wind at body height
`v = max( v₁₀ · ln(z_body/z₀) / ln(z_ref/z₀),  v_min )`, with z_ref = 10 m (forecast height),
z_body = 1.1 m (ISO 7726 standing reference height), z₀ = open-grass roughness length, and v_min = 0.1 m/s (Gagge's floor)
→ `constants.wind_profile`, **TODO until sourced**. Self-generated air movement from running comes from
Gagge's activity term in h_c (§7.1), not from v.

---

## 7. Heat exchange (Gagge 1986 as implemented in the reference)

### 7.1 Dry heat (convection + radiation) through clothing
```
h_c   = max( 3.0·P^0.53,  8.6·(v·P)^0.53,  5.66·(met_A − 0.85)^0.39 )          [W/(m²K)]
         natural          forced            activity (only if met_A > 0.85)
h_r   = 4 · ε · σ · (A_r/A_D) · ((T_cl + T_r)/2 + 273.15)^3                 [W/(m²K)]
T_op  = (h_r·T_r + h_c·T_a) / (h_r + h_c)                                     [°C]
R_a   = 1 / (f_cl · (h_c + h_r))                                              [m²K/W]
T_cl  = (R_a·T_sk + R_cl·T_op) / (R_a + R_cl)        ← iterate with h_r until |ΔT_cl| ≤ 0.01 K
DRY   = (T_sk − T_op) / (R_a + R_cl)                                          [W/m²]  (C + R, + = loss)
```
P = barometric pressure in atm (1.0 at the field; → `gagge_1986.p_atm_atm`). ε = 0.95 and A_r/A_D = 0.73
(standing) → `gagge_1986`. *Vectorized implementation:* a fixed number of T_cl/h_r fixed-point iterations
(warm-started from the previous step's T_cl). The test suite checks the residual is ≤ 0.01 K, matching the reference's tolerance.

### 7.2 Respiration
```
C_res = 0.0014 · M · (34 − T_a)           [W/m²]  sensible
E_res = 0.0023 · M · (44 − p_a[mmHg])     [W/m²]  latent
```

### 7.3 Evaporation and its cap E_max
```
LR     = 2.2 / P                                        [K/mmHg]   Lewis relation
R_e,a  = 1 / (LR · f_cl · h_c)                          [m²·mmHg/W] air layer
E_max  = (p_sk,s(T_sk) − p_a) / (R_e,a + R_e,cl)        [W/m²]     max evaporation at fully wet skin
E_rsw  = 0.68 · m_rsw                                   [W/m²]     0.68 W·h/g latent heat of sweat
w      = 0.06 + 0.94 · E_rsw / E_max                    wettedness incl. 6 % diffusion
E_sk   = w · E_max = E_rsw + E_diff
```
**Cap:** `w ≤ w_crit`, where `w_crit = 0.59 · v^−0.08` (clothed) or `0.38 · v^−0.29` (nude) (Gagge).
When the cap binds, sweating beyond what can evaporate drips and is lost, and **E_sk can't exceed the
cap**. This is the mechanism behind uncompensable heat stress in pads and humidity.
* `cap_mode: consistent` (default): `p_rsw = (w_crit − 0.06)/0.94`, `E_rsw = p_rsw·E_max`,
  `E_diff = 0.06·(1 − p_rsw)·E_max`, so `E_sk = E_rsw + E_diff = w_crit·E_max` exactly.
* `cap_mode: ashrae55_reference`: the reference code sets `p_rsw = w_crit/0.94`, `E_rsw = p_rsw·E_max`,
  `E_diff = 0.06(1 − p_rsw)E_max`, which gives `E_sk = (w_crit + 0.06)·E_max`, about 10 % more evaporation than the reported w implies.
  We use this mode only for the agreement test against pythermalcomfort.

  The default is the more conservative choice. We flag it for the physio-reviewer.
* If `E_max < 0` (air vapour pressure above skin saturation): `E_rsw = E_diff = 0`.

### 7.4 Core → skin transfer
`Q_cs = (K_cs + c_bl · SKBF) · (T_cr − T_sk)`  [W/m²], with K_cs = 5.28 W/(m²K) and c_bl = 1.163 W·h/(L·K).

---

## 8. Thermoregulatory control (Gagge), per athlete and ensemble member

Signals (positive parts):
```
warm_sk = max(T_sk − T_sk,n, 0)    cold_sk = max(T_sk,n − T_sk, 0)
warm_cr = max(T_cr − T_cr,n, 0)    cold_cr = max(T_cr,n − T_cr, 0)
warm_b  = max(T_b − T_b,n, 0)      T_b,n = α₀·T_sk,n + (1 − α₀)·T_cr,n
```
with set points T_sk,n = 33.7 °C, T_cr,n = 36.8 °C, α₀ = 0.1.

Effectors:
```
SKBF  = (SKBF_n + θ_dil · c_dil · warm_cr) / (1 + c_str · cold_sk),   clipped to [0.5, SKBF_max]   [L/(m²h)]
m_rsw = θ_sw · c_sw · warm_b · exp(warm_sk / 10.7),                   clipped to [0, m_rsw,max]    [g/(m²h)]
α     = 0.0417737 + 0.7451833 / (SKBF + 0.585417)
```
SKBF_n = 6.3, c_dil = 120, c_str = 0.5, c_sw = 170, SKBF_max = 90, m_rsw,max = 500 → `gagge_1986`.

**Individualization** (θ multipliers, defaults 1):
* `θ_sw = θ_dil = thermo_scale` (CONTRACTS `AthleteCalibration.thermo_scale`: "scales sweating/vasomotor effectiveness").
* **Acclimatization** (`athlete.acclimatization_day`), with a(d) ∈ [0, 1] the adaptation fraction on day d:
  `θ_sw ← θ_sw · (1 + a(d)·Δ_sw_gain)`, a sweat-onset threshold shift `T_b,n ← T_b,n − a(d)·Δ_threshold`,
  and a resting core shift `T_cr(0) ← T_cr(0) − a(d)·Δ_rest`. a(d), Δ_sw_gain, Δ_threshold and Δ_rest come from
  `constants.acclimatization`, **TODO until sourced**. Until they're sourced, the code sets every Δ to 0, so all
  athletes run as Gagge's unacclimatized reference man, and the output labels say so.
  `days_since_last_heat_session` (decay) isn't modelled in v1.

---

## 9. Integration, ensemble and outputs

### 9.1 Time stepping (explicit Euler, the same scheme and update order as the reference)
For each step k with inputs u_k (drill/gear/shade/weather at the step start):
1. `M = M_act,k + M_shiv`; compute C_res, E_res, h_c, the T_cl/h_r iteration and DRY using the current T_sk.
2. `Q_cs` from the current SKBF.
3. Storage: `S_cr = M − W − C_res − E_res − Q_cs`, `S_sk = Q_cs − DRY − E_sk`.
4. Update:
   `T_cr += S_cr · A_D · dt / ((1−α)·c_b·m·3600)`,  `T_sk += S_sk · A_D · dt / (α·c_b·m·3600)`  (c_b in W·h/(kg·K)).
5. With the new temperatures: signals → SKBF, m_rsw → E_rsw, E_max(T_sk) → w, E_sk (with cap) → M_shiv → α.
   These are used in the next step, a one-step control lag, as in the reference.

Initial state: `T_cr = T_cr,n (− acclimatization shift)`, `T_sk = T_sk,n`, `SKBF = SKBF_n`, `α = α₀`,
`E_sk = 0.1·met_A` (the reference's initial guess).

**Step size:** `step_min` sets dt. A test checks that `step_min = 0.25` (15 s) gives core temperatures within a
stated tolerance of `step_min = 1`. If plain 1-min Euler fails that test, the integrator sub-steps internally
(`dt_internal ≤ max_internal_dt_s`) and reports on the `step_min` grid. The skin node's time constant at high
blood flow is about 1–2 min, so this needs checking.

### 9.2 Ensemble (uncertainty, never invented)
For each athlete i and member e (common random numbers from `seed`; the same draws are reused for every
candidate plan in the optimizer):
```
met_scale[e,i]    ~ N(μ_m,i, σ_m,i²)   μ, σ from athlete.calib, else prior (1, constants.ensemble_priors.met_scale_sd)
thermo_scale[e,i] ~ N(μ_θ,i, σ_θ,i²)   μ, σ from athlete.calib, else prior (1, constants.ensemble_priors.thermo_scale_sd)
```
Draws are truncated to `[μ − k·σ, μ + k·σ]` and floored above 0 (k → `ensemble_priors.truncate_sd`).
The prior SDs are **TODO until sourced**. Until then, the uncertainty band reflects only those placeholder
SDs, and the labels say so. Forecast-weather uncertainty isn't in v1's ensemble (a listed limitation).
`core_c_p50`, `core_c_p95` = 50th/95th percentile over the ensemble axis (numpy linear interpolation). With
n = 30, p95 sits between the 29th and 30th order statistics, so it's noisy at the ±0.05 °C level.

### 9.3 Outputs (CONTRACTS `SimulationResult`)
* `times[k]` = plan start + (k+1)·step (the state at the **end** of each step); T = ceil(total minutes / step).
* Per athlete: `core_c_p50[T]`, `core_c_p95[T]`, `peak_core_c_p95`, `first_cross_min` (minutes from start
  to the end of the first step where p95 ≥ limit), and `status`: `over_limit` if peak p95 ≥ limit, `near_limit` if
  peak p95 ≥ limit − `near_limit_margin_c` (DESIGN), otherwise `below_limit`. Never "safe".
* `limit_core_c = constants.planning_limit_core_c.value` (**TODO until sourced**; presented as an
  AT-owned illustrative threshold).
* `training_load_met_min` = team mean over athletes of Σ (MET × minutes) over non-break drill minutes the athlete
  takes part in.
* `labels` always include `"estimate — planning only"`, plus `"synthetic roster"`, `"forecast is fixture"`, and
  `"uses unverified constants: …"` (the TODO keys the run touched) where those apply.

---

## 10. Limitations (said out loud)

1. Gagge 1986 was fitted to resting and moderately active adults, not adolescent football players. Validation in
   WS7 (published football-uniform study and JOS-3 cross-check) has to show how far off it is.
2. No dehydration effect on core temperature, no plasma-volume changes, no cardiovascular drift.
3. Activity is a per-drill average MET. Intermittent sprints within a drill aren't resolved.
4. Clothing has no heat or moisture storage. Sweat-soaked pads aren't modelled.
5. Radiation: no extra longwave from hot ground or turf, and shade is treated as complete. Both bias predictions low.
6. Wind at body height uses a neutral log profile. Stadium sheltering is ignored.
7. Weather uncertainty isn't sampled, and prior SDs are placeholders until sourced.
8. The skin-mass fraction α changes with blood flow (inherited from Gagge), so energy bookkeeping isn't exact.
9. p95 from 30 draws is a statistical estimate with its own sampling noise.

## 11. Constants status (summary — authoritative list is constants.yaml)

| Key | Used for | Status |
|---|---|---|
| `gagge_1986.*` | every thermoregulation coefficient | SECONDARY (read from pythermalcomfort source) |
| `physical.*` | σ, 273.15, mmHg/kPa, kcal→J | VERIFIED (CODATA/NIST definitions) |
| `body_surface_area` | DuBois A_D | SECONDARY |
| `metabolic.w_per_kg_per_met` | MET → W | pending source-checker |
| `drill_met` | intensity → MET | pending source-checker |
| `gear_clothing` | clo, R_e,cl, f_cl | pending source-checker |
| `solarcal`, `irradiance_split`, `solar_position`, `wind_profile` | radiation & wind | pending source-checker |
| `acclimatization` | sweat gain / threshold shifts | pending source-checker (zero-effect until sourced) |
| `ensemble_priors` | met/thermo SD | pending source-checker |
| `planning_limit_core_c` | limit line | pending source-checker |
| `non_participant`, `shade_model`, `near_limit_margin_c` | modelling/product assumptions | DESIGN (owned by the AT/coach, not a sourced fact) |

## 12. How it is checked

* `tests/test_twonode.py`: rises with met; falls at rest in shade; monotonic in heat-stress inputs (T_a, RH, solar)
  and therefore in WBGT; bounded 36–42 °C on fixtures; agreement with `two_nodes_gagge` after 59 min of constant
  conditions (reference mode, 70 kg / 1.8258 m², i_cl = 0.45) within a stated tolerance; 15 s vs 1 min step
  stability; performance (16 athletes × 113 min × 30 draws < 50 ms).
* `jos3_ref.py`: the same scenario through JOS-3 (Takahashi et al. 2021), changing `par/clo/tdb/tr/rh/v` between
  `simulate()` calls. The report gives the core-temperature gap. JOS-3 pelvis core stands in for rectal temperature.
