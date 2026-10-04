"""HTTP routes for the FREE voice path (no paid API; Gemini stays optional and off). Mounted in engine/api.py.

GET  /voice/status                                  → which decision backend / STT / TTS is available (and why not)
POST /voice/decide      {text, plan?, roster?, choices?}  → routing: intent + slots, or the two options to ask "Did you mean …?"
POST /voice/transcribe  {audio_b64, mime_type?}     → {text, backend}   (laptop-only faster-whisper; 503 when not installed)
POST /plan/parse_local  {text, current_plan?, site?, date?, start?}   → PlanDraft (same shape as /plan/parse)

The voice path: transcript → /voice/decide → (/voice/answer | /plan/parse_local) → the ENGINE's sentence → /guard → speak.
Numbers come only from the engine. CONTRACTS v1.7 (additive).
"""
from __future__ import annotations

import base64
import binascii
import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from engine import decide, fixtures, llm_plan, local_plan, paid_api, stt_local, voice_local

router = APIRouter(tags=["free voice path (decision layer)"])


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow")


class DecideRequest(_Model):
    text: str = Field(min_length=1, max_length=2000)
    plan: Optional[dict[str, Any]] = Field(default=None, description="the plan on screen; default: the fixture plan")
    roster: Optional[list[dict[str, Any]]] = Field(default=None, description="default: the fixture roster")
    choices: Optional[dict[str, Any]] = Field(
        default=None, description="the coach's answers to an earlier 'Did you mean …?': {intent?, athlete_id?, drill_id?}")


class TranscribeRequest(_Model):
    audio_b64: str = Field(min_length=1)
    mime_type: str = "audio/wav"


class LocalParse(_Model):
    text: str = Field(min_length=1, max_length=5000)
    site: Optional[dict[str, Any]] = None
    date: Optional[str] = None
    start: Optional[str] = None
    current_plan: Optional[dict[str, Any]] = None


@router.get("/voice/status")
def voice_status() -> dict[str, Any]:
    gem = llm_plan.status()
    llm_plan._load_dotenv()
    eleven = bool(os.environ.get("ELEVENLABS_API_KEY") and os.environ.get("ELEVENLABS_VOICE_ID")) and not paid_api.disabled()
    return {"decide": decide.status(),
            "gemini": {"configured": gem["configured"], "paid_apis_disabled": gem["paid_apis_disabled"]},
            "stt": {"browser": "Web Speech API (in the browser; the engine cannot see it)", "whisper": stt_local.available()},
            "tts": {"elevenlabs": eleven, "fallback": "browser speechSynthesis"},
            "paid_api": paid_api.counts()}


@router.post("/voice/decide")
def voice_decide(req: DecideRequest) -> dict[str, Any]:
    plan = req.plan if req.plan and req.plan.get("drills") else fixtures.plan()
    roster = req.roster if req.roster else fixtures.roster()
    try:
        return voice_local.route(req.text, plan, roster, choices=req.choices)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/voice/transcribe")
def voice_transcribe(req: TranscribeRequest) -> dict[str, Any]:
    try:
        audio = base64.b64decode(req.audio_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(422, "audio_b64 is not valid base64") from e
    try:
        return stt_local.transcribe_wav(audio)
    except stt_local.STTUnavailable as e:
        raise HTTPException(503, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/plan/parse_local")
def plan_parse_local(req: LocalParse) -> dict[str, Any]:
    try:
        return local_plan.parse_text(req.text, req.current_plan, site=req.site, date=req.date, start=req.start)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
