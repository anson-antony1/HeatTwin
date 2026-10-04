"""Voice Q&A (CONTRACTS v1.3): /voice/intent → /voice/answer → /voice/tts.

* ``parse_intent``: Gemini transcribes (audio) and classifies the question into ``{intent, slots}`` against a JSON schema.
  It returns names only; the engine validates the output and resolves drill/athlete names against the plan on screen.
  Nothing numeric that Gemini returns is ever shown — slot numbers (minutes, position) are checked and used as inputs.
* ``answer``: the engine runs the tool and writes the sentence (engine/voice_tools.py), already passed through
  engine/guard.py; ``numbers`` lists every number token in that sentence, so the app can check the answer it displays
  or speaks contains no other number (per-answer ledger).
* ``tts``: ElevenLabs text-to-speech for an approved sentence; the key stays on the engine (.env).
"""
from __future__ import annotations

import base64
import json
import os
import re
from typing import Any, Literal, Mapping, Optional, Sequence

from pydantic import BaseModel, Field, ValidationError

from engine import consts, guard, llm_plan, voice_tools

INTENTS = ("plan_summary", "optimize", "what_if", "athlete_status", "field_conditions", "unknown")
CHANGES = ("gear", "duration", "shade", "intensity", "remove", "add_break", "move")
LABEL = "intent parsed by AI — numbers come from the engine"
# Questions HeatTwin must not answer with a judgement (CLAUDE.md rule 4). The first matching kind wins; the boundary
# sentence comes before any estimate, and on its own when there is nothing to estimate.
BOUNDARIES: list[tuple[str, re.Pattern, str]] = [
    ("medication", re.compile(r"\b(ibuprofen|advil|motrin|tylenol|acetaminophen|aspirin|aleve|naproxen|medicines?|"
                              r"medications?|meds|pills?|drugs?|dose)\b", re.I),
     "HeatTwin can't advise on that — ask your athletic trainer or a physician."),
    ("diagnosis", re.compile(r"\b(heat ?stroke|heat exhaustion|heat illness|heat cramps?|dehydrated|sick|ill|"
                             r"concussion|does \w+ have|what'?s wrong)\b", re.I),
     "HeatTwin can't tell what is wrong with an athlete. If you are worried about an athlete, follow your school's "
     "emergency action plan and get your athletic trainer."),
    ("treatment", re.compile(r"\b(ice|ice bath|cold ?tub|cool (him|her|them) down|immerse|911|ambulance|ems|"
                             r"need (water|fluids)|give (him|her|them))\b", re.I),
     "HeatTwin doesn't make care decisions. If you are worried about an athlete, follow your school's emergency "
     "action plan; Collapse mode reads the KSI cold-water-immersion steps."),
    ("clearance", re.compile(r"\b(safe|fine|ok|okay|cleared?|good to go|all right|alright|healthy|in danger|danger|"
                             r"keep (playing|practicing|going)|go back in|return to play|sit (out|him|her)|pull (him|her|"
                             r"them|\w+ out)|should (i|we) (pull|stop|bench|rest)|stop practice|continue practice|"
                             r"can (we|they|he|she|\w+) (continue|keep|play|practice|go))\b", re.I),
     "HeatTwin can't clear an athlete or decide whether practice continues — that call belongs to your athletic "
     "trainer."),
]


def boundary_for(question: Optional[str]) -> Optional[tuple[str, str]]:
    """(kind, sentence) when the question asks HeatTwin to clear, diagnose, treat or medicate; else None."""
    for kind, rx, sentence in BOUNDARIES:
        if question and rx.search(question):
            return kind, sentence
    return None
UNKNOWN_SAY = ("I can answer about the whole plan, one athlete, the field conditions, or a what-if change to one drill. "
               "Estimate, planning only.")

INTENT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "transcript": {"type": "STRING", "description": "What the coach said, verbatim (for typed text, repeat it)."},
        "intent": {"type": "STRING", "enum": list(INTENTS)},
        "athlete": {"type": "STRING", "description": "Athlete name or id exactly as listed, if the question is about one athlete."},
        "drill": {"type": "STRING", "description": "Drill name or id exactly as listed, if a what-if names a drill."},
        "change": {"type": "STRING", "enum": list(CHANGES)},
        "gear": {"type": "STRING", "enum": llm_plan.GEARS},
        "intensity": {"type": "STRING", "enum": llm_plan.INTENSITIES},
        "duration_min": {"type": "INTEGER", "description": "New drill length or break length in minutes, only if the coach said a number."},
        "shade": {"type": "BOOLEAN"},
        "move_to": {"type": "INTEGER", "description": "New 0-based position in the drill list, only for change=move."},
        "preset": {"type": "STRING", "enum": ["max_load", "fewest_changes"]},
    },
    "required": ["transcript", "intent"],
}

INSTRUCTIONS = """You route a high school football coach's question about today's practice plan to ONE tool.
Return JSON only, matching the schema. Do not answer the question, do not estimate temperatures, do not add numbers
the coach did not say. Intents:
- plan_summary: who is over the line, how hot the plan runs, how many athletes, FHSAA issues for the whole plan.
- optimize: fix / rewrite / optimize the plan; preset fewest_changes if they ask for few changes, else max_load.
- what_if: the effect of ONE change to ONE drill (gear, duration, shade, intensity, remove it, add a break after it, move it).
- athlete_status: one named athlete.
- field_conditions: weather, WBGT, heat index, FHSAA zone, forecast.
- unknown: anything else.
Use the drill and athlete names exactly as they appear in the lists given. Leave a field out when the coach didn't say it."""


class Parsed(BaseModel):
    transcript: str = ""
    intent: Literal["plan_summary", "optimize", "what_if", "athlete_status", "field_conditions", "unknown"]
    athlete: Optional[str] = None
    drill: Optional[str] = None
    change: Optional[Literal["gear", "duration", "shade", "intensity", "remove", "add_break", "move"]] = None
    gear: Optional[Literal["none", "helmet", "helmet_shoulder_pads", "full_pads"]] = None
    intensity: Optional[Literal["rest", "light", "moderate", "hard", "max"]] = None
    duration_min: Optional[int] = Field(default=None, ge=1)
    shade: Optional[bool] = None
    move_to: Optional[int] = Field(default=None, ge=0)
    preset: Optional[Literal["max_load", "fewest_changes"]] = None


def _timeout() -> tuple[float, float]:
    """(connect, read) seconds: a dead network fails fast, so the app falls back instead of hanging."""
    return float(consts.get("voice.connect_timeout_s")), float(consts.get("voice.read_timeout_s"))


def _context(plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]]) -> str:
    drills = "; ".join(f"{d['id']} = {d.get('name', '')}" for d in plan["drills"])
    names = "; ".join(f"{a['id']} = {voice_tools._plain(a.get('name'))}" for a in roster)
    return f"Drills on the plan: {drills}.\nAthletes: {names}."


def _call(parts: list[dict[str, Any]]) -> Parsed:
    import requests

    llm_plan.gate_gemini()   # kill switch: no Gemini request while HEATTWIN_DISABLE_PAID_APIS is on
    body = {"systemInstruction": {"parts": [{"text": INSTRUCTIONS}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": INTENT_SCHEMA,
                                 "temperature": 0.0, "maxOutputTokens": consts.get("voice.max_output_tokens")}}
    last: Exception | None = None
    for _ in range(2):  # one retry on malformed output
        try:
            r = requests.post(llm_plan.API.format(model=llm_plan.model_name()), json=body, timeout=_timeout(),
                              headers={"x-goog-api-key": llm_plan._key(), "Content-Type": "application/json"})
        except requests.RequestException as e:
            raise llm_plan.LLMError(f"Gemini unreachable: {type(e).__name__}") from e
        if r.status_code != 200:
            raise llm_plan.LLMError(f"Gemini HTTP {r.status_code}")
        try:
            text = "".join(p.get("text", "") for p in r.json()["candidates"][0]["content"]["parts"])
            return Parsed.model_validate(json.loads(text))
        except (KeyError, IndexError, json.JSONDecodeError, ValidationError) as e:
            last = e
    raise llm_plan.LLMError(f"Gemini output did not match the intent schema: {last}")


def resolve(p: Parsed, plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """Validated Gemini/local output → slots with ids from THIS plan and roster; unmatched names are reported, not guessed."""
    slots: dict[str, Any] = {}
    unresolved: list[str] = []
    if p.intent == "athlete_status":
        aid = voice_tools.resolve_athlete(p.athlete or "", roster)
        if aid:
            slots["athlete_id"] = aid
        else:
            unresolved.append(f"athlete: {p.athlete or '(none named)'}")
    if p.intent == "what_if":
        did = voice_tools.resolve_drill(p.drill or "", plan)
        if did:
            slots["drill_id"] = did
        else:
            unresolved.append(f"drill: {p.drill or '(none named)'}")
        if p.change:
            slots["change"] = p.change
        else:
            unresolved.append("change: (not said)")
        limit = consts.get("fhsaa_practice_limits.max_single_practice_min")
        for k in ("gear", "intensity", "shade", "move_to", "duration_min"):
            v = getattr(p, k)
            if v is not None:
                slots[k] = v
        if slots.get("duration_min") is not None and slots["duration_min"] > limit:
            unresolved.append(f"duration_min: {slots.pop('duration_min')} is longer than a whole practice")
        if slots.get("move_to") is not None and slots["move_to"] >= len(plan["drills"]):
            unresolved.append(f"move_to: position {slots.pop('move_to')} is not on the plan")
        need = {"gear": "gear", "intensity": "intensity", "duration": "duration_min", "move": "move_to"}.get(p.change or "")
        if need and need not in slots:
            unresolved.append(f"{need}: (not said)")
    if p.intent == "optimize":
        slots["preset"] = p.preset or "max_load"
    return slots, unresolved


def parse_intent(*, text: Optional[str] = None, audio: Optional[bytes] = None, mime_type: str = "audio/wav",
                 plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    parts: list[dict[str, Any]] = [{"text": _context(plan, roster)}]
    if audio is not None:
        mime = mime_type.split(";")[0].strip().lower()
        if mime not in llm_plan.AUDIO_MIME:
            raise ValueError(f"unsupported audio type {mime_type!r}; send WAV")
        if not audio or len(audio) > llm_plan.MAX_AUDIO_BYTES:
            raise ValueError("audio is empty or too long")
        parts += [{"inline_data": {"mime_type": mime, "data": base64.b64encode(audio).decode()}},
                  {"text": "The audio is the coach's question. Transcribe it and route it."}]
    elif text and text.strip():
        parts.append({"text": f"The coach typed: {text.strip()}"})
    else:
        raise ValueError("send text or audio_b64")
    p = _call(parts)
    if text and not p.transcript:
        p.transcript = text.strip()
    slots, unresolved = resolve(p, plan, roster)
    return {"transcript": guard.check(p.transcript, source="voice.transcript", log=False)["redacted_text"],
            "intent": p.intent, "slots": slots, "unresolved": unresolved, "labels": [LABEL],
            "model": llm_plan.model_name()}


# ── answer ───────────────────────────────────────────────────────────────────

_NUM = re.compile(r"\b\d{1,2}:\d{2}\b|-?\d+(?:\.\d+)?")


def numbers_in(text: str) -> list[str]:
    """Every number token (and clock time) in ``text`` as written — the per-answer ledger."""
    return _NUM.findall(text)


def change_from_slots(slots: Mapping[str, Any]) -> dict[str, Any]:
    c, did = slots.get("change"), slots.get("drill_id")
    if c == "add_break":
        return {"add_break_after": did, **({"minutes": slots["duration_min"]} if slots.get("duration_min") else {})}
    if c == "remove":
        return {"drill_id": did, "remove": True}
    if c == "shade":
        return {"drill_id": did, "shade": slots.get("shade", True)}
    key = {"gear": "gear", "intensity": "intensity", "duration": "duration_min", "move": "move_to"}[c]
    return {"drill_id": did, key: slots[key]}


def ask_back(missing: Sequence[str]) -> str:
    plain = {"drill_id": "which drill", "athlete_id": "which athlete", "change": "what change",
             "duration_min": "how many minutes", "move_to": "which position", "gear": "which gear",
             "intensity": "which intensity"}
    parts = [plain.get(m.split(":")[0], m.split(":")[0]) for m in missing]
    what = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return f"Tell me {what}, and I'll answer. Estimate, planning only."


def finish(intent: str, say: str, data: Mapping[str, Any], labels: Sequence[str],
           question: Optional[str] = None) -> dict[str, Any]:
    b = boundary_for(question)
    if b:  # asked to clear, diagnose, treat or medicate: state the boundary first (the estimate follows, if any)
        say = f"{b[1]} The estimate: {say}" if numbers_in(say) else f"{b[1]} {say}"
        labels = [*labels, f"boundary stated ({b[0]})"]
    g = guard.check(say, source=f"voice.answer.{intent}")
    say = g["redacted_text"]
    return {"intent": intent, "say": say, "numbers": numbers_in(say), "data": dict(data),
            "labels": list(labels) + ([] if g["ok"] else ["guard redacted part of this sentence"])}


# ── text-to-speech ───────────────────────────────────────────────────────────

class TTSUnavailable(RuntimeError):
    pass


def tts(text: str) -> bytes:
    """ElevenLabs TTS for an approved sentence (re-guarded by the caller). Needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID."""
    import requests

    llm_plan._load_dotenv()
    from engine import paid_api
    try:
        paid_api.gate("elevenlabs")   # kill switch: the web falls back to speechSynthesis
    except paid_api.PaidAPIDisabled as e:
        raise TTSUnavailable(str(e)) from e
    key, voice = os.environ.get("ELEVENLABS_API_KEY"), os.environ.get("ELEVENLABS_VOICE_ID")
    if not key or not voice:
        raise TTSUnavailable("no ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID on the engine")
    body: dict[str, Any] = {"text": text}
    if os.environ.get("ELEVENLABS_MODEL"):
        body["model_id"] = os.environ["ELEVENLABS_MODEL"]
    try:
        r = requests.post(f"https://api.elevenlabs.io/v1/text-to-speech/{voice}", json=body,
                          headers={"xi-api-key": key, "accept": "audio/mpeg"}, timeout=_timeout())
    except requests.RequestException as e:
        raise TTSUnavailable(f"ElevenLabs unreachable: {type(e).__name__}") from e
    if r.status_code != 200:
        raise TTSUnavailable(f"ElevenLabs HTTP {r.status_code}")
    return r.content
