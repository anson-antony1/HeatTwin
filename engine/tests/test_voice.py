"""Voice Q&A (CONTRACTS v1.3): Gemini routes only; the engine answers; every number in `say` is in `numbers`."""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from engine import guard, llm_plan, voice
from engine.api import app

c = TestClient(app)
PLAN = c.get("/demo/inputs").json()["plan"]


def _ledger_ok(ans):
    toks = re.findall(r"\b\d{1,2}:\d{2}\b|-?\d+(?:\.\d+)?", ans["say"])
    return all(t in ans["numbers"] for t in toks)


@pytest.mark.parametrize("intent,slots", [
    ("plan_summary", {}), ("athlete_status", {"athlete_id": "a07"}), ("field_conditions", {}),
    ("what_if", {"drill_id": "d6", "change": "remove"}), ("what_if", {"drill_id": "d3", "change": "add_break"}),
    ("what_if", {"drill_id": "d4", "change": "gear", "gear": "helmet"}), ("unknown", {}),
])
def test_answer_is_engine_written_guarded_and_self_consistent(intent, slots):
    a = c.post("/voice/answer?demo=1", json={"intent": intent, "slots": slots, "plan": PLAN}).json()
    assert a["intent"] == intent and a["say"]
    assert guard.check(a["say"], log=False)["ok"]
    assert _ledger_ok(a)
    assert "estimate — planning only" in a["labels"]
    assert "safe" not in a["say"].lower()


def test_answer_labels_carry_fixture_provenance():
    a = c.post("/voice/answer?demo=1", json={"intent": "athlete_status", "slots": {"athlete_id": "a07"}, "plan": PLAN}).json()
    assert "synthetic roster" in a["labels"] and "forecast is fixture" in a["labels"]


def test_answer_asks_back_instead_of_guessing():
    a = c.post("/voice/answer", json={"intent": "what_if", "slots": {"change": "gear"}}).json()
    assert a["numbers"] == [] and "drill" in a["say"]
    a = c.post("/voice/answer", json={"intent": "athlete_status", "slots": {}}).json()
    assert a["numbers"] == [] and "athlete" in a["say"]


def test_add_break_default_is_the_fhsaa_break_length():
    from engine import consts, voice_tools
    z = [x["break_min"] for x in consts.get("fhsaa_wbgt_zones.zones") if x.get("break_min")]
    p = voice_tools.apply_change(PLAN, {"add_break_after": "d3"})
    added = next(d for d in p["drills"] if d["id"] == "wb_whatif")
    assert added["duration_min"] == min(z)


def test_athlete_status_post_uses_the_plan_sent():
    short = {**PLAN, "drills": PLAN["drills"][:2]}
    full = c.post("/athlete_status?demo=1", json={"athlete": "a07", "plan": PLAN}).json()
    part = c.post("/athlete_status?demo=1", json={"athlete": "a07", "plan": short}).json()
    assert part["peak_p95_c"] < full["peak_p95_c"]
    assert c.post("/athlete_status", json={"athlete": "Nobody", "plan": PLAN}).status_code == 404


def test_field_conditions_post_window_follows_plan():
    f = c.post("/field_conditions?demo=1", json={"plan": PLAN}).json()
    assert f["hours"] and guard.check(f["say"], log=False)["ok"]


def test_intent_resolves_names_against_plan_and_reports_unmatched(monkeypatch):
    calls = []

    def fake(parts):
        calls.append(parts)
        return voice.Parsed(transcript="what if we cut the gassers", intent="what_if", drill="Conditioning (gassers)",
                            change="remove")
    monkeypatch.setattr(voice, "_call", fake)
    j = c.post("/voice/intent", json={"text": "what if we cut the gassers", "plan": PLAN}).json()
    assert j["intent"] == "what_if" and j["slots"] == {"drill_id": "d6", "change": "remove"} and j["unresolved"] == []
    assert voice.LABEL in j["labels"]
    assert "d6 = Conditioning (gassers)" in calls[0][0]["text"]

    monkeypatch.setattr(voice, "_call", lambda parts: voice.Parsed(transcript="x", intent="athlete_status", athlete="Zed"))
    j = c.post("/voice/intent", json={"text": "how is Zed", "plan": PLAN}).json()
    assert "athlete_id" not in j["slots"] and j["unresolved"]


def test_intent_validation_rejects_out_of_range_numbers(monkeypatch):
    monkeypatch.setattr(voice, "_call", lambda parts: voice.Parsed(transcript="x", intent="what_if", drill="d4",
                                                                    change="duration", duration_min=999))
    j = c.post("/voice/intent", json={"text": "make team period 999 minutes", "plan": PLAN}).json()
    assert "duration_min" not in j["slots"] and any("duration_min" in u for u in j["unresolved"])


def test_intent_without_key_is_503(monkeypatch):
    def nokey(parts):
        raise llm_plan.LLMNotConfigured("no GEMINI_API_KEY")
    monkeypatch.setattr(voice, "_call", nokey)
    assert c.post("/voice/intent", json={"text": "who is over"}).status_code == 503


def test_tts_reguards_and_is_unavailable_without_key(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.setattr(llm_plan, "_load_dotenv", lambda: None)
    assert c.post("/voice/tts", json={"text": "He is safe to keep going."}).status_code == 422
    assert c.post("/voice/tts", json={"text": "Estimate, planning only."}).status_code == 503


ADVERSARIAL = {   # demo-qa should-fix 3: each must get a boundary sentence (kind), never a bare estimate
    "Is Devin safe to keep practicing?": "clearance", "Can Caleb keep playing?": "clearance",
    "When can Elijah go back in?": "clearance", "Should Devin sit out?": "clearance", "Should I pull Jordan?": "clearance",
    "Can we continue practice?": "clearance", "Should we stop practice?": "clearance", "Is Noah in danger?": "clearance",
    "Is Devin healthy?": "clearance", "Is it safe to run the gassers?": "clearance", "Is he safe?": "clearance",
    "Does Darius have heat stroke?": "diagnosis", "Should I give Logan ibuprofen?": "medication",
    "Does Mason need ice or water?": "treatment", "Do I need to call 911 for Devin?": "treatment",
}
ORDINARY = ["Who crosses the planning line first in this practice?", "What's the WBGT at 4 pm, and which FHSAA zone is that?",
            "How hot does Isaiah get?", "What if we drop the gassers?", "What if team period is helmets only?",
            "Fix the plan.", "Can you do it in six changes or fewer?"]


@pytest.mark.parametrize("q,kind", ADVERSARIAL.items())
def test_boundary_questions_get_the_boundary_first(q, kind):
    assert voice.boundary_for(q)[0] == kind
    for intent, slots in (("athlete_status", {"athlete_id": "a07"}), ("athlete_status", {}), ("unknown", {})):
        a = c.post("/voice/answer?demo=1", json={"intent": intent, "slots": slots, "plan": PLAN, "question": q}).json()
        assert a["say"].startswith(voice.boundary_for(q)[1]) and guard.check(a["say"], log=False)["ok"]
        assert f"boundary stated ({kind})" in a["labels"]
        assert all(t in a["numbers"] for t in voice.numbers_in(a["say"]))


@pytest.mark.parametrize("q", ORDINARY)
def test_ordinary_questions_get_no_boundary(q):
    assert voice.boundary_for(q) is None
