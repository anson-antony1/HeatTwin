"""llm_plan / llm_routes with Gemini mocked (no network, no key needed)."""
import base64
import json

import pytest
from fastapi.testclient import TestClient

from engine import llm_plan
from engine.api import app

REPLY = {
    "transcript": "Start at 3:30. Ten minutes warmup in helmets, twenty individual in full pads, water break in the shade, "
                  "team period 25 we can't cut, gassers 12 can go.",
    "start_time_local": "15:30",
    "drills": [
        {"name": "Warmup", "duration_min": 10, "intensity": "light", "gear": "helmet", "is_break": False, "shade": False, "priority": 2, "movable": False},
        {"name": "Individual", "duration_min": 20, "intensity": "moderate", "gear": "full_pads", "is_break": False, "shade": False, "priority": 2, "movable": True},
        {"name": "Water break", "duration_min": 0, "intensity": "rest", "gear": "full_pads", "is_break": True, "shade": True, "priority": 2, "movable": True},
        {"name": "Team period", "duration_min": 25, "intensity": "hard", "gear": "full_pads", "is_break": False, "shade": False, "priority": 1, "movable": True},
        {"name": "Water break", "duration_min": 4, "intensity": "light", "gear": "full_pads", "is_break": True, "shade": True, "priority": 2, "movable": True},
        {"name": "Gassers", "duration_min": 12, "intensity": "max", "gear": "full_pads", "is_break": False, "shade": False, "priority": 3, "movable": True},
    ],
    "assumptions": ["Assumed the athletes are safe to continue in full pads."],
    "unclear": [],
}


@pytest.fixture
def gemini(monkeypatch):
    calls = []

    def fake(parts):
        calls.append(parts)
        return json.dumps(REPLY)
    monkeypatch.setattr(llm_plan, "_call_gemini", fake)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    return calls


def test_text_to_contract_plan(gemini):
    r = llm_plan.parse_text("anything", date="2026-10-05")
    plan = r["plan"]
    assert plan["start"] == "2026-10-05T15:30:00-04:00"
    assert [d["id"] for d in plan["drills"]] == ["d1", "d2", "d3", "b1", "d4"]   # zero-length break dropped
    assert {"id", "name", "duration_min", "intensity", "gear", "shade", "is_break", "priority", "movable"} == set(plan["drills"][0])
    assert plan["drills"][3]["intensity"] == "rest"                                  # breaks forced to rest
    assert r["total_min"] == 71 and r["needs_confirmation"] is True
    assert any("Water break" in u for u in r["unclear"])
    assert r["labels"] and "confirm" in r["labels"][0]


def test_generated_text_passes_guard(gemini):
    r = llm_plan.parse_text("anything")
    assert not any("safe" in a.lower().split() for a in r["assumptions"])


def test_plan_is_accepted_by_simulate_shapes(gemini):
    from engine.api import PracticePlan
    PracticePlan.model_validate(llm_plan.parse_text("anything")["plan"])


def test_start_override_and_default(gemini):
    assert llm_plan.parse_text("x", start="2026-10-06T07:00:00-04:00")["plan"]["start"] == "2026-10-06T07:00:00-04:00"
    REPLY_no_time = dict(REPLY, start_time_local=None)
    llm_plan._call_gemini = lambda parts: json.dumps(REPLY_no_time)
    r = llm_plan.parse_text("x")
    assert any("Start time" in u for u in r["unclear"])


def test_audio_is_sent_inline(gemini):
    llm_plan.parse_audio(b"RIFF....WAVEfmt ", "audio/wav")
    inline = gemini[-1][0]["inline_data"]
    assert inline["mime_type"] == "audio/wav" and base64.b64decode(inline["data"]) == b"RIFF....WAVEfmt "


@pytest.mark.parametrize("mime", ["audio/webm", "video/mp4", "text/plain"])
def test_unsupported_audio_rejected(gemini, mime):
    with pytest.raises(ValueError):
        llm_plan.parse_audio(b"x", mime)


def test_malformed_output_retried_then_error(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    outs = iter(["not json", json.dumps(REPLY)])
    monkeypatch.setattr(llm_plan, "_call_gemini", lambda parts: next(outs))
    assert llm_plan.parse_text("x")["plan"]["drills"]
    monkeypatch.setattr(llm_plan, "_call_gemini", lambda parts: '{"drills": [{"name": "x"}]}')
    with pytest.raises(llm_plan.LLMError):
        llm_plan.parse_text("x")


def test_routes(gemini):
    c = TestClient(app)
    assert c.get("/plan/llm_status").json()["configured"] is True
    r = c.post("/plan/parse", json={"text": "warmup 10"})
    assert r.status_code == 200 and r.json()["plan"]["drills"]
    wav = base64.b64encode(b"RIFF....WAVE").decode()
    assert c.post("/plan/parse_audio", json={"audio_b64": wav, "mime_type": "audio/wav"}).status_code == 200
    assert c.post("/plan/parse_audio", json={"audio_b64": "%%%", "mime_type": "audio/wav"}).status_code == 422
    assert c.post("/plan/parse_audio", json={"audio_b64": wav, "mime_type": "audio/webm"}).status_code == 422


def test_no_key_is_503(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(llm_plan, "_load_dotenv", lambda: None)
    assert TestClient(app).post("/plan/parse", json={"text": "warmup"}).status_code == 503


def test_edit_existing_plan_keeps_context(monkeypatch):
    """With current_plan, the model gets the plan + edit instructions, and start/site carry over."""
    seen = {}

    def fake(parts, editing=False):
        seen["parts"], seen["editing"] = parts, editing
        return json.dumps({
            "transcript": "add 20 minutes of jumping jacks at the end",
            "start_time_local": None,
            "drills": [
                {"name": "Warmup", "duration_min": 10, "intensity": "light", "gear": "helmet", "is_break": False,
                 "shade": False, "priority": 2, "movable": False},
                {"name": "Jumping jacks", "duration_min": 20, "intensity": "moderate", "gear": "helmet",
                 "is_break": False, "shade": False, "priority": 2, "movable": True},
            ],
            "assumptions": ["Jumping jacks set to moderate."],
            "unclear": [],
            "changes": ["Added 20 min of jumping jacks at the end."],
        })

    monkeypatch.setattr(llm_plan, "_call_gemini", fake)
    current = {"id": "p", "site": {"name": "Field X", "lat": 0, "lon": 0, "surface": "turf"},
               "start": "2026-10-04T16:15:00-04:00",
               "drills": [{"id": "d1", "name": "Warmup", "duration_min": 10, "intensity": "light", "gear": "helmet",
                           "shade": False, "is_break": False, "priority": 2, "movable": False}]}
    out = llm_plan.parse_text("add 20 minutes of jumping jacks at the end", current_plan=current)

    assert seen["editing"] is True
    assert "Current plan" in seen["parts"][0]["text"] and '"Warmup"' in seen["parts"][0]["text"]
    assert out["edited"] is True and out["changes"] == ["Added 20 min of jumping jacks at the end."]
    assert out["plan"]["start"] == current["start"]          # no "start time not stated" when editing
    assert out["plan"]["site"]["name"] == "Field X"
    assert [d["name"] for d in out["plan"]["drills"]] == ["Warmup", "Jumping jacks"]
    assert not any("Start time" in u for u in out["unclear"])
