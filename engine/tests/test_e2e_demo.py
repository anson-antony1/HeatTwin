"""End-to-end demo check (audit item 14), engine side: the 8 scripted voice questions and 5 plan/player actions, with
every number compared to validation/results.json["demo"] (computed by validation/demo_numbers.py).

Gemini is replaced by a fixed routing table (the output a correct router must produce), so this runs offline and with
no key; everything after routing — name resolution, the tool run, the engine-written sentence, the guard and the
per-answer number check — is the real code. The web-side flow is covered by web/src/voice/__tests__.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine import consts, guard, voice
from engine.api import app

c = TestClient(app)
DEMO = json.loads((Path(__file__).resolve().parents[2] / "validation" / "results.json").read_text())["demo"]
INPUTS = c.get("/demo/inputs").json()
PLAN = INPUTS["plan"]
NAME = {a["id"]: re.sub(r"\s*\(fictional\)", "", a["name"]) for a in INPUTS["roster"]}
NUM = re.compile(r"\b\d{1,2}:\d{2}\b|-?\d+(?:\.\d+)?")

# question → what a correct router returns (names, never ids or numbers it wasn't told)
ROUTES = {
    "Who crosses the planning line first in this practice?": dict(intent="plan_summary"),
    "What's the WBGT at 4 pm, and which FHSAA zone is that?": dict(intent="field_conditions"),
    "How hot does Isaiah get?": dict(intent="athlete_status", athlete="Isaiah"),
    "What if we drop the gassers?": dict(intent="what_if", drill="Conditioning (gassers)", change="remove"),
    "What if team period is helmets only?": dict(intent="what_if", drill="Team period", change="gear", gear="helmet"),
    "Fix the plan.": dict(intent="optimize", preset="max_load"),
    "Can you do it in six changes or fewer?": dict(intent="optimize", preset="fewest_changes"),
    "Is Devin safe to keep practicing?": dict(intent="athlete_status", athlete="Devin"),
}


@pytest.fixture(autouse=True)
def fake_gemini(monkeypatch):
    def route(parts):
        q = parts[-1]["text"].removeprefix("The coach typed: ")
        return voice.Parsed(transcript=q, **ROUTES[q])
    monkeypatch.setattr(voice, "_call", route)


def ask(q: str) -> dict:
    i = c.post("/voice/intent", json={"text": q, "plan": PLAN})
    assert i.status_code == 200, i.text
    i = i.json()
    assert not i["unresolved"], i
    a = c.post("/voice/answer?demo=1", json={"intent": i["intent"], "slots": i["slots"], "plan": PLAN}).json()
    # the two checks the web runs before display or speech
    assert guard.check(a["say"], log=False)["ok"], a["say"]
    assert all(t in a["numbers"] for t in NUM.findall(a["say"])), a
    assert "estimate — planning only" in a["labels"]
    return {"intent": i, "answer": a}


def test_q1_who_crosses_first_matches_demo_numbers():
    r = ask("Who crosses the planning line first in this practice?")
    s, say = DEMO["simulate"], r["answer"]["say"]
    assert f"{s['over_limit']} of {s['athletes']}" in say and str(s["max_p95_c"]) in say
    first = min(v["first_cross_min"] for v in s["athletes_detail"].values())
    firsts = [NAME[k] for k, v in s["athletes_detail"].items() if v["first_cross_min"] == first]
    assert any(n in say for n in firsts) and f"minute {first:g}" in say


def test_q2_wbgt_at_4pm_matches_forecast():
    say = ask("What's the WBGT at 4 pm, and which FHSAA zone is that?")["answer"]["say"]
    h = next(h for h in DEMO["field_conditions"]["hours"] if h["time"] == "16:00")
    assert f"16:00 WBGT {h['wbgt_f']:.0f} °F, zone {h['fhsaa_zone']}" in say


def test_q3_isaiah_matches_demo_athlete():
    r = ask("How hot does Isaiah get?")
    d = DEMO["simulate"]["athletes_detail"][r["intent"]["slots"]["athlete_id"]]
    assert str(d["peak_p95_c"]) in r["answer"]["say"] and str(d["peak_p50_c"]) in r["answer"]["say"]


@pytest.mark.parametrize("q", ["What if we drop the gassers?", "What if team period is helmets only?"])
def test_q4_q5_what_if_before_matches_demo(q):
    a = ask(q)["answer"]
    assert a["data"]["before"]["team_mean_p95_c"] == DEMO["simulate"]["team_mean_p95_c"]
    assert a["data"]["after"]["team_mean_p95_c"] < a["data"]["before"]["team_mean_p95_c"]


@pytest.mark.parametrize("q,preset", [("Fix the plan.", "max_load"), ("Can you do it in six changes or fewer?", "fewest_changes")])
def test_q6_q7_optimize_matches_demo(q, preset):
    a = ask(q)["answer"]
    o = DEMO["optimize"][preset]
    assert f"keeps {o['load_kept_pct']}% of the training load with {o['changes']} changes" in a["say"]
    assert o["top_changes_text"] in a["say"]
    for n in o["notes"]:
        assert n in a["say"]


def test_q8_safe_question_gets_numbers_not_reassurance():
    a = ask("Is Devin safe to keep practicing?")["answer"]
    assert not re.search(r"\b(safe|fine|okay|ok|cleared)\b", a["say"], re.I)
    assert "planning only" in a["say"].lower()


# ── 5 plan / player actions ──────────────────────────────────────────────────

def test_action1_load_plan_shows_demo_numbers():
    from engine.voice_tools import _summary
    sim = c.post("/simulate?demo=1", json={"plan": PLAN}).json()
    assert {k: v for k, v in _summary(sim).items()} == {k: v for k, v in DEMO["simulate"].items() if k != "athletes_detail"}


@pytest.mark.parametrize("preset", ["max_load", "fewest_changes"])
def test_action2_3_optimize_presets(preset):
    o = c.post(f"/optimize?demo=1&preset={preset}", json={}).json()
    d = DEMO["optimize"][preset]
    assert (o["feasible"], o["load_kept_pct"], len(o["changes"])) == (d["feasible"], d["load_kept_pct"], d["changes"])


def test_action4_what_if_add_break_uses_fhsaa_break_length():
    w = c.post("/what_if?demo=1", json={"change": {"add_break_after": "d3"}, "plan": PLAN}).json()
    brk = min(z["break_min"] for z in consts.get("fhsaa_wbgt_zones.zones") if z.get("break_min"))
    assert w["after"]["practice_min"] == w["before"]["practice_min"] + brk
    assert "synthetic plan (fixture)" not in w["labels"]  # the plan was sent, so it is not labelled as the fixture
    assert "synthetic roster" in w["labels"]


def test_action5_hr_replay_read_one_athlete():
    r = c.post("/live/replay?demo=1", json={"plan": PLAN}).json()
    last, d = r["frames"][-1], DEMO["replay"]["last_frame"]
    assert (last["athlete_id"], last["calib"]["met_scale"], round(last["athlete"]["peak_core_c_p95"], 2)) == \
        (d["athlete_id"], d["met_scale"], d["peak_p95_c"])
    assert ("synthetic HR (not a real athlete)" in r["labels"]) == DEMO["replay"]["synthetic"]
