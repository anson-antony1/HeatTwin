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

import json

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
    drill_type: str | None = None                          # CONTRACTS v1.2 (optional)

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
                   gear_by=tuple(sorted((d.get("gear_by_athlete") or {}).items())) or None,
                   drill_type=d.get("drill_type"))

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
        if self.drill_type:
            d["drill_type"] = self.drill_type
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
    infeas_rules: float = 0.0   # FHSAA + NATA (regulatory) part of infeas
    infeas_heat: float = 0.0    # p95-over-limit part
    infeas_cap: float = 0.0     # changes over the preset cap

    def rank(self) -> tuple:
        """Lexicographic, in tiers: feasible first; then regulatory violations, then heat excess, then changes over
        the preset cap (a cap never trades against a rule); then most load, fewest changes, fewest added minutes."""
        return (0 if self.feasible else 1, round(self.infeas_rules, 6), round(self.infeas_heat, 6),
                round(self.infeas_cap, 6), -round(self.load_w, 6), self.n_changes, self.added_min)


class Problem:
    """Everything fixed during one optimization: roster arrays, ensemble draws, weather on the step grid."""

    def __init__(self, plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]],
                 weather: Sequence[Mapping[str, Any]], *, n_ensemble: int = 30, seed: int = 0, step_min: float = 1.0,
                 settings=None, max_changes: int | None = None):
        self.max_changes = max_changes
        from engine import settings as at_settings
        self.S = settings or at_settings.resolve()
        self.plan = plan
        self.roster = list(roster)
        self.weather = list(weather)
        self.step_min = step_min
        self.t0 = twonode.parse_time(plan["start"])
        self.R = twonode.build_roster(self.roster)
        self.gear_caps = twonode.gear_caps(self.roster)
        self.D = twonode.make_draws(n_ensemble, len(self.R.ids), seed)
        self.orig: State = tuple(Seg.from_drill(d) for d in plan["drills"])
        self.orig_by_src = {s.src: s for s in self.orig}
        self.orig_index = {s.src: i for i, s in enumerate(self.orig)}
        self.orig_total = sum(s.duration for s in self.orig)
        self.max_total = self.orig_total + int(self.S.max_added_minutes)
        # horizon: the longest plan the search may produce, plus one original drill so a "top changes" undo still fits
        horizon = self.max_total + max(s.duration for s in self.orig)
        self.env = twonode.build_environment(self.weather, plan["site"], self.t0, step_min,
                                             int(math.ceil(horizon / step_min)))
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
        o = self.orig_by_src.get(s.src) if s.src else None
        return metabolic.drill_met({"intensity": s.intensity, "met_override": s.met_override, "is_break": s.is_break,
                                    "name": o.name if o else s.name, "drill_type": s.drill_type})

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
        tl = twonode.build_timeline(plan["drills"], self.R.ids, self.step_min, rest_shade=self.S.non_participant_shade,
                                    gear_cap=self.gear_caps)
        core = twonode.simulate_arrays(tl, self.env, self.R, self.D, clothing_mode=self.S.clothing_mode).core
        p95 = np.round(np.percentile(core, 95.0, axis=0), 3)        # [N, T] — same rounding as SimulationResult
        peak = p95.max(axis=1)
        over = p95 >= self.limit
        first = np.where(over.any(axis=1), over.argmax(axis=1), -1)
        excess = float(np.sum(np.maximum(peak - self.limit, 0.0) + (peak >= self.limit) * 1e-3))
        n_ch = len(diff(self, st))
        over_cap = float(max(0, n_ch - self.max_changes)) if self.max_changes is not None else 0.0
        inf_rules = self.fhsaa_infeasibility(plan, viol)
        inf_heat = excess / float(_opt("heat_excess_per_unit_c"))
        infeas = inf_rules + inf_heat + over_cap
        load = self.weighted_load(st)
        energy = (float(_opt("infeasibility_weight")) * infeas - 100.0 * load / self.load0
                  + float(_opt("change_penalty")) * n_ch)
        at_risk = tuple(a for a, pk in zip(self.R.ids, peak) if pk >= self.limit - self.near)
        ev = Eval(st, infeas == 0.0, infeas, viol, peak, first, load, n_ch, energy, at_risk,
                  added_min=max(self.total(st) - self.orig_total, 0), infeas_rules=inf_rules,
                  infeas_heat=inf_heat, infeas_cap=over_cap)
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
    if P.max_changes is not None and ev.n_changes >= P.max_changes and rng.random() < float(_opt("swap_probability")):
        return swap_move(P, st, ev, rng)
    return _random_move(P, st, ev, rng)


def swap_move(P: Problem, st: State, ev: Eval, rng: random.Random) -> State | None:
    """At the change cap: undo one change (remove an added break / restore an attribute) and make another."""
    n = len(st)
    undo = [c for i in range(n) for c in (mv_remove_added_break(P, st, i),
                                          *(mv_restore(P, st, i, a) for a in ("gear", "participants", "duration")))
            if c is not None]
    if not undo:
        return None
    mid = rng.choice(undo)
    return _random_move(P, mid, ev, rng)


def _random_move(P: Problem, st: State, ev: Eval, rng: random.Random) -> State | None:
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
    if P.max_changes is not None and ev.n_changes > P.max_changes:
        for i in range(len(st)):
            fix.append(mv_remove_added_break(P, st, i))
            fix += [mv_restore(P, st, i, a) for a in ("gear", "participants", "duration")]
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
            art = "an" if str(s.duration).startswith("8") or s.duration in (11, 18) else "a"
            d = f"Added {art} {s.duration}-min shaded water break after '{prev}'"
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
    if P.max_changes is not None:  # capped preset: construct within the cap, wider beam
        width = max(width, int(_opt("capped_beam_width")))
        per = max(per, int(_opt("capped_beam_candidates_per_state")))
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
                if P.max_changes is not None and ev.n_changes > P.max_changes:
                    continue
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
             demo: bool = False, preset: str = "max_load", _cap: int | None = None, _seed: bool = True
             ) -> dict[str, Any]:
    """CONTRACTS.md ``OptimizeResult`` (dict), plus additive fields ``infeasible_reasons``, ``labels``, ``settings``.

    ``demo=True``: fixed seed, ensemble size and SA iteration cap from constants.demo_mode; the time budget becomes a
    safety stop, so the same inputs always give the same plan.

    ``preset="fewest_changes"`` (minimum compliant edit, CONTRACTS v1.4): search with the preset's change cap; if no
    plan within it meets every rule with everyone under the line, raise the cap one step at a time (up to the max_load
    plan's change count) and return the first plan that does, with ``fewest_changes.min_compliant_changes`` = that cap.
    Only if none qualifies is the max_load plan returned (``fell_back``). ``_cap`` = one capped search, no stepping.

    ``preset="max_load"`` in demo mode also seeds from the minimum compliant edit (optimizer.seed_max_load_from_min_edit):
    it anneals once more starting from that plan, then returns the best compliant plan by training load kept, tie-break
    fewer changes, among the max-load search, the minimum-edit plan and the seeded search. ``_seed=False`` = the plain
    max-load search (used as the upper bound of the cap stepping).
    """
    beam_cfg: dict[str, Any] = {}
    demo_cfg: dict[str, Any] = {}
    if demo:
        dm = dict(consts.get("demo_mode"))
        dm.update((dm.get("preset_overrides") or {}).get(preset, {}))
        demo_cfg = dm
        beam_cfg = {k: dm[k] for k in ("beam_width", "beam_depth", "beam_candidates_per_state") if k in dm}
        seed, n_ensemble = int(dm["seed"]), int(dm["n_ensemble"])
        max_iterations, budget_s = int(dm["sa_iterations"]), float(dm["safety_budget_s"])
        dl = f"demo mode: seed {seed}, {max_iterations} annealing iterations (reproducible)"
        extra_labels = [*extra_labels, dl] if dl not in extra_labels else list(extra_labels)
    presets = consts.get("optimizer_presets")
    if preset not in presets or preset in ("status", "note"):
        raise ValueError(f"unknown preset {preset!r}")
    max_changes = presets[preset]["max_changes"] if _cap is None else _cap
    pl = f"preset fewest_changes: at most {max_changes} changes"
    if max_changes is not None and _cap is None and pl not in extra_labels:
        extra_labels = [*extra_labels, pl]
    t_start = time.perf_counter()
    budget = float(budget_s if budget_s is not None else _opt("default_budget_s"))
    deadline = t_start + budget
    P = Problem(plan, roster, weather, n_ensemble=n_ensemble, seed=seed, step_min=step_min, settings=settings,
                max_changes=max_changes)
    beam_deadline = t_start + budget * float(_opt("beam_time_fraction"))
    sa_deadline = t_start + budget * float(_opt("sa_time_fraction_end"))
    best, beam_iters = beam_search(P, beam_deadline, beam_cfg)
    n_max = int(max_iterations if max_iterations is not None else _opt("sa_max_iterations"))
    restarts = int(demo_cfg["sa_restarts"] if demo else _opt("sa_restarts"))
    beam_best = best
    sa_iters, best_it, stopped = 0, 0, "iterations"
    for k in range(restarts):  # multi-start SA: same ensemble draws, different search RNG; alternate start points
        if time.perf_counter() > sa_deadline:
            stopped = "time_budget"
            break
        start = beam_best if k % 2 == 0 else P.evaluate(P.orig)
        rng_k = random.Random(seed * 1000 + k)
        remaining = max(sa_deadline - time.perf_counter(), 0.0) / max(restarts - k, 1)
        sa_best, it_k, bit_k, stopped = anneal(P, start, time.perf_counter() + remaining, rng_k, n_max)
        if _better(sa_best, best):
            best, best_it = sa_best, sa_iters + bit_k
        sa_iters += it_k
    best = recover(P, best, deadline)
    best = simplify(P, best, deadline + min(1.0, 0.1 * budget))
    if time.perf_counter() > deadline and stopped != "time_budget":
        stopped = "time_budget"

    fallback_note = None
    kw = dict(budget_s=budget_s, seed=seed, n_ensemble=n_ensemble, step_min=step_min, max_iterations=max_iterations,
              extra_labels=extra_labels, settings=settings, demo=demo)
    seed_note = None
    # demo mode only: the cap stepping takes far longer than a time-budgeted call's budget (default_budget_s)
    if preset == "max_load" and _cap is None and _seed and demo and bool(_opt("seed_max_load_from_min_edit")):
        cap0 = consts.get("optimizer_presets.fewest_changes.max_changes")
        upper = max(len(diff(P, best.state)), cap0) if best.feasible else None
        me, _ = _min_edit(plan, roster, weather, kw, cap0, upper)
        if me is not None:
            ev_me = P.evaluate(me.state)
            rng_s = random.Random(seed * 1000 + restarts)
            t_s = time.perf_counter() + budget / max(restarts, 1)
            seeded, it_s, _bit, _st = anneal(P, ev_me, t_s, rng_s, n_max)
            sa_iters += it_s
            seeded = simplify(P, recover(P, seeded, t_s), t_s + min(1.0, 0.1 * budget))
            cands = [("max-load search", best), ("minimum-edit plan", ev_me), ("search seeded from the minimum edit", seeded)]
            scored = [(name, ev, _load_kept(P, ev, roster, weather, step_min, settings)) for name, ev in cands if ev.feasible]
            if scored:   # best compliant plan by training load kept, tie-break fewer changes
                name, best, kept = max(scored, key=lambda x: (x[2], -x[1].n_changes))
                seed_note = ("max_load: best compliant plan by training load kept (tie-break fewer changes) among "
                             + "; ".join(f"{n} {k:.1f}% / {e.n_changes} changes" for n, e, k in scored)
                             + f" — chosen: {name}")
    if max_changes is not None and _cap is None and not best.feasible:
        alt = optimize(plan, roster, weather, preset="max_load", _seed=False, **kw)
        searched = [max_changes]
        if alt["feasible"]:  # minimum compliant edit: raise the cap step by step up to the max_load plan's count
            r, more = _min_edit(plan, roster, weather, kw, max_changes + 1, len(alt["changes"]))
            searched += more
            if r is not None:
                cap = searched[-1]
                r["fewest_changes"] = {"cap": max_changes, "min_compliant_changes": cap, "searched_caps": searched,
                                       "fell_back": False}
                r["labels"].append(f"fewest_changes: needs at least {cap} changes — no plan within {cap - 1} "
                                   "changes met every rule with every athlete under the line (caps "
                                   f"{max_changes}–{cap} searched one at a time)")
                r["search"]["preset"] = "fewest_changes"
                r["search"]["max_changes"] = cap
                return r
            alt["fewest_changes"] = {"cap": max_changes, "min_compliant_changes": None, "searched_caps": searched,
                                     "fell_back": True}
            alt["labels"].append(f"fewest_changes: no capped plan up to {len(alt['changes'])} changes qualified — "
                                 f"showing the max_load plan ({len(alt['changes'])} changes)")
            alt["search"]["preset"] = "fewest_changes→max_load"
            alt["search"]["max_changes"] = max_changes
            return alt
        fallback_note = "max_load fallback also found no plan meeting every constraint"
    final = _renumber_added(best.state, P)
    new_plan = P.to_plan(final)
    changes_out = diff(P, final, with_times=True)
    top3 = top_changes(P, final, changes_out, int(_opt("top_changes_k")))
    labels = list(extra_labels)
    original = twonode.simulate_roster(roster, plan, weather, step_min=step_min, n_ensemble=n_ensemble, seed=seed,
                                       extra_labels=labels, settings=P.S)
    optimized = twonode.simulate_roster(roster, new_plan, weather, step_min=step_min, n_ensemble=n_ensemble, seed=seed,
                                        extra_labels=labels, settings=P.S)
    load0 = original["training_load_met_min"]
    reasons = _infeasible_reasons(P, best)
    out = _Result({
        "original": original,
        "optimized": optimized,
        "plan": new_plan,
        "changes": changes_out,
        "top_changes": top3,
        "top_changes_text": top_changes_text(top3),
        "load_kept_pct": round(100.0 * optimized["training_load_met_min"] / load0, 1) if load0 else 100.0,
        "feasible": bool(best.feasible),
        "search": {
            "iterations": beam_iters + sa_iters,
            "seconds": round(time.perf_counter() - t_start, 3),
            "method": f"beam(width={int(_opt('beam_width'))}) warm start + {restarts}× simulated annealing + recover + simplify",
            "evaluations": P.evaluations,
            "cache_hits": P.cache_hits,
            "beam_iterations": beam_iters,
            "sa_iterations": sa_iters,
            "sa_best_iteration": best_it,
            "stopped_by": stopped,
            "seed": seed,
            "budget_s": budget,
            "demo": demo,
            "preset": preset,
            "max_changes": max_changes,
            "weighted_load_kept_pct": round(100.0 * best.load_w / P.load0, 1),
        },
        "infeasible_reasons": reasons,
        "settings": P.S.as_dict(),
        "labels": [twonode.ESTIMATE_LABEL, *labels, *P.S.labels()]
                  + ([] if best.feasible else ["no plan met every constraint — least-bad plan shown"])
                  + ([fallback_note] if fallback_note else [])
                  + ([seed_note] if seed_note else []),
    })
    out.state = best.state   # internal (not serialized): seeds other searches
    if max_changes is not None and _cap is None and best.feasible:  # compliant within the requested cap
        out["fewest_changes"] = {"cap": max_changes, "min_compliant_changes": len(changes_out),
                                 "searched_caps": [max_changes], "fell_back": False}
    return out


class _Result(dict):
    """OptimizeResult dict; ``.state`` holds the search state (not part of the JSON) for seeding other searches."""
    state: State = ()


_CAPPED: dict[str, dict[str, Any]] = {}


def _min_edit(plan, roster, weather, kw: Mapping[str, Any], cap_from: int, cap_to: int | None
              ) -> tuple[dict[str, Any] | None, list[int]]:
    """Capped searches with the cap raised one step at a time from ``cap_from`` to ``cap_to``; the first plan meeting
    every rule with every athlete under the line, and the caps searched."""
    searched: list[int] = []
    if cap_to is None:
        return None, searched
    for cap in range(cap_from, cap_to + 1):
        searched.append(cap)
        key = None
        if kw.get("demo"):  # demo searches are deterministic: max_load seeding and fewest_changes share capped runs
            key = json.dumps([plan, roster, weather, {k: v for k, v in kw.items() if k != "settings"},
                              repr(kw.get("settings")), cap], sort_keys=True, default=str)
        r = _CAPPED.get(key) if key else None
        if r is None:
            r = optimize(plan, roster, weather, preset="fewest_changes", _cap=cap, **kw)
            if key:
                _CAPPED[key] = r
        if r["feasible"]:
            return r, searched
    return None, searched


def _load_kept(P: Problem, ev: Eval, roster, weather, step_min: float, settings) -> float:
    """Training load kept (%, unweighted MET·min, as reported) for a candidate state."""
    plan_c = P.to_plan(_renumber_added(ev.state, P))
    a = twonode.simulate_roster(roster, P.plan, weather, step_min=step_min, n_ensemble=5, seed=0, settings=P.S)
    b = twonode.simulate_roster(roster, plan_c, weather, step_min=step_min, n_ensemble=5, seed=0, settings=P.S)
    return round(100.0 * b["training_load_met_min"] / a["training_load_met_min"], 1) if a["training_load_met_min"] else 100.0


# ─────────────────────────────────────────────────────────────────────────────
# Top changes by heat reduction (for the UI and the voice agent)
# ─────────────────────────────────────────────────────────────────────────────

def undo_change(P: Problem, st: State, ch: Mapping[str, str]) -> State | None:
    """The plan with one reported change reverted (best effort; the result need not satisfy every constraint)."""
    move, src = ch.get("move"), ch["drill_id"]
    idx = [i for i, s in enumerate(st) if s.src == src]
    if move == "insert_break":
        return tuple(s for s in st if s.id != src)
    o = P.orig_by_src.get(src)
    if o is None:
        return None
    if move == "remove":
        prev = {x.src for x in P.orig[:P.orig_index[src]]}
        k = max([i + 1 for i, s in enumerate(st) if s.src in prev], default=0)
        return st[:k] + (o,) + st[k:]
    if not idx:
        return None
    if move == "split" or move == "platoon":
        parts = [st[i] for i in idx]
        merged = replace(parts[0], duration=sum(p.duration for p in parts), id=src, part=1, name=o.name,
                         participants=o.participants if move == "platoon" else parts[0].participants)
        out = [s for s in st if s.src != src]
        out.insert(idx[0], merged)
        return tuple(out)
    if move == "reorder":
        first = st[idx[0]]
        rest = st[:idx[0]] + st[idx[0] + 1:]
        prev = {x.src for x in P.orig[:P.orig_index[src]]}
        k = max([i + 1 for i, s in enumerate(rest) if s.src in prev], default=0)
        return rest[:k] + (first,) + rest[k:]
    attrs = {"gear_down": ("gear", "gear_by"), "gear_per_athlete": ("gear_by",), "rotate_out": ("participants",),
             "shade": ("shade",)}.get(move)
    out = list(st)
    if attrs:
        for i in idx:
            out[i] = replace(out[i], **{a: getattr(o, a) for a in attrs})
        return tuple(out)
    if move in ("trim", "lengthen_break"):
        total = sum(st[i].duration for i in idx)
        out[idx[0]] = replace(out[idx[0]], duration=st[idx[0]].duration + (o.duration - total))
        return tuple(out) if out[idx[0]].duration > 0 else None
    return None


def top_changes(P: Problem, st: State, changes: Sequence[Mapping[str, str]], k: int) -> list[dict[str, Any]]:
    """Rank reported changes by how much undoing each one would raise the team-mean peak p95 (°C)."""
    base = float(np.mean(P.evaluate(st).peak_p95))
    scored = []
    for ch in changes:
        alt = undo_change(P, st, ch)
        if alt is None or not alt:
            continue
        delta = float(np.mean(P.evaluate(alt).peak_p95)) - base
        scored.append({**ch, "heat_reduction_c": round(delta, 2)})
    scored.sort(key=lambda c: -c["heat_reduction_c"])
    return [c for c in scored if c["heat_reduction_c"] > 0][:k]


def top_changes_text(top: Sequence[Mapping[str, Any]]) -> str:
    if not top:
        return "No single change accounts for a measurable drop in the estimated team peak."
    parts = [f"{i + 1}) {c['detail']} (team peak estimate {c['heat_reduction_c']:.1f} °C lower)" for i, c in enumerate(top)]
    return "Biggest heat reductions: " + "; ".join(parts) + ". Estimate — planning only."


def _renumber_added(st: State, P: "Problem | None" = None) -> State:
    """Give added breaks stable, sequential ids (ib1, ib2, …) in plan order, and name drill parts from what they are:
    complementary participant groups → "(platoon A/B…)", otherwise "(part k of n)"; a single part keeps its name."""
    k = 0
    out = []
    for s in st:
        if s.src is None:
            k += 1
            s = replace(s, id=f"ib{k}")
        out.append(s)
    if P is None:
        return tuple(out)
    by_src: dict[str, list[int]] = {}
    for i, s in enumerate(out):
        if s.src is not None:
            by_src.setdefault(s.src, []).append(i)
    for src, idx in by_src.items():
        base = P.orig_by_src[src].name
        parts = [out[i] for i in idx]
        if len(parts) == 1:
            out[idx[0]] = replace(parts[0], name=base)
            continue
        groups = [set(p.participants) if p.participants is not None else None for p in parts]
        platoon = all(g is not None for g in groups) and sum(len(g) for g in groups) == len(set().union(*groups))
        for j, i in enumerate(idx):
            label = f"platoon {chr(ord('A') + j)}" if platoon else f"part {j + 1} of {len(idx)}"
            out[i] = replace(out[i], name=f"{base} ({label})")
    return tuple(out)


def _infeasible_reasons(P: Problem, ev: Eval) -> list[str]:
    return list(dict.fromkeys(_reasons(P, ev)))  # de-duplicate, keep order


def _reasons(P: Problem, ev: Eval) -> list[str]:
    out = []
    if P.max_changes is not None and ev.n_changes > P.max_changes:
        out.append(f"needs {ev.n_changes} changes; the fewest_changes preset allows {P.max_changes}")
    for v in ev.violations:
        out.append(f"FHSAA: {v['rule']} — {v['detail']}")
    for a, pk in zip(P.R.ids, ev.peak_p95):
        if pk >= P.limit:
            name = P.R.names[P.R.ids.index(a)]
            out.append(f"{name}: estimated p95 core {pk:.1f} °C is at or above the {P.limit:.1f} °C planning limit")
    if any("zone5" in v["rule"] for v in ev.violations):
        out.insert(0, "FHSAA zone 5: no outdoor activity is allowed in these hours — move practice indoors or reschedule.")
    return out
