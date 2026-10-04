"""End to end, FREE path, text in (no audio, no paid API): the 8 scripted voice questions go
transcript → engine/decide.py (via POST /voice/decide) → the engine endpoint → the engine-written sentence → /guard.

Every number in the sentence is then checked against numbers the engine returns from a DIFFERENT, direct call for the same
request (/simulate, /athlete_status, /field_conditions, /what_if, /optimize): each number token must equal an engine value
rounded to the token's own decimals (clock times: an engine hour). Where the router abstains it asks "Did you mean …?"; the
test taps the correct option, as the coach would, and requires that option to be among the top two.

Needs the embedding model in the local cache (python -m engine.decide --fetch); skips, with the reason, without it.
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from engine import decide, guard, paid_api, voice
from engine.api import app

FE = decide.get_backend("fastembed")
pytestmark = pytest.mark.skipif(not FE.semantic, reason=f"embedding model not cached: {decide._backend_why.get('fastembed')}")

c = TestClient(app)
INPUTS = c.get("/demo/inputs").json()
PLAN, ROSTER = INPUTS["plan"], INPUTS["roster"]
NAME = {a["id"]: re.sub(r"\s*\(fictional\)", "", a["name"]) for a in ROSTER}

# transcript → (intent the router must reach, slots it must resolve)
SCRIPTED = {
    "Who crosses the planning line first in this practice?": ("plan_summary", {}),
    "What's the WBGT at 4 pm, and which FHSAA zone is that?": ("field_conditions", {}),
    "How hot does Isaiah get?": ("athlete_status", {"athlete_id": "a07"}),
    "What if we drop the gassers?": ("what_if", {"drill_id": "d6", "change": "remove"}),
    "What if team period is helmets only?": ("what_if", {"drill_id": "d4", "change": "gear", "gear": "helmet"}),
    "Fix the plan.": ("optimize", {"preset": "max_load"}),
    "Can you do it in six changes or fewer?": ("optimize", {"preset": "fewest_changes"}),
    "Is Devin safe to keep practicing?": ("athlete_status", {"athlete_id": "a02"}),
}


def route(question: str, expect_intent: str, expect_slots: dict | None = None) -> dict:
    """POST /voice/decide, tapping the right "Did you mean …?" option until the router stops asking (at most 3 questions)."""
    choices: dict = {}
    for _ in range(4):
        r = c.post("/voice/decide", json={"text": question, "plan": PLAN, "roster": ROSTER, "choices": choices})
        assert r.status_code == 200, r.text
        r = r.json()
        assert r["source"] == "local" and r["decisions"]["intent"]["backend"] == FE.key
        if not r["abstain"]:
            return r
        opts = r["did_you_mean"]
        assert len(opts) == 2 and len({o["label"] for o in opts}) == 2          # the top two, labelled apart
        key, want = {"intent": ("intent", expect_intent), "athlete": ("athlete_id", (expect_slots or {}).get("athlete_id")),
                     "drill": ("drill_id", (expect_slots or {}).get("drill_id"))}[r["asking"]]
        right = next((o for o in opts if o["choices"].get(key) == want), None)
        assert right is not None, f"{question!r}: the right answer is not among the two options offered: {opts}"
        choices.update(right["choices"])
    raise AssertionError("the router kept asking")


# ── independent engine numbers ──────────────────────────────────────────────

def _decimals(tok: str) -> int:
    return len(tok.split(".")[1]) if "." in tok else 0


def assert_numbers_are_engine_numbers(say: str, refs: set[float], times: set[str] = frozenset()) -> None:
    for tok in voice.numbers_in(say):
        if re.fullmatch(r"\d{1,2}:\d{2}", tok):
            assert tok in times, (tok, say)
        else:
            assert any(round(r, _decimals(tok)) == round(float(tok), _decimals(tok)) for r in refs), (tok, sorted(refs), say)


def _percentile_level(sim: dict) -> set[float]:
    """The "95" in "95th percentile": the percentile the engine's own field names carry (peak_core_c_p95)."""
    return {float(m.group(1)) for k in sim["athletes"][0] for m in [re.fullmatch(r"\w*_p(\d\d)", k)] if m}


def _sim_summary(sim: dict) -> set[float]:
    ath = sim["athletes"]
    crosses = [a["first_cross_min"] for a in ath if a["first_cross_min"] is not None]
    return {float(len(ath)), float(sum(a["status"] == "over_limit" for a in ath)), float(sim["limit_core_c"]),
            float(max(a["peak_core_c_p95"] for a in ath)), float(len(sim["fhsaa_violations"])),
            *(float(m) for m in crosses), *_percentile_level(sim)}


def engine_numbers(intent: str, slots: dict) -> tuple[set[float], set[str]]:
    times: set[str] = set()
    if intent == "plan_summary":
        return _sim_summary(c.post("/simulate?demo=1", json={"plan": PLAN}).json()), times
    if intent == "field_conditions":
        f = c.post("/field_conditions?demo=1", json={"plan": PLAN}).json()
        times = {h["time"] for h in f["hours"]}
        return {float(h["wbgt_f"]) for h in f["hours"]} | {float(h["fhsaa_zone"]) for h in f["hours"]}, times
    if intent == "athlete_status":
        a = c.post("/athlete_status?demo=1", json={"athlete": slots["athlete_id"], "plan": PLAN}).json()
        pct = {float(m.group(1)) for k in a for m in [re.fullmatch(r"peak_p(\d\d)_c", k)] if m and k != "peak_p50_c"}
        return {a["peak_p50_c"], a["peak_p95_c"], a["limit_c"], *pct, *([a["first_cross_min"]] if a["first_cross_min"] is not None else [])}, times
    if intent == "what_if":
        change = voice.change_from_slots(slots)
        w = c.post("/what_if?demo=1", json={"plan": PLAN, "change": change}).json()
        return {float(w[k][f]) for k in ("before", "after") for f in ("team_mean_p95_c", "over_limit", "athletes", "limit_c")}, times
    if intent == "optimize":
        o = c.post(f"/optimize?demo=1&preset={slots['preset']}", json={"plan": PLAN}).json()
        notes = [x.removeprefix("fewest_changes: ") for x in o["labels"] if x.startswith("fewest_changes:")]
        text_nums = voice.numbers_in(" ".join([o.get("top_changes_text", ""), *notes]))
        return ({float(o["load_kept_pct"]), float(len(o["changes"])), *_sim_summary(o["optimized"]), *(float(t) for t in text_nums
                                                                                                        if ":" not in t)},
                {t for t in text_nums if ":" in t})
    raise AssertionError(intent)


@pytest.mark.parametrize("question", list(SCRIPTED))
def test_scripted_voice_question_end_to_end_with_no_paid_api(question):
    expect_intent, expect_slots = SCRIPTED[question]
    before = paid_api.counts()["attempted"]
    r = route(question, expect_intent, expect_slots)
    assert r["intent"] == expect_intent and not r["unresolved"], r
    for k, v in expect_slots.items():
        assert r["slots"].get(k) == v, (question, r["slots"])

    # the engine writes the sentence; the app asks /guard before showing or speaking it
    a = c.post("/voice/answer?demo=1", json={"intent": r["intent"], "slots": r["slots"], "plan": PLAN, "question": question}).json()
    assert a["intent"] == expect_intent and a["say"] and "[removed:" not in a["say"]
    g = c.post("/guard", json={"text": a["say"]}).json()
    assert g["ok"] and g["blocked_by"] == [], g
    assert a["guard"]["ok"] and a["guard"]["blocked_by"] == []
    assert a["numbers"] == voice.numbers_in(a["say"])                                   # the per-answer ledger
    assert "estimate — planning only" in a["labels"]
    assert not re.search(r"\b(safe|fine|okay|ok)\b", a["say"], re.I)

    # every number spoken is an engine number for the same request, taken from a different call
    refs, times = engine_numbers(r["intent"], r["slots"])
    assert_numbers_are_engine_numbers(a["say"], refs, times)
    assert paid_api.counts()["attempted"] == before                                     # nothing metered was even attempted


def test_the_safe_question_gets_the_boundary_first_and_numbers_not_reassurance():
    q = "Is Devin safe to keep practicing?"
    r = route(q, "athlete_status", {"athlete_id": "a02"})
    a = c.post("/voice/answer?demo=1", json={"intent": r["intent"], "slots": r["slots"], "plan": PLAN, "question": q}).json()
    assert a["say"].startswith(voice.boundary_for(q)[1]) and "boundary stated (clearance)" in a["labels"]
    assert NAME[r["slots"]["athlete_id"]] == "Devin"


def test_unclear_speech_is_asked_about_not_answered_with_numbers():
    r = c.post("/voice/decide", json={"text": "purple elephants sing on tuesdays", "plan": PLAN}).json()
    assert r["abstain"] or r["intent"] == "unknown"
    if r["abstain"]:
        assert len(r["did_you_mean"]) == 2
    else:
        a = c.post("/voice/answer?demo=1", json={"intent": r["intent"], "slots": r["slots"], "plan": PLAN}).json()
        assert a["numbers"] == []


def test_plan_entry_by_voice_text_is_a_draft_the_coach_must_confirm():
    t = "ten minute warmup in helmets then twenty minute team period in full pads then a five minute water break"
    r = c.post("/voice/decide", json={"text": t, "plan": PLAN, "choices": {"intent": "plan_entry"}}).json()
    assert r["intent"] == "plan_entry"
    d = c.post("/plan/parse_local", json={"text": t, "current_plan": None}).json()
    assert d["needs_confirmation"] is True and len(d["plan"]["drills"]) == 3
    assert c.post("/simulate?demo=1", json={"plan": d["plan"]}).status_code == 200       # a valid plan only after the coach's Confirm
    assert all(guard.check(x, log=False)["ok"] for x in [*d["assumptions"], *d["unclear"]])
