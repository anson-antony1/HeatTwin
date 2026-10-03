"""HeatTwin engine API (FastAPI). Shapes follow CONTRACTS.md; extra fields are additive.

    uvicorn engine.api:app --reload --port 8000

POST /simulate  {plan?, roster?, weather?, step_min?, n_ensemble?, seed?}           → SimulationResult
POST /optimize  {plan?, roster?, weather?, budget_s?, seed?, n_ensemble?}           → OptimizeResult
GET  /sources                                                                       → constants.yaml as JSON
GET  /health

Missing ``plan``/``roster`` fall back to fixtures/plan.json and fixtures/roster.json (labelled synthetic).
Missing ``weather`` uses WS1's engine.weather.get_forecast when it exists and covers the plan, otherwise the cached
NWS fixture forecast (labelled "forecast is fixture"). Every result is labelled "estimate — planning only".
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from engine import consts, fixtures, optimizer
from engine import settings as at_settings
from engine.physio import twonode

app = FastAPI(title="HeatTwin engine", version="0.1.0",
              description="Per-athlete heat-strain estimates for practice planning. Estimate — planning only.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── request shapes (CONTRACTS.md; extra fields allowed so additive changes don't break callers) ──

class _Model(BaseModel):
    model_config = ConfigDict(extra="allow")


class AthleteCalibration(_Model):
    met_scale: float
    met_scale_sd: float
    thermo_scale: float
    thermo_scale_sd: float
    n_sessions: int
    updated_at: str


class Athlete(_Model):
    id: str
    name: str
    position: Optional[str] = None
    height_m: float = Field(gt=0)
    mass_kg: float = Field(gt=0)
    age_yr: float = Field(gt=0)
    sex: Literal["male", "female"]
    body_fat_pct: Optional[float] = None
    hr_rest_bpm: Optional[float] = None
    hr_max_bpm: Optional[float] = None
    acclimatization_day: float = Field(ge=1)
    days_since_last_heat_session: Optional[float] = None
    flags: Optional[list[str]] = None
    calib: Optional[AthleteCalibration] = None


class Drill(_Model):
    id: str
    name: str
    duration_min: float = Field(gt=0)
    intensity: Literal["rest", "light", "moderate", "hard", "max"]
    met_override: Optional[float] = Field(default=None, gt=0)
    gear: Literal["none", "helmet", "helmet_shoulder_pads", "full_pads"]
    shade: bool
    is_break: bool
    priority: Literal[1, 2, 3]
    movable: bool
    participants: Optional[list[str]] = None


class Site(_Model):
    name: str
    lat: float
    lon: float
    surface: Literal["grass", "turf"]


class PracticePlan(_Model):
    id: str
    site: Site
    start: str
    drills: list[Drill] = Field(min_length=1)


class WeatherHour(_Model):
    time: str
    air_temp_c: float
    rh_pct: float = Field(ge=0, le=100)
    wind_m_s: float = Field(ge=0)
    cloud_cover_pct: float = Field(ge=0, le=100)
    solar_w_m2: Optional[float] = None
    wbgt_f: float
    fhsaa_zone: Literal[1, 2, 3, 4, 5]
    source: Literal["nws_forecast", "field_node", "assimilated", "fixture"]


class SimulateRequest(_Model):
    plan: Optional[PracticePlan] = None
    roster: Optional[list[Athlete]] = None
    weather: Optional[list[WeatherHour]] = None
    step_min: float = Field(default=1.0, gt=0, le=5)
    n_ensemble: int = Field(default=30, ge=5, le=500)
    seed: int = 0
    settings: Optional[dict[str, Any]] = Field(default=None, description="AT-owned overrides; see GET /settings")


class OptimizeRequest(SimulateRequest):
    budget_s: Optional[float] = Field(default=None, gt=0, le=60)


# ── helpers ──

def _dump(x):
    return x.model_dump(exclude_none=True) if hasattr(x, "model_dump") else x


def _inputs(req: SimulateRequest) -> tuple[dict, list[dict], list[dict], list[str]]:
    labels: list[str] = []
    if req.plan is not None:
        plan = _dump(req.plan)
    else:
        plan = fixtures.plan()
        labels.append("synthetic plan (fixture)")
    if req.roster is not None:
        roster = [_dump(a) for a in req.roster]
    else:
        roster = fixtures.roster()
        if fixtures.roster_is_synthetic():
            labels.append("synthetic roster")
    if not roster:
        raise HTTPException(422, "roster is empty")
    ids = {a["id"] for a in roster}
    for d in plan["drills"]:
        unknown = set(d.get("participants") or []) - ids
        if unknown:
            raise HTTPException(422, f"drill {d['id']} lists participants not on the roster: {sorted(unknown)}")
    weather = [_dump(h) for h in req.weather] if req.weather is not None else _forecast_for(plan, labels)
    return plan, roster, weather, labels


def _forecast_for(plan: dict, labels: list[str]) -> list[dict]:
    """WS1 live forecast if available and covering the plan window, else the cached NWS fixture."""
    t0 = twonode.parse_time(plan["start"])
    minutes = sum(float(d["duration_min"]) for d in plan["drills"]) + consts.get("optimizer.max_added_minutes")
    t1 = t0 + timedelta(minutes=minutes)
    try:
        from engine import weather as ws1  # WS1, may not exist yet
        hours = ws1.get_forecast(plan["site"]["lat"], plan["site"]["lon"])
        hours = [h.model_dump() if hasattr(h, "model_dump") else dict(h) for h in hours]
        ts = [twonode.parse_time(h["time"]) for h in hours]
        if hours and min(ts) <= t0 and max(ts) + timedelta(hours=1) >= t1:
            if any(h.get("source") == "fixture" for h in hours):
                labels.append("forecast is fixture")
            return hours
    except Exception:  # noqa: BLE001 — any WS1 failure falls back to the cached fixture
        pass
    hours = fixtures.forecast()
    ts = [twonode.parse_time(h["time"]) for h in hours]
    if not (min(ts) <= t0 and max(ts) + timedelta(hours=1) >= t1):
        labels.append("fixture forecast does not cover the plan window; nearest hours used")
    return hours


def _settings(req: SimulateRequest) -> at_settings.AtSettings:
    try:
        return at_settings.resolve(req.settings)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


def _guard(result: dict) -> dict:
    """Every generated sentence passes engine/guard.py (redacted + logged on a hit)."""
    from engine import guard
    return guard.guard_result(result)


class GuardRequest(_Model):
    text: str


class HrReading(_Model):
    athlete_id: str
    ts: str
    hr_bpm: float
    device: Optional[str] = None
    replay: bool = False


class LiveStart(SimulateRequest):
    start_now: bool = Field(default=False, description="v1.1: set the plan start to now (live HR from a strap)")


_LIVE: dict[str, Any] = {}
_DEMO_CACHE: dict[tuple, dict] = {}


def _live_session():
    from engine.calibrate import LiveSession
    if "session" not in _LIVE:
        req = SimulateRequest()
        plan, roster, weather, labels = _inputs(req)
        _LIVE["session"] = LiveSession(plan, roster, weather, extra_labels=labels)
    return _LIVE["session"]


# ── routes ──

@app.get("/health")
def health() -> dict[str, Any]:
    from engine import fhsaa_adapter
    return {"ok": True, "model": twonode.MODEL_NAME, "fhsaa": "stub" if fhsaa_adapter.USING_STUB else "ws1"}


@app.post("/simulate")
def simulate(req: SimulateRequest | None = None, demo: bool = Query(False, description="fixed seed (demo mode)")
             ) -> dict[str, Any]:
    req = req or SimulateRequest()
    if demo:
        dm = consts.get("demo_mode")
        req = req.model_copy(update={"seed": int(dm["seed"]), "n_ensemble": int(dm["n_ensemble"])})
    plan, roster, weather, labels = _inputs(req)
    return _guard(twonode.simulate_roster(roster, plan, weather, step_min=req.step_min, n_ensemble=req.n_ensemble,
                                          seed=req.seed, extra_labels=labels, settings=_settings(req)))


@app.post("/optimize")
def optimize(req: OptimizeRequest | None = None,
             demo: bool = Query(False, description="fixed seed + fixed iteration cap instead of a time budget"),
             preset: str = Query("max_load", description="max_load | fewest_changes (cap of changes, maximize load)")
             ) -> dict[str, Any]:
    req = req or OptimizeRequest()
    key = None
    if demo:  # demo runs are deterministic → cache identical requests (warm before presenting)
        key = (preset, req.model_dump_json())
        if key in _DEMO_CACHE:
            return _DEMO_CACHE[key]
    plan, roster, weather, labels = _inputs(req)
    try:
        res = optimizer.optimize(plan, roster, weather, budget_s=req.budget_s, seed=req.seed,
                                 n_ensemble=req.n_ensemble, step_min=req.step_min, extra_labels=labels,
                                 settings=_settings(req), demo=demo, preset=preset)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    res = _guard(res)
    if key is not None:
        _DEMO_CACHE[key] = res
    return res


@app.post("/live/start")
def live_start(req: LiveStart | None = None) -> dict[str, Any]:
    """v1.1: start a live session for /hr (defaults to fixtures). Resets calibration state."""
    from engine.calibrate import LiveSession
    req = req or LiveStart()
    plan, roster, weather, labels = _inputs(req)
    if req.start_now:
        from datetime import datetime
        plan = dict(plan, start=datetime.now().astimezone().replace(second=0, microsecond=0).isoformat())
        labels = [*labels, "plan clock set to now for a live HR session"]
        if req.weather is None:
            weather = _forecast_for(plan, labels)
    _LIVE["session"] = LiveSession(plan, roster, weather, settings=_settings(req), seed=req.seed, extra_labels=labels)
    return {"ok": True, "plan_id": plan["id"], "start": plan["start"], "athletes": [a["id"] for a in roster],
            "labels": labels}


@app.post("/hr")
def hr(reading: HrReading) -> dict[str, Any]:
    """Live HR → {athlete_id, calib, reforecast: SimulationResult, gates, labels} (CONTRACTS; gates/labels v1.1)."""
    try:
        out = _live_session().add_reading(_dump(reading))
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    if "reforecast" in out:
        out["reforecast"] = _guard(out["reforecast"])
    out["labels"] = __import__("engine.guard", fromlist=["guard_strings"]).guard_strings(out["labels"], "hr")
    return out


@app.post("/guard")
def guard_text(req: GuardRequest) -> dict[str, Any]:
    from engine import guard
    return guard.check(req.text, source="api")


@app.get("/settings")
def settings() -> dict[str, Any]:
    """AT-owned settings: defaults, sources and allowed values. Override any of them via ``settings`` in a request."""
    return {"owner": "athletic trainer", "settings": at_settings.resolve().describe()}


@app.get("/sources")
def sources() -> dict[str, Any]:
    return consts.as_json()
