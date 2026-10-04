"""WS3 — per-athlete calibration from live heart rate (ensemble Kalman filter) + Relay-style gates.

Observation model (constants.hr_model): HR = HR_rest + %VO₂R·(HR_max − HR_rest), with
%VO₂R = (MET − 1)/(VO₂max/3.5 − 1) — the inverse of metabolic.met_from_hr (Swain & Leutholtz 1997). The MET is the
drill's MET × met_scale (rest MET if the athlete is rotated out), capped at the athlete's aerobic ceiling. Cardiovascular
drift is not modelled yet, so heat-driven HR rise is read as extra metabolic rate (conservative). thermo_scale is not
observable from HR without a drift term and is left unchanged — said in the output.

Every ``update_interval_s`` the mean HR of the last ``window_s`` updates an ensemble of met_scale values (stochastic EnKF
with perturbed observations, seeded → deterministic). The rest of the plan is then re-forecast with the new calibration.

Gates (Relay): the re-forecast only says it "shows a crossing" when (a) p95 core reaches the planning limit, (b) stays
there ≥ persistence_min consecutive minutes, and (c) HR coverage in the last window is adequate and at least
min_updates_before_flag updates have run. Otherwise it says "not enough data" or "no crossing in re-forecast" and names
the gate that held it back. Replayed or synthetic HR is labelled ``replay: true`` everywhere.
"""
from __future__ import annotations

import csv
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from engine import consts
from engine.physio import metabolic, twonode


def _c(key: str):
    return consts.get(f"calibration.{key}")


# ── observation model ───────────────────────────────────────────────────────

def hr_from_met(met, hr_rest: float, hr_max: float, vo2max_ml_kg_min: float):
    """Predicted HR for a MET (inverse of %HRR ≈ %VO₂R)."""
    ml = consts.get("hr_met.ml_o2_per_kg_min_per_met")
    vo2r = (np.asarray(met, dtype=float) - 1.0) / max(vo2max_ml_kg_min / ml - 1.0, 1e-6)
    return hr_rest + np.clip(vo2r, 0.0, 1.0) * (hr_max - hr_rest)


def personal_baseline(rest_hr: Sequence[float], load_hr: Sequence[float] = ()) -> dict[str, Any]:
    """Relay-style personal baseline from prior sessions: median and MAD of resting and at-load HR."""
    out: dict[str, Any] = {"n_rest": len(rest_hr), "n_load": len(load_hr)}
    for name, xs in (("rest", rest_hr), ("load", load_hr)):
        if len(xs):
            a = np.asarray(xs, dtype=float)
            med = float(np.median(a))
            out[f"hr_{name}_median_bpm"] = round(med, 1)
            out[f"hr_{name}_mad_bpm"] = round(float(np.median(np.abs(a - med))), 1)
    return out


# ── live session ────────────────────────────────────────────────────────────

@dataclass
class AthleteState:
    athlete: dict[str, Any]
    ens: np.ndarray                                  # met_scale ensemble
    readings: list[tuple[float, float, bool]] = field(default_factory=list)  # (epoch s, bpm, replay)
    last_update: float | None = None
    n_updates: int = 0
    last_coverage: float = 0.0
    dropped: int = 0
    skipped_rest: int = 0       # live demo: windows that looked like rest, not the mapped drill (not assimilated)
    ceiling_held: int = 0       # windows at/above the modelled HR ceiling for every member (nothing to learn)
    last_window: str = ""       # "updated" | "rest" | "ceiling" | "" — what the latest window did (gate message)


class LiveSession:
    """Holds one practice: plan, roster, weather, and per-athlete calibration state."""

    def __init__(self, plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]],
                 weather: Sequence[Mapping[str, Any]], *, settings=None, seed: int = 0,
                 extra_labels: Sequence[str] = (), observe: Mapping[str, Mapping[str, Any]] | None = None):
        """``observe`` (live demo): athlete id → the plan drill they are actually doing. Their HR is read against that
        drill's intensity and gear at every minute instead of the plan drill at the clock; the re-forecast still runs
        the plan as written with the calibrated met_scale."""
        from engine import settings as at_settings
        self.plan, self.weather = dict(plan), list(weather)
        self.roster = [dict(a) for a in roster]
        self.S = settings or at_settings.resolve()
        self.rng = np.random.default_rng(seed)
        self.seed = seed
        self.extra_labels = list(extra_labels)
        self.t0 = twonode.parse_time(plan["start"])
        self.R = twonode.build_roster(self.roster)
        self.tl = twonode.build_timeline(plan["drills"], self.R.ids, 1.0, rest_shade=self.S.non_participant_shade,
                                         gear_cap=twonode.gear_caps(self.roster))
        self.observe = {aid: dict(d) for aid, d in (observe or {}).items()}
        one = lambda d, part: twonode.build_timeline([{**d, "duration_min": 1, "participants": part}], self.R.ids,  # noqa: E731
                                                     1.0, rest_shade=self.S.non_participant_shade,
                                                     gear_cap=twonode.gear_caps(self.roster))
        self.obs_tl = {aid: one(d, None) for aid, d in self.observe.items()}     # on the mapped drill
        self.rest_tl = {aid: one(d, []) for aid, d in self.observe.items()}      # rotated out of it (resting)
        pri = consts.get("ensemble_priors")
        self.state: dict[str, AthleteState] = {}
        self._last_refc: dict[str, Any] | None = None
        for a in self.roster:
            c = a.get("calib") or {}
            mu, sd = c.get("met_scale", 1.0), c.get("met_scale_sd", pri["met_scale_sd"])
            ens = np.maximum(mu + sd * self.rng.standard_normal(int(_c("n_ensemble"))),
                             consts.get("ensemble_defaults.min_scale"))
            self.state[a["id"]] = AthleteState(athlete=a, ens=ens)

    # model HR for athlete at a plan minute, for each ensemble met_scale
    def _predict(self, aid: str, minute: int, ens: np.ndarray, *, resting: bool = False) -> np.ndarray | None:
        a = self.state[aid].athlete
        if a.get("hr_rest_bpm") is None:
            return None
        i = self.R.ids.index(aid)
        if aid in self.obs_tl:   # live demo: the mapped drill (or resting from it) at every minute
            tl, k = (self.rest_tl[aid] if resting else self.obs_tl[aid]), 0
        else:
            tl, k = self.tl, int(np.clip(minute, 0, self.tl.n_steps - 1))
        met = tl.met[i, k] * ens
        if self.S.clothing_mode == "conservative":  # the gear surcharge is metabolic: measured HR includes it
            met = met * (1.0 + twonode.gear_met_surcharge()[tl.gear[i, k]])
        met = np.minimum(met, self.R.met_cap[i])
        hr_max = a.get("hr_max_bpm") or metabolic.hr_max_bpm(float(a["age_yr"]))
        # cardiovascular drift is not modelled (constants.hr_model.drift_bpm_per_c_core = 0, status TODO)
        return hr_from_met(met, float(a["hr_rest_bpm"]), float(hr_max), twonode.vo2max_ml_kg_min(a))

    def add_reading(self, reading: Mapping[str, Any], *, reforecast: bool = True) -> dict[str, Any]:
        aid = reading["athlete_id"]
        if aid not in self.state:
            raise KeyError(f"athlete {aid} is not on this session's roster")
        st = self.state[aid]
        ts = twonode.parse_time(reading["ts"]).timestamp()
        hr = float(reading["hr_bpm"])
        lo, hi = _c("plausible_hr_bpm")
        replay = bool(reading.get("replay", False))
        if lo <= hr <= hi:
            st.readings.append((ts, hr, replay))
        else:
            st.dropped += 1
        updated = held = False
        if st.last_update is None or ts - st.last_update >= _c("update_interval_s"):
            updated = self._update(aid, ts)
            held = st.last_window in ("rest", "ceiling")
        out = {"athlete_id": aid, "calib": self.calib(aid), "updated": updated, "replay": replay,
               "labels": self._labels(aid)}
        if reforecast and (updated or st.n_updates == 0):
            out["reforecast"] = self._last_refc = self.reforecast()
            out["gates"] = self.gates(aid, out["reforecast"])
        elif reforecast and held and self._last_refc is not None:   # say why nothing was learnt from this window
            out["gates"] = self.gates(aid, self._last_refc)
        return out

    def _update(self, aid: str, now: float) -> bool:
        st = self.state[aid]
        win = [hr for (t, hr, _) in st.readings if now - _c("window_s") < t <= now]
        expected = _c("window_s") / _c("expected_reading_interval_s")
        st.last_coverage = min(len(win) / expected, 1.0)
        st.last_update = now
        if st.last_coverage < _c("min_coverage_fraction"):
            return False
        minute = int((now - self.t0.timestamp()) // 60 - _c("window_s") / 120)  # window midpoint
        y_e = self._predict(aid, minute, st.ens)
        if y_e is None:
            return False
        y = float(np.mean(win))
        if aid in self.observe:   # live demo: a window that looks like rest is not read against the drill
            y_rest = self._predict(aid, minute, st.ens, resting=True)
            if y < 0.5 * (float(np.mean(y_rest)) + float(np.mean(y_e))):
                st.skipped_rest += 1
                st.last_window = "rest"
                return False
        if np.var(y_e) == 0:      # every member at the modelled HR ceiling (aerobic cap): HR cannot tell them apart
            if y >= float(y_e.max()):
                st.ceiling_held += 1
                st.last_window = "ceiling"
            return False
        r = float(_c("obs_sd_bpm")) ** 2
        cov_xy = float(np.cov(st.ens, y_e)[0, 1])
        k = cov_xy / (float(np.var(y_e, ddof=1)) + r)
        perturbed = y + self.rng.normal(0.0, np.sqrt(r), st.ens.size)
        st.ens = np.maximum(st.ens + k * (perturbed - y_e), consts.get("ensemble_defaults.min_scale"))
        st.n_updates += 1
        st.last_window = "updated"
        return True

    def calib(self, aid: str) -> dict[str, Any]:
        st = self.state[aid]
        prior = st.athlete.get("calib") or {}
        return {
            "met_scale": round(float(np.mean(st.ens)), 4),
            "met_scale_sd": round(float(np.std(st.ens, ddof=1)), 4),
            "thermo_scale": prior.get("thermo_scale", 1.0),
            "thermo_scale_sd": prior.get("thermo_scale_sd", consts.get("ensemble_priors.thermo_scale_sd")),
            "n_sessions": prior.get("n_sessions", 0),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    def roster_with_calib(self) -> list[dict[str, Any]]:
        out = []
        for a in self.roster:
            b = dict(a)
            if self.state[a["id"]].n_updates:
                b["calib"] = self.calib(a["id"])
            out.append(b)
        return out

    def reforecast(self) -> dict[str, Any]:
        labels = [*self.extra_labels, "re-forecast with live-HR calibration (state from plan start; not assimilated)"]
        if any(r[2] for st in self.state.values() for r in st.readings):
            labels.append("replay: true — heart rate is replayed, not live")
        return twonode.simulate_roster(self.roster_with_calib(), self.plan, self.weather, seed=self.seed,
                                       extra_labels=labels, settings=self.S)

    def gates(self, aid: str, refc: Mapping[str, Any], now_min: float | None = None) -> dict[str, Any]:
        st = self.state[aid]
        ath = next(a for a in refc["athletes"] if a["id"] == aid)
        p95 = np.asarray(ath["core_c_p95"])
        over = p95 >= refc["limit_core_c"]
        run, best = 0, 0
        for o in over:
            run = run + 1 if o else 0
            best = max(best, run)
        g = {
            "crossing": bool(over.any()),
            "persistent": best >= int(_c("persistence_min")),
            "coverage_ok": st.last_coverage >= _c("min_coverage_fraction") and st.n_updates >= int(_c("min_updates_before_flag")),
            "coverage_fraction": round(st.last_coverage, 2),
            "n_updates": st.n_updates,
        }
        held = [k for k in ("coverage_ok", "crossing", "persistent") if not g[k]]
        g["flag"] = not held
        g["held_by"] = held
        if not g["coverage_ok"] and st.last_window == "ceiling":
            g["message"] = "HR at or above the model's ceiling — calibration held"
        elif not g["coverage_ok"] and st.last_window == "rest":
            g["message"] = "HR looks like rest — not read against the live-demo drill"
        elif not g["coverage_ok"]:
            g["message"] = "not enough data"
        elif g["flag"]:
            g["message"] = "re-forecast shows crossing"
        else:
            g["message"] = "no crossing in re-forecast"
        return g

    def _labels(self, aid: str) -> list[str]:
        lab = [twonode.ESTIMATE_LABEL, "thermo_scale not updated from HR (no drift term in the HR model)"]
        st = self.state[aid]
        if aid in self.observe:
            d = self.observe[aid]
            lab.append(f"live demo: HR read against '{d['name']}' ({d['intensity']}), not the plan drill at the clock")
            if st.skipped_rest:
                lab.append(f"live demo: {st.skipped_rest} window(s) looked like rest and were not assimilated")
        if st.ceiling_held:
            lab.append(f"{st.ceiling_held} window(s) at or above the modelled HR ceiling — met_scale held there")
        if any(r[2] for r in self.state[aid].readings):
            lab.append("replay: true")
        return lab


def match_drill(plan: Mapping[str, Any], query: str) -> dict[str, Any] | None:
    """A plan drill by id, else the first non-break drill whose name contains ``query`` (case-insensitive)."""
    q = query.strip().lower()
    by_id = next((d for d in plan["drills"] if d["id"].lower() == q and not d.get("is_break")), None)
    return dict(by_id) if by_id else next((dict(d) for d in plan["drills"]
                                           if not d.get("is_break") and q and q in d["name"].lower()), None)


# ── replay ──────────────────────────────────────────────────────────────────

def read_hr_csv(path: str | Path) -> list[dict[str, Any]]:
    with open(path) as f:
        rows = [r for r in csv.DictReader(line for line in f if not line.startswith("#"))]
    return [{"athlete_id": r["athlete_id"], "ts": r["ts"], "hr_bpm": float(r["hr_bpm"]), "device": r.get("device", ""),
             "replay": True} for r in rows]


def replay(session: LiveSession, rows: Iterable[Mapping[str, Any]], *, speed: float | None = None,
           realtime: bool = False, reforecast: bool = True) -> list[dict[str, Any]]:
    """Feed readings in order; with ``realtime`` sleep (Δt / speed) between them. Every output is labelled replay."""
    speed = float(speed or _c("replay_speed"))
    outs, prev = [], None
    for r in rows:
        r = {**r, "replay": True}
        t = twonode.parse_time(r["ts"]).timestamp()
        if realtime and prev is not None:
            time.sleep(max(t - prev, 0.0) / speed)
        prev = t
        o = session.add_reading(r, reforecast=reforecast)
        if o["updated"]:
            outs.append(o)
    return outs


def main() -> None:
    import argparse
    from engine import fixtures
    ap = argparse.ArgumentParser(description="Replay an HR CSV through live calibration")
    ap.add_argument("csv")
    ap.add_argument("--speed", type=float, default=None)
    ap.add_argument("--realtime", action="store_true")
    a = ap.parse_args()
    s = LiveSession(fixtures.plan(), fixtures.roster(), fixtures.forecast(), extra_labels=["synthetic roster"])
    for o in replay(s, read_hr_csv(a.csv), speed=a.speed, realtime=a.realtime):
        g = o.get("gates", {})
        print(f"{o['athlete_id']} met_scale {o['calib']['met_scale']:.3f} ± {o['calib']['met_scale_sd']:.3f} | "
              f"{g.get('message', '')} held_by={g.get('held_by')} | replay")


if __name__ == "__main__":
    main()
