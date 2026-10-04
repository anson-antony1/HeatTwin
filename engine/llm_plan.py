"""Coach's words (typed or spoken) → draft PracticePlan, via Google Gemini.

PLAN.md "Runtime AI (not in the safety loop)": the coach describes practice in plain English, the LLM turns it into
CONTRACTS.md ``Drill[]``, the output is schema-validated, and **the coach confirms** before anything is simulated.
The LLM never sees athlete data and never produces heat-risk judgements; it only structures the coach's own plan.

Speech needs no separate model: Gemini takes the audio directly and returns the transcript and the drills in one
call. The browser records with MediaRecorder and converts to 16 kHz mono WAV (web/src/lib/useVoicePlan.ts), a format
Gemini accepts.

Key: ``GEMINI_API_KEY`` from the environment or the repo-root ``.env`` (gitignored — never commit it).
Model: ``GEMINI_MODEL`` (default below).
"""
from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import Any, Literal, Optional

from engine import consts
from pydantic import BaseModel, Field, ValidationError

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-3.1-flash-lite"   # cheapest that matched gemini-3.8-flash exactly on our text + voice tests (2026-10-03)
MAX_OUTPUT_TOKENS = 2048                 # caps cost per call; a 10-drill plan needs ~600-1100
TIMEOUT_S = 45.0
MAX_AUDIO_BYTES = 15 * 1024 * 1024        # Gemini inline-data limit is ~20 MB per request (base64 grows ~4/3)
AUDIO_MIME = {"audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"}
LABEL = "parsed by AI from the coach's description — coach must confirm"


class LLMNotConfigured(RuntimeError):
    pass


class LLMError(RuntimeError):
    pass


# ── key / model ──────────────────────────────────────────────────────────────

def _load_dotenv() -> None:
    """Minimal .env reader (KEY=VALUE lines) so no extra dependency is needed. Real env vars win."""
    path = Path(__file__).resolve().parents[1] / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _key() -> str:
    _load_dotenv()
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise LLMNotConfigured("GEMINI_API_KEY is not set (put it in .env at the repo root)")
    return key


def model_name() -> str:
    _load_dotenv()
    return os.environ.get("GEMINI_MODEL", DEFAULT_MODEL)


def status() -> dict[str, Any]:
    from engine import paid_api
    try:
        _key()
        configured = not paid_api.disabled()
    except LLMNotConfigured:
        configured = False
    return {"configured": configured, "provider": "google-gemini", "model": model_name(),
            "paid_apis_disabled": paid_api.disabled()}


def gate_gemini() -> None:
    """Kill switch (engine/paid_api.py): raise LLMNotConfigured before any Gemini request while paid APIs are off."""
    from engine import paid_api
    try:
        paid_api.gate("gemini")
    except paid_api.PaidAPIDisabled as e:
        raise LLMNotConfigured(str(e)) from e


# ── what the model must return ───────────────────────────────────────────────

INTENSITIES = ["rest", "light", "moderate", "hard", "max"]
GEARS = ["none", "helmet", "helmet_shoulder_pads", "full_pads"]

# Gemini structured-output schema (OpenAPI subset). Field meanings are in the instructions below.
RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "transcript": {"type": "STRING", "description": "What the coach said, verbatim (for typed input: the text)."},
        "start_time_local": {"type": "STRING", "nullable": True, "description": "Practice start as HH:MM 24 h if stated, else null."},
        "drills": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "duration_min": {"type": "NUMBER"},
                    "intensity": {"type": "STRING", "enum": INTENSITIES},
                    "gear": {"type": "STRING", "enum": GEARS},
                    "is_break": {"type": "BOOLEAN"},
                    "shade": {"type": "BOOLEAN"},
                    "priority": {"type": "INTEGER", "description": "1, 2 or 3"},
                    "movable": {"type": "BOOLEAN"},
                },
                "required": ["name", "duration_min", "intensity", "gear", "is_break", "shade", "priority", "movable"],
                "propertyOrdering": ["name", "duration_min", "intensity", "gear", "is_break", "shade", "priority", "movable"],
            },
        },
        "assumptions": {"type": "ARRAY", "items": {"type": "STRING"},
                        "description": "Every value you filled in that the coach did not say."},
        "unclear": {"type": "ARRAY", "items": {"type": "STRING"},
                    "description": "Anything you could not interpret; ask the coach."},
        "changes": {"type": "ARRAY", "items": {"type": "STRING"},
                    "description": "Editing an existing plan only: each change you made, one short sentence each."},
    },
    "required": ["transcript", "drills", "assumptions", "unclear"],
    "propertyOrdering": ["transcript", "start_time_local", "drills", "assumptions", "unclear", "changes"],
}

INSTRUCTIONS = """You turn a high school football coach's description of today's practice into a list of drills.
Only structure what the coach said. Do not add, remove, reorder, lengthen or shorten drills, and do not give safety,
heat or medical advice.

For each drill, in the order the coach said them:
- name: short, the coach's own words ("Individual period", "Inside run", "Water break").
- duration_min: minutes as stated. If a duration is missing, do not guess: use 0 and list it in "unclear".
- intensity: rest (standing, water break, walkthrough at a stand), light (warmup, stretching, calisthenics,
  walkthrough), moderate (individual/position drills, special teams, 7-on-7), hard (team period, inside run,
  scrimmage, live tackling), max (conditioning, sprints, gassers).
- gear: none (shorts/t-shirt), helmet (helmets only), helmet_shoulder_pads ("shells", helmet and shoulder pads),
  full_pads (full pads / full gear). If the coach states gear once for the practice, apply it to every drill until they
  change it. Water breaks keep the gear of the drill before them.
- is_break: true only for water/rest breaks. shade: true only if the coach says the break is in shade/under a tent.
- priority: 1 if the coach says it must happen or can't be cut, 3 if they say it's optional or can be cut, else 2.
- movable: false if the coach ties it to a time or order ("first", "always end with"), else true. A warmup at the start
  is movable=false.
Put in "assumptions" only what a coach would want to double-check (one short sentence each, at most 4): gear carried
over or inferred, how you read the start time, durations you inferred. Do not list intensity, priority or movable values
that follow from the rules above.
"transcript": verbatim words of the coach. "start_time_local": start time if stated, 24 h HH:MM, else null."""

# Appended when the coach is changing a plan that already exists (memory of the last session).
EDIT_INSTRUCTIONS = """EDITING AN EXISTING PLAN. The current plan is given below as JSON. The coach is now describing changes
to it ("add 20 minutes of jumping jacks at the end", "make team period 15 minutes", "drop special teams", "move
conditioning to the start"). Return the FULL updated drill list in order:
- Keep every drill the coach did not mention exactly as it is: same name, duration_min, intensity, gear, is_break,
  shade, priority, movable, in the same position.
- Apply only the changes the coach describes (add, remove, reorder, rename, change duration or gear). New drills follow
  the field rules above.
- If the coach instead describes a whole new practice from scratch ("today we're doing…" listing a full session),
  replace the plan with it.
- "changes": one short sentence per change you made. "assumptions": only values you filled in for new or changed
  drills. Do not list the unchanged drills anywhere.
- "start_time_local": the current plan's start unless the coach changes it."""


class ParsedDrill(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    duration_min: float = Field(ge=0, le=240)
    intensity: Literal["rest", "light", "moderate", "hard", "max"]
    gear: Literal["none", "helmet", "helmet_shoulder_pads", "full_pads"]
    is_break: bool
    shade: bool
    priority: Literal[1, 2, 3]
    movable: bool


class Parsed(BaseModel):
    transcript: str = ""
    start_time_local: Optional[str] = None
    drills: list[ParsedDrill]
    assumptions: list[str] = []
    unclear: list[str] = []
    changes: list[str] = []


# ── Gemini call ──────────────────────────────────────────────────────────────

def _call_gemini(parts: list[dict[str, Any]], editing: bool = False) -> str:
    """One generateContent call with JSON-constrained output; returns the JSON text."""
    import requests

    gate_gemini()
    body = {
        "systemInstruction": {"parts": [{"text": INSTRUCTIONS + ("\n\n" + EDIT_INSTRUCTIONS if editing else "")}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": RESPONSE_SCHEMA,
                             "temperature": 0.1, "maxOutputTokens": MAX_OUTPUT_TOKENS},
    }
    try:
        r = requests.post(API.format(model=model_name()), json=body, timeout=(float(consts.get("voice.connect_timeout_s")), TIMEOUT_S),
                          headers={"x-goog-api-key": _key(), "Content-Type": "application/json"})
    except requests.RequestException as e:
        raise LLMError(f"Gemini unreachable: {type(e).__name__}") from e
    if r.status_code != 200:
        msg = r.json().get("error", {}).get("message", r.text[:200]) if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
        raise LLMError(f"Gemini HTTP {r.status_code}: {msg}")
    data = r.json()
    try:
        return "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
    except (KeyError, IndexError) as e:
        reason = (data.get("promptFeedback") or {}).get("blockReason") or (data.get("candidates") or [{}])[0].get("finishReason")
        raise LLMError(f"Gemini returned no content ({reason})") from e


def _parse(parts: list[dict[str, Any]], editing: bool = False) -> Parsed:
    last: Exception | None = None
    for _ in range(2):                                     # one retry on malformed output
        text = _call_gemini(parts, editing=True) if editing else _call_gemini(parts)
        try:
            return Parsed.model_validate(json.loads(text))
        except (json.JSONDecodeError, ValidationError) as e:
            last = e
    raise LLMError(f"Gemini output did not match the drill schema: {last}")


# ── public API ───────────────────────────────────────────────────────────────

def _current_plan_part(current_plan: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """The plan being edited, trimmed to the fields the model works with."""
    if not current_plan or not current_plan.get("drills"):
        return []
    keep = ("name", "duration_min", "intensity", "gear", "is_break", "shade", "priority", "movable")
    drills = [{k: d[k] for k in keep if k in d} for d in current_plan["drills"]]
    start = str(current_plan.get("start", ""))[11:16] or None
    return [{"text": "Current plan (edit this):\n" + json.dumps({"start_time_local": start, "drills": drills})}]


def parse_text(text: str, current_plan: Optional[dict[str, Any]] = None, **plan_kw) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        raise ValueError("text is empty")
    ctx = _current_plan_part(current_plan)
    label = "Coach's changes:" if ctx else "Coach's practice description:"
    parsed = _parse(ctx + [{"text": f"{label}\n{text}"}], editing=bool(ctx))
    return draft_plan(parsed, current_plan=current_plan if ctx else None, **plan_kw)


def parse_audio(audio: bytes, mime_type: str, current_plan: Optional[dict[str, Any]] = None,
                **plan_kw) -> dict[str, Any]:
    mime = mime_type.split(";")[0].strip().lower()
    if mime not in AUDIO_MIME:
        raise ValueError(f"unsupported audio type {mime_type!r}; send WAV (see web/src/lib/useVoicePlan.ts)")
    if not audio:
        raise ValueError("audio is empty")
    if len(audio) > MAX_AUDIO_BYTES:
        raise ValueError("audio too long; keep the description under ~5 minutes")
    ctx = _current_plan_part(current_plan)
    ask = ("The audio is the coach describing changes to the current plan. Transcribe it and return the updated drills."
           if ctx else "The audio is the coach describing today's practice. Transcribe it and extract the drills.")
    parts = ctx + [{"inline_data": {"mime_type": mime, "data": base64.b64encode(audio).decode()}}, {"text": ask}]
    return draft_plan(_parse(parts, editing=bool(ctx)), current_plan=current_plan if ctx else None, **plan_kw)


_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def draft_plan(p: Parsed, site: Optional[dict[str, Any]] = None, date: Optional[str] = None,
               start: Optional[str] = None, plan_id: str = "plan-voice-1",
               current_plan: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Parsed LLM output → {plan (CONTRACTS.md PracticePlan), transcript, assumptions, unclear, labels, ...}.

    ``start`` (full ISO time) wins over the spoken start time; otherwise ``date`` (YYYY-MM-DD) + spoken HH:MM; site,
    date and start default to the fixture plan's. Drills with no stated duration are dropped from the plan and named
    in ``unclear`` so the coach fills them in.
    """
    from engine import fixtures, guard

    base = fixtures.plan()
    site = site or (current_plan or {}).get("site") or base["site"]
    unclear = list(p.unclear)
    if start is None and current_plan and not p.start_time_local and current_plan.get("start"):
        start = current_plan["start"]                      # editing: the start time carries over
    if start is None:
        day = date or base["start"][:10]
        tz = base["start"][19:] or "-04:00"
        hhmm = (p.start_time_local or "").strip()
        m = _HHMM.match(hhmm)
        start = f"{day}T{int(m.group(1)):02d}:{m.group(2)}:00{tz}" if m else base["start"].replace(base["start"][:10], day)
        if not m:
            unclear.append("Start time not stated; using the default start time.")

    drills, n_drill, n_break = [], 0, 0
    for d in p.drills:
        if d.duration_min <= 0:
            if not any(d.name.lower() in u.lower() for u in unclear):   # the model may already have said so
                unclear.append(f"No duration for \"{d.name}\".")
            continue
        if d.is_break:
            n_break += 1
            did = f"b{n_break}"
        else:
            n_drill += 1
            did = f"d{n_drill}"
        drills.append({"id": did, "name": d.name, "duration_min": round(float(d.duration_min), 1),
                       "intensity": "rest" if d.is_break else d.intensity, "gear": d.gear, "shade": d.shade,
                       "is_break": d.is_break, "priority": d.priority, "movable": d.movable})

    g = lambda items, src: [guard.check(s, source=src)["redacted_text"] for s in items]  # noqa: E731
    return {
        "plan": {"id": plan_id, "site": site, "start": start, "drills": drills},
        "transcript": p.transcript,
        "assumptions": g(p.assumptions, "llm_plan.assumptions"),
        "unclear": g(unclear, "llm_plan.unclear"),
        "changes": g(p.changes, "llm_plan.changes") if current_plan else [],
        "edited": bool(current_plan),
        "total_min": round(sum(d["duration_min"] for d in drills), 1),
        "needs_confirmation": True,
        "labels": [LABEL],
        "model": model_name(),
    }
