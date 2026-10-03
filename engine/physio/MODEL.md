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
| 4 | Clothing vapour permeation efficiency i_cl = 0.45 for all clothing | Football-uniform sweating-manikin values per gear level (McCullough & Kenney 2003), corrected for wind and body movement per ISO 7933 (§5) |
| 5 | Mean radiant temperature (MRT) is an input | MRT = air temp + solar ΔMRT (ASHRAE 55 SolarCal) in sun; MRT = air temp in shade (§6) |
| 6 | Wind is an input | 10 m forecast wind → wind at body height (log profile) (§6.4) |
| 7 | Sweat and blood-flow gains fixed | Gains scaled by calibration `thermo_scale`; acclimatization day shifts the set point and sweat gain (§8) |
| 8 | One deterministic run | Ensemble of N draws per athlete → p50 / p95 (§9) |
| 9 | At the wettedness cap, skin evaporation = (w_crit + 0.06)·E_max (quirk) | Default: skin evaporation = w_crit·E_max, consistent with the definition w = E_sk/E_max; the reference behaviour is available as a mode (§7.3) |
| 10 | Critical wettedness w_crit = 0.59·v^−0.08 (clothed, Gagge's comfort-derived value) | ISO 7933 w_max: 0.85 unacclimatized → 1.0 acclimatized (§7.3), in the default ISO clothing mode |
| 11 | No aerobic ceiling | Metabolic rate per athlete clipped at VO₂max (§4) |

Three **clothing modes** (constants `model_options.clothing_mode`):
* `conservative` (**planning default**; the name is historical, as it's now the Armstrong-calibrated mode): ISO 7933 dynamic
  structure with the wind credit kept and the **walking-ventilation credit off**, plus a **gear load surcharge** on metabolic
  heat, `M × (1 + δ·w(gear))`. δ = **0.0486** is fitted to Armstrong 2010's FULL whole-protocol rise (2.37 °C over
  56.2 min); that was the owner's decision on Oct 3. The safety margin lives in p95 and the AT-owned limit, not in the median
  physics. w(gear) is 0 for `none` and `helmet`, 0.636 for `helmet_shoulder_pads` and 1 for `full_pads`.

  **Treadmill metabolism and work (owner decision 2).** Armstrong's methods give the treadmill pace as "5.6 km/h, 5% grade".
  ACSM walking equation (Moore et al. 2021, Eq. 1): speed 5.6 km/h = 93.333 m/min; VO2 = 0.1×93.333 + 1.8×93.333×0.05 + 3.5 = 9.333 + 8.400 + 3.5 = 21.233 mL/kg/min = 6.067 MET. Walking up the grade does external mechanical
  work, W = m·g·v·grade (≈ 38 W/m² for the mean participant, about 11 % of metabolic rate). That work isn't heat and is
  subtracted (physio-reviewer, Oct 3). With both corrections, CON (no surcharge) decides the credit:

  | walk credit | treadmill MET | CON treadmill rate | error / SD | CON rise (°C) | error / SD |
  |---|---|---|---|---|---|
  | 1 | acsm | 0.0224 | -0.98 | 1.14 | -1.67 |
  | 1 | compendium | 0.0166 | -1.36 | 0.84 | -2.43 |
  | 0 | acsm | 0.0358 | -0.08 | 1.85 | +0.10 |
  | 0 | compendium | 0.0241 | -0.86 | 1.24 | -1.42 |

  The credit is **off**: −0.08 SD on rate and +0.10 SD on rise with ACSM, against −0.98 / −1.67 SD with the credit on. It
  flipped twice today. First it was dropped because the Compendium 5.3 MET was too low. Then it was kept on ACSM MET while
  treadmill work was still counted as heat. Now it's off with both corrections in place.
  **Tension:** the field data favour more cooling than this (§12b), so this choice raises field predictions by about 1 °C.

  **Both calibration fits** (ACSM MET, work subtracted, credit off):

  | Fit target | δ | FULL treadmill rate | FULL rise | CON treadmill rate | CON rise |
  |---|---|---|---|---|---|
  | whole_rise (in use) | 0.0486 | 0.0621 (meas 0.071 ± 0.032) | 2.37 (meas 2.37 ± 0.45) | 0.0358 (meas 0.037 ± 0.015) | 1.85 (meas 1.81 ± 0.40) |
  | treadmill_rate | 0.1348 | 0.071 (meas 0.071 ± 0.032) | 2.76 (meas 2.37 ± 0.45) | 0.0358 (meas 0.037 ± 0.015) | 1.85 (meas 1.81 ± 0.40) |

* `iso7933_dynamic` (alternate): the full ISO 7933 dynamic correction, with no surcharge.
* `gagge_static`: Gagge's own clothing and w_crit structure with static intrinsic manikin values. With Gagge's
  i_cl = 0.45 law and 70 kg / 1.8258 m², this mode reproduces `two_nodes_gagge` (test tolerance 0.01 °C).

**Armstrong et al. 2010 reproduction** (`validation/armstrong_2010.py` → `validation/results.json`): deterministic mean
participant, 33 °C / 48.5 % RH chamber, air speed not reported (still-air floor 0.1 m/s shown; a sweep is in results.json),
METs: box lifting 4.0 (Compendium 11820), seated 1.0 (07021), treadmill 6.067 (ACSM walking equation at the reported
speed and grade).

| Model | Condition | Treadmill rate (model) | Measured (mean ± SD) | Error / SD | Whole-protocol rise model / measured (°C) |
|---|---|---|---|---|---|
| conservative | CON | 0.0358 | 0.037 ± 0.015 | -0.08 | 1.85 / 1.81 |
| conservative | FULL | 0.0621 | 0.071 ± 0.032 | -0.28 | 2.37 / 2.37 (fit) |
| iso7933_dynamic | CON | 0.0224 | 0.037 ± 0.015 | -0.98 | 1.14 / 1.81 |
| iso7933_dynamic | FULL | 0.0399 | 0.071 ± 0.032 | -0.97 | 1.48 / 2.37 |
| gagge_static | CON | 0.0314 | 0.037 ± 0.015 | -0.37 | 1.66 / 1.81 |
| gagge_static | FULL | 0.0568 | 0.071 ± 0.032 | -0.44 | 2.21 / 2.37 |
| jos3 | CON | 0.0336 | 0.037 ± 0.015 | -0.22 | 1.88 / 1.81 |
| jos3 | FULL | 0.0396 | 0.071 ± 0.032 | -0.98 | 1.56 / 2.37 |

Summary values only: Tables 3 and 4. Figure 2's time course isn't tabulated and wasn't digitized. The air speed wasn't reported; results.json has a 0.1 / 0.5 / 1.0 m/s sweep, and it's the largest uncertainty, since conservative CON moves by about 1 SD between 0.1 and 0.5 m/s. JOS-3 behaves like the ISO-dynamic mode: it under-predicts FULL by about 1 SD.

The FULL rise in conservative mode is the calibration target, and CON decided the walking credit, so the remaining unfitted checks are the FULL treadmill rate (−0.28 SD) and the CON rise (+0.10 SD). ISO-dynamic and JOS-3 both under-predict FULL by about 1 SD.

**Field consequence** (fixture practice, NATA-phased gear, cached NWS forecast). Conservative (planning default): median peak 39.7–41.0 °C, p95 40.5–41.7 °C; all 16 athletes cross 39.0 °C at p95 between minutes 45 and 52. ISO-dynamic: median 38.8–39.8 °C, p95 39.5–40.5 °C. In both modes all 16 athletes cross 39.0 °C at p95 on the
unmodified plan. Field context: Godek 2006 measured NFL preseason practice maxima of 38.65 ± 0.48 °C (adult, acclimatized,
unknown intensity), so conservative is likely hot in the field while ISO is low in the lab. The truth needs field data with
measured activity.

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

1. Drill → MET: `met = drill.met_override` if given, otherwise `drill_met[intensity]`. The values come from the 2024 Adult
   Compendium (VERIFIED): rest 1.3 (07040 standing quietly), light 2.8 (02024 calisthenics, light), moderate 4.0 (15232 football
   touch/flag, light — "estimated" in the Compendium), hard 8.0 (15210 football, competitive), max 11.0 (02078 shuttle running).
   The intensity → code mapping is DESIGN. The Compendium has no football-practice codes and covers ages 19–59; using it for
   15–18-year-olds is an extrapolation. Context: Hitchcock 2007 measured a simulated practice in collegiate linemen
   at 55 % VO₂max (6.7 MET) on average.
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
5. **Sustained aerobic ceiling:** `M ≤ 0.81·VO₂max/3.5 · k_MET · m / A_D`. 0.81 is the highest drill intensity Hitchcock
   2007 measured in simulated football practice ("ranged from 30 to 81% VO(2)max"); using it as a ceiling is DESIGN. VO₂max is
   the athlete's value if known, else the Boden et al. 2022 high-school defaults: linemen (OL/DL) 32.8, others 41.8, unknown
   position 38.5 mL·kg⁻¹·min⁻¹. With a 100 % ceiling, high met_scale draws hold linemen at VO₂max for 40 min (physio-reviewer
   J3). With this ceiling, "hard" (8 MET) is capped at 7.6 MET for linemen.
6. External work `W = 0` (the reference default; ASHRAE treats W as negligible for most activities).
   → `gagge_1986.external_work_fraction` (0).
7. Shivering (Gagge): `M_shiv = k_shiv · cold_sk · cold_cr` is added to M. It never activates in heat but is kept for correctness.

**HR → met** (live HR from WS3, not used for planning):
`%HRR = (HR − HR_rest)/(HR_max − HR_rest)`; %HRR ≈ %VO₂R (Swain & Leutholtz 1997);
`VO₂ = VO₂_rest + %HRR·(VO₂max − VO₂_rest)`; `met = VO₂ / 3.5`.
`HR_max = 208 − 0.7·age` (Tanaka et al. 2001) unless the roster has `hr_max_bpm`.
VO₂max default by position group → `constants.hr_met` (Boden et al. 2022). %HRR ≈ %VO₂R and Tanaka were derived in adults.
*Caveat:* cardiovascular drift in heat raises HR at fixed VO₂, so HR-derived met is biased high late in
hot sessions. WS3 should treat it as an observation with inflated error. We don't correct it here.

---

## 5. Clothing / gear (clothing.py)

Each `GearLevel` maps to a measured ensemble in `constants.gear_clothing` (McCullough & Kenney 2003, Tables 1–3,
VERIFIED). The ensembles: `none` = reference T-shirt and shorts; `helmet_shoulder_pads` = P2 practice; `full_pads` = G1
warm-weather game uniform (a judgement call). `helmet` has **no measured ensemble**, so it conservatively reuses P2 (DESIGN, flagged).
Values per level: total insulation I_T (clo), intrinsic I_cl (clo), f_cl, intrinsic R_e,cl (m²·kPa/W), permeability index i_m.

**Default — ISO 7933 dynamic correction** (`constants.iso7933_dynamic`, read from pythermalcomfort `phs.py`):
```
w_a      = min(0.0052·(M − 58), 0.7)                     walking speed from metabolic rate [m/s] (ISO default)
corr_cl  = min(1.044·exp((0.066·v′ − 0.398)·v′ + (0.094·w′ − 0.378)·w′), 1)     v′ = min(v,3), w′ = min(w_a,1.5)
corr_ia  = min(exp((0.047·v − 0.472)·v + (0.117·w′ − 0.342)·w′), 1)
corr_tot = corr_cl  (I_cl > 0.6 clo), else blended ((0.6 − I_cl)·corr_ia + I_cl·corr_cl)/0.6
I_T,dyn  = I_T · corr_tot                                                       [m²K/W]
i_m,dyn  = min(i_m · ((2.6·corr_tot − 6.5)·corr_tot + 4.9), 0.9)
R_e,T    = I_T,dyn / (i_m,dyn · 16.7)  [m²·kPa/W] → × 7.50062 → m²·mmHg/W       total evaporative resistance
R_cl     = I_T,dyn − I_a·corr_ia / f_cl,  I_a = 0.0946 m²K/W (McCullough's 0.61 clo still-air layer, contained in I_T)
```
These enter the Gagge exchange as follows. Dry heat uses `R_cl` (dynamic) with Gagge's air layer (§7.1). Evaporation uses
`E_max = (p_sk,s − p_a)/R_e,T` in place of Gagge's `R_e,a + R_e,cl` (§7.3). Both depend on M, so they're
computed per athlete and per ensemble member every step. ISO's walking-speed default caps at 0.7 m/s, which
under-represents running and is the conservative direction.

**Static mode** (`gagge_static`):

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
  `engine.wbgt.solar_from_cloud` when it exists, otherwise a fallback: Haurwitz clear-sky
  `1098·cos z·exp(−0.059/cos z)` × Kasten–Czeplak `(1 − 0.75·(N/8)^3.4)` (`constants.clear_sky_fallback`, SECONDARY).
  The NWS WBGT algorithm uses the same Kasten–Czeplak cloud reduction. Any fallback use is labelled in the output.
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
ΔMRT    = linearised value (h_r ≈ 6)
T_r     = ((T_a + 273.15)^4 + h_r·ΔMRT/σ)^(1/4) − 273.15      ← exact-radiation MRT fed to the T⁴ exchange
```
The last line converts SolarCal's linearised field to the MRT whose exact longwave exchange delivers the same absorbed
energy. This was a physio-reviewer finding: feeding `T_a + ΔMRT` straight into Gagge's T⁴ radiation over-delivered the
field by about 25 %. On the fixture, ΔMRT is 20–30 K.
`f_p(β)` is the projected-area factor for a standing person (ASHRAE 55 table, as in pythermalcomfort
`solar_gain`), **averaged over body azimuth** because players face every direction during practice.
f_eff = 0.725, α_sw = 0.7, α_lw = 0.95, h_r = 6.012 and the f_p table are in `constants.solarcal`. Ground reflectance ρ is
0.23 for grass (FAO-56) and 0.11 for synthetic turf (Singh 2024 review) → `constants.solarcal_ground`.
A test checks this against pythermalcomfort `solar_gain` (fed its fixed 0.2·I_dir diffuse) to within 1e-6.

**Shade** (drill `shade: true`, or a non-participant in the cooling area): `T_r = T_a`.
*Assumption:* the canopy blocks direct, diffuse and reflected shortwave. The model ignores extra longwave from
sun-heated ground and canopy. This underestimates the radiant load in shade, so in-shade predictions run slightly
low. → `constants.shade_model` (DESIGN assumption).

*Also ignored in sun:* longwave from sun-heated turf above air temperature. That makes sun-exposed predictions
low too, worst on artificial turf. Listed in §10.

### 6.4 Wind at body height
`v = max( v₁₀ · ln(z_body/z₀) / ln(z_ref/z₀),  v_min )`, with z_ref = 10 m (forecast height), z_body = 1.1 m (standing
abdomen height used with ISO 7243), z₀ = 0.03 m (WMO Davenport "open"), and v_min = 0.1 m/s (Gagge's floor). The NWS WBGT
algorithm also uses the log law to bring 10 m wind down → `constants.wind_profile` (SECONDARY). Self-generated air movement from running comes from
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
(standing) → `gagge_1986`. *Vectorized implementation:* T_cl/h_r fixed-point iterations until every element moves
≤ 0.01 K, as in the reference. h_r is warm-started from the previous step; T_cl is re-guessed from it.

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
In the default ISO mode `E_max = (p_sk,s − p_a)/R_e,T` (§5).
**Cap:** `w ≤ w_crit`. In ISO mode w_crit = ISO 7933 w_max = 0.85 + a·(1.0 − 0.85), with a the acclimatization fraction (§8;
the interpolation is DESIGN). In static mode `w_crit = 0.59 · v^−0.08` (clothed) or `0.38 · v^−0.29` (nude) (Gagge).
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
* **Acclimatization** (`constants.acclimatization`, block DESIGN; each magnitude VERIFIED). The adaptation fraction is
  `a(d) = interp(d; days [1, 6, 14] → [0, 0.75, 1])`. That follows Périard 2015 ("75–80% of the adaptations occur in the first
  4–7 days", complete by 10–14) and the NATA 14-day period. It's reduced by 2.5 % for each day beyond the first since the last
  heat session (Daanen 2018). Effects at full adaptation:
  - **Set-point shift** of −0.3 °C on T_cr,n, so T_b,n, resting core and sweating onset all move. Buono 1998: resting Tre
    37.0 → 36.7 °C. Mee 2018: resting −0.28, sweat-onset Tre −0.29 °C. The two move together, so one shift is used.
  - **Sweat gain** × (1 + 0.11) (Poirier 2015: whole-body evaporative heat loss up to ~11 % by day 14).
  - **w_max** 0.85 → 1.0 (ISO 7933 unacclimatized/acclimatized; interpolation DESIGN).
  These magnitudes come mostly from laboratory heat acclimation in adults. Transferring them to adolescent field
  acclimatization is an assumption.

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

**Step size:** the physics integrates at ≤ `model_options.max_internal_dt_s` = 30 s and reports on the `step_min` grid. With
plain 1-min Euler, one fixture drill boundary differed from 15-s steps by 0.051 °C. With 30-s sub-steps the < 0.05 °C test passes,
at 5.5 ms per 16 × 113 × 30 simulation. Skin: 1-min Euler overshoots by up to 0.7 °C right at
drill boundaries (the skin node's time constant is about 1 min at high blood flow) and damps within 2 steps. Skin isn't
an output, and the core is unaffected.

### 9.2 Ensemble (uncertainty, never invented)
For each athlete i and member e (common random numbers from `seed`; the same draws are reused for every
candidate plan in the optimizer):
```
met_scale[e,i]    ~ N(μ_m,i, σ_m,i²)   μ, σ from athlete.calib, else prior (1, constants.ensemble_priors.met_scale_sd)
thermo_scale[e,i] ~ N(μ_θ,i, σ_θ,i²)   μ, σ from athlete.calib, else prior (1, constants.ensemble_priors.thermo_scale_sd)
```
Draws are truncated at ±3 SD and floored above 0 (`ensemble_defaults`, DESIGN). Prior SDs (`ensemble_priors`, DESIGN,
derived from verified tables) are met_scale 0.20 and thermo_scale 0.15:
* met_scale: Kozey 2010, between-person CV of measured METs, median ~20 %.
* thermo_scale: Armstrong 2010, linemen sweat-rate CV 13–17 % under lab control. Field CVs of 22–47 % also include body size and
  intensity, which the model already represents.

Forecast-weather uncertainty isn't in v1's ensemble (a listed limitation).
`core_c_p50`, `core_c_p95` = 50th/95th percentile over the ensemble axis (numpy linear interpolation). With
n = 30, p95 is noisy. Across 12 seeds the hottest athlete's peak p95 has an SD of about 0.12 °C. Quote headline p95
to 0.1 °C and state the seed; the optimizer uses common random numbers, so plan comparisons aren't affected.

### 9.3 Outputs (CONTRACTS `SimulationResult`)
* `times[k]` = plan start + (k+1)·step (the state at the **end** of each step); T = ceil(total minutes / step).
* Per athlete: `core_c_p50[T]`, `core_c_p95[T]`, `peak_core_c_p95`, `first_cross_min` (minutes from start
  to the end of the first step where p95 ≥ limit), and `status`: `over_limit` if peak p95 ≥ limit, `near_limit` if
  peak p95 ≥ limit − `near_limit_margin_c` (DESIGN), otherwise `below_limit`. Never "safe".
* `limit_core_c = constants.planning_limit_core_c.value` (39.0 °C, NIOSH 2016 "reason to terminate exposure"; presented as an
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
4. Clothing has no heat or moisture storage. Sweat-soaked pads aren't modelled. The `helmet` gear level has no measured
   ensemble. ISO 7933's walking-speed default (≤ 0.7 m/s) under-represents running.
5. Radiation: no extra longwave from hot ground or turf, and shade is treated as complete. Both bias predictions low.
6. Wind at body height uses a neutral log profile. Stadium sheltering is ignored.
7. Weather uncertainty isn't sampled, and prior SDs are placeholders until sourced.
8. The skin-mass fraction α changes with blood flow (inherited from Gagge), so energy bookkeeping isn't exact.
9. p95 from 30 draws is a statistical estimate with its own sampling noise.

## 10b. Modelling judgement calls flagged by the physio-reviewer (not changed; ranked by effect)

1. **ISO 7933 dynamic correction on pads** is the largest lever: static clothing gives a 47.1 °C peak p95, ISO-corrected
   gives about 40–41.6. In full pads it raises i_m from 0.37 to about 0.80. That's aggressive for impermeable foam, and it's
   why the Armstrong 2010 full-uniform rise is under-predicted (0.035–0.045 vs 0.071 ± 0.032 °C/min). Better options: correct
   only the non-pad area fraction, or calibrate against Armstrong (WS7).
2. **ISO w_max (0.85–1.0) inside Gagge's all-or-nothing wettedness cap.** Gagge's w_crit (about 0.58) would add about 1.6 °C.
   ISO pairs w_max with a sweat-efficiency curve that this model lacks.
3. **Sustained aerobic ceiling** (§4.5) at 0.81·VO₂max: about −1 °C for the heaviest linemen versus a 100 % ceiling.
4. **Ensemble spread:** met_scale is held for the whole session (SD 0.20), which maximises the spread of accumulated heat.
   Deterministic peak vs p95 differ by about 1.2 °C.
5. Acclimatization is worth about −0.2 °C on the team maximum (up to −0.5 °C per athlete). The consistent cap mode adds +0.19 °C. Initial
   core 36.8 vs 37.1 °C changes peak p95 by +0.04.

## 10c. Second physio-review (conservative mode, Oct 3): fixed and open

**Fixed:**
- The helmet level no longer inherits a surcharge. It already borrows P2's clothing values; the per-gear weights are now explicit in `clothing_conservative.surcharge_weight_by_gear`.
- The surcharge is treated as metabolic. It's applied before the VO₂max ceiling and inside the live-HR observation model, so calibration doesn't count it twice.
- Athletes rotated out of a drill are capped at their NATA gear limit.
- The numba kernel raises on a non-converged T_cl, and stale text is corrected.

**Open judgement calls (owner's decision):**
1. **Calibration statistic. DECIDED Oct 3:** δ is fitted to the whole-protocol rise (now 0.0486; the treadmill-rate fit, 0.1348, is reported alongside it).
2. **Walking-ventilation credit. DECIDED Oct 3 by the CON rule:** off, once the treadmill's external work is subtracted (see §5 table). Field data pull the other way (§12b).
3. **The surcharge sits before the VO₂max ceiling.** In the field the ceiling binds for many lineman p95 draws, so δ moves p95 less than the median.
4. **δ depends on the unreported chamber air speed:** 0.167 at 0.1 m/s, 0.23 at 0.3 m/s, 0.30 at 0.5 m/s. The lowest is used.

## 11. Constants status (summary — authoritative list is constants.yaml)

| Key | Used for | Status |
|---|---|---|
| `gagge_1986.*` | every thermoregulation coefficient | SECONDARY (read from pythermalcomfort source) |
| `physical.*` | σ, 273.15, mmHg/kPa, kcal→J | VERIFIED (CODATA/NIST definitions) |
| `body_surface_area` | DuBois A_D | SECONDARY |
| `metabolic` | 1 MET = 1 kcal·kg⁻¹·h⁻¹ | VERIFIED |
| `drill_met` | intensity → MET | DESIGN mapping of VERIFIED Compendium values |
| `gear_clothing` | I_T, I_cl, f_cl, R_e,cl, i_m | VERIFIED (McCullough & Kenney 2003); `helmet` level TODO (uses P2) |
| `iso7933_dynamic` | wind/motion clothing correction, w_max | SECONDARY (pythermalcomfort phs.py; ISO text paywalled) |
| `solar_position` | sun elevation | VERIFIED (NOAA) |
| `solarcal`, `solarcal_ground`, `irradiance_split`, `wind_profile`, `clear_sky_fallback` | radiation & wind | SECONDARY |
| `hr_met`, `hr_max_formula` | VO₂max ceiling, HR → met | VERIFIED (adult-derived) |
| `acclimatization` | set point, sweat gain, w_max | DESIGN curve over VERIFIED magnitudes |
| `ensemble_priors` | met/thermo SD | DESIGN (derived from VERIFIED tables) |
| `planning_limit_core_c` | 39.0 °C limit line (alternatives 38.0, 38.5) | VERIFIED (NIOSH 2016); AT-owned |
| `non_participant`, `shade_model`, `near_limit_margin_c`, `model_options`, `ensemble_defaults` | modelling/product assumptions | DESIGN |

## 12b. Field plausibility vs pill data from football practices (`validation/field_plausibility.py`)

**Field data** (constants.field_core_temp_studies, collected by the source-checker): group-mean practice peaks 38.2–38.8 °C; individual maxima 39.1–39.3 °C; no reading ≥ 40 °C reported.

The model's p50 peak for each study's mean participant is compared with the study's group-mean peak, and its p95 with
mean + 1.645 SD and the highest individual reading. The papers don't report practice structure, so our fixture drill mix
(40 min "hard" at 8 MET, 12 min "max" at 11 MET), scaled to each study's duration, is used. Cloud isn't reported either, so
sun is bracketed: overcast / clear. The WBGT-only rows run the **demo roster and plan**, not the study cohorts. McClelland
is hotter than the demo forecast, so its gap is understated; the Yeargin evening is warmer than the study days, so its gap is
overstated.

| Study [group] | Measured peak mean ± SD (°C) | ≈ p95 | Max individual | Model p50 peak | Model p95 peak | p50 − measured mean |
|---|---|---|---|---|---|---|
| Godek 2006 (NFL, AM full equipment) [linemen] | 38.65 ± 0.48 | 39.44 | 39.29 | 39.5 / 40.64 | 39.98 / 41.16 | 0.85 / 1.99 |
| Godek 2006 (NFL, AM full equipment) [backs] | 38.44 ± 0.32 | 38.97 | 39.08 | 39.34 / 40.6 | 40.51 / 41.78 | 0.9 / 2.16 |
| Fowkes Godek 2004 (Div II, PM full pads) [all] | 38.6 ± n/a | — | 39.11 | 39.82 / 40.91 | 40.19 / 41.45 | 1.22 / 2.31 |
| McClelland 2018 (Div III, WBGT 29.1–31.4 °C) [demo roster vs study cohort] | 38.56 ± 0.32 | 39.09 | — | 40.23 | 41.1 | 1.67 |
| DeMartini-Nolan 2018 (Div I, WBGT ≈ 28.75 °C) [demo roster vs study cohort] | 38.83 ± 0.42 | 39.52 | — | 40.23 | 41.1 | 1.4 |
| Yeargin 2010 (high school, heat-acclimatized) [all] | 38.7 ± 0.3 | 39.19 | — | 40.44 | 41.95 | 1.73 |

**Sensitivity on the demo practice** (team-mean peaks, one change at a time):

| Case | p50 | p95 | Δp50 | Δp95 |
|---|---|---|---|---|
| baseline (conservative mode, as planned) | 40.23 | 41.1 | — | — |
| hard/max drills at the 'moderate' MET (activity level) | 37.91 | 38.82 | -2.32 | -2.27 |
| all drills in shade (no solar load) | 39.42 | 40.21 | -0.81 | -0.88 |
| ISO-dynamic clothing (no gear surcharge) | 39.2 | 39.91 | -1.03 | -1.19 |
| every athlete fully acclimatized (day 14) | 39.9 | 40.73 | -0.33 | -0.37 |
| no ensemble spread (met/thermo SD = 0) | 40.25 | 40.25 | 0.02 | -0.85 |
| walking-ventilation credit on (owner rule turned it off) | 39.29 | 39.93 | -0.94 | -1.16 |

**Reading it plainly.**
- Our medians sit **1.4–1.7 °C above** the field group-mean peaks at matched WBGT. Against the Godek cohorts they're 0.85–1.2 °C
  above under overcast sky and 2.0–2.3 °C above under clear sky. Model p95 is well above the highest individual readings.
- The largest one-at-a-time sensitivity is the **activity level**: running "hard" and "max" drills at the "moderate" MET lowers
  medians by 2.3 °C. The Compendium's "competitive football" 8 MET is a game value applied to whole practice blocks, while
  Hitchcock 2007 measured a 55 % VO₂max average in simulated practice.
- **Clothing treatment** comes next (ISO-dynamic without surcharge, −1.0), then the **walking-ventilation credit** (−0.9; it's
  off by the owner's CON rule), then sun (−0.8).
- These are sensitivities, not a demonstrated cause, and the sweep can't separate them from one another.
- Choices in the field scenarios that push the model up:
  - acclimatization is set to the camp day (about +0.2 °C);
  - gassers run in full pads;
  - backs come out at or above linemen, the reverse of the field data, because of the position-based VO₂max ceilings.

Nothing was tuned: the gap is reported. Narrowing it needs measured drill intensity (HR or GPS from the team's own practices,
WS3) and field validation of the clothing ventilation terms.

## 12. How it is checked

* `tests/test_twonode.py`: rises with met; falls at rest in shade; monotonic in heat-stress inputs (T_a, RH, solar)
  and therefore in WBGT; bounded 36–42 °C on fixtures; agreement with `two_nodes_gagge` after 59 min of constant
  conditions (reference mode, 70 kg / 1.8258 m², i_cl = 0.45) within a stated tolerance; 15 s vs 1 min step
  stability; performance (16 athletes × 113 min × 30 draws < 50 ms).
* `jos3_ref.py`: the same scenario through JOS-3 (Takahashi et al. 2021), changing `par/clo/tdb/tr/rh/v` between
  `simulate()` calls. The report gives the core-temperature gap. JOS-3 pelvis core stands in for rectal temperature.
  On the fixture practice (deterministic, all 16 athletes), JOS-3 peaks run **2.2 °C hotter** than twonode-v1's ISO mode
  (RMSE 1.4 °C) and **2.8 °C cooler** than its static mode. JOS-3 takes clo only, with no wind/motion correction of vapour
  resistance and no activity-driven convection, so it sits between our two clothing treatments. This is reported as a
  finding, not tuned away.
