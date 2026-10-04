"""Engine tests run on fixtures with no network (CLAUDE.md rule 6)."""
import pytest


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
