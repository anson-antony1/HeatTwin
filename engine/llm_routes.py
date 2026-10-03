"""HTTP routes for coach plan entry by text or voice (engine/llm_plan.py). Mounted in engine/api.py.

GET  /plan/llm_status                                         → {configured, provider, model}
POST /plan/parse        {text, current_plan?, site?, date?, start?}          → PlanDraft
POST /plan/parse_audio  {audio_b64, mime_type, current_plan?, site?, date?, start?} → PlanDraft

With ``current_plan`` the coach's words edit that plan (everything they don't mention is kept) and the draft adds
``changes`` (one sentence per change) and ``edited: true``.

PlanDraft = {plan: PracticePlan, transcript, assumptions[], unclear[], total_min, needs_confirmation: true,
             labels[], model}. The web app shows the draft for the coach to edit/confirm, then sends ``plan`` to
POST /simulate or /optimize as usual.
"""
from __future__ import annotations

import base64
import binascii
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from engine import llm_plan

router = APIRouter(prefix="/plan", tags=["plan entry (LLM)"])


class _PlanContext(BaseModel):
    site: Optional[dict[str, Any]] = Field(default=None, description="PracticePlan.site; default: fixture site")
    date: Optional[str] = Field(default=None, description="YYYY-MM-DD for a spoken start time; default: fixture date")
    start: Optional[str] = Field(default=None, description="Full ISO start; overrides any spoken start time")
    current_plan: Optional[dict[str, Any]] = Field(
        default=None, description="The plan already in use. When given, the coach's words edit it (keep the rest).")


class ParseText(_PlanContext):
    text: str = Field(min_length=1, max_length=5000)


class ParseAudio(_PlanContext):
    audio_b64: str = Field(min_length=1)
    mime_type: str = "audio/wav"


def _run(fn, *args, ctx: _PlanContext) -> dict[str, Any]:
    try:
        return fn(*args, current_plan=ctx.current_plan, site=ctx.site, date=ctx.date, start=ctx.start)
    except llm_plan.LLMNotConfigured as e:
        raise HTTPException(503, str(e)) from e
    except llm_plan.LLMError as e:
        raise HTTPException(502, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/llm_status")
def llm_status() -> dict[str, Any]:
    return llm_plan.status()


@router.post("/parse")
def parse(req: ParseText) -> dict[str, Any]:
    return _run(llm_plan.parse_text, req.text, ctx=req)


@router.post("/parse_audio")
def parse_audio(req: ParseAudio) -> dict[str, Any]:
    try:
        audio = base64.b64decode(req.audio_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(422, "audio_b64 is not valid base64") from e
    return _run(llm_plan.parse_audio, audio, req.mime_type, ctx=req)
