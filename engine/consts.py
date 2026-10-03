"""Read-only access to engine/constants.yaml.

Logic never hard-codes a physiological, physical or regulatory number: it calls
``get("block.key")``. ``status(block)`` reports VERIFIED / SECONDARY / TODO / DESIGN so
outputs can label which unverified constants a result depends on.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import yaml

CONSTANTS_PATH = Path(__file__).with_name("constants.yaml")


@lru_cache(maxsize=1)
def load() -> dict[str, Any]:
    with CONSTANTS_PATH.open() as f:
        return yaml.safe_load(f)


def get(path: str, default: Any = ...) -> Any:
    """``get("gagge_1986.c_sw_g_m2_h_k")`` → value. Raises KeyError if missing and no default."""
    node: Any = load()
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit():
            node = node[int(part)]
        else:
            if default is ...:
                raise KeyError(f"constants.yaml has no '{path}'")
            return default
    return node


def status(block: str) -> str:
    """Status of a top-level block (or a sub-block that carries its own ``status``)."""
    node: Any = load()
    found = "MISSING"
    for part in block.split("."):
        if not isinstance(node, dict) or part not in node:
            return found
        node = node[part]
        if isinstance(node, dict) and "status" in node:
            found = str(node["status"])
    return found


def unverified(blocks: Iterable[str]) -> list[str]:
    """Blocks whose status is not VERIFIED, as ``"block (STATUS)"`` strings, sorted."""
    out = []
    for b in sorted(set(blocks)):
        s = status(b)
        if s != "VERIFIED":
            out.append(f"{b} ({s})")
    return out


def as_json() -> dict[str, Any]:
    """constants.yaml as a JSON-able dict (for GET /sources)."""
    return load()
