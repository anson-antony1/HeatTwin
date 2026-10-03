"""HeatTwin engine API (FastAPI). Shapes follow CONTRACTS.md; extra fields are additive.

    uvicorn engine.api:app --reload --port 8000

POST /simulate  {plan?, roster?, weather?, step_min?, n_ensemble?, seed?}           → SimulationResult
POST /optimize  {plan?, roster?, weather?, budget_s?, seed?, n_ensemble?}           → OptimizeResult
GET  /sources                                                                       → constants.yaml as JSON
GET  /health

Missing ``plan``/``roster`` fall back to fixtures/plan.json and fixtures/roster.json (labelled synthetic).
Missing ``weather`` uses the cached NWS fixture forecast (labelled "forecast is fixture"). Live NWS (WS1
engine.weather.get_forecast) is opt-in with HEATTWIN_WEATHER=live and is never used with ``?demo=1``, so demo numbers are
reproducible with the network off. Every result is labelled "estimate — planning only".
"""
from __future__ import annotations

import os
from datetime import timedelta
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from engine import consts, fixtures, node_routes, optimizer
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


def _inputs(req: SimulateRequest, demo_mode: bool = False, node_scenario: bool = False
            ) -> tuple[dict, list[dict], list[dict], list[str]]:
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
    weather = ([_dump(h) for h in req.weather] if req.weather is not None
               else _forecast_for(plan, labels, demo_mode, node_scenario))
    return plan, roster, weather, labels


def weather_mode(demo_mode: bool = False) -> str:
    """'fixture' (default, and always with ?demo=1) or 'live' (HEATTWIN_WEATHER=live: WS1 NWS fetch)."""
    return "live" if not demo_mode and os.environ.get("HEATTWIN_WEATHER", "").lower() == "live" else "fixture"


def _forecast_for(plan: dict, labels: list[str], demo_mode: bool = False, node_scenario: bool = False) -> list[dict]:
    """Weather for a plan, in order: ?demo=1 → the pinned saved forecast (always); node_scenario (live session or
    ?source=node) and the indoor node demo running → its labelled scenario weather; HEATTWIN_WEATHER=live → live NWS;
    else the saved forecast. Live falls back to the saved forecast."""
    t0 = twonode.parse_time(plan["start"])
    minutes = sum(float(d["duration_min"]) for d in plan["drills"]) + consts.get("optimizer.max_added_minutes")
    t1 = t0 + timedelta(minutes=minutes)
    if demo_mode:  # ?demo=1: always the pinned saved forecast, even while the node demo runs
        labels.append("demo mode: forecast pinned to the cached NWS fixture")
        return _fixture_hours(t0, t1, labels)
    if node_scenario:  # live session or ?source=node: the indoor node demo's scenario weather, when it is running
        scenario = node_routes.demo_weather(t0, t1)
        if scenario:
            labels.append(node_routes.DEMO_LABEL)
            return scenario
    if weather_mode() == "live":
        try:
            from engine import weather as ws1  # WS1
            hours = ws1.get_forecast(plan["site"]["lat"], plan["site"]["lon"])
            hours = [h.model_dump() if hasattr(h, "model_dump") else dict(h) for h in hours]
            ts = [twonode.parse_time(h["time"]) for h in hours]
            if hours and min(ts) <= t0 and max(ts) + timedelta(hours=1) >= t1:
                if any(h.get("source") == "fixture" for h in hours):
                    labels.append("forecast is fixture")
                return hours
        except Exception:  # noqa: BLE001 — any WS1 failure falls back to the cached fixture
            pass
        labels.append("live forecast unavailable; cached NWS fixture used")
    return _fixture_hours(t0, t1, labels)


def _fixture_hours(t0, t1, labels: list[str]) -> list[dict]:
    hours = fixtures.forecast()
    ts = [twonode.parse_time(h["time"]) for h in hours]
    if not (min(ts) <= t0 and max(ts) + timedelta(hours=1) >= t1):
        labels.append("fixture forecast does not cover the plan window; nearest hours used")
    return hours


def _plan_roster(req: SimulateRequest) -> tuple[dict, list[dict]]:
    """Plan and roster only (no forecast needed), with the same fixture fallbacks as _inputs."""
    plan = _dump(req.plan) if req.plan is not None else fixtures.plan()
    roster = [_dump(a) for a in req.roster] if req.roster is not None else fixtures.roster()
    return plan, roster


def _demo_req(req: SimulateRequest, demo_mode: bool) -> SimulateRequest:
    """Demo mode: the fixed seed and ensemble size from constants.demo_mode."""
    if not demo_mode:
        return req
    dm = consts.get("demo_mode")
    return req.model_copy(update={"seed": int(dm["seed"]), "n_ensemble": int(dm["n_ensemble"])})


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


class LiveReplayRequest(SimulateRequest):
    file: Optional[str] = Field(default=None, description="v1.3: HR file under fixtures/; default newest real, else synthetic")


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
    return {"ok": True, "model": twonode.MODEL_NAME, "fhsaa": "stub" if fhsaa_adapter.USING_STUB else "ws1",
            "weather": weather_mode()}


@app.post("/simulate")
def simulate(req: SimulateRequest | None = None,
             demo_mode: bool = Query(False, alias="demo", description="fixed seed + pinned saved forecast"),
             source: str = Query("auto", description="auto | node (use the indoor node demo's scenario weather)")
             ) -> dict[str, Any]:
    req = _demo_req(req or SimulateRequest(), demo_mode)
    plan, roster, weather, labels = _inputs(req, demo_mode, node_scenario=source == "node")
    return _guard(twonode.simulate_roster(roster, plan, weather, step_min=req.step_min, n_ensemble=req.n_ensemble,
                                          seed=req.seed, extra_labels=labels, settings=_settings(req)))


@app.post("/optimize")
def optimize(req: OptimizeRequest | None = None,
             demo_mode: bool = Query(False, alias="demo", description="fixed seed + fixed iteration cap instead of a time budget"),
             preset: str = Query("max_load", description="max_load | fewest_changes (cap of changes, maximize load)"),
             source: str = Query("auto", description="auto | node (use the indoor node demo's scenario weather)")
             ) -> dict[str, Any]:
    req = req or OptimizeRequest()
    key = None
    if demo_mode:  # demo runs are deterministic (pinned forecast, fixed seed) → cache identical requests
        key = (preset, req.model_dump_json())
        if key in _DEMO_CACHE:
            return _DEMO_CACHE[key]
    plan, roster, weather, labels = _inputs(req, demo_mode, node_scenario=source == "node")
    try:
        res = optimizer.optimize(plan, roster, weather, budget_s=req.budget_s, seed=req.seed,
                                 n_ensemble=req.n_ensemble, step_min=req.step_min, extra_labels=labels,
                                 settings=_settings(req), demo=demo_mode, preset=preset)
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
    plan, roster, weather, labels = _inputs(req, node_scenario=True)   # Live mode: node demo scenario if running
    if req.start_now:
        from datetime import datetime
        plan = dict(plan, start=datetime.now().astimezone().replace(second=0, microsecond=0).isoformat())
        labels = [*labels, "plan clock set to now for a live HR session"]
        if req.weather is None:
            labels = [x for x in labels if x not in ("forecast is fixture", node_routes.DEMO_LABEL)]
            weather = _forecast_for(plan, labels, node_scenario=True)
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


class WhatIfRequest(SimulateRequest):
    change: dict[str, Any]


class AthleteStatusRequest(SimulateRequest):
    athlete: str = Field(min_length=1, description="v1.3: athlete id or name on the roster")


class VoiceIntentRequest(SimulateRequest):
    text: Optional[str] = Field(default=None, max_length=2000)
    audio_b64: Optional[str] = None
    mime_type: str = "audio/wav"


class VoiceAnswerRequest(SimulateRequest):
    intent: Literal["plan_summary", "optimize", "what_if", "athlete_status", "field_conditions", "unknown"]
    slots: dict[str, Any] = Field(default_factory=dict)


class TtsRequest(_Model):
    text: str = Field(min_length=1, max_length=2000)


@app.post("/what_if")
def what_if(req: WhatIfRequest, demo_mode: bool = Query(False, alias="demo", description="fixed seed (demo mode)")) -> dict[str, Any]:
    """v1.2 voice tool: one plan edit → before/after team summary (numbers only + a guarded sentence)."""
    from engine import voice_tools
    req = _demo_req(req, demo_mode)
    plan, roster, weather, labels = _inputs(req, demo_mode)
    try:
        return voice_tools.what_if(roster, plan, weather, req.change, settings=_settings(req), seed=req.seed,
                                   n_ensemble=req.n_ensemble, extra_labels=labels)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


def _athlete_status(req: SimulateRequest, athlete: str, demo_mode: bool) -> dict[str, Any]:
    from engine import voice_tools
    req = _demo_req(req, demo_mode)
    plan, roster, weather, labels = _inputs(req, demo_mode)
    res = twonode.simulate_roster(roster, plan, weather, n_ensemble=req.n_ensemble, seed=req.seed, extra_labels=labels,
                                  settings=_settings(req))
    try:
        return voice_tools.athlete_status(res, roster, athlete)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


def _field_conditions(req: SimulateRequest, demo_mode: bool) -> dict[str, Any]:
    from engine import voice_tools
    req = _demo_req(req, demo_mode)
    plan, roster, weather, labels = _inputs(req, demo_mode)
    res = twonode.simulate_roster(roster[:1], plan, weather, n_ensemble=req.n_ensemble, seed=req.seed,
                                  extra_labels=labels, settings=_settings(req))
    return voice_tools.field_conditions(res)


@app.get("/athlete_status")
def athlete_status(athlete_id: str, demo_mode: bool = Query(True, alias="demo")) -> dict[str, Any]:
    """v1.2 voice tool: one athlete's estimate on the fixture plan (use POST to send the plan on screen)."""
    return _athlete_status(SimulateRequest(), athlete_id, demo_mode)


@app.post("/athlete_status")
def athlete_status_post(req: AthleteStatusRequest, demo_mode: bool = Query(False, alias="demo")) -> dict[str, Any]:
    """v1.3: one athlete's estimate on the plan sent (the plan on screen)."""
    return _athlete_status(req, req.athlete, demo_mode)


@app.get("/field_conditions")
def field_conditions(demo_mode: bool = Query(True, alias="demo")) -> dict[str, Any]:
    """v1.2 voice tool: hourly WBGT / FHSAA zone over the fixture plan's window (use POST for the plan on screen)."""
    return _field_conditions(SimulateRequest(), demo_mode)


@app.post("/field_conditions")
def field_conditions_post(req: SimulateRequest | None = None, demo_mode: bool = Query(False, alias="demo")) -> dict[str, Any]:
    """v1.3: hourly WBGT / FHSAA zone over the window of the plan sent."""
    return _field_conditions(req or SimulateRequest(), demo_mode)


# ── voice Q&A (v1.3): Gemini routes, the engine answers ──

@app.post("/voice/intent")
def voice_intent(req: VoiceIntentRequest) -> dict[str, Any]:
    """Gemini → {transcript, intent, slots} only (schema-validated); names resolved against the plan sent."""
    import base64
    import binascii
    from engine import llm_plan, voice
    plan, roster = _plan_roster(req)
    audio = None
    if req.audio_b64:
        try:
            audio = base64.b64decode(req.audio_b64, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(422, "audio_b64 is not valid base64") from e
    try:
        return voice.parse_intent(text=req.text, audio=audio, mime_type=req.mime_type, plan=plan, roster=roster)
    except llm_plan.LLMNotConfigured as e:
        raise HTTPException(503, str(e)) from e
    except llm_plan.LLMError as e:
        raise HTTPException(502, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@app.post("/voice/answer")
def voice_answer(req: VoiceAnswerRequest, demo_mode: bool = Query(False, alias="demo", description="fixed seed (demo mode)")
                 ) -> dict[str, Any]:
    """The engine runs the tool for an intent and writes the (guarded) sentence; `numbers` = every number in it."""
    from engine import voice, voice_tools
    s = req.slots or {}
    base = SimulateRequest(**req.model_dump(include={"plan", "roster", "weather", "step_min", "n_ensemble", "seed",
                                                     "settings"}, exclude_none=True))
    if req.intent == "plan_summary":
        out = voice_tools.plan_summary(simulate(base, demo_mode=demo_mode))
    elif req.intent == "optimize":
        preset = s.get("preset") if s.get("preset") in ("max_load", "fewest_changes") else "max_load"
        out = voice_tools.optimize_summary(optimize(OptimizeRequest(**base.model_dump(exclude_none=True)), demo_mode=demo_mode,
                                                    preset=preset))
    elif req.intent == "athlete_status":
        if not s.get("athlete_id"):
            return voice.finish("athlete_status", voice.ask_back(["athlete"]), {}, [twonode.ESTIMATE_LABEL])
        out = _athlete_status(base, s["athlete_id"], demo_mode)
    elif req.intent == "field_conditions":
        out = _field_conditions(base, demo_mode)
    elif req.intent == "what_if":
        missing = [k for k in ("drill_id", "change") if not s.get(k)]
        try:
            change = voice.change_from_slots(s) if not missing else None
        except KeyError as e:
            missing.append(str(e).strip("'"))
            change = None
        if change is None:
            return voice.finish("what_if", voice.ask_back(missing), {}, [twonode.ESTIMATE_LABEL])
        out = what_if(WhatIfRequest(**base.model_dump(exclude_none=True), change=change), demo_mode=demo_mode)
    else:
        return voice.finish("unknown", voice.UNKNOWN_SAY, {}, [twonode.ESTIMATE_LABEL])
    data = {k: v for k, v in out.items() if k not in ("say", "labels")}
    return voice.finish(req.intent, out["say"], data, out.get("labels", [twonode.ESTIMATE_LABEL]))


@app.post("/voice/tts")
def voice_tts(req: TtsRequest):
    """ElevenLabs TTS for an approved sentence. Re-guarded here: 422 on a guard hit; 503 when TTS is unavailable."""
    from fastapi.responses import Response
    from engine import guard, voice
    g = guard.check(req.text, source="voice.tts")
    if not g["ok"]:
        raise HTTPException(422, "text did not pass the language guard")
    try:
        return Response(content=voice.tts(req.text), media_type="audio/mpeg")
    except voice.TTSUnavailable as e:
        raise HTTPException(503, str(e)) from e


@app.get("/demo/inputs")
def demo_inputs() -> dict[str, Any]:
    """v1.3: the plan, roster and weather that /simulate?demo=1 uses with no body (so the web shows the same ones)."""
    plan, roster, weather, labels = _inputs(SimulateRequest(), demo_mode=True)
    srcs = {h.get("source") for h in weather}
    if "fixture" in srcs and "forecast is fixture" not in labels:
        labels.append("forecast is fixture")
    return {"plan": plan, "roster": roster, "weather": weather, "labels": [twonode.ESTIMATE_LABEL, *labels],
            "synthetic": {"plan": fixtures.plan_is_synthetic(), "roster": fixtures.roster_is_synthetic(),
                          "weather": "fixture" in srcs and bool(fixtures.forecast_meta().get("synthetic", False))}}


_REPLAY_CACHE: dict[str, dict[str, Any]] = {}


@app.post("/live/replay")
def live_replay(req: LiveReplayRequest | None = None, demo_mode: bool = Query(False, alias="demo", description="fixed seed (demo mode)")
                ) -> dict[str, Any]:
    """v1.3: replay a recorded (or the synthetic) HR file through live calibration → per-update frames (deterministic)."""
    from engine import demo_data
    req = _demo_req(req or LiveReplayRequest(), demo_mode)
    key = f"{demo_mode}|{req.model_dump_json()}"
    if key in _REPLAY_CACHE:
        return _REPLAY_CACHE[key]
    plan, roster, weather, labels = _inputs(req, demo_mode)
    try:
        out = demo_data.run_replay(plan, roster, weather, settings=_settings(req), seed=req.seed,
                                   n_ensemble=req.n_ensemble, extra_labels=labels, file=req.file)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    out["plan_forecast"] = _guard(out["plan_forecast"])
    from engine import guard
    out["labels"] = guard.guard_strings(out["labels"], "replay")
    _REPLAY_CACHE[key] = out
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


# Coach plan entry by text/voice via Gemini (engine/llm_routes.py)
from engine import llm_routes  # noqa: E402
app.include_router(llm_routes.router)

from engine import weather_routes  # noqa: E402 — live conditions for the web app (WS1 forecast)

app.include_router(weather_routes.router)

# Sideline node (engine/node_routes.py): POST /node, GET /node/latest, GET /node/history.
app.include_router(node_routes.router)


def _on_node_demo_update() -> dict | None:
    """A node demo reading changed the scenario: refresh the live session's weather and re-forecast it."""
    s = _LIVE.get("session")
    if s is None:
        return None
    t0 = twonode.parse_time(s.plan["start"])
    minutes = sum(float(d["duration_min"]) for d in s.plan["drills"])
    scenario = node_routes.demo_weather(t0, t0 + timedelta(minutes=minutes))
    if not scenario:
        return None
    s.weather = scenario
    if node_routes.DEMO_LABEL not in s.extra_labels:
        s.extra_labels = [*s.extra_labels, node_routes.DEMO_LABEL]
    return _guard(s.reforecast())


node_routes.on_demo_update = _on_node_demo_update
