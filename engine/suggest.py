"""Live suggestion: a fast, targeted re-plan for ONE athlete for the rest of the session (overnight item 3).

When a live athlete's calibrated re-forecast crosses the planning line, the engine offers the coach a small change to the
rest of the plan for that athlete only: rest in the shade at the start of a coming block, rotate out of a coming block
(rotated-out athletes rest in the shaded cooling area, constants.non_participant), or a lighter gear level for a block.
At most constants.live_suggest.max_changes changes, at most budget_s of search, warm-started from the best single
change. The plan's length and everyone else's drills are unchanged. Numbers are the engine's p95 estimates; every
sentence passes engine/guard.py. A suggestion is applied only when the coach presses Apply (POST /live/apply).
"""
from __future__ import annotations

from engine import units  # display °F

import copy
import time
from itertools import combinations
from typing import Any, Mapping, Optional, Sequence

from engine import consts, guard
from engine.optimizer import GEAR_DOWN, GEAR_LABEL
from engine.physio import metabolic, twonode


def _cfg(k: str):
    return consts.get(f"live_suggest.{k}")


def _starts(drills: Sequence[Mapping[str, Any]]) -> list[float]:
    out, t = [], 0.0
    for d in drills:
        out.append(t)
        t += float(d["duration_min"])
    return out


def _gear(d: Mapping[str, Any], aid: str) -> str:
    return (d.get("gear_by_athlete") or {}).get(aid, d["gear"])


def candidates(plan: Mapping[str, Any], aid: str, now_min: float, rest_min: int) -> list[tuple[str, str]]:
    """(kind, drill id) for the next lookahead_blocks blocks that start at or after now and include the athlete."""
    drills = plan["drills"]
    out: list[tuple[str, str]] = []
    n = 0
    for d, t in zip(drills, _starts(drills)):
        if t < now_min - 1e-9 or d.get("is_break"):
            continue
        if d.get("participants") is not None and aid not in d["participants"]:
            continue
        n += 1
        if n > int(_cfg("lookahead_blocks")):
            break
        if float(d["duration_min"]) > rest_min:
            out.append(("rest_start", d["id"]))
        out.append(("rotate_out", d["id"]))
        if _gear(d, aid) in GEAR_DOWN:
            out.append(("gear_down", d["id"]))
    return out


def _new_id(drills: Sequence[Mapping[str, Any]], base: str) -> str:
    taken = {d["id"] for d in drills}
    n = 1
    while f"{base}r{n}" in taken:
        n += 1
    return f"{base}r{n}"


def apply_changes(plan: Mapping[str, Any], aid: str, changes: Sequence[tuple[str, str]], roster_ids: Sequence[str],
                  rest_min: int) -> dict[str, Any]:
    p = copy.deepcopy(dict(plan))
    by_id = {d["id"]: d for d in p["drills"]}
    for kind, did in changes:          # gear first: it edits the drill a split then copies
        if kind == "gear_down":
            d = by_id[did]
            d["gear_by_athlete"] = {**(d.get("gear_by_athlete") or {}), aid: GEAR_DOWN[_gear(d, aid)]}
    for kind, did in changes:
        if kind not in ("rotate_out", "rest_start"):
            continue
        i = next(k for k, d in enumerate(p["drills"]) if d["id"] == did)
        d = p["drills"][i]
        others = [x for x in (d.get("participants") or roster_ids) if x != aid]
        if kind == "rotate_out":
            p["drills"][i] = {**d, "participants": others}
        else:
            first = {**d, "id": _new_id(p["drills"], did), "duration_min": rest_min, "participants": others}
            rest = {**d, "duration_min": float(d["duration_min"]) - rest_min}
            p["drills"][i:i + 1] = [first, rest]
    return p


def _phrase(kind: str, d: Mapping[str, Any], aid: str, rest_min: int, shade: bool) -> str:
    """Wording follows the AT setting for where rotated-out athletes rest (settings.non_participant_shade)."""
    if kind == "rest_start":
        return f"rest {'in the shade ' if shade else ''}for the first {rest_min} min of '{d['name']}'"
    if kind == "rotate_out":
        return f"rotate out of '{d['name']}' ({'rest in the shaded cooling area' if shade else 'rest out of the drill'})"
    return f"{GEAR_LABEL[GEAR_DOWN[_gear(d, aid)]]} for '{d['name']}'"


def _load_lost(plan: Mapping[str, Any], changes: Sequence[tuple[str, str]], rest_min: int) -> float:
    rest_met = metabolic.intensity_met(consts.get("non_participant.intensity"))
    by_id = {d["id"]: d for d in plan["drills"]}
    lost = 0.0
    for kind, did in changes:
        d = by_id[did]
        minutes = float(d["duration_min"]) if kind == "rotate_out" else rest_min if kind == "rest_start" else 0.0
        lost += max(metabolic.drill_met(d) - rest_met, 0.0) * minutes
    return lost


def suggest(plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]], weather: Sequence[Mapping[str, Any]],
            aid: str, now_min: float, *, settings=None, seed: int = 0,
            before: Optional[Mapping[str, Any]] = None) -> Optional[dict[str, Any]]:
    """Best ≤ max_changes edit for athlete ``aid`` (calibrated roster entry inside ``roster``) or None if no block
    is left to change. ``before`` = that athlete's entry from the current re-forecast (for the before numbers)."""
    t0 = time.perf_counter()
    rest_min = int(consts.get(str(_cfg("rest_block_from"))))
    ath = next(a for a in roster if a["id"] == aid)
    ids = [a["id"] for a in roster]
    cands = candidates(plan, aid, now_min, rest_min)
    if not cands:
        return None

    def run(p: Mapping[str, Any]) -> dict[str, Any]:
        r = twonode.simulate_roster([ath], p, weather, seed=seed, settings=settings)
        return {**r["athletes"][0], "limit": r["limit_core_c"]}

    base = run(plan)                                  # (pays any one-off JIT compile before the budget starts)
    deadline = time.perf_counter() + float(_cfg("budget_s"))
    limit = base["limit"]
    tried: list[dict[str, Any]] = []

    def evaluate(ch: tuple[tuple[str, str], ...]) -> None:
        r = run(apply_changes(plan, aid, ch, ids, rest_min))
        tried.append({"changes": ch, "peak": r["peak_core_c_p95"], "first_cross_min": r.get("first_cross_min"),
                      "under": r["peak_core_c_p95"] < limit, "load_lost": _load_lost(plan, ch, rest_min)})

    for c in cands:                                   # every single change
        if time.perf_counter() > deadline:
            break
        evaluate((c,))
    singles = sorted(tried, key=lambda x: x["peak"])
    if int(_cfg("max_changes")) >= 2:                 # warm start: pair the best singles with every other single
        seeds = [s["changes"][0] for s in singles[:4]]
        for a, b in combinations(cands, 2):
            if time.perf_counter() > deadline:
                break
            if a not in seeds and b not in seeds:
                continue
            if a[1] == b[1] and {a[0], b[0]} != {"rest_start", "gear_down"}:
                continue                              # one structural change per block (gear can join a rest)
            evaluate((a, b))
    if not tried:
        return None
    # The quick search simulates the athlete alone; the app shows the whole-roster re-forecast, whose ensemble draws
    # differ slightly. Confirm candidates (best first) with the whole roster and report THAT re-forecast, so the
    # numbers on the card are the numbers the app shows after Apply.
    ranked = sorted(tried, key=lambda t: (not t["under"], t["load_lost"] if t["under"] else t["peak"],
                                          len(t["changes"]), t["peak"]))
    best = None
    for t in ranked:
        if best is not None and time.perf_counter() > deadline:
            break
        r = twonode.simulate_roster(roster, apply_changes(plan, aid, t["changes"], ids, rest_min), weather, seed=seed,
                                    settings=settings)
        a = next(x for x in r["athletes"] if x["id"] == aid)
        t = {**t, "peak": a["peak_core_c_p95"], "first_cross_min": a.get("first_cross_min"),
             "under": a["peak_core_c_p95"] < limit}
        if best is None or (t["under"] and not best["under"]) or (t["under"] == best["under"] and not t["under"]
                                                                  and t["peak"] < best["peak"]):
            best = t
        if best["under"]:
            break
    b_peak0 = (before or {}).get("peak_core_c_p95", base["peak_core_c_p95"])
    if best is None or best["peak"] >= b_peak0 - 1e-9:
        return None                                   # nothing helps: say nothing rather than suggest a no-op
    new_plan = apply_changes(plan, aid, best["changes"], ids, rest_min)
    by_id = {d["id"]: d for d in plan["drills"]}
    if settings is None:
        from engine import settings as at_settings
        settings = at_settings.resolve()
    phrases = [_phrase(k, by_id[d], aid, rest_min, bool(settings.non_participant_shade)) for k, d in best["changes"]]
    b_peak = (before or {}).get("peak_core_c_p95", base["peak_core_c_p95"])
    name = str(ath.get("name", aid)).replace(" (fictional)", "")
    outcome = ("under the planning line" if best["under"] else
               f"still over the planning line from minute {best['first_cross_min']:g}" if best["first_cross_min"] is not None
               else "still over the planning line")
    # HR-calibrated: both numbers use this athlete's heart-rate calibration (the plan view after Apply, on an HR replay
    # recorded on another plan, shows the plan forecast without it — demo-qa F1)
    result = (f"HR-calibrated re-forecast peak {units.f(b_peak)} → {units.f(best['peak'])} °F (p95), {outcome}. "
              "Estimate — planning only.")
    text = f"Suggested for {name}, rest of session: {'; '.join(phrases)}. {result}"
    g = guard.check(text, source="live_suggestion")
    go = guard.check(result, source="live_suggestion")
    return {
        "athlete_id": aid,
        "changes": [{"kind": k, "drill_id": d, "detail": guard.check(p, source="live_suggestion")["redacted_text"]}
                    for (k, d), p in zip(best["changes"], phrases)],
        "text": g["redacted_text"], "outcome": go["redacted_text"], "guard_ok": g["ok"] and go["ok"],
        "before": {"peak_core_c_p95": round(float(b_peak), 2),
                   "first_cross_min": (before or {}).get("first_cross_min", base.get("first_cross_min"))},
        "after": {"peak_core_c_p95": round(float(best["peak"]), 2), "first_cross_min": best["first_cross_min"],
                  "under_line": best["under"]},
        "plan": new_plan,
        "searched": len(tried), "elapsed_s": round(time.perf_counter() - t0, 3),
        "labels": ["live suggestion — the coach decides; estimate — planning only",
                   f"searched {len(tried)} options in {time.perf_counter() - t0:.2f} s (≤ {_cfg('max_changes')} changes)"],
    }
