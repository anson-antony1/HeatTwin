"""WS7 — field plausibility: twonode-v1 vs ingestible-pill core temperatures from American football practices.

Studies (constants.field_core_temp_studies): Godek 2006 (NFL), Fowkes Godek 2004 (Div II), McClelland 2018 (Div III),
DeMartini-Nolan 2018 (Div I), Yeargin 2010 (high school). Group-mean practice peaks 38.2–38.8 °C, individual maxima
39.1–39.3 °C.

What is compared: the model's p50 peak for the study's mean participant against the study's group-mean peak, and its
p95 peak against mean + 1.645 SD (≈ the population 95th percentile) and the highest individual reading.

Inputs the papers do not report are assumptions (constants.field_plausibility_assumptions, DESIGN): the practice
structure is our fixture plan scaled to the study's duration — the dominant unknown — and sun is bracketed between
overcast and clear sky instead of guessed. A sensitivity sweep on the demo scenario names the parameter that drives any
gap. Nothing is tuned here; the gap is reported.

    python -m validation.field_plausibility    # prints, and writes validation/results.json["field_plausibility"]
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from engine import consts, fixtures
from engine import settings as at_settings
from engine.physio import twonode

RESULTS = Path(__file__).resolve().parents[1] / "validation" / "results.json"
Z95 = 1.645


def _rh_from_wet_bulb(tdb: float, twb: float) -> float:
    """Invert pythermalcomfort.utilities.wet_bulb_tmp (Stull 2011 empirical wet-bulb formula) for RH by bisection."""
    from pythermalcomfort.utilities import wet_bulb_tmp
    lo, hi = 1.0, 100.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if float(wet_bulb_tmp(tdb, mid)) < twb:
            lo = mid
        else:
            hi = mid
    return round(0.5 * (lo + hi), 1)


def _template(duration_min: int, gear: str | None) -> list[dict]:
    """Fixture drill sequence scaled to ``duration_min``; per-athlete gear caps dropped; gear overridden if given."""
    drills = copy.deepcopy(fixtures.plan()["drills"])
    total = sum(d["duration_min"] for d in drills)
    for d in drills:
        d.pop("gear_by_athlete", None)
        d["duration_min"] = max(1, int(round(d["duration_min"] * duration_min / total)))
        if gear is not None and not d["is_break"] and d["gear"] != "none":
            d["gear"] = gear
        elif gear is not None and d["is_break"]:
            d["gear"] = gear
    return drills


def _weather(start: datetime, hours: int, air_c: float, rh: float, cloud: float, wbgt_c: float | None) -> list[dict]:
    wind = float(consts.get("field_plausibility_assumptions.wind_m_s"))
    ph = consts.get("physical")
    out = []
    for k in range(-1, hours + 1):
        h = {"time": (start + timedelta(hours=k)).isoformat(), "air_temp_c": air_c, "rh_pct": rh, "wind_m_s": wind,
             "cloud_cover_pct": cloud, "source": "fixture", "fhsaa_zone": 1,
             "wbgt_f": (wbgt_c * ph["f_per_c"] + ph["f_offset"]) if wbgt_c is not None else 0.0}
        if cloud >= 100.0:
            h["solar_w_m2"] = 0.0
        out.append(h)
    return out


def _nearest_height(mass: float) -> float:
    r = min(fixtures.roster(), key=lambda a: abs(a["mass_kg"] - mass))
    return float(r["height_m"])


def _athlete(aid: str, mass: float, age: float, day: float, position: str) -> dict:
    return {"id": aid, "name": aid, "height_m": _nearest_height(mass), "mass_kg": mass, "age_yr": age, "sex": "male",
            "acclimatization_day": day, "position": position, "hr_rest_bpm": None}


def _peaks(roster, drills, weather, start, lat, lon, settings) -> list[tuple[float, float]]:
    plan = {"id": "field", "site": {"name": "study site", "lat": lat, "lon": lon, "surface": "grass"},
            "start": start.isoformat(), "drills": drills}
    res = twonode.simulate_roster(roster, plan, weather, settings=settings)
    return [(max(a["core_c_p50"]), a["peak_core_c_p95"]) for a in res["athletes"]]


def scenarios(settings=None) -> list[dict]:
    S = settings or at_settings.resolve()
    F = consts.get("field_core_temp_studies")
    A = consts.get("field_plausibility_assumptions")
    date = datetime.fromisoformat(A["date"])
    tz = timezone(timedelta(hours=-4))
    rows = []

    def add(study, group, measured, start, lat, lon, roster, drills, air_c, rh, wbgt_c, note):
        out = {}
        for sky, cloud in (("overcast", 100.0), ("clear", 0.0)):
            w = _weather(start.replace(minute=0), 4, air_c, rh, cloud, wbgt_c)
            out[sky] = _peaks(roster, drills, w, start, lat, lon, S)[0]
        mean, sd = measured["tc_max"]
        rows.append({
            "study": study, "group": group, "measured_peak_mean_c": mean, "measured_peak_sd_c": sd,
            "measured_p95_c": round(mean + Z95 * sd, 2) if sd is not None else None,
            "measured_max_individual_c": measured.get("max_individual"),
            "model_p50_peak_c": {k: round(v[0], 2) for k, v in out.items()},
            "model_p95_peak_c": {k: round(v[1], 2) for k, v in out.items()},
            "p50_minus_measured_mean_c": {k: round(v[0] - mean, 2) for k, v in out.items()},
            "inputs": {"air_temp_c": air_c, "rh_pct": rh, "wbgt_c": wbgt_c}, "note": note,
        })

    g6 = F["godek_2006"]
    rh6 = _rh_from_wet_bulb(g6["am"]["dry_bulb_c"], g6["am"]["wet_bulb_c"])
    lat, lon = A["sites"]["godek_2006"]
    start = datetime.combine(date.date(), datetime.strptime(g6["am"]["start"], "%H:%M").time(), tz)
    drills = _template(g6["duration_min"], g6["am"]["gear"])
    for grp, pos in (("linemen", "OL"), ("backs", "RB")):
        a = _athlete(f"godek06_{grp}", g6[grp]["mass_kg"], 26, g6["preseason_days"][0], pos)
        add("Godek 2006 (NFL, AM full equipment)", grp,
            {"tc_max": g6[grp]["tc_max"], "max_individual": g6[grp]["tc_max_range"][1]},
            start, lat, lon, [a], drills, g6["am"]["dry_bulb_c"], rh6, None,
            f"RH {rh6} % from dry/wet bulb {g6['am']['dry_bulb_c']}/{g6['am']['wet_bulb_c']} °C (highest pair reported); age 26 assumed")

    g4 = F["godek_2004"]
    lat, lon = A["sites"]["godek_2004"]
    start = datetime.combine(date.date(), datetime.strptime(g4["pm"]["start"], "%H:%M").time(), tz)
    a = _athlete("godek04", g4["mass_kg"], 20, g4["preseason_days"][0], "OL")
    add("Fowkes Godek 2004 (Div II, PM full pads)", "all",
        {"tc_max": [g4["tc_group_after_practice_approx"], None], "max_individual": g4["tc_max_individual"]},
        start, lat, lon, [a], _template(g4["pm"]["duration_min"], g4["pm"]["gear"]),
        g4["pm"]["air_temp_c"], g4["pm"]["rh_pct"], None,
        "group value read from a figure (SECONDARY), SD not available; age 20 assumed")

    # WBGT-only studies → compare with the demo practice, whose forecast WBGT (28.3–30 °C) shares their band
    demo = twonode.simulate_roster(fixtures.roster(), fixtures.plan(), fixtures.forecast(), settings=S)
    p50 = [max(a["core_c_p50"]) for a in demo["athletes"]]
    p95 = [a["peak_core_c_p95"] for a in demo["athletes"]]
    for key, label in (("mcclelland_2018", "McClelland 2018 (Div III, WBGT 29.1–31.4 °C)"),
                       ("demartini_nolan_2018", "DeMartini-Nolan 2018 (Div I, WBGT ≈ 28.75 °C)")):
        mean, sd = F[key]["tc_max"]
        rows.append({
            "study": label, "group": "demo roster vs study cohort", "measured_peak_mean_c": mean,
            "measured_peak_sd_c": sd, "measured_p95_c": round(mean + Z95 * sd, 2), "measured_max_individual_c": None,
            "model_p50_peak_c": {"demo_forecast": round(float(np.mean(p50)), 2),
                                 "demo_range": [round(min(p50), 2), round(max(p50), 2)]},
            "model_p95_peak_c": {"demo_forecast": round(float(np.mean(p95)), 2),
                                 "demo_range": [round(min(p95), 2), round(max(p95), 2)]},
            "p50_minus_measured_mean_c": {"demo_forecast": round(float(np.mean(p50)) - mean, 2)},
            "inputs": {"wbgt_c": "demo forecast 28.3–30.0"},
            "note": "matched on WBGT band only: different roster (high school, NATA-phased gear) and practice plan",
        })

    y = F["yeargin_2010"]
    a = _athlete("yeargin10", y["mass_kg"], y["age_yr"], 14, "WR")
    start = datetime(2026, 10, 4, 17, 0, tzinfo=tz)
    evening = [h for h in fixtures.forecast() if h["time"] >= "2026-10-04T16:00"]
    res = twonode.simulate_roster([a], {"id": "yeargin", "site": fixtures.plan()["site"], "start": start.isoformat(),
                                        "drills": _template(y["duration_min"], "full_pads")}, evening, settings=S)
    mean, sd = y["tc_max"]
    pk50, pk95 = max(res["athletes"][0]["core_c_p50"]), res["athletes"][0]["peak_core_c_p95"]
    rows.append({
        "study": "Yeargin 2010 (high school, heat-acclimatized)", "group": "all", "measured_peak_mean_c": mean,
        "measured_peak_sd_c": sd, "measured_p95_c": round(mean + Z95 * sd, 2), "measured_max_individual_c": None,
        "model_p50_peak_c": {"forecast_evening": round(pk50, 2)}, "model_p95_peak_c": {"forecast_evening": round(pk95, 2)},
        "p50_minus_measured_mean_c": {"forecast_evening": round(pk50 - mean, 2)},
        "inputs": {"wbgt_c": "fixture forecast 17:00–19:48, 27.8 → 25.6 °C (study warm days 25 ± 1)"},
        "note": "matched on WBGT band only (Ta/RH not in the paper): Gainesville fixture evening hours; full pads after the "
                "3-day phase-in; fully acclimatized (day 14); slightly warmer than the study",
    })
    return rows


def sensitivity(settings=None) -> list[dict]:
    """Demo practice: change one input at a time; report the shift in team-mean p50 and p95 peak."""
    S = settings or at_settings.resolve()
    roster, plan, weather = fixtures.roster(), fixtures.plan(), fixtures.forecast()

    def team(r=roster, p=plan, w=weather, s=S):
        res = twonode.simulate_roster(r, p, w, settings=s)
        return (float(np.mean([max(a["core_c_p50"]) for a in res["athletes"]])),
                float(np.mean([a["peak_core_c_p95"] for a in res["athletes"]])))

    base = team()
    out = [{"case": "baseline (conservative mode, as planned)", "p50": round(base[0], 2), "p95": round(base[1], 2)}]

    def case(name, **kw):
        v = team(**kw)
        out.append({"case": name, "p50": round(v[0], 2), "p95": round(v[1], 2),
                    "delta_p50": round(v[0] - base[0], 2), "delta_p95": round(v[1] - base[1], 2)})

    lighter = copy.deepcopy(plan)
    for d in lighter["drills"]:
        if not d["is_break"] and d["intensity"] in ("hard", "max"):
            d["intensity"] = "moderate"
    case("hard/max drills at the 'moderate' MET (activity level)", p=lighter)
    shade = copy.deepcopy(plan)
    for d in shade["drills"]:
        d["shade"] = True
    case("all drills in shade (no solar load)", p=shade)
    case("ISO-dynamic clothing (no gear surcharge)", s=S.with_overrides({"clothing_mode": "iso7933_dynamic"}))
    acc = [dict(a, acclimatization_day=14, gear_limit=None) for a in roster]
    case("every athlete fully acclimatized (day 14)", r=acc)
    calm = [dict(a, calib={"met_scale": 1.0, "met_scale_sd": 0.0, "thermo_scale": 1.0, "thermo_scale_sd": 0.0,
                           "n_sessions": 0, "updated_at": ""}) for a in roster]
    case("no ensemble spread (met/thermo SD = 0)", r=calm)
    orig_wc = twonode.walk_credit
    try:
        twonode.walk_credit = lambda mode: 1.0  # sensitivity only
        case("walking-ventilation credit on (owner rule turned it off)")
    finally:
        twonode.walk_credit = orig_wc
    return out


def run() -> dict:
    return {
        "computed_by": "validation/field_plausibility.py",
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": twonode.MODEL_NAME, "synthetic": False,
        "field_summary": consts.get("field_core_temp_studies.summary"),
        "scenarios": scenarios(),
        "sensitivity_demo": sensitivity(),
        "notes": [
            "Practice structure in the studies is not reported; the fixture plan's drill mix (40 min at 'hard' = 8 MET, "
            "12 min at 'max' = 11 MET) is used, scaled to each study's duration (gassers run in the study's gear).",
            "NFL/college acclimatization is set to the camp day (no heat exposure before camp assumed) — pushes the model up ~0.2 °C.",
            "WBGT-only rows run the demo roster and plan, not the study cohorts: McClelland is hotter than the demo (gap understated), "
            "Yeargin's matched evening is warmer than the study days (gap overstated).",
            "The sweep shows sensitivities one at a time; the largest is not proven to be the cause of the gap.",
            "Sun is bracketed (overcast vs clear) because cloud cover is not reported.",
            "Study peaks are group means of individual maxima; the model's p50 is the median peak for the mean participant.",
            "estimate — planning only",
        ],
    }


def main() -> None:
    res = run()
    data = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    data["field_plausibility"] = res
    RESULTS.write_text(json.dumps(data, indent=1) + "\n")
    print("field summary:", res["field_summary"])
    for r in res["scenarios"]:
        print(f"- {r['study']} [{r['group']}]: measured {r['measured_peak_mean_c']} ± {r['measured_peak_sd_c']} "
              f"(p95≈{r['measured_p95_c']}, max {r['measured_max_individual_c']}) | model p50 {r['model_p50_peak_c']} "
              f"p95 {r['model_p95_peak_c']} | Δp50 {r['p50_minus_measured_mean_c']}")
    print("sensitivity (demo, team means):")
    for s in res["sensitivity_demo"]:
        print("  ", s)
    print(f"wrote {RESULTS}")


if __name__ == "__main__":
    main()
