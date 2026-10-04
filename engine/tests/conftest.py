"""Engine tests run on fixtures with no network (CLAUDE.md rule 6)."""
import os

import pytest

os.environ["HEATTWIN_NODE"] = "off"   # never let the engine's built-in bridge grab a real Arduino during tests


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


@pytest.fixture(autouse=True)
def _committed_hr_only(monkeypatch, tmp_path_factory):
    """Tests see only the HR recordings committed to git, never a local (uncommitted) one in fixtures/ — the newest real
    recording wins the replay by design, so a strap session on this machine must not change test results. Tests about
    other recordings set demo_data.FIXTURES themselves."""
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
