"""engine/guard.py — redact diagnosis, reassurance and non-KSI treatment language; pass protocol and planning text."""
from __future__ import annotations

import json

import pytest

from engine import fixtures, guard


@pytest.fixture(autouse=True)
def _tmp_log(tmp_path, monkeypatch):
    monkeypatch.setattr(guard, "LOG_PATH", tmp_path / "guard_hits.jsonl")


@pytest.mark.parametrize("text,rule", [
    ("Devin is safe to keep practicing.", "reassurance"),
    ("Everyone looks fine after the break.", "reassurance"),
    ("Marcus is OK now.", "reassurance"),
    ("He's cleared to play.", "reassurance"),
    ("No risk for the backs today.", "reassurance"),
    ("Jalen has heat stroke.", "diagnosis"),
    ("This is exertional heat stroke.", "diagnosis"),
    ("The athlete is suffering from heat exhaustion.", "diagnosis"),
    ("Kai is dehydrated.", "diagnosis"),
    ("Our diagnosis: hyperthermia.", "diagnosis"),
    ("Give him ibuprofen for the fever.", "treatment"),
    ("Start IV fluids.", "treatment"),
    ("Core estimate is 38.6 °C, so stop cooling.", "treatment"),
    ("Take him out of the tub now.", "treatment"),
])
def test_blocks_and_redacts(text, rule):
    out = guard.check(text)
    assert out["ok"] is False
    assert any(h["rule"] == rule for h in out["hits"])
    assert f"[removed: {rule}]" in out["redacted_text"]


@pytest.mark.parametrize("text", [
    "estimate — planning only",
    "not a diagnosis",
    "Times entered by coach; not a diagnosis.",
    "This plan is not safe to run as written.",
    "Safety boundary: rectal temperature is the only basis for treatment.",
    "Unsafe gear combination for day-2 athletes.",
    "Cool first, transport second.",
    "Immerse in cold water under 15 °C and stir the water aggressively.",
    "Call 911 now.",
    "Remove from the tub only after rectal temperature reaches 39 °C (KSI).",
    "If no rectal thermometer is available, cool for 10-15 minutes and then transport.",
    "Estimated p95 core 39.2 °C is at or above the 39.0 °C planning limit.",
    "Added a 4-min shaded water break after 'Inside run' at 16:08",
    "Ran 'Team period' in 2 platoons (8 athletes × 12 min, 8 athletes × 13 min); the resting platoon waits in the shaded cooling area",
])
def test_passes_protocol_and_planning_text(text):
    out = guard.check(text)
    assert out["ok"], out["hits"]
    assert out["redacted_text"] == text


def test_hits_are_logged(tmp_path):
    guard.check("He is fine.", source="test")
    lines = [json.loads(x) for x in guard.LOG_PATH.read_text().splitlines()]
    assert lines and lines[0]["rule"] == "reassurance" and lines[0]["source"] == "test"


def test_engine_outputs_pass_the_guard():
    from engine.optimizer import optimize
    res = optimize(fixtures.plan(), fixtures.roster()[:4], fixtures.forecast(), n_ensemble=10, budget_s=60,
                   max_iterations=40, seed=0)
    texts = res["labels"] + res["infeasible_reasons"] + [c["detail"] for c in res["changes"]]
    texts += res["original"]["labels"] + [v["detail"] for v in res["original"]["fhsaa_violations"]]
    for t in texts:
        assert guard.check(t, log=False)["ok"], t


def test_api_guard_endpoint():
    from fastapi.testclient import TestClient
    from engine.api import app
    r = TestClient(app).post("/guard", json={"text": "He is fine, give him aspirin."}).json()
    assert r["ok"] is False and {h["rule"] for h in r["hits"]} == {"reassurance", "treatment"}


# ── polish 2a: the Collapse 911 script may say "suspected exertional heat stroke" (KSI step 1); nothing else may ──
SCRIPT = "collapse.911_script"
PHRASE = "suspected exertional heat stroke"


def _collapse_911_strings() -> list[str]:
    """The 'call' step's detail and spoken line, read from the shipped Collapse screen."""
    import re
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2] / "web/src/views/CollapseMode.tsx").read_text()
    step = re.search(r"id:\s*'call',(.*?)\n\s*\},", src, re.S).group(1)
    out = [m.group(1) for m in re.finditer(r"(?:detail|say):\s*'([^']*)'", step)]
    assert len(out) == 2 and all(PHRASE in s.lower() for s in out), out
    return out


def test_collapse_911_script_passes_with_its_own_source():
    for s in _collapse_911_strings():
        out = guard.check(s, source=SCRIPT)
        assert out["ok"], out["hits"]
        assert out["redacted_text"] == s


@pytest.mark.parametrize("source", ["", "api", "voice.tts", "voice", "labels", "hr", "replay", "changes",
                                    "top_changes_text", "collapse", "collapse.911"])
def test_same_phrase_is_blocked_everywhere_else(source):
    for s in [*_collapse_911_strings(), PHRASE, f"Say {PHRASE}.", "This could be suspected heat stroke."]:
        out = guard.check(s, source=source)
        assert out["ok"] is False and any(h["rule"] == "diagnosis" for h in out["hits"]), (source, s)


def test_script_exception_is_only_that_phrase():
    for s in ["Say suspected heat exhaustion.", "Possible exertional heat stroke.", "He has heat stroke.",
              "The athlete is fine.", "Give him ibuprofen."]:
        assert guard.check(s, source=SCRIPT)["ok"] is False, s


def test_api_guard_cannot_claim_the_script_exception():
    from fastapi.testclient import TestClient
    from engine.api import app
    r = TestClient(app).post("/guard", json={"text": f"Say {PHRASE}.", "source": SCRIPT}).json()
    assert r["ok"] is False


def test_script_exception_is_cited():
    from engine import consts
    blk = consts.get("guard_exceptions")
    assert blk["status"] == "VERIFIED" and "suspected" in blk["quote_or_location"] and blk["url"].startswith("https://")
    assert blk["scripts"][SCRIPT] == [PHRASE]


def test_live_guidance_card_passes_guard_endpoint():
    """polish 2b: the model-triggered card on the Live roster is neutral (no diagnosis, no symptom checklist)."""
    import re
    from pathlib import Path

    from fastapi.testclient import TestClient
    from engine.api import app
    src = (Path(__file__).resolve().parents[2] / "web/src/views/CoachDashboard.tsx").read_text()
    card = re.search(r"function GuidanceCard\(\).*?\n\}\n", src, re.S).group(0)
    jsx = card[card.index('className="eyebrow"'):]
    texts = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", t)).strip() for t in re.findall(r">([^<>{}]+(?:<strong>[^<]*</strong>[^<>{}]*)?)<", jsx)]
    texts = [t for t in texts if t]
    assert "Heads-up" in texts and any("emergency action plan" in t for t in texts), texts
    c = TestClient(app)
    for t in texts:
        r = c.post("/guard", json={"text": t}).json()
        assert r["ok"], (t, r["hits"])
        assert not re.search(r"heat\s*stroke|heat\s+illness|confused|stumbling", t, re.I), t
