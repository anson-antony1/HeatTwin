"""Settings an athletic trainer (AT) owns. Defaults come from constants.yaml; requests may override them.

Every simulation and optimization result lists the settings it ran with in ``labels`` (and whether each is the default
or set by the AT), so nobody mistakes a product default for a sourced fact.
"""
from __future__ import annotations

from engine import units  # display °F

from dataclasses import asdict, dataclass, fields, replace
from typing import Any, Mapping

from engine import consts
from engine.physio.clothing import GEAR_LEVELS

CLOTHING_MODES = ("conservative", "iso7933_dynamic", "gagge_static")


@dataclass(frozen=True)
class AtSettings:
    planning_limit_core_c: float
    near_limit_margin_c: float
    clothing_mode: str
    non_participant_shade: bool
    enforce_nata_gear_phasing: bool
    max_added_minutes: int
    p1_min_kept_fraction: float
    priority_weights: tuple[tuple[int, float], ...]
    gear_floor_by_intensity: tuple[tuple[str, str], ...]
    overridden: tuple[str, ...] = ()

    # ── construction ──
    @classmethod
    def defaults(cls) -> "AtSettings":
        o = consts.get("optimizer")
        return cls(
            planning_limit_core_c=float(consts.get("planning_limit_core_c.value")),
            near_limit_margin_c=float(consts.get("near_limit_margin_c.value")),
            clothing_mode=str(consts.get("model_options.clothing_mode")),
            non_participant_shade=bool(consts.get("non_participant.shade")),
            enforce_nata_gear_phasing=True,
            max_added_minutes=int(o["max_added_minutes"]),
            p1_min_kept_fraction=float(o["p1_min_kept_fraction"]),
            priority_weights=tuple(sorted((int(k), float(v)) for k, v in o["priority_weights"].items())),
            gear_floor_by_intensity=tuple(sorted((o.get("gear_floor_by_intensity") or {}).items())),
        )

    def with_overrides(self, d: Mapping[str, Any] | None) -> "AtSettings":
        if not d:
            return self
        known = {f.name for f in fields(self)} - {"overridden"}
        bad = set(d) - known
        if bad:
            raise ValueError(f"unknown setting(s): {sorted(bad)}")
        lo = consts.get("gagge_1986.t_cr_neutral_c")
        hi_f = consts.get("nata_ehs.ehs_core_f")
        ph = consts.get("physical")
        hi = (hi_f - ph["f_offset"]) / ph["f_per_c"]
        v = dict(d)
        if "planning_limit_core_c" in v and not (lo < float(v["planning_limit_core_c"]) < hi):
            raise ValueError(f"planning_limit_core_c must be above {lo} °C (neutral core) and below {hi:.1f} °C "
                             "(NATA exertional-heat-stroke threshold)")
        if "near_limit_margin_c" in v and not (0 <= float(v["near_limit_margin_c"]) <= 2):
            raise ValueError("near_limit_margin_c must be 0–2 °C")
        if "clothing_mode" in v and v["clothing_mode"] not in CLOTHING_MODES:
            raise ValueError(f"clothing_mode must be one of {CLOTHING_MODES}")
        if "max_added_minutes" in v and not (0 <= int(v["max_added_minutes"]) <= 120):
            raise ValueError("max_added_minutes must be 0–120")
        if "p1_min_kept_fraction" in v and not (0 <= float(v["p1_min_kept_fraction"]) <= 1):
            raise ValueError("p1_min_kept_fraction must be 0–1")
        if "priority_weights" in v:
            v["priority_weights"] = tuple(sorted((int(k), float(w)) for k, w in dict(v["priority_weights"]).items()))
            if {k for k, _ in v["priority_weights"]} != {1, 2, 3}:
                raise ValueError("priority_weights needs keys 1, 2, 3")
        if "gear_floor_by_intensity" in v:
            g = dict(v["gear_floor_by_intensity"])
            if not all(x in GEAR_LEVELS for x in g.values()):
                raise ValueError(f"gear floors must be in {GEAR_LEVELS}")
            v["gear_floor_by_intensity"] = tuple(sorted(g.items()))
        for k in ("non_participant_shade", "enforce_nata_gear_phasing"):
            if k in v:
                v[k] = bool(v[k])
        changed = tuple(sorted(k for k in v if getattr(self, k) != v[k]))
        return replace(self, **v, overridden=tuple(sorted(set(self.overridden) | set(changed))))

    # ── views ──
    def weights(self) -> dict[int, float]:
        return dict(self.priority_weights)

    def gear_floor(self) -> dict[str, str]:
        return dict(self.gear_floor_by_intensity)

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["priority_weights"] = {str(k): w for k, w in self.priority_weights}
        d["gear_floor_by_intensity"] = dict(self.gear_floor_by_intensity)
        d.pop("overridden")
        return d

    def labels(self) -> list[str]:
        tag = lambda k: "set by AT" if k in self.overridden else "default"  # noqa: E731
        return [
            f"AT-owned settings — planning limit {units.f(self.planning_limit_core_c, 1)} °F ({tag('planning_limit_core_c')}; "
            f"default from NIOSH 2016), near-limit band {units.df(self.near_limit_margin_c)} °F ({tag('near_limit_margin_c')}), "
            f"clothing mode {self.clothing_mode} ({tag('clothing_mode')}), rotated-out athletes rest in "
            f"{'shade' if self.non_participant_shade else 'sun'} ({tag('non_participant_shade')}), NATA gear phasing "
            f"{'enforced' if self.enforce_nata_gear_phasing else 'not enforced'} ({tag('enforce_nata_gear_phasing')})",
        ]

    def describe(self) -> list[dict[str, Any]]:
        """For GET /settings: every AT-owned setting with its default, current value, status and source."""
        d = AtSettings.defaults()
        rows = [
            ("planning_limit_core_c", "planning_limit_core_c", "Line the p95 core estimate must stay below"),
            ("near_limit_margin_c", "near_limit_margin_c", "'near_limit' band below the line"),
            ("clothing_mode", "clothing_conservative", "Clothing heat-transfer treatment"),
            ("non_participant_shade", "non_participant", "Rotated-out athletes rest in the shaded cooling area"),
            ("enforce_nata_gear_phasing", "nata_gear_phasing", "Flag gear above an athlete's acclimatization day"),
            ("max_added_minutes", "optimizer", "Most minutes the optimizer may add to practice"),
            ("p1_min_kept_fraction", "optimizer", "Share of each priority-1 drill's minutes that must be kept"),
            ("priority_weights", "optimizer", "Objective weight per drill priority"),
            ("gear_floor_by_intensity", "optimizer", "Least gear the optimizer may leave on contact drills"),
        ]
        out = []
        cur, dflt = self.as_dict(), d.as_dict()
        for key, block, what in rows:
            out.append({"key": key, "value": cur[key], "default": dflt[key], "owner": "athletic trainer",
                        "description": what, "status": consts.status(block),
                        "source": consts.get(f"{block}.source", consts.get(f"{block}.note", ""))})
        out[0]["alternatives"] = consts.get("planning_limit_core_c.alternatives")
        out[2]["allowed"] = list(CLOTHING_MODES)
        return out


def resolve(overrides: Mapping[str, Any] | None = None) -> AtSettings:
    return AtSettings.defaults().with_overrides(overrides)
