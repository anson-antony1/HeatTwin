"""WS4 — practice-plan optimizer.

Given a plan, roster and weather, find a plan that
  * has zero FHSAA violations (engine/fhsaa.py, or the local stub until WS1 lands),
  * keeps every athlete's p95 estimated core temperature below constants.planning_limit_core_c,
  * keeps priority-1 drills at ≥ optimizer.p1_min_kept_fraction of their minutes,
  * leaves non-movable drills in place (every original drill before/after them stays before/after them),
  * grows the practice by at most optimizer.max_added_minutes,
and maximizes Σ MET × minutes × priority weight × participating fraction, tie-breaking on fewest changes.

Moves: reorder movable drills · insert a shaded break · lengthen a break · downgrade gear · trim priority-2/3
(and ≤ 10 % of priority-1) drills · split a drill around a break · rotate the at-risk subgroup out of a block
(``participants``) · plus inverse moves (remove an added break, restore an attribute).

Search: beam search over targeted moves (warm start) → simulated annealing over all moves, with a plan-hash
cache, common random numbers for the ensemble, and a time budget. Results are deterministic for a given seed and
iteration cap; the time budget is a safety stop (``search.stopped_by`` says which limit ended the search).

Every output is an estimate for planning only.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, replace
from datetime import timedelta
from typing import Any, Mapping, Sequence

import numpy as np

from engine import consts, fhsaa_adapter, gear_rules
from engine.physio import clothing, metabolic, twonode

GEAR_DOWN = {"full_pads": "helmet_shoulder_pads", "helmet_shoulder_pads": "helmet", "helmet": "none"}
GEAR_LABEL = {"none": "no pads", "helmet": "helmet only", "helmet_shoulder_pads": "helmet + shoulder pads",
              "full_pads": "full pads"}


# ─────────────────────────────────────────────────────────────────────────────
# Plan representation
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Seg:
    id: str
    src: str | None          # original drill id; None for an added break
    part: int                # 1-based part number for split drills (1 = unsplit or first part)
    name: str
    duration: int
    intensity: str
    met_override: float | None
    gear: str
    shade: bool
    is_break: bool
    priority: int
    movable: bool
    participants: tuple[str, ...] | None
    gear_by: tuple[tuple[str, str], ...] | None = None   # per-athlete gear (CONTRACTS v1.1 gear_by_athlete)

    def gear_of(self, athlete_id: str) -> str:
        return dict(self.gear_by or ()).get(athlete_id, self.gear)

    @staticmethod
    def from_drill(d: Mapping[str, Any]) -> "Seg":
        p = d.get("participants")
        return Seg(id=d["id"], src=d["id"], part=1, name=d["name"], duration=int(round(float(d["duration_min"]))),
                   intensity=d["intensity"], met_override=d.get("met_override"), gear=d["gear"],
                   shade=bool(d.get("shade", False)), is_break=bool(d.get("is_break", False)),
                   priority=int(d.get("priority", 2)), movable=bool(d.get("movable", True)),
                   participants=tuple(sorted(p)) if p is not None else None,
                   gear_by=tuple(sorted((d.get("gear_by_athlete") or {}).items())) or None)

    def to_drill(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "name": self.name, "duration_min": self.duration,
                             "intensity": self.intensity, "gear": self.gear, "shade": self.shade,
                             "is_break": self.is_break, "priority": self.priority, "movable": self.movable}
        if self.met_override is not None:
            d["met_override"] = self.met_override
        if self.participants is not None:
            d["participants"] = list(self.participants)
        if self.gear_by:
            d["gear_by_athlete"] = dict(self.gear_by)
        return d


State = tuple  # tuple[Seg, ...]


def _opt(key: str):
    return consts.get(f"optimizer.{key}")


# ─────────────────────────────────────────────────────────────────────────────
# Evaluation
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Eval:
    state: State
    feasible: bool
    infeas: float
    violations: list[dict[str, str]]
    peak_p95: np.ndarray        # [N]
    first_cross_step: np.ndarray  # [N], -1 if none
    load_w: float
    n_changes: int
    energy: float
    at_risk: tuple[str, ...]

    added_min: int = 0

    def rank(self) -> tuple:
        """Lexicographic: feasible first, least infeasibility, most load, fewest changes, fewest added minutes."""
        return (0 if self.feasible else 1, round(self.infeas, 6), -round(self.load_w, 6), self.n_changes, self.added_min)


class Problem:
    """Everything fixed during one optimization: roster arrays, ensemble draws, weather on the step grid."""

    def __init__(self, plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]],
                 weather: Sequence[Mapping[str, Any]], *, n_ensemble: int = 30, seed: int = 0, step_min: float = 1.0,
                 settings=None):
        from engine import settings as at_settings
        self.S = settings or at_settings.resolve()
        self.plan = plan
        self.roster = list(roster)
        self.weather = list(weather)
        self.step_min = step_min
        self.t0 = twonode.parse_time(plan["start"])
        self.R = twonode.build_roster(self.roster)
        self.D = twonode.make_draws(n_ensemble, len(self.R.ids), seed)
        self.orig: State = tuple(Seg.from_drill(d) for d in plan["drills"])
        self.orig_by_src = {s.src: s for s in self.orig}
        self.orig_index = {s.src: i for i, s in enumerate(self.orig)}
        self.orig_total = sum(s.duration for s in self.orig)
        self.max_total = self.orig_total + int(self.S.max_added_minutes)
        self.env = twonode.build_environment(self.weather, plan["site"], self.t0, step_min,
                                             int(math.ceil(self.max_total / step_min)))
        self.limit = self.S.planning_limit_core_c
        self.near = self.S.near_limit_margin_c
        self.weights = self.S.weights()
        self.p1_frac = self.S.p1_min_kept_fraction
        self.fixed_before = {s.src: {o.src for o in self.orig[:i]} for i, s in enumerate(self.orig) if not s.movable}
        self.break_min = self._break_min()
        self.cache: dict[int, Eval] = {}
        self.evaluations = 0
        self.cache_hits = 0
        self.added = 0
        self.load0 = max(self.weighted_load(self.orig), 1e-9)

    def _break_min(self) -> int:
        zs = [int(z["break_min"]) for z in consts.get("fhsaa_wbgt_zones.zones") if z.get("break_min")]
        return max(zs) if zs else int(_opt("lengthen_step_min"))

    # ── constraint helpers ──
    def fixed_ok(self, st: State) -> bool:
        """Every part of every original drill stays on the same side of each non-movable drill."""
        present = {s.src for s in st if s.src is not None}
        srcs = [s.src for s in st]
        for i, s in enumerate(st):
            if s.src is not None and s.src in self.fixed_before:
                before = {x for x in srcs[:i] if x is not None}
                after = {x for x in srcs[i + 1:] if x is not None}
                want = self.fixed_before[s.src] & present
                if before != want or (after & want):
                    return False
        return True

    def structure_ok(self, st: State) -> bool:
        """Split parts keep their order; no two breaks back to back (lengthen instead)."""
        last_part: dict[str, int] = {}
        for a, b in zip(st, st[1:]):
            if a.is_break and b.is_break:
                return False
        mp = int(_opt("min_split_part_min"))
        counts: dict[str, int] = {}
        for s in st:
            if s.src is not None:
                if s.part <= last_part.get(s.src, 0):
                    return False
                last_part[s.src] = s.part
                counts[s.src] = counts.get(s.src, 0) + 1
        return all(s.duration >= mp for s in st if s.src is not None and counts[s.src] > 1 and not s.is_break)

    def gear_ok(self, st: State) -> bool:
        """Downgrades never go below the intensity's gear floor (the coach's own original gear is always allowed)."""
        floor = self.S.gear_floor()
        order = clothing.GEAR_LEVELS
        for s in st:
            if s.is_break or s.intensity not in floor or s.src is None:
                continue
            if s.gear != self.orig_by_src[s.src].gear and order.index(s.gear) < order.index(floor[s.intensity]):
                return False
        return True

    def total(self, st: State) -> int:
        return sum(s.duration for s in st)

    def src_minutes(self, st: State, src: str) -> int:
        return sum(s.duration for s in st if s.src == src)

    def p1_min(self, src: str) -> int:
        return int(math.ceil(self.p1_frac * self.orig_by_src[src].duration - 1e-9))

    def valid(self, st: State) -> bool:
        if not st or self.total(st) > self.max_total or not self.fixed_ok(st):
            return False
        if not self.structure_ok(st) or not self.gear_ok(st):
            return False
        for src, o in self.orig_by_src.items():
            if o.priority == 1 and not o.is_break and self.src_minutes(st, src) < self.p1_min(src):
                return False
        return all(s.duration > 0 for s in st)

    # ── objective ──
    def met_of(self, s: Seg) -> float:
        return metabolic.drill_met({"intensity": s.intensity, "met_override": s.met_override})

    def weighted_load(self, st: State) -> float:
        n = len(self.R.ids)
        tot = 0.0
        for s in st:
            if s.is_break:
                continue
            frac = 1.0 if s.participants is None else len(s.participants) / n
            tot += self.met_of(s) * s.duration * self.weights[s.priority] * frac
        return tot

    def to_plan(self, st: State) -> dict[str, Any]:
        p = {k: v for k, v in self.plan.items() if k != "drills"}
        p["drills"] = [s.to_drill() for s in st]
        return p

    def evaluate(self, st: State) -> Eval:
        key = hash(st)
        if key in self.cache:
            self.cache_hits += 1
            return self.cache[key]
        self.evaluations += 1
        plan = self.to_plan(st)
        viol = fhsaa_adapter.violations(plan, self.weather, self.roster if self.S.enforce_nata_gear_phasing else None)
        tl = twonode.build_timeline(plan["drills"], self.R.ids, self.step_min, rest_shade=self.S.non_participant_shade)
        core = twonode.simulate_arrays(tl, self.env, self.R, self.D, clothing_mode=self.S.clothing_mode).core
        p95 = np.round(np.percentile(core, 95.0, axis=0), 3)        # [N, T] — same rounding as SimulationResult
        peak = p95.max(axis=1)
        over = p95 >= self.limit
        first = np.where(over.any(axis=1), over.argmax(axis=1), -1)
        excess = float(np.sum(np.maximum(peak - self.limit, 0.0) + (peak >= self.limit) * 1e-3))
        infeas = self.fhsaa_infeasibility(plan, viol) + excess / float(_opt("heat_excess_per_unit_c"))
        load = self.weighted_load(st)
        n_ch = len(diff(self, st))
        energy = (float(_opt("infeasibility_weight")) * infeas - 100.0 * load / self.load0
                  + float(_opt("change_penalty")) * n_ch)
        at_risk = tuple(a for a, pk in zip(self.R.ids, peak) if pk >= self.limit - self.near)
        ev = Eval(st, infeas == 0.0, infeas, viol, peak, first, load, n_ch, energy, at_risk,
                  added_min=max(self.total(st) - self.orig_total, 0))
        self.cache[key] = ev
        return ev

    def fhsaa_infeasibility(self, plan: Mapping[str, Any], viol: list[dict[str, str]]) -> float:
        """1 per violation, except break-per-hour shortfalls, which count by missing minutes (in units of one
        required break) so that each added break minute is visible progress."""
        rb = fhsaa_adapter.required_breaks
        n_other = sum(1 for v in viol if "breaks_per_hour" not in v["rule"])
        n_breaks = len(viol) - n_other
        if rb is None or n_breaks == 0:
            return float(len(viol))
        deficit = 0.0
        for b in rb(plan, self.weather):
            if b.get("zone", 1) < 5 and b["break_min"] < b["required_min"]:
                deficit += (b["required_min"] - b["break_min"]) / max(self.break_min, 1)
        return n_other + max(deficit, 1e-3 * n_breaks)

    def new_break(self, after: Seg | None, minutes: int) -> Seg:
        self.added += 1
        gear = after.gear if (after is not None and _opt("inserted_break_gear") == "same_as_previous") else "none"
        gear_by = after.gear_by if (after is not None and gear == after.gear) else None
        return Seg(id=f"ib{self.added}", src=None, part=1, name="Water break (shade, added)", duration=minutes,
                   intensity="rest", met_override=None, gear=gear, shade=True, is_break=True, priority=1,
                   movable=True, participants=None, gear_by=gear_by)


# ─────────────────────────────────────────────────────────────────────────────
# Moves
# ─────────────────────────────────────────────────────────────────────────────

def _replace_at(st: State, i: int, seg: Seg | None) -> State:
    return st[:i] + ((seg,) if seg is not None else ()) + st[i + 1:]


def mv_reorder(P: Problem, st: State, i: int, j: int) -> State | None:
    s = st[i]
    if not s.movable or i == j:
        return None
    rest = st[:i] + st[i + 1:]
    j = max(1 if not st[0].movable else 0, min(j, len(rest)))
    return rest[:j] + (s,) + rest[j:]


def mv_insert_break(P: Problem, st: State, k: int) -> State | None:
    if k <= 0 or k > len(st):
        return None
    if st[k - 1].is_break or (k < len(st) and st[k].is_break):
        return None
    return st[:k] + (P.new_break(st[k - 1], P.break_min),) + st[k:]


def mv_lengthen_break(P: Problem, st: State, i: int) -> State | None:
    s = st[i]
    if not s.is_break:
        return None
    return _replace_at(st, i, replace(s, duration=s.duration + int(_opt("lengthen_step_min"))))


def mv_gear_down(P: Problem, st: State, i: int) -> State | None:
    s = st[i]
    if s.gear not in GEAR_DOWN:
        return None
    new = GEAR_DOWN[s.gear]
    order = clothing.GEAR_LEVELS
    per = tuple((a, g) for a, g in (s.gear_by or ()) if order.index(g) < order.index(new)) or None
    return _replace_at(st, i, replace(s, gear=new, gear_by=per))


def mv_phase_gear_all(P: Problem, st: State) -> State | None:
    """Apply per-athlete NATA gear caps to every drill at once (one coaching instruction)."""
    out = st
    for i in range(len(st)):
        out = mv_phase_gear(P, out, i) or out
    return out if out != st else None


def mv_phase_gear(P: Problem, st: State, i: int) -> State | None:
    """Cap each athlete's gear in drill i at their NATA acclimatization limit (per-athlete gear)."""
    s = st[i]
    per = gear_rules.capped_gear_by_athlete(s.to_drill(), P.roster)
    new = tuple(sorted(per.items())) or None
    if new == s.gear_by:
        return None
    return _replace_at(st, i, replace(s, gear_by=new))


def mv_trim(P: Problem, st: State, i: int, step: int | None = None) -> State | None:
    s = st[i]
    if s.is_break or s.src is None:
        return None
    step = step or int(_opt("trim_step_min"))
    if s.priority == 1:
        others = P.src_minutes(st, s.src) - s.duration
        floor = max(P.p1_min(s.src) - others, 1)
        new = max(s.duration - step, floor)
        if new >= s.duration:
            return None
        return _replace_at(st, i, replace(s, duration=new))
    new = s.duration - step
    return _replace_at(st, i, replace(s, duration=new) if new > 0 else None)


def mv_split(P: Problem, st: State, i: int, at: int | None = None) -> State | None:
    s = st[i]
    mp = int(_opt("min_split_part_min"))
    if s.is_break or not s.movable or s.duration < 2 * mp:
        return None
    at = at if at is not None else s.duration // 2
    at = max(mp, min(at, s.duration - mp))
    n_parts = sum(1 for x in st if x.src == s.src)
    a = replace(s, duration=at)
    b = replace(s, duration=s.duration - at, id=f"{s.src}.{n_parts + 1}", part=n_parts + 1,
                name=f"{P.orig_by_src[s.src].name} (part {n_parts + 1})")
    return st[:i] + (a, P.new_break(a, P.break_min), b) + st[i + 1:]


def mv_rotate_out(P: Problem, st: State, i: int, out_ids: Sequence[str]) -> State | None:
    """Rotate ``out_ids`` out of drill i (they rest in the shaded cooling area, constants.non_participant)."""
    s = st[i]
    if s.is_break or not out_ids:
        return None
    current = set(s.participants) if s.participants is not None else set(P.R.ids)
    keep = current - set(out_ids)
    if keep == current or not keep:
        return None
    return _replace_at(st, i, replace(s, participants=tuple(sorted(keep))))


def hottest(P: Problem, ev: Eval, k: int) -> list[str]:
    """The k athletes with the highest peak p95 in ``ev`` (at-risk first)."""
    order = np.argsort(-ev.peak_p95, kind="stable")
    return [P.R.ids[j] for j in order[:k]]


def mv_platoon(P: Problem, st: State, i: int, ev: Eval) -> State | None:
    """Split drill i in two halves run by alternating platoons (hottest athletes spread across both); the other
    platoon rests in the shaded cooling area. Each athlete does about half the drill's minutes."""
    s = st[i]
    mp = int(_opt("min_split_part_min"))
    if s.is_break or not s.movable or s.duration < 2 * mp or s.participants is not None:
        return None
    order = hottest(P, ev, len(P.R.ids))
    a_ids, b_ids = tuple(sorted(order[0::2])), tuple(sorted(order[1::2]))
    n_parts = sum(1 for x in st if x.src == s.src)
    half = s.duration // 2
    a = replace(s, duration=half, participants=a_ids, name=f"{P.orig_by_src[s.src].name} (platoon A)")
    b = replace(s, duration=s.duration - half, participants=b_ids, id=f"{s.src}.{n_parts + 1}", part=n_parts + 1,
                name=f"{P.orig_by_src[s.src].name} (platoon B)")
    return st[:i] + (a, b) + st[i + 1:]


def mv_remove_added_break(P: Problem, st: State, i: int) -> State | None:
    return _replace_at(st, i, None) if st[i].src is None else None


def mv_restore(P: Problem, st: State, i: int, attr: str) -> State | None:
    s = st[i]
    if s.src is None:
        return None
    o = P.orig_by_src[s.src]
    if attr == "duration" and s.part == 1 and sum(1 for x in st if x.src == s.src) == 1 and s.duration != o.duration:
        return _replace_at(st, i, replace(s, duration=o.duration))
    if attr in ("gear", "participants") and getattr(s, attr) != getattr(o, attr):
        return _replace_at(st, i, replace(s, **{attr: getattr(o, attr)}))
    return None


def mv_untrim(P: Problem, st: State, i: int, step: int) -> State | None:
    """Give back minutes to a trimmed drill (never above its original total)."""
    s = st[i]
    if s.src is None or s.is_break:
        return None
    room = P.orig_by_src[s.src].duration - P.src_minutes(st, s.src)
    if room <= 0:
        return None
    return _replace_at(st, i, replace(s, duration=s.duration + min(step, room)))


def mv_gear_up(P: Problem, st: State, i: int) -> State | None:
    s = st[i]
    up = {v: k for k, v in GEAR_DOWN.items()}
    if s.src is None or s.gear == P.orig_by_src[s.src].gear or s.gear not in up:
        return None
    return _replace_at(st, i, replace(s, gear=up[s.gear]))


def mv_shorten_break(P: Problem, st: State, i: int) -> State | None:
    s = st[i]
    if not s.is_break:
        return None
    floor = P.break_min if s.src is None else P.orig_by_src[s.src].duration
    new = s.duration - int(_opt("lengthen_step_min"))
    if new < floor:
        return None
    return _replace_at(st, i, replace(s, duration=new))


def random_move(P: Problem, st: State, ev: Eval, rng: random.Random) -> State | None:
    n = len(st)
    kind = rng.choices(
        ["reorder", "insert", "lengthen", "gear", "trim", "split", "rotate", "platoon", "remove", "untrim",
         "gear_up", "shorten", "restore"],
        weights=[3, 3, 2, 2, 2, 1, 2, 2, 1, 2, 1, 1, 1])[0]
    i = rng.randrange(n)
    if kind == "reorder":
        return mv_reorder(P, st, i, rng.randrange(n))
    if kind == "insert":
        return mv_insert_break(P, st, rng.randrange(1, n + 1))
    if kind == "lengthen":
        return mv_lengthen_break(P, st, i)
    if kind == "gear":
        return mv_gear_down(P, st, i)
    if kind == "trim":
        return mv_trim(P, st, i, rng.choice([int(_opt("trim_step_min")), max(1, st[i].duration // 2), st[i].duration]))
    if kind == "split":
        mp = int(_opt("min_split_part_min"))
        return mv_split(P, st, i, rng.randint(mp, max(mp, st[i].duration - mp)))
    if kind == "rotate":
        return mv_rotate_out(P, st, i, hottest(P, ev, rng.randint(1, max(1, len(P.R.ids) // 2))))
    if kind == "platoon":
        return mv_platoon(P, st, i, ev)
    if kind == "remove":
        return mv_remove_added_break(P, st, i)
    if kind == "untrim":
        return mv_untrim(P, st, i, rng.choice([1, int(_opt("trim_step_min"))]))
    if kind == "gear_up":
        return mv_gear_up(P, st, i)
    if kind == "shorten":
        return mv_shorten_break(P, st, i)
    return mv_restore(P, st, i, rng.choice(["duration", "gear", "participants"]))


def targeted_moves(P: Problem, st: State, ev: Eval) -> list[State]:
    """Candidate fixes aimed at the current problems (beam-search expansion), cheapest in load first:
    FHSAA fixes → load-free heat fixes (reorder, added break, gear) → load-losing fixes (split, platoon, rotate, trim)."""
    fix: list[State | None] = []
    free: list[State | None] = []
    lossy: list[State | None] = []
    starts = np.cumsum([0] + [s.duration for s in st])
    for v in ev.violations:
        rule = v["rule"]
        if "breaks_per_hour" in rule:
            fix += [mv_insert_break(P, st, k) for k in range(1, len(st) + 1)]
            fix += [mv_lengthen_break(P, st, i) for i, s in enumerate(st) if s.is_break]
        elif rule == gear_rules.RULE:
            fix += [mv_phase_gear(P, st, i) for i, s in enumerate(st) if s.id == v["drill_id"]]
            fix.append(mv_phase_gear_all(P, st))
        elif rule.endswith("_gear") or "protective_gear" in rule:
            fix += [mv_gear_down(P, st, i) for i, s in enumerate(st) if s.id == v["drill_id"]]
        elif "conditioning" in rule or "max_duration" in rule:
            for i, s in enumerate(st):
                if s.priority >= 2 and not s.is_break:
                    fix += [mv_trim(P, st, i, s.duration), mv_trim(P, st, i)]
                if s.src is None:
                    fix.append(mv_remove_added_break(P, st, i))
    if (ev.first_cross_step >= 0).any():
        k = int(ev.first_cross_step[ev.first_cross_step >= 0].min())
        j = int(np.searchsorted(starts, k * P.step_min, side="right") - 1)
        j = min(j, len(st) - 1)
        before = [i for i in range(0, j + 1) if not st[i].is_break]
        for i, s in enumerate(st):
            if s.movable:
                free += [mv_reorder(P, st, i, t) for t in range(len(st))]
        for i in before:
            free += [mv_insert_break(P, st, i), mv_insert_break(P, st, i + 1), mv_gear_down(P, st, i)]
        free += [mv_lengthen_break(P, st, i) for i, s in enumerate(st[: j + 1]) if s.is_break]
        n_ath = len(P.R.ids)
        for i in sorted(before, key=lambda i: -P.met_of(st[i]))[:3]:
            lossy += [mv_split(P, st, i), mv_trim(P, st, i) if st[i].priority >= 2 else None]
        for i, s in enumerate(st):
            if not s.is_break and P.met_of(s) >= metabolic.intensity_met("hard"):
                lossy.append(mv_platoon(P, st, i, ev))
        for k_out in sorted({max(1, len(ev.at_risk) // 2), max(1, n_ath // 4), max(1, n_ath // 2)}):
            lossy.append(mv_rotate_out(P, st, j, hottest(P, ev, k_out)))
    out, seen = [], set()
    for c in fix + free + lossy:
        if c is not None and c not in seen and P.valid(c):
            seen.add(c)
            out.append(c)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Diff → human-readable changes
# ─────────────────────────────────────────────────────────────────────────────

def _lis_keep(seq: list[int]) -> set[int]:
    """Indices (into seq) of one longest increasing subsequence."""
    import bisect
    tails, tails_idx, prev = [], [], [-1] * len(seq)
    for i, x in enumerate(seq):
        k = bisect.bisect_left(tails, x)
        if k == len(tails):
            tails.append(x)
            tails_idx.append(i)
        else:
            tails[k] = x
            tails_idx[k] = i
        prev[i] = tails_idx[k - 1] if k else -1
    keep, i = set(), (tails_idx[-1] if tails_idx else -1)
    while i >= 0:
        keep.add(i)
        i = prev[i]
    return keep


def diff(P: Problem, st: State, with_times: bool = False) -> list[dict[str, str]]:
    """Changes from the original plan. ``kind`` stays within CONTRACTS.md; ``move`` gives the finer type."""
    ch: list[dict[str, str]] = []
    starts = {}
    if with_times:
        t = P.t0
        for s in st:
            starts[s.id] = t
            t += timedelta(minutes=s.duration)
        t = P.t0
        orig_starts = {}
        for s in P.orig:
            orig_starts[s.src] = t
            t += timedelta(minutes=s.duration)
    hhmm = lambda t: t.strftime("%H:%M")  # noqa: E731

    firsts = [s for s in st if s.src is not None and s.part == 1]
    seq = [P.orig_index[s.src] for s in firsts]
    keep = _lis_keep(seq)
    for k, s in enumerate(firsts):
        if k not in keep:
            d = f"Moved '{s.name}'"
            if with_times:
                d += f" to {hhmm(starts[s.id])} (was {hhmm(orig_starts[s.src])})"
            ch.append({"kind": "reorder", "move": "reorder", "drill_id": s.src, "detail": d})

    for src, o in P.orig_by_src.items():
        parts = [s for s in st if s.src == src]
        if not parts:
            ch.append({"kind": "trim", "move": "remove", "drill_id": src,
                       "detail": f"Removed '{o.name}' ({o.duration} min, priority {o.priority})"})
            continue
        mins = sum(p.duration for p in parts)
        base = set(o.participants) if o.participants is not None else set(P.R.ids)
        groups = [set(p.participants) if p.participants is not None else set(base) for p in parts]
        platoon = (len(parts) > 1 and all(p.participants is not None for p in parts)
                   and sum(len(g) for g in groups) == len(set().union(*groups)) and set().union(*groups) == base)
        if platoon:
            ch.append({"kind": "trim", "move": "platoon", "drill_id": src,
                       "detail": f"Ran '{o.name}' in {len(parts)} platoons ("
                                 + ", ".join(f"{len(g)} athletes × {p.duration} min" for g, p in zip(groups, parts))
                                 + "); the resting platoon waits in the shaded cooling area"})
        elif len(parts) > 1:
            idx = [st.index(p) for p in parts]
            around = any(any(x.is_break for x in st[a + 1:b]) for a, b in zip(idx, idx[1:]))
            ch.append({"kind": "insert_break", "move": "split", "drill_id": src,
                       "detail": f"Split '{o.name}' into {len(parts)} parts"
                                 + (" around shaded breaks" if around else "")
                                 + f" ({' + '.join(str(p.duration) for p in parts)} min)"})
        if mins != o.duration:
            if o.is_break and mins > o.duration:
                ch.append({"kind": "insert_break", "move": "lengthen_break", "drill_id": src,
                           "detail": f"Lengthened '{o.name}' from {o.duration} to {mins} min"})
            else:
                ch.append({"kind": "trim", "move": "trim", "drill_id": src,
                           "detail": f"Trimmed '{o.name}' from {o.duration} to {mins} min"})
        gears = {p.gear for p in parts}
        if gears != {o.gear}:
            new = " / ".join(GEAR_LABEL[g] for g in sorted(gears, key=clothing.GEAR_LEVELS.index))
            ch.append({"kind": "gear_change", "move": "gear_down", "drill_id": src,
                       "detail": f"'{o.name}': {GEAR_LABEL[o.gear]} → {new}"})
        per_new = {a: g for p in parts for a, g in (p.gear_by or ())}
        per_old = dict(o.gear_by or ())
        if per_new != per_old:
            changed = {a: g for a, g in per_new.items() if per_old.get(a) != g}
            if changed:
                by_gear: dict[str, list[str]] = {}
                for a, g in changed.items():
                    by_gear.setdefault(g, []).append(P.R.names[P.R.ids.index(a)])
                ch.append({"kind": "gear_change", "move": "gear_per_athlete", "drill_id": src,
                           "detail": f"'{o.name}': per-athlete gear to meet NATA acclimatization phasing — "
                                     + "; ".join(f"{GEAR_LABEL[g]}: {', '.join(sorted(n))}" for g, n in by_gear.items())})
        if any(p.shade != o.shade for p in parts):
            ch.append({"kind": "shade", "move": "shade", "drill_id": src, "detail": f"'{o.name}' moved to shade"})
        if not platoon and any(g != base for g in groups):
            nm = lambda ids: ", ".join(P.R.names[P.R.ids.index(a)] for a in sorted(ids))  # noqa: E731
            if len(parts) == 1:
                out = base - groups[0]
                detail = f"Rotated {len(out)} athlete(s) out of '{o.name}' to the shaded cooling area: {nm(out)}"
            else:
                sizes = ", ".join(f"part {k + 1}: {len(g)} athletes × {p.duration} min" for k, (g, p) in enumerate(zip(groups, parts)))
                never = base - set().union(*groups)
                detail = (f"Ran '{o.name}' with rotating groups ({sizes}); athletes not in a part rest in the shaded "
                          f"cooling area" + (f"; sitting out the whole drill: {nm(never)}" if never else ""))
            ch.append({"kind": "trim", "move": "rotate_out", "drill_id": src, "detail": detail})
    for s in st:
        if s.src is None:
            prev = st[st.index(s) - 1].name if st.index(s) > 0 else "start"
            d = f"Added a {s.duration}-min shaded water break after '{prev}'"
            if with_times:
                d += f" at {hhmm(starts[s.id])}"
            ch.append({"kind": "insert_break", "move": "insert_break", "drill_id": s.id, "detail": d})
    return ch


# ─────────────────────────────────────────────────────────────────────────────
# Search
# ─────────────────────────────────────────────────────────────────────────────

def _better(a: Eval, b: Eval | None) -> bool:
    return b is None or a.rank() < b.rank()


def _repair_score(P: Problem, cur: Eval, ev: Eval) -> float:
    """Infeasibility removed per % of weighted load given up (zero-loss moves get a small floor)."""
    gain = cur.infeas - ev.infeas
    if gain <= 0:
        return -math.inf
    loss_pct = max(100.0 * (cur.load_w - ev.load_w) / P.load0, 0.0)
    return gain / (loss_pct + float(_opt("repair_loss_floor_pct"))) - float(_opt("change_penalty")) * (ev.n_changes - cur.n_changes)


def beam_search(P: Problem, deadline: float, cfg: Mapping[str, Any] | None = None) -> tuple[Eval, int]:
    """Repair beam: from each state, keep the candidates removing the most infeasibility per unit of load lost."""
    cfg = cfg or {}
    width = int(cfg.get("beam_width", _opt("beam_width")))
    depth = int(cfg.get("beam_depth", _opt("beam_depth")))
    per = int(cfg.get("beam_candidates_per_state", _opt("beam_candidates_per_state")))
    start = P.evaluate(P.orig)
    beam, best, iters = [start], start, 0
    for _ in range(depth):
        if best.feasible or time.perf_counter() > deadline:
            break
        scored: list[tuple[float, tuple, Eval]] = []
        for cur in beam:
            for c in targeted_moves(P, cur.state, cur)[:per]:
                if time.perf_counter() > deadline:
                    break
                iters += 1
                ev = P.evaluate(c)
                scored.append((_repair_score(P, cur, ev), ev.rank(), ev))
        if not scored:
            break
        scored.sort(key=lambda x: (-x[0], x[1]))
        nxt, seen = [], set()
        for sc, _, ev in scored:
            if sc == -math.inf or ev.state in seen:
                continue
            seen.add(ev.state)
            nxt.append(ev)
            if _better(ev, best):
                best = ev
            if len(nxt) >= width:
                break
        if not nxt:
            break
        beam = nxt
    return best, iters


def anneal(P: Problem, start: Eval, deadline: float, rng: random.Random,
           n_max: int) -> tuple[Eval, int, int, str]:
    t0, t1 = float(_opt("sa_t0")), float(_opt("sa_t_end"))
    cur, best, best_it = start, start, 0
    it = 0
    stopped = "iterations"
    while it < n_max:
        if time.perf_counter() > deadline:
            stopped = "time_budget"
            break
        temp = t0 * (t1 / t0) ** (it / max(n_max - 1, 1))
        it += 1
        cand = random_move(P, cur.state, cur, rng)
        if cand is None or not P.valid(cand):
            continue
        ev = P.evaluate(cand)
        d = ev.energy - cur.energy
        if d <= 0 or rng.random() < math.exp(-d / temp):
            cur = ev
            if _better(cur, best):
                best, best_it = cur, it
    return best, it, best_it, stopped


def recover(P: Problem, best: Eval, deadline: float) -> Eval:
    """Greedy load recovery from a feasible plan: give back trimmed minutes, gear, participants or break time
    while staying feasible; take the best single step each round."""
    if not best.feasible:
        return best
    while time.perf_counter() < deadline:
        st = best.state
        cands: list[State | None] = []
        for i in range(len(st)):
            cands += [mv_untrim(P, st, i, 1), mv_untrim(P, st, i, int(_opt("trim_step_min"))),
                      mv_gear_up(P, st, i), mv_shorten_break(P, st, i), mv_remove_added_break(P, st, i),
                      mv_restore(P, st, i, "participants")]
        nxt = None
        for c in cands:
            if c is None or not P.valid(c) or time.perf_counter() > deadline:
                continue
            ev = P.evaluate(c)
            if ev.feasible and ev.rank() < best.rank() and (nxt is None or ev.rank() < nxt.rank()):
                nxt = ev
        if nxt is None:
            break
        best = nxt
    return best


def simplify(P: Problem, best: Eval, deadline: float) -> Eval:
    """Greedy pass: undo any single change that keeps (or improves) the rank — fewer changes on ties."""
    improved = True
    while improved and time.perf_counter() < deadline:
        improved = False
        st = best.state
        cands = []
        for i in range(len(st)):
            cands.append(mv_remove_added_break(P, st, i))
            for attr in ("gear", "participants", "duration"):
                cands.append(mv_restore(P, st, i, attr))
        for c in cands:
            if c is None or not P.valid(c):
                continue
            ev = P.evaluate(c)
            if ev.rank() <= best.rank() or (ev.feasible == best.feasible and ev.infeas <= best.infeas
                                           and ev.load_w >= best.load_w and ev.n_changes < best.n_changes):
                if ev.rank() < best.rank() or ev.n_changes < best.n_changes:
                    best, improved = ev, True
                    break
    return best


def optimize(plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]], weather: Sequence[Mapping[str, Any]],
             budget_s: float | None = None, seed: int = 0, n_ensemble: int = 30, step_min: float = 1.0,
             max_iterations: int | None = None, extra_labels: Sequence[str] = (), settings=None,
             demo: bool = False) -> dict[str, Any]:
    """CONTRACTS.md ``OptimizeResult`` (dict), plus additive fields ``infeasible_reasons``, ``labels``, ``settings``.

    ``demo=True``: fixed seed, ensemble size and SA iteration cap from constants.demo_mode; the time budget becomes a
    safety stop, so the same inputs always give the same plan.
    """
    beam_cfg: dict[str, Any] = {}
    if demo:
        dm = consts.get("demo_mode")
        beam_cfg = {k: dm[k] for k in ("beam_width", "beam_depth", "beam_candidates_per_state") if k in dm}
        seed, n_ensemble = int(dm["seed"]), int(dm["n_ensemble"])
        max_iterations, budget_s = int(dm["sa_iterations"]), float(dm["safety_budget_s"])
        extra_labels = [*extra_labels, f"demo mode: seed {seed}, {max_iterations} annealing iterations (reproducible)"]
    t_start = time.perf_counter()
    budget = float(budget_s if budget_s is not None else _opt("default_budget_s"))
    deadline = t_start + budget
    P = Problem(plan, roster, weather, n_ensemble=n_ensemble, seed=seed, step_min=step_min, settings=settings)
    rng = random.Random(seed)

    beam_deadline = t_start + budget * float(_opt("beam_time_fraction"))
    sa_deadline = t_start + budget * float(_opt("sa_time_fraction_end"))
    best, beam_iters = beam_search(P, beam_deadline, beam_cfg)
    n_max = int(max_iterations if max_iterations is not None else _opt("sa_max_iterations"))
    sa_best, sa_iters, best_it, stopped = anneal(P, best, sa_deadline, rng, n_max)
    if _better(sa_best, best):
        best = sa_best
    best = recover(P, best, deadline)
    best = simplify(P, best, deadline + min(1.0, 0.1 * budget))
    if time.perf_counter() > deadline and stopped != "time_budget":
        stopped = "time_budget"

    final = _renumber_added(best.state)
    new_plan = P.to_plan(final)
    labels = list(extra_labels)
    original = twonode.simulate_roster(roster, plan, weather, step_min=step_min, n_ensemble=n_ensemble, seed=seed,
                                       extra_labels=labels, settings=P.S)
    optimized = twonode.simulate_roster(roster, new_plan, weather, step_min=step_min, n_ensemble=n_ensemble, seed=seed,
                                        extra_labels=labels, settings=P.S)
    load0 = original["training_load_met_min"]
    reasons = _infeasible_reasons(P, best)
    return {
        "original": original,
        "optimized": optimized,
        "plan": new_plan,
        "changes": diff(P, final, with_times=True),
        "load_kept_pct": round(100.0 * optimized["training_load_met_min"] / load0, 1) if load0 else 100.0,
        "feasible": bool(best.feasible),
        "search": {
            "iterations": beam_iters + sa_iters,
            "seconds": round(time.perf_counter() - t_start, 3),
            "method": f"beam(width={int(_opt('beam_width'))}) warm start + simulated annealing + simplify",
            "evaluations": P.evaluations,
            "cache_hits": P.cache_hits,
            "beam_iterations": beam_iters,
            "sa_iterations": sa_iters,
            "sa_best_iteration": best_it,
            "stopped_by": stopped,
            "seed": seed,
            "budget_s": budget,
            "demo": demo,
            "weighted_load_kept_pct": round(100.0 * best.load_w / P.load0, 1),
        },
        "infeasible_reasons": reasons,
        "settings": P.S.as_dict(),
        "labels": [twonode.ESTIMATE_LABEL, *labels, *P.S.labels()]
                  + ([] if best.feasible else ["no plan met every constraint — least-bad plan shown"]),
    }


def _renumber_added(st: State) -> State:
    """Give added breaks stable, sequential ids (ib1, ib2, …) in plan order."""
    k = 0
    out = []
    for s in st:
        if s.src is None:
            k += 1
            s = replace(s, id=f"ib{k}")
        out.append(s)
    return tuple(out)


def _infeasible_reasons(P: Problem, ev: Eval) -> list[str]:
    out = []
    for v in ev.violations:
        out.append(f"FHSAA: {v['rule']} — {v['detail']}")
    for a, pk in zip(P.R.ids, ev.peak_p95):
        if pk >= P.limit:
            name = P.R.names[P.R.ids.index(a)]
            out.append(f"{name}: estimated p95 core {pk:.1f} °C is at or above the {P.limit:.1f} °C planning limit")
    if any("zone5" in v["rule"] for v in ev.violations):
        out.insert(0, "FHSAA zone 5: no outdoor activity is allowed in these hours — move practice indoors or reschedule.")
    return out
