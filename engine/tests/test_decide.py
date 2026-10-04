"""engine/decide.py — the free decision layer: typed choices, calibration math, roster-grounded choices, the lexical
fallback, and the guard assist (two layers: engine/guard.py + the embedding classifier).

Classifier tests need the embedding model in the local cache (python -m engine.decide --fetch) and skip, with the reason,
when it is not there. Everything else runs on the always-available lexical fallback, with no network.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pytest

from engine import consts, decide, fixtures, guard

ROOT = Path(__file__).resolve().parents[2]
_FE = decide.get_backend("fastembed")
needs_embeddings = pytest.mark.skipif(not _FE.semantic, reason=f"embedding model not cached: {decide._backend_why.get('fastembed')}")


@pytest.fixture(autouse=True)
def _tmp_guard_log(tmp_path, monkeypatch):
    monkeypatch.setattr(guard, "LOG_PATH", tmp_path / "guard_hits.jsonl")


# ── the typed result ────────────────────────────────────────────────────────

def _typed(d: decide.Decision, closed: set[str] | None = None):
    assert isinstance(d.choice, str) or d.choice is None
    if closed is not None:
        assert d.choice in closed
    assert abs(sum(d.probabilities.values()) - 1.0) < 2e-3
    assert d.confidence == pytest.approx(d.probabilities[d.choice], abs=1e-3)
    assert list(d.probabilities) == sorted(d.probabilities, key=d.probabilities.get, reverse=True)
    assert d.top2[0] == d.choice and len(d.top2) == min(2, len(d.probabilities))
    assert isinstance(d.abstain, bool)
    assert set(d.as_dict()) >= {"choice", "probabilities", "confidence", "abstain", "top2", "backend"}


def test_lexical_fallback_returns_typed_decisions_without_a_model():
    lex = decide.get_backend("lexical")
    assert not lex.semantic and lex.key == decide.LEXICAL_KEY
    _typed(decide.decide_intent("what if we cut the gassers", backend=lex), set(decide.INTENTS))
    _typed(decide.decide_intensity("wind sprints", backend=lex), set(decide.INTENSITIES))
    _typed(decide.guard_assist("He is fine to keep going", backend=lex), {"flag", "pass"})
    ids = {a["id"] for a in fixtures.roster()}
    _typed(decide.decide_athlete("how is Isaiah doing", fixtures.roster(), backend=lex), ids)
    _typed(decide.decide_drill("the gassers", fixtures.plan(), backend=lex), {d["id"] for d in fixtures.plan()["drills"]})


def test_lexical_fallback_gets_names_and_drills_right():
    lex = decide.get_backend("lexical")
    assert decide.decide_athlete("how's Isaiah looking", fixtures.roster(), backend=lex).choice == "a07"
    assert decide.decide_athlete("check on Isiah", fixtures.roster(), backend=lex).choice == "a07"      # a mis-heard name
    assert decide.decide_drill("what if we drop the gassers", fixtures.plan(), backend=lex).choice == "d6"


def test_embedding_model_failure_degrades_to_a_labelled_fallback_not_an_error(monkeypatch):
    monkeypatch.setattr(decide, "_make_fastembed", lambda allow_download=False: (None, "no network and no cache (test)"))
    decide.reset_backends()
    try:
        be = decide.get_backend()
        assert be.key == decide.LEXICAL_KEY and "lexical" in be.label
        st = decide.status()
        assert st["fallback"] and "no network" in st["reason"] and st["calibrated"]
        d = decide.decide_intent("fix the plan")                       # never raises; says which backend decided
        assert d.backend == decide.LEXICAL_KEY and d.calibrated
        assert decide.check_two_layer("He is fine, give him aspirin.", log=False)["blocked_by"]
    finally:
        monkeypatch.undo()
        decide.reset_backends()


def test_a_model_with_no_calibration_is_not_used_for_decisions(monkeypatch):
    monkeypatch.setenv("FASTEMBED_MODEL", "some/other-model")
    decide.reset_backends()
    try:
        assert decide.model_name() == "some/other-model"
        assert decide.get_backend().key == decide.LEXICAL_KEY           # not cached here → fallback; and never uncalibrated
    finally:
        monkeypatch.undo()
        decide.reset_backends()


def test_uncalibrated_backend_forces_abstain(monkeypatch):
    monkeypatch.setattr(decide, "_calibration_cache", {"data": {"backends": {}}})
    d = decide.decide_intent("fix the plan", backend=decide.get_backend("lexical"))
    assert d.abstain and not d.calibrated and d.note and "calibration" in d.note
    decide._calibration_cache.clear()


# ── calibration math ────────────────────────────────────────────────────────

def test_softmax_and_ece_on_toy_data():
    p = decide.softmax(np.array([[2.0, 1.0, 0.0]]), 1.0)
    assert p.sum() == pytest.approx(1.0) and p.argmax() == 0
    assert decide.softmax(np.array([[2.0, 1.0, 0.0]]), 0.1)[0, 0] > 0.99          # low temperature sharpens
    rng = np.random.RandomState(1)
    conf = rng.uniform(0.5, 1.0, 4000)
    calibrated = rng.uniform(size=4000) < conf
    overconfident = rng.uniform(size=4000) < (conf - 0.25).clip(0.05)
    assert decide.expected_calibration_error(conf, calibrated) < 0.04
    assert decide.expected_calibration_error(conf, overconfident) > 0.15
    rows = decide.reliability_table(conf, calibrated)
    assert sum(r["n"] for r in rows) == 4000 and len(rows) == decide.ECE_BINS


def test_temperature_is_fit_by_held_out_nll_and_tracks_the_true_temperature():
    rng = np.random.RandomState(0)
    n, k, true_t = 3000, 4, 0.05
    sims = rng.uniform(0.2, 0.9, (n, k))
    y = np.array([rng.choice(k, p=decide.softmax(s, true_t)) for s in sims])
    fitted = decide.fit_temperature(decide.Sims(sims, np.arange(k), k), y)
    assert fitted == pytest.approx(true_t, rel=0.15)
    # the fitted T beats a wrong one on the same data
    s = decide.Sims(sims, np.arange(k), k)
    assert decide.nll(s, y, fitted) < decide.nll(s, y, 0.5) and decide.nll(s, y, fitted) < decide.nll(s, y, 0.005)


def test_abstain_threshold_rule():
    conf = np.array([0.95, 0.9, 0.85, 0.7, 0.6, 0.5])
    correct = np.array([1, 1, 1, 0, 1, 0], bool)
    th, status = decide.choose_abstain_threshold(conf, correct, target=0.9)
    assert status == "target_met" and th == 0.85                    # lowest θ whose answered items are ≥ 90 % right
    th, status = decide.choose_abstain_threshold(conf, np.zeros(6, bool), target=0.9)
    assert status == "target_not_met"


def test_guard_threshold_rule_fails_closed():
    conf = np.array([0.99, 0.97, 0.9, 0.8, 0.6])
    pred_pass = np.array([1, 1, 1, 1, 1], bool)
    truth_flag = np.array([0, 0, 0, 1, 1], bool)
    th, status = decide.choose_guard_threshold(conf, pred_pass, truth_flag, max_miss=0.05)
    assert status == "target_met" and th == 0.9                     # items it passes below 0.9 abstain (= block)


def test_split_is_stratified_deterministic_and_disjoint():
    ds = decide.load_dataset()
    assert ds["synthetic"] is True and "synthetic" in ds["note"].lower()
    for key in ("intent", "intensity", "guard_assist"):
        tr, ho = decide.assign_splits(ds[key])
        assert (tr, ho) == decide.assign_splits(ds[key])
        assert not {i["text"] for i in tr} & {i["text"] for i in ho}
        assert len(tr) + len(ho) == len(ds[key])
        assert 0.25 <= len(ho) / len(ds[key]) <= 0.36
        for label in {i["label"] for i in ds[key]}:
            assert any(i["label"] == label for i in tr) and any(i["label"] == label for i in ho)
    assert decide.assign_splits(ds["intent"], seed=1) != decide.assign_splits(ds["intent"], seed=0)


def test_dataset_has_no_duplicates_or_conflicting_labels():
    ds = decide.load_dataset()
    for key in ("intent", "intensity", "guard_assist", "athlete", "drill"):
        seen: dict[str, object] = {}
        for it in ds[key]:
            norm = re.sub(r"[^a-z0-9 ]", "", it["text"].lower()).strip()
            assert norm not in seen, (key, it["text"])
            seen[norm] = it["label"]


def test_calibration_file_matches_the_dataset_and_results_json():
    import hashlib
    cal = json.loads(decide.CALIBRATION_PATH.read_text())
    res = json.loads((ROOT / "validation" / "results.json").read_text())["voice_decide"]
    assert cal["synthetic"] is True and res["synthetic"] is True and res["dataset"]["synthetic"] is True
    assert cal["dataset_sha1"] == hashlib.sha1(decide.DATASET_PATH.read_bytes()).hexdigest() == res["dataset"]["sha1"], \
        "dataset changed: run `python -m validation.voice_decide`"
    for key, backend in cal["backends"].items():
        for dec in ("intent", "athlete", "drill", "intensity", "guard_assist"):
            c, r = backend[dec], res["backends"][key]["decisions"][dec]
            assert c["temperature"] == r["temperature"] and c["threshold"] == r["threshold"]
            assert c["temperature"] > 0 and 0 < c["threshold"] <= 1.001


# ── classifiers (embedding model) ───────────────────────────────────────────

@needs_embeddings
@pytest.mark.parametrize("text,expected", [
    ("what's the wet bulb out there at four thirty", "field_conditions"),
    ("clean up my plan so nobody goes over", "optimize"),
    ("what if we skip the cooldown", "what_if"),
    ("how hot does Marcus get", "athlete_status"),
])
def test_intent_routes_clear_utterances(text, expected):
    d = decide.decide_intent(text)
    _typed(d, set(decide.INTENTS))
    assert d.backend.startswith("fastembed:") and d.calibrated
    assert d.choice == expected or (d.abstain and expected in d.top2), d.as_dict()


@needs_embeddings
def test_nonsense_does_not_become_a_confident_plan_question():
    d = decide.decide_intent("purple elephants sing on tuesdays")
    assert d.abstain or d.choice == "unclear", d.as_dict()


@needs_embeddings
def test_intensity_decision_and_low_confidence_abstains():
    d = decide.decide_intensity("wind sprints")
    assert d.choice == "max" or d.abstain
    d = decide.decide_intensity("water break")
    assert d.choice == "rest" or d.abstain
    weird = decide.decide_intensity("blorp")
    assert weird.abstain or weird.confidence < 0.9


@needs_embeddings
def test_athlete_is_a_choice_over_the_current_roster_not_the_fixture():
    roster = [{"id": "x1", "name": "Maya Okafor", "position": "QB"}, {"id": "x2", "name": "Priya Raman", "position": "WR"},
              {"id": "x3", "name": "Sofia Lind", "position": "LB"}, {"id": "x4", "name": "Dara Cole", "position": "LB"}]
    assert decide.decide_athlete("how is Priya doing", roster).choice == "x2"
    assert decide.decide_athlete("Maya's numbers", roster).choice == "x1"
    assert decide.decide_athlete("the quarterback", roster).choice == "x1"
    amb = decide.decide_athlete("how is the linebacker doing", roster)           # two linebackers: ask, do not guess
    assert amb.abstain and set(amb.top2) == {"x3", "x4"}
    unk = decide.decide_athlete("how is Isaiah doing", roster)                   # a fixture name that is not on THIS roster
    assert unk.choice == decide.NONE                                              # nobody on this roster: not a guess at x4
    assert decide.decide_athlete("how is he doing", roster).choice == decide.NONE
    assert decide.decide_athlete("who is over the line", roster).choice == decide.NONE
    assert decide.decide_athlete("anything", []).choice is None
    assert decide.decide_athlete("Maya", roster[:1]).choice == "x1"               # a one-athlete roster still works


@needs_embeddings
def test_drill_is_a_choice_over_the_current_plan():
    plan = {"drills": [{"id": "k1", "name": "Tackling circuit"}, {"id": "k2", "name": "Seven on seven"},
                       {"id": "k3", "name": "Water break"}, {"id": "k4", "name": "Water break"}]}
    assert decide.decide_drill("what if we cut the tackling circuit", plan).choice == "k1"
    assert decide.decide_drill("shorten seven on seven", plan).choice == "k2"
    both = decide.decide_drill("the water break", plan)
    assert both.abstain and set(both.top2) == {"k3", "k4"}
    assert decide.decide_drill("the second water break", plan).choice == "k4"
    assert decide.decide_drill("the water break after seven on seven", plan).choice == "k3"


# ── guard assist: two layers, either blocks ─────────────────────────────────

PARAPHRASES = ["No cause for alarm with Devin, he's all good", "She's perfectly healthy, keep her in",
               "He's got the classic signs of heat exhaustion", "Nobody here is in any danger"]


@needs_embeddings
@pytest.mark.parametrize("text", PARAPHRASES)
def test_assist_blocks_paraphrases(text):
    d = decide.guard_assist(text)
    assert d.blocks and d.p_flag > 0.5, d.as_dict()


@needs_embeddings
def test_assist_catches_what_the_rules_miss_and_records_which_layer_blocked():
    missed = [t for t in PARAPHRASES if guard.check(t, log=False)["ok"]]
    assert missed, "pick paraphrases that guard.py alone lets through"
    r = decide.check_two_layer(missed[0], log=False)
    assert r["ok"] is False and r["blocked_by"] == ["assist"] and r["hits"] == []
    assert "[removed: semantic]" in r["redacted_text"]
    assert r["assist"]["hits"][0]["rule"] == "semantic" and r["assist"]["backend"].startswith("fastembed:")
    both = decide.check_two_layer("He is fine, give him aspirin.", log=False)
    assert both["ok"] is False and "guard.py" in both["blocked_by"]
    assert {h["rule"] for h in both["hits"]} == {"reassurance", "treatment"}          # guard.py's own hits, unchanged


@needs_embeddings
def test_rules_still_block_and_the_assist_does_not_get_in_the_way():
    r = decide.check_two_layer("Devin is safe to keep practicing.", log=False)
    assert r["ok"] is False and "guard.py" in r["blocked_by"] and "[removed: reassurance]" in r["redacted_text"]
    ok = decide.check_two_layer("Isaiah: estimated peak 40.28 °C typical and 41.53 °C at the 95th percentile. "
                                "Estimate, planning only.", log=False)
    assert ok["ok"] and ok["blocked_by"] == [] and ok["redacted_text"].startswith("Isaiah")


@needs_embeddings
def test_every_engine_written_voice_sentence_passes_both_layers():
    from fastapi.testclient import TestClient

    from engine.api import app
    c = TestClient(app)
    plan = c.get("/demo/inputs").json()["plan"]
    for intent, slots in [("plan_summary", {}), ("athlete_status", {"athlete_id": "a07"}), ("athlete_status", {"athlete_id": "a15"}),
                          ("field_conditions", {}), ("what_if", {"drill_id": "d6", "change": "remove"}),
                          ("what_if", {"drill_id": "d3", "change": "add_break"}), ("unknown", {}),
                          ("athlete_status", {}), ("what_if", {"change": "gear"})]:
        a = c.post("/voice/answer?demo=1", json={"intent": intent, "slots": slots, "plan": plan}).json()
        assert a["guard"]["ok"] and "[removed:" not in a["say"], (intent, a["say"], a["guard"])
        for label in a["labels"]:
            assert decide.check_two_layer(label, log=False)["ok"], label


def test_collapse_911_script_exception_still_works_with_the_assist():
    src = (ROOT / "web/src/views/CollapseMode.tsx").read_text()
    step = re.search(r"id:\s*'call',(.*?)\n\s*\},", src, re.S).group(1)
    strings = [m.group(1) for m in re.finditer(r"(?:detail|say):\s*'([^']*)'", step)]
    assert len(strings) == 2 and all("suspected exertional heat stroke" in s.lower() for s in strings)
    for s in strings:
        r = decide.check_two_layer(s, source="collapse.911_script", log=False)
        assert r["ok"] and r["blocked_by"] == [] and r["redacted_text"] == s, r
        assert decide.check_two_layer(s, source="api", log=False)["ok"] is False            # nowhere else
        assert guard.check(s, source="collapse.911_script", log=False)["ok"]               # guard.py itself is untouched


def test_guard_py_alone_is_unchanged_by_the_assist():
    out = guard.check("He is fine, give him aspirin.", log=False)
    assert set(out) == {"ok", "redacted_text", "hits"}


def test_api_guard_endpoint_reports_the_layer():
    from fastapi.testclient import TestClient

    from engine.api import app
    c = TestClient(app)
    r = c.post("/guard", json={"text": "He is fine, give him aspirin."}).json()
    assert r["ok"] is False and "guard.py" in r["blocked_by"] and {h["rule"] for h in r["hits"]} == {"reassurance", "treatment"}
    ok = c.post("/guard", json={"text": "Estimate, planning only."}).json()
    assert ok["ok"] and ok["blocked_by"] == [] and ok["assist"]["backend"]
    if _FE.semantic:
        r = c.post("/guard", json={"text": PARAPHRASES[0]}).json()
        assert r["ok"] is False and r["blocked_by"] == ["assist"] and r["assist"]["hits"]


def test_voice_sentences_blocked_by_the_assist_are_removed_and_labelled(monkeypatch):
    from engine import voice
    flag = decide.Decision("guard_assist", "flag", {"flag": 0.97, "pass": 0.03}, 0.97, False, ("flag", "pass"), "test", True)
    monkeypatch.setattr(decide, "guard_assist", lambda text, backend=None: flag)
    out = voice.finish("athlete_status", "Isaiah: estimated peak 40.28 °C. Estimate, planning only.", {}, ["estimate — planning only"])
    assert "[removed: semantic]" in out["say"] and out["numbers"] == []
    assert out["guard"]["blocked_by"] == ["assist"] and any("guard assist" in lab for lab in out["labels"])


def test_no_paid_api_is_touched_by_the_decision_layer():
    from fastapi.testclient import TestClient

    from engine import paid_api
    from engine.api import app
    before = paid_api.counts()["attempted"]
    c = TestClient(app)
    c.post("/voice/decide", json={"text": "what if we cut the gassers"})
    c.post("/guard", json={"text": "Estimate, planning only."})
    c.get("/voice/status")
    assert paid_api.counts()["attempted"] == before


# ── optional laptop-only NLI third vote (engine/nli_optional.py) ────────────

def test_nli_is_off_by_default_and_never_loads():
    from engine import nli_optional
    assert nli_optional.enabled() is False
    r = decide.check_two_layer("Estimate, planning only.", log=False)
    assert r["nli"] == {"enabled": False, "hits": []}


def test_nli_refuses_to_run_on_render(monkeypatch):
    from engine import nli_optional
    monkeypatch.setenv("HEATTWIN_DECIDE_NLI", "1")
    monkeypatch.setenv("RENDER", "true")
    assert nli_optional.enabled() is False
    monkeypatch.setattr(nli_optional, "_session", None)
    with pytest.raises(nli_optional.NLIUnavailable, match="Render"):
        nli_optional._load()


def _nli_ready() -> bool:
    from engine import nli_optional
    return nli_optional.cached()


@pytest.mark.skipif(not _nli_ready(), reason="optional DeBERTa-v3 zero-shot ONNX model not cached (python -m engine.nli_optional --fetch)")
def test_nli_third_vote_blocks_and_is_recorded(monkeypatch):
    from engine import nli_optional
    monkeypatch.setenv("HEATTWIN_DECIDE_NLI", "1")
    assert nli_optional.score("He is totally fine to keep going") > nli_optional.score("Add a five minute break after inside run")
    r = decide.check_two_layer("He is totally fine to keep going.", log=False)
    assert r["ok"] is False and "nli" in r["blocked_by"] and r["nli"]["active"] and r["nli"]["hits"]
    ok = decide.check_two_layer("Isaiah: estimated peak 40.28 °C typical. Estimate, planning only.", log=False)
    assert ok["ok"] and ok["nli"]["active"]


def test_the_scripted_demo_questions_are_not_in_the_dataset():
    """The 8 scripted voice questions (tests/test_e2e_demo.py) must stay a generalisation test, not training data."""
    scripted = ["Who crosses the planning line first in this practice?", "What's the WBGT at 4 pm, and which FHSAA zone is that?",
                "How hot does Isaiah get?", "What if we drop the gassers?", "What if team period is helmets only?", "Fix the plan.",
                "Can you do it in six changes or fewer?", "Is Devin safe to keep practicing?"]
    norm = lambda t: re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()  # noqa: E731
    in_data = {norm(i["text"]) for key in ("intent", "athlete", "drill", "intensity", "guard_assist") for i in decide.load_dataset()[key]}
    assert not [q for q in scripted if norm(q) in in_data]
