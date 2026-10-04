"""`make check-sources` (CLAUDE.md rule 2): every constant the demo path uses is sourced, or a justified DESIGN choice.

    python engine/check_sources.py

* Runs the demo path (POST /simulate?demo=1 and /optimize?demo=1, in-process) and reads the engine's own label
  "uses unverified constants: …" — the non-VERIFIED constants that path actually touched.
* FAIL if any of them is TODO.
* FAIL if any of them is DESIGN without a ``justification`` field (owner decision Oct 3: DESIGN is accepted only with a
  written justification; the web's Settings → Sources card shows them).
Lists every TODO and DESIGN entry, and (for information) top-level blocks with no top-level ``source``.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def entries(node: Any, path: str = "") -> dict[str, dict]:
    """Every dict (block or nested entry) that carries a status, by dotted path."""
    out: dict[str, dict] = {}
    if isinstance(node, dict):
        if "status" in node and path:
            out[path] = node
        for k, v in node.items():
            out.update(entries(v, f"{path}.{k}" if path else str(k)))
    return out


def _covers(a: str, b: str) -> bool:
    return a == b or a.startswith(b + ".") or b.startswith(a + ".")


def main() -> int:
    import yaml
    from fastapi.testclient import TestClient

    from engine.api import app
    data = yaml.safe_load((Path(__file__).resolve().parent / "constants.yaml").read_text())
    ent = entries(data)
    todo = sorted(k for k, v in ent.items() if str(v.get("status")).upper() == "TODO")
    design = sorted(k for k, v in ent.items() if str(v.get("status")).upper() == "DESIGN")
    c = TestClient(app)
    used: set[str] = set()
    for path in ("/simulate?demo=1", "/optimize?demo=1"):
        for lab in c.post(path, json={}).json().get("labels", []):
            m = re.match(r"uses unverified constants: (.*)", lab)
            if m:
                used |= {re.sub(r"\s*\(.*\)$", "", x.strip()) for x in m.group(1).split(",")}
    todo_used = sorted(t for t in todo if any(_covers(t, u) for u in used))
    design_used = sorted(d for d in design if any(_covers(d, u) for u in used))
    unjustified = [d for d in design_used if not ent[d].get("justification")]
    unsourced = [k for k, v in data.items() if isinstance(v, dict) and not v.get("source")
                 and not (str(v.get("status", "")).upper() == "DESIGN" and (v.get("note") or v.get("justification")))]
    print(f"TODO entries ({len(todo)}): {', '.join(todo) or 'none'}")
    print(f"DESIGN entries ({len(design)}); on the demo path: {', '.join(design_used) or 'none'}")
    print(f"non-VERIFIED constants on the demo path ({len(used)}): {', '.join(sorted(used)) or 'none'}")
    fails = []
    if todo_used:
        fails.append(f"TODO constants used by the demo path: {', '.join(todo_used)}")
    if unjustified:
        fails.append(f"DESIGN constants on the demo path without a justification: {', '.join(unjustified)}")
    if unsourced:
        print(f"info: blocks with no top-level source (not on the demo path checks): {', '.join(unsourced)}")
    for f in fails:
        print("FAIL " + f)
    if not fails:
        print("OK: no TODO on the demo path; every DESIGN constant on it has a written justification")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
