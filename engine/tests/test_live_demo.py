"""Overnight item 3: live-demo profile, athlete-only suggestion and Apply."""
import json
import subprocess
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine import api, consts, profiles, suggest
from engine.physio import twonode

client = TestClient(api.app)
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def local_dir(tmp_path, monkeypatch):
    d = tmp_path / "local"
    d.mkdir()
    monkeypatch.setattr(profiles, "LOCAL_DIR", d)
    monkeypatch.delenv("HEATTWIN_PROFILE", raising=False)
    return d


def test_personal_profiles_are_git_ignored():
    r = subprocess.run(["git", "check-ignore", "-q", "profiles/local/anson.json"], cwd=ROOT)
    assert r.returncode == 0


def test_incomplete_local_profile_falls_back_to_the_fictional_athlete(local_dir):
    (local_dir / "anson.json").write_text(json.dumps({"id": "live1", "name": "Anson (live)", "height_m": None}))
    p, labels = profiles.load()
    assert p["name"] == "Demo athlete (live)" and any("incomplete" in x for x in labels)
    assert any("fictional, synthetic" in x for x in labels)


def test_complete_local_profile_is_used_and_demo_overrides(local_dir, monkeypatch):
    full = {**profiles.demo_profile(), "name": "Tester (live)", "_comment": "x"}
    (local_dir / "tester.json").write_text(json.dumps(full))
    p, labels = profiles.load()
    assert p["name"] == "Tester (live)" and "_comment" not in p and "not in the repo" in labels[0]
    monkeypatch.setenv("HEATTWIN_PROFILE", "demo")
    assert profiles.load()[0]["name"] == "Demo athlete (live)"


def _post(start: str, secs, bpm_at):
    t0 = twonode.parse_time(start)
    out = None
    for s in secs:
        out = client.post("/hr", json={"athlete_id": "live1", "ts": (t0 + timedelta(seconds=s)).isoformat(),
                                       "hr_bpm": bpm_at(s), "device": "synthetic rehearsal"}).json()
    return out


def test_live_profile_session_suggests_and_applies(local_dir):
    r = client.post("/live/start", json={"profile": True, "start_now": True}).json()
    assert r["athletes"][-1] == "live1" and r["live_demo"]["live1"]["intensity"] == "max"
    assert r["labels"][0] == "live demo · conditioning"
    hr = lambda s: 82 if s < 120 else (82 + (s - 120) * 2 if s < 160 else 162)   # noqa: E731 — stand, then jumping jacks
    _post(r["start"], range(0, 125), hr)
    a = client.get("/live/state").json()["athletes"]["live1"]
    assert not a["gates"]["flag"] and "suggestion" not in a          # standing is not evidence of the drill
    _post(r["start"], range(125, 185), hr)
    st = client.get("/live/state").json()
    a = st["athletes"]["live1"]
    assert st["roster_extra"][0]["id"] == "live1"
    assert a["gates"]["flag"] is True                                 # first informative window, ≈ 60 s after the rise
    sg = a["suggestion"]
    assert 1 <= len(sg["changes"]) <= consts.get("live_suggest.max_changes") and sg["guard_ok"] is True
    assert sg["after"]["peak_core_c_p95"] < sg["before"]["peak_core_c_p95"]
    assert "plan" not in sg and "Estimate — planning only." in sg["outcome"]
    ap = client.post("/live/apply", json={"athlete_id": "live1"}).json()
    assert ap["ok"] and ap["applied"]["after"] == sg["after"]
    st = client.get("/live/state").json()
    a = st["athletes"]["live1"]
    assert round(a["athlete"]["peak_core_c_p95"], 2) == sg["after"]["peak_core_c_p95"]   # what the card promised
    if sg["after"]["under_line"]:
        assert a["gates"]["flag"] is False and "suggestion" not in a
    assert client.post("/live/apply", json={"athlete_id": "live1"}).status_code == 404
    assert api._LIVE["session"].plan["drills"] == ap["plan"]["drills"]
    from engine import fixtures
    assert ap["plan"]["start"] == fixtures.plan()["start"]   # the web's plan keeps its own start


def test_suggestion_respects_cap_budget_and_only_changes_that_athlete():
    from engine import fixtures
    plan, roster, w = fixtures.plan(), fixtures.roster(), fixtures.forecast()
    res = suggest.suggest(plan, roster, w, "a07", 3.0)
    assert res is not None and len(res["changes"]) <= 2 and res["elapsed_s"] < consts.get("live_suggest.budget_s") + 2
    new = res["plan"]
    assert sum(float(d["duration_min"]) for d in new["drills"]) == sum(float(d["duration_min"]) for d in plan["drills"])
    for d in new["drills"]:   # everyone else keeps every drill; only a07 is rotated out or re-geared
        if d.get("participants") is not None:
            assert set(a["id"] for a in roster) - set(d["participants"]) == {"a07"}
        for aid, g in (d.get("gear_by_athlete") or {}).items():
            base = next(x for x in plan["drills"] if x["id"] == d["id"].rstrip("r"))
            if aid != "a07":
                assert g == (base.get("gear_by_athlete") or {}).get(aid, base["gear"])
    from engine import guard
    assert guard.check(res["text"], log=False)["ok"]


def test_hr_replay_offers_the_suggestion_at_the_first_flag():
    """Render has no strap: the synthetic HR replay offers the same athlete-only suggestion (with its plan)."""
    r = client.post("/live/replay?demo=1", json={"file": "hr_a07_synthetic.csv"}).json()
    sg = r["suggestions"]["a07"]
    first_flag = next(f["minute"] for f in r["frames"] if f["athlete_id"] == "a07" and f["gates"].get("flag"))
    assert sg["at_minute"] == first_flag and sg["plan"]["id"] == r["plan_forecast"]["plan_id"]
    assert sg["guard_ok"] and 1 <= len(sg["changes"]) <= 2 and "replay" in sg["labels"]
    assert sg["after"]["peak_core_c_p95"] < sg["before"]["peak_core_c_p95"]
