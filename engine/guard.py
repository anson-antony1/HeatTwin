"""Language guard (Relay-style) for every user-facing sentence HeatTwin generates.

Policy (CLAUDE.md rule 4; KSI / MHSAA cold-water-immersion guidance):
  * no diagnosis — HeatTwin never says an athlete has, or is, a heat illness;
  * no reassurance — never "safe", "fine", "OK", "cleared", "no risk" about an athlete or plan;
  * no treatment beyond the KSI cooling protocol — no medication, no deciding to stop cooling (only the KSI rule
    "remove once rectal temperature reaches 39 °C", stated with rectal temperature, is allowed).

``check(text)`` → ``{ok, redacted_text, hits}`` (CONTRACTS POST /guard). Each hit is replaced by
``[removed: <rule>]`` and appended to ``engine/logs/guard_hits.jsonl`` (git-ignored) so the team can audit what the
guard caught. Negated forms ("not a diagnosis", "is not safe") and words that merely contain a term ("safety",
"unsafe") pass.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

LOG_PATH = Path(__file__).resolve().parent / "logs" / "guard_hits.jsonl"

_NEG_BEFORE = re.compile(r"\b(?:not|never|no|isn't|aren't|cannot|can't|nor)\b(?:\s+(?:a|an|be|been|considered|"
                         r"yet|always|necessarily))?\s*$", re.I)
_ILLNESS = (r"(?:exertional\s+)?(?:heat\s*stroke|heat\s+exhaustion|heat\s+illness|hyperthermia|heat\s+syncope|"
            r"heat\s+cramps|dehydration|EHS|EHI)")

# (rule, pattern, negatable): a negatable hit is skipped when the words right before it negate it
RULES: list[tuple[str, re.Pattern[str], bool]] = [
    # ── diagnosis ──
    ("diagnosis", re.compile(r"\bdiagnos(?:is|es|ed|e|ing)\b", re.I), True),
    ("diagnosis", re.compile(rf"\b(?:has|have|had|is\s+having|is\s+suffering\s+from|suffers\s+from|suffering\s+from|"
                             rf"is\s+showing\s+signs\s+of|shows\s+signs\s+of|presenting\s+with|is\s+in)\s+(?:an?\s+)?"
                             rf"{_ILLNESS}\b", re.I), False),
    ("diagnosis", re.compile(rf"\b(?:this|it|that)\s+(?:is|looks\s+like|appears\s+to\s+be)\s+(?:an?\s+)?{_ILLNESS}\b",
                             re.I), False),
    ("diagnosis", re.compile(r"\b(?:is|are|looks)\s+(?:severely\s+|mildly\s+)?(?:dehydrated|hyperthermic)\b", re.I),
     False),
    ("diagnosis", re.compile(rf"\b(?:suspected|suspect|possible|probable)\s+(?:of\s+)?(?:an?\s+)?{_ILLNESS}\b", re.I),
     True),
    # ── reassurance ──
    ("reassurance", re.compile(r"\b(?:safe|fine|okay|ok|all\s+clear|cleared(?:\s+to\s+play)?|good\s+to\s+go|"
                               r"out\s+of\s+danger|no\s+risk|nothing\s+to\s+worry\s+about)\b", re.I), True),
    # ── treatment beyond KSI cooling ──
    ("treatment", re.compile(r"\b(?:aspirin|ibuprofen|acetaminophen|paracetamol|tylenol|advil|motrin|nsaids?|"
                             r"antipyretics?|fever\s+reducers?|medications?|medicines?|pills?|salt\s+tablets?|"
                             r"iv\s+fluids?|intravenous)\b", re.I), True),
    ("treatment", re.compile(r"\b(?:stop|end|discontinue|halt)\s+(?:the\s+)?cooling\b", re.I), True),
    ("treatment", re.compile(r"\b(?:take|get|pull|remove)\s+(?:him|her|them|the\s+athlete|\w+)?\s*out\s+of\s+the\s+"
                             r"(?:tub|water|ice\s+bath)\b", re.I), True),
]

# KSI cooling-protocol sentences may mention removal when they tie it to rectal temperature (KSI CWI guide).
_KSI_REMOVAL = re.compile(r"rectal\s+temp\w*.{0,60}\b39\b|\b39\b.{0,60}rectal", re.I | re.S)


def _script_exceptions(source: str) -> set[str]:
    """Phrases the fixed script ``source`` may say (constants.yaml guard_exceptions.scripts, KSI step 1); else none."""
    from engine import consts
    return {_norm(p) for p in (consts.get("guard_exceptions.scripts", {}) or {}).get(source, [])}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _sentences(text: str) -> Iterable[tuple[int, int]]:
    start = 0
    for m in re.finditer(r"[.!?\n]+", text):
        yield start, m.end()
        start = m.end()
    if start < len(text):
        yield start, len(text)


def check(text: str, *, source: str = "", log: bool = True) -> dict[str, Any]:
    """Guard one text → ``{ok, redacted_text, hits[]}``. Hits are redacted and logged."""
    hits: list[dict[str, Any]] = []
    allowed = _script_exceptions(source) if source else set()
    for s0, s1 in _sentences(text):
        sent = text[s0:s1]
        ksi_removal_ok = bool(_KSI_REMOVAL.search(sent))
        for rule, pat, negatable in RULES:
            for m in pat.finditer(sent):
                if negatable and _NEG_BEFORE.search(sent[max(0, m.start() - 30):m.start()]):
                    continue
                if rule == "treatment" and ksi_removal_ok and re.search(r"out\s+of|stop|end|remove", m.group(0), re.I):
                    continue
                if allowed and _norm(m.group(0)) in allowed:
                    continue
                hits.append({"rule": rule, "match": m.group(0), "start": s0 + m.start(), "end": s0 + m.end()})
    hits.sort(key=lambda h: h["start"])
    merged: list[dict[str, Any]] = []
    for h in hits:  # drop overlaps (keep the first)
        if merged and h["start"] < merged[-1]["end"]:
            continue
        merged.append(h)
    out, pos = [], 0
    for h in merged:
        out.append(text[pos:h["start"]])
        out.append(f"[removed: {h['rule']}]")
        pos = h["end"]
    out.append(text[pos:])
    if merged and log:
        _log(merged, source)
    return {"ok": not merged, "redacted_text": "".join(out), "hits": merged}


def _log(hits: list[dict[str, Any]], source: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with LOG_PATH.open("a") as f:
            for h in hits:
                f.write(json.dumps({"ts": ts, "source": source, "rule": h["rule"], "match": h["match"]}) + "\n")
    except OSError:
        pass  # logging must never block guarding


def guard_strings(items: list[str], source: str) -> list[str]:
    return [check(x, source=source)["redacted_text"] for x in items]


def guard_result(res: dict[str, Any]) -> dict[str, Any]:
    """Guard every generated sentence in a SimulationResult / OptimizeResult in place."""
    for key in ("labels", "infeasible_reasons"):
        if isinstance(res.get(key), list):
            res[key] = guard_strings(res[key], key)
    for v in res.get("fhsaa_violations", []) or []:
        v["detail"] = check(v["detail"], source="fhsaa_violations")["redacted_text"]
    for c in res.get("changes", []) or []:
        c["detail"] = check(c["detail"], source="changes")["redacted_text"]
    for c in res.get("top_changes", []) or []:
        c["detail"] = check(c["detail"], source="top_changes")["redacted_text"]
    if isinstance(res.get("top_changes_text"), str):
        res["top_changes_text"] = check(res["top_changes_text"], source="top_changes_text")["redacted_text"]
    for sub in ("original", "optimized"):
        if isinstance(res.get(sub), dict):
            guard_result(res[sub])
    return res
