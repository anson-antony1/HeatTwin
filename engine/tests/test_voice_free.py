"""The free voice path (no paid API): /voice/decide, /plan/parse_local, /voice/status, /voice/transcribe, and the rules the
router and the local plan parser apply on top of engine/decide.py."""
from __future__ import annotations

import base64
import io
import struct
import wave

import pytest
from fastapi.testclient import TestClient

from engine import decide, fixtures, local_plan, paid_api, stt_local, voice_local
from engine.api import app

c = TestClient(app)
PLAN = fixtures.plan()
ROSTER = fixtures.roster()
FE = decide.get_backend("fastembed")
needs_embeddings = pytest.mark.skipif(not FE.semantic, reason=f"embedding model not cached: {decide._backend_why.get('fastembed')}")


# ── numbers the coach says ───────────────────────────────────────────────────

def test_spoken_numbers_become_digits():
    assert voice_local.words_to_digits("twenty five minutes and ten minutes") == "25 minutes and 10 minutes"
    assert voice_local.words_to_digits("a seven on seven period") == "a 7 on 7 period"
    assert voice_local.minutes_in("make it thirty-five minutes") == 35.0
    assert voice_local.gear_in("in helmets only") == "helmet" and voice_local.gear_in("full pads") == "full_pads"
    assert voice_local.gear_in("in shells") == "helmet_shoulder_pads" and voice_local.gear_in("in shorts") == "none"
    assert voice_local.gear_in("helmet and shoulder pads") == "helmet_shoulder_pads"


@pytest.mark.parametrize("text,expect", [
    ("what if we drop the gassers", {"change": "remove"}),
    ("what if team period is helmets only", {"change": "gear", "gear": "helmet"}),
    ("what if inside run is in shells", {"change": "gear", "gear": "helmet_shoulder_pads"}),
    ("what if we cut conditioning in half", {"change": "duration", "duration_min": 6}),
    ("what if team period was only fifteen minutes", {"change": "duration", "duration_min": 15}),
    ("what if we add a water break after inside run", {"change": "add_break"}),
    ("what if we add a six minute break after team period", {"change": "add_break", "duration_min": 6}),
    ("what if we move conditioning to the start", {"change": "move", "move_to": 0}),
    ("what if we put conditioning last", {"change": "move", "move_to": 8}),
    ("what if the break is in the shade", {"change": "shade", "shade": True}),
])
def test_what_if_slot_extraction(text, expect):
    drill = {"drop the gassers": "d6", "cut conditioning": "d6", "conditioning": "d6"}.get(
        next((k for k in ("drop the gassers", "cut conditioning", "conditioning") if k in text), ""), "d4")
    fields, notes = voice_local.extract_what_if(text, PLAN, drill)
    assert {k: fields.get(k) for k in expect} == expect, (fields, notes)


def test_two_changes_in_one_what_if_asks_which():
    fields, notes = voice_local.extract_what_if("what if we drop conditioning and go helmets only for team period", PLAN, "d6")
    assert fields["change"] == "remove" and notes == ["change: (more than one change said)"]


# ── /voice/decide ───────────────────────────────────────────────────────────

def test_decide_endpoint_shape_and_labels():
    r = c.post("/voice/decide", json={"text": "What's the WBGT at 4 pm, and which FHSAA zone is that?"}).json()
    assert set(r) >= {"transcript", "intent", "slots", "unresolved", "abstain", "asking", "did_you_mean", "decisions", "source",
                      "backend", "labels"}
    assert r["source"] == "local" and r["decisions"]["intent"]["choice"] in decide.INTENTS
    assert voice_local.LABEL in r["labels"]
    assert c.post("/voice/decide", json={"text": "   "}).status_code in (422,)
    assert c.post("/voice/decide", json={"text": ""}).status_code == 422


@needs_embeddings
def test_decide_resolves_names_against_the_plan_and_roster_sent():
    plan = {"id": "p", "site": PLAN["site"], "start": PLAN["start"],
            "drills": [{**PLAN["drills"][0], "id": "q1", "name": "Tackling circuit"},
                       {**PLAN["drills"][1], "id": "q2", "name": "Seven on seven"}]}
    roster = [{**ROSTER[0], "id": "r1", "name": "Maya Okafor", "position": "QB"},
              {**ROSTER[1], "id": "r2", "name": "Priya Raman", "position": "WR"}]
    r = c.post("/voice/decide", json={"text": "how hot does Priya get", "plan": plan, "roster": roster}).json()
    assert r["intent"] == "athlete_status" and r["slots"] == {"athlete_id": "r2"} and not r["abstain"]
    r = c.post("/voice/decide", json={"text": "what if we cut the tackling circuit", "plan": plan, "roster": roster}).json()
    assert r["intent"] == "what_if" and r["slots"] == {"drill_id": "q1", "change": "remove"}


@needs_embeddings
def test_abstain_asks_one_question_with_two_options_and_the_answer_resolves_it():
    r = c.post("/voice/decide", json={"text": "what if we make the water break shorter"}).json()
    # two water breaks on the plan: the drill decision cannot tell them apart → ask, offering both, labelled apart
    if r["intent"] == "what_if" and r["asking"] == "drill":
        assert r["abstain"] and len(r["did_you_mean"]) == 2
        labels = [o["label"] for o in r["did_you_mean"]]
        assert len(set(labels)) == 2 and all(o["choices"].get("drill_id") in {"b1", "b2"} for o in r["did_you_mean"])
        pick = r["did_you_mean"][1]
        r2 = c.post("/voice/decide", json={"text": "what if we make the water break shorter", "choices": pick["choices"]}).json()
        assert not r2["abstain"] and r2["slots"]["drill_id"] == pick["choices"]["drill_id"]
        assert r2["decisions"]["drill"]["note"] == "confirmed by the coach"
    else:                                                       # the intent itself was uncertain: still one question
        assert r["abstain"] and r["asking"] == "intent" and len(r["did_you_mean"]) == 2


def test_confirmed_intent_choice_replaces_the_decision():
    r = c.post("/voice/decide", json={"text": "hmm", "choices": {"intent": "field_conditions"}}).json()
    assert r["intent"] == "field_conditions" and not r["abstain"] and r["decisions"]["intent"]["confidence"] == 1.0


def test_plan_entry_and_unclear_map_to_engine_intents():
    r = c.post("/voice/decide", json={"text": "hmm", "choices": {"intent": "plan_entry"}}).json()
    assert r["intent"] == "plan_entry" and r["slots"] == {}
    r = c.post("/voice/decide", json={"text": "hmm", "choices": {"intent": "unclear"}}).json()
    assert r["intent"] == "unknown"


def test_decide_answers_feed_voice_answer_without_gemini():
    before = paid_api.counts()["attempted"]
    r = c.post("/voice/decide", json={"text": "what's the heat index out there", "choices": {"intent": "field_conditions"}}).json()
    a = c.post("/voice/answer?demo=1", json={"intent": r["intent"], "slots": r["slots"], "plan": PLAN}).json()
    assert a["intent"] == "field_conditions" and a["say"] and a["numbers"]
    assert paid_api.counts()["attempted"] == before


def test_fewest_changes_phrases_pick_the_preset():
    for text in ("do it with the fewest changes", "can you do it in six changes or fewer", "as few changes as possible"):
        r = c.post("/voice/decide", json={"text": text, "choices": {"intent": "optimize"}}).json()
        assert r["slots"] == {"preset": "fewest_changes"}, text
    r = c.post("/voice/decide", json={"text": "fix the plan", "choices": {"intent": "optimize"}}).json()
    assert r["slots"] == {"preset": "max_load"}


def test_voice_status_reports_every_part_and_no_key():
    s = c.get("/voice/status").json()
    assert s["gemini"]["configured"] is False and s["tts"]["elevenlabs"] is False
    assert s["decide"]["backend"] and "fallback" in s["decide"] and "ready" in s["stt"]["whisper"]
    assert s["paid_api"]["disabled"] is True


# ── /plan/parse_local ───────────────────────────────────────────────────────

def _names(d):
    return [(x["name"], x["duration_min"]) for x in d["plan"]["drills"]]


@needs_embeddings
def test_local_plan_parses_a_described_practice_into_a_draft():
    d = c.post("/plan/parse_local", json={"text": "Practice starts at four with a ten minute warmup in helmets, then twenty minute "
                                                  "team period in full pads, a five minute water break, then conditioning for "
                                                  "twelve minutes"}).json()
    assert d["needs_confirmation"] is True and d["model"] == local_plan.LOCAL_MODEL and d["labels"] == [local_plan.LOCAL_LABEL]
    assert _names(d) == [("warmup", 10.0), ("team period", 20.0), ("water break", 5.0), ("conditioning", 12.0)]
    p = d["plan"]
    assert p["start"][11:16] == "16:00" and [x["gear"] for x in p["drills"]] == ["helmet", "full_pads", "full_pads", "full_pads"]
    assert [x["is_break"] for x in p["drills"]] == [False, False, True, False] and p["drills"][2]["intensity"] == "rest"
    assert d["total_min"] == 47.0 and any("afternoon" in a for a in d["assumptions"])
    assert [x["id"] for x in p["drills"]] == ["d1", "d2", "b1", "d3"]
    # the draft is a valid PracticePlan for the engine
    assert c.post("/simulate?demo=1", json={"plan": p}).status_code == 200


@needs_embeddings
def test_local_plan_states_what_it_assumed():
    d = c.post("/plan/parse_local", json={"text": "ten minutes of dynamic warmup then twenty minutes of individual period"}).json()
    assert any("Gear was not said" in a and "full pads" in a for a in d["assumptions"])
    assert any("default start time" in u for u in d["unclear"])
    assert all(x["gear"] == "full_pads" for x in d["plan"]["drills"])


def test_local_plan_leaves_out_drills_with_no_duration_and_says_so():
    d = c.post("/plan/parse_local", json={"text": "ten minutes of warmup in helmets then a water break then 20 minutes of team"}).json()
    assert [x["name"] for x in d["plan"]["drills"]] == ["warmup", "team"]
    assert any('No duration for "water break"' in u for u in d["unclear"])


def test_low_confidence_intensity_becomes_a_confirm_screen_assumption_leaning_harder(monkeypatch):
    unsure = decide.Decision("intensity", "light", {"light": 0.4, "hard": 0.35, "max": 0.25}, 0.4, True, ("light", "hard"), "t", True)
    monkeypatch.setattr(decide, "decide_intensity", lambda text, backend=None: unsure)
    d = local_plan.parse_text("ten minutes of mystery work in helmets")
    assert d["plan"]["drills"][0]["intensity"] == "hard"                      # the harder of the two most probable
    assert any("Not sure how hard" in a and "assumed hard" in a for a in d["assumptions"])
    sure = decide.Decision("intensity", "light", {"light": 0.95, "hard": 0.05}, 0.95, False, ("light", "hard"), "t", True)
    monkeypatch.setattr(decide, "decide_intensity", lambda text, backend=None: sure)
    d = local_plan.parse_text("ten minutes of mystery work in helmets")
    assert d["plan"]["drills"][0]["intensity"] == "light" and not any("Not sure how hard" in a for a in d["assumptions"])


@pytest.mark.parametrize("text,check", [
    ("add fifteen minutes of jumping jacks at the end", lambda n, d: n[-1] == ("jumping jacks", 15.0) and len(n) == 10),
    ("make team period thirty minutes", lambda n, d: ("Team period", 30.0) in n),
    ("drop special teams from the plan", lambda n, d: "Special teams" not in [x[0] for x in n] and len(n) == 8),
    ("make the warmup five minutes shorter", lambda n, d: n[0] == ("Dynamic warmup", 5.0)),
    ("cut individual period down to fifteen minutes", lambda n, d: ("Individual period", 15.0) in n),
    ("extend the team period to forty minutes", lambda n, d: ("Team period", 40.0) in n),
    ("replace conditioning with ten minutes of sprints", lambda n, d: ("sprints", 10.0) in n and len(n) == 9),
    ("add a ten minute film session at the start", lambda n, d: n[0] == ("film session", 10.0)),
])
@needs_embeddings
def test_local_plan_edits_the_current_plan_and_keeps_the_rest(text, check):
    d = c.post("/plan/parse_local", json={"text": text, "current_plan": PLAN}).json()
    assert d["edited"] is True and d["changes"] and not d["unclear"], (d["changes"], d["unclear"])
    assert check(_names(d), d), _names(d)
    # everything the coach did not mention is unchanged (names, minutes, gear, intensity)
    old = {x["name"]: x for x in PLAN["drills"]}
    for x in d["plan"]["drills"]:
        if x["name"] in old and x["duration_min"] == old[x["name"]]["duration_min"]:
            assert (x["gear"], x["intensity"]) == (old[x["name"]]["gear"], old[x["name"]]["intensity"])


@needs_embeddings
def test_local_plan_edits_ask_instead_of_guessing():
    d = c.post("/plan/parse_local", json={"text": "make the water break longer", "current_plan": PLAN}).json()
    assert d["unclear"] and "Did you mean" in " ".join(d["unclear"]) or "By how long" in " ".join(d["unclear"])
    assert _names(d) == [(x["name"], x["duration_min"]) for x in PLAN["drills"]]                 # nothing changed
    d = c.post("/plan/parse_local", json={"text": "make team period shorter", "current_plan": PLAN}).json()
    assert any("By how long" in u for u in d["unclear"]) and d["changes"] == []


@needs_embeddings
def test_local_plan_start_time_edit_keeps_every_drill():
    d = c.post("/plan/parse_local", json={"text": "push the whole practice back to five o'clock", "current_plan": PLAN}).json()
    assert d["edited"] and d["plan"]["start"][11:16] == "17:00" and len(d["plan"]["drills"]) == 9
    assert d["changes"] == ["Changed the start time."]


def test_local_plan_with_nothing_to_parse_says_so():
    d = c.post("/plan/parse_local", json={"text": "um okay"}).json()
    assert d["plan"]["drills"] == [] and d["unclear"]
    assert c.post("/plan/parse_local", json={"text": ""}).status_code == 422


@needs_embeddings
def test_local_plan_text_passes_both_guard_layers():
    from engine import guard
    d = c.post("/plan/parse_local", json={"text": "add fifteen minutes of jumping jacks at the end", "current_plan": PLAN}).json()
    for t in [*d["assumptions"], *d["unclear"], *d["changes"], *d["labels"]]:
        assert decide.check_two_layer(t, log=False)["ok"], t
        assert guard.check(t, log=False)["ok"], t


# ── speech to text ──────────────────────────────────────────────────────────

def _silent_wav(seconds: float = 0.5) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack("<h", 0) * int(16000 * seconds))
    return buf.getvalue()


def test_transcribe_is_503_when_whisper_is_not_available(monkeypatch):
    def nope(*a, **k):
        raise stt_local.STTUnavailable("faster-whisper is not installed (test)")
    monkeypatch.setattr(stt_local, "_load", nope)
    r = c.post("/voice/transcribe", json={"audio_b64": base64.b64encode(_silent_wav()).decode()})
    assert r.status_code == 503 and "faster-whisper" in r.json()["detail"]


def test_transcribe_rejects_bad_input():
    assert c.post("/voice/transcribe", json={"audio_b64": "!!!"}).status_code == 422


@pytest.mark.skipif(not stt_local.available()["ready"], reason="faster-whisper or its model is not installed/cached (optional)")
def test_transcribe_with_local_whisper_returns_text_only():
    r = c.post("/voice/transcribe", json={"audio_b64": base64.b64encode(_silent_wav(1.0)).decode()})
    assert r.status_code == 200 and set(r.json()) == {"text", "backend", "language"}
    assert r.json()["backend"].startswith("faster-whisper:") and isinstance(r.json()["text"], str)
