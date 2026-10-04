"""`make check-sources`: fail if a constant the demo path uses is TODO, or a block has no source (CLAUDE.md rule 2).

    python engine/check_sources.py

* Lists every constants.yaml block (and nested entry) whose status is TODO.
* Runs the demo path (POST /simulate?demo=1 and /optimize?demo=1, in-process) and reads the engine's own label
  "uses unverified constants: …" — the constants that path actually touched — and fails if any of them is TODO.
* Fails if a top-level block with numbers has neither ``source`` nor a DESIGN/ablation status note.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _todos(node: Any, path: str = "") -> list[str]:
    out = []
    if isinstance(node, dict):
        if str(node.get("status", "")).upper() == "TODO":
            out.append(path)
        for k, v in node.items():
            out += _todos(v, f"{path}.{k}" if path else str(k))
    return out


def main() -> int:
    import yaml
    from fastapi.testclient import TestClient

    from engine.api import app
    root = Path(__file__).resolve().parent
    data = yaml.safe_load((root / "constants.yaml").read_text())
    todos = _todos(data)
    unsourced = [k for k, v in data.items() if isinstance(v, dict) and not v.get("source")
                 and str(v.get("status", "")).upper() not in ("DESIGN",) and "note" not in v]
    c = TestClient(app)
    used: set[str] = set()
    for path in ("/simulate?demo=1", "/optimize?demo=1"):
        for lab in c.post(path, json={}).json().get("labels", []):
            m = re.match(r"uses unverified constants: (.*)", lab)
            if m:
                used |= {re.sub(r"\s*\(.*\)$", "", x.strip()) for x in m.group(1).split(",")}
    todo_used = sorted(u for u in used if any(u == t or u.startswith(t + ".") or t.startswith(u + ".") for t in todos))
    print(f"TODO constants ({len(todos)}): {', '.join(todos) or 'none'}")
    print(f"unverified constants on the demo path ({len(used)}): {', '.join(sorted(used)) or 'none'}")
    if unsourced:
        print(f"FAIL blocks with no source, status or note: {', '.join(unsourced)}")
    if todo_used:
        print(f"FAIL TODO constants used by the demo path: {', '.join(todo_used)}")
    if not (todo_used or unsourced):
        print("OK: no TODO constant on the demo path; every block has a source or a DESIGN note")
    return 1 if (todo_used or unsourced) else 0


if __name__ == "__main__":
    sys.exit(main())
