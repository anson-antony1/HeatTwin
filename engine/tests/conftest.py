"""Engine tests run on fixtures with no network (CLAUDE.md rule 6)."""
import os

import pytest

os.environ["HEATTWIN_NODE"] = "off"   # never let the engine's built-in bridge grab a real Arduino during tests
os.environ["HEATTWIN_DISABLE_PAID_APIS"] = "1"   # no Gemini / ElevenLabs request from any test (engine/paid_api.py)


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: runs the optimizer on the full demo fixture with the default budget")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch, tmp_path_factory):
    """engine.weather (WS1) never calls NWS in tests and sees no cached live forecasts → the curated fixture."""
    from engine import weather

    def offline(*a, **k):
        raise ConnectionError("tests run offline")
    monkeypatch.setattr(weather, "fetch_gridpoint", offline)
    monkeypatch.setattr(weather, "CACHE_DIR", tmp_path_factory.mktemp("weather_cache"))
    from engine import field_sensor
    field_sensor.reset()          # the in-memory NWS cache of the Arduino field mode never leaks between tests
    yield
    field_sensor.reset()


@pytest.fixture(autouse=True)
def _no_paid_apis(monkeypatch):
    """Tests never reach Gemini or ElevenLabs: no key from the shell or .env (tests that need one set a fake key and
    stub the call)."""
    from engine import llm_plan
    for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(llm_plan, "_load_dotenv", lambda: None)


@pytest.fixture(autouse=True)
def _committed_hr_only(monkeypatch, tmp_path_factory):
    """Tests see only the HR recordings committed to git, never a local (uncommitted) one in fixtures/, so a strap
    session on this machine cannot change test results (validation reads real recordings). Tests about other
    recordings set demo_data.FIXTURES themselves."""
    import shutil
    import subprocess

    from engine import demo_data
    d = tmp_path_factory.mktemp("hr_fixtures")
    root = demo_data.FIXTURES.parent
    try:
        tracked = subprocess.run(["git", "ls-files", "fixtures/hr_*.csv"], cwd=root, capture_output=True, text=True,
                                 check=True).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        tracked = [f"fixtures/{demo_data.SYNTHETIC_HR}"]
    for rel in tracked:
        shutil.copy(root / rel, d / (root / rel).name)
    monkeypatch.setattr(demo_data, "FIXTURES", d)
