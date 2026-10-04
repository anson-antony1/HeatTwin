"""Kill switch: with HEATTWIN_DISABLE_PAID_APIS on (the default), no Gemini or ElevenLabs request is ever sent."""
import pytest

from engine import llm_plan, paid_api, voice


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    paid_api.reset()
    monkeypatch.setattr(paid_api, "LOG_PATH", tmp_path / "paid_api.jsonl")
    monkeypatch.setenv("GEMINI_API_KEY", "would-be-real")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "would-be-real")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "v")

    def no_network(*a, **k):
        raise AssertionError("a paid API request was attempted over the network")
    import requests
    monkeypatch.setattr(requests, "post", no_network)


def test_switch_defaults_on(monkeypatch):
    monkeypatch.delenv("HEATTWIN_DISABLE_PAID_APIS", raising=False)
    assert paid_api.disabled() is True


def test_gemini_plan_parse_falls_back_without_a_request():
    with pytest.raises(llm_plan.LLMNotConfigured, match="paid APIs are disabled"):
        llm_plan._call_gemini([{"text": "x"}])
    assert llm_plan.status()["configured"] is False


def test_gemini_voice_intent_falls_back_without_a_request():
    with pytest.raises(llm_plan.LLMNotConfigured):
        voice._call([{"text": "how is Isaiah"}])


def test_elevenlabs_tts_falls_back_without_a_request():
    with pytest.raises(voice.TTSUnavailable, match="paid APIs are disabled"):
        voice.tts("Call nine one one now.")


def test_attempts_are_counted_logged_and_served():
    for f in (lambda: llm_plan._call_gemini([{"text": "x"}]), lambda: voice.tts("hi")):
        with pytest.raises(Exception):
            f()
    c = paid_api.counts()
    assert c["attempted"] == 2 and c["sent"] == 0 and c["by_api"]["gemini"]["attempted"] == 1
    assert len(paid_api.LOG_PATH.read_text().splitlines()) == 2
    from fastapi.testclient import TestClient
    from engine.api import app
    h = TestClient(app).get("/health").json()
    assert h["ok"] is True and h["paid_api"]["sent"] == 0 and h["paid_api"]["disabled"] is True
