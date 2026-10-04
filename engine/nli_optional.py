"""OPTIONAL, LAPTOP-ONLY zero-shot NLI for the guard assist (decision (e)). Off by default; never on Render.

A DeBERTa-v3 zero-shot model (default ``MoritzLaurer/deberta-v3-base-zeroshot-v2.0``, ONNX, ~740 MB in RAM, ~40 ms per
sentence on a laptop CPU) reads the sentence as a premise and two hypotheses: "the text says a person is safe / fine / okay /
cleared" and "the text says a person has a heat illness or a diagnosis". Its entailment probability is a THIRD vote next to
engine/guard.py and the embedding assist (engine/decide.py ``check_two_layer``): block when any layer flags.

    HEATTWIN_DECIDE_NLI=1                       turn it on (default off)
    HEATTWIN_NLI_MODEL=<hf repo with onnx/…>    default above; e.g. MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33 (87 MB)
    HEATTWIN_NLI_ONNX=onnx/model.onnx           file inside the repo (xsmall: onnx/model_quantized.onnx)
    HEATTWIN_NLI_CACHE_DIR=…                    default <repo>/.cache/nli (git-ignored)
    python -m engine.nli_optional --fetch       download the model once (otherwise only a cached model loads)

No torch: onnxruntime + tokenizers (both already installed with fastembed). The decision threshold is computed by
``python -m validation.voice_decide`` on the held-out guard-assist items and stored in engine/data/decide_calibration.json
(``nli``); with no threshold or no model the layer is simply absent (``check_two_layer`` says so). The engine refuses to
load it when the ``RENDER`` environment variable is set.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"
DEFAULT_ONNX = "onnx/model.onnx"
HYPOTHESES = ("The text says that a person is safe, fine, okay, or cleared to continue.",
              "The text says that a person has a heat illness or a medical diagnosis.")
MAX_TOKENS = 256

_session: Any = None
_tokenizer: Any = None
_why: Optional[str] = None
_lock = threading.Lock()


class NLIUnavailable(RuntimeError):
    pass


def model_name() -> str:
    return os.environ.get("HEATTWIN_NLI_MODEL") or DEFAULT_MODEL


def onnx_file() -> str:
    return os.environ.get("HEATTWIN_NLI_ONNX") or (DEFAULT_ONNX if model_name() == DEFAULT_MODEL else "onnx/model_quantized.onnx")


def cache_dir() -> Path:
    return Path(os.environ.get("HEATTWIN_NLI_CACHE_DIR") or ROOT / ".cache" / "nli")


def enabled() -> bool:
    """Opted in, and not on a server (Render sets RENDER)."""
    on = os.environ.get("HEATTWIN_DECIDE_NLI", "").strip().lower() in ("1", "true", "yes", "on")
    return on and not os.environ.get("RENDER")


def _load(allow_download: bool = False) -> None:
    global _session, _tokenizer, _why
    with _lock:
        if _session is not None:
            return
        if os.environ.get("RENDER"):
            _why = "the NLI layer never runs on Render"
            raise NLIUnavailable(_why)
        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from tokenizers import Tokenizer
        except Exception as e:
            _why = f"onnxruntime / huggingface_hub / tokenizers not importable ({type(e).__name__})"
            raise NLIUnavailable(_why) from e
        allow = allow_download or os.environ.get("HEATTWIN_DECIDE_DOWNLOAD", "").strip().lower() in ("1", "true", "yes", "on")
        try:
            kw = {"cache_dir": str(cache_dir()), "local_files_only": not allow}
            onnx = hf_hub_download(model_name(), onnx_file(), **kw)
            tok = hf_hub_download(model_name(), "tokenizer.json", **kw)
            _session = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"])
            _tokenizer = Tokenizer.from_file(tok)
            _tokenizer.enable_truncation(max_length=MAX_TOKENS)
        except Exception as e:
            _why = f"NLI model {model_name()} is not cached ({type(e).__name__}); run `python -m engine.nli_optional --fetch`"
            _session = _tokenizer = None
            raise NLIUnavailable(_why) from e


def cached() -> bool:
    """Is the model file on disk? (No load.)"""
    try:
        from huggingface_hub import try_to_load_from_cache
        hit = try_to_load_from_cache(model_name(), onnx_file(), cache_dir=str(cache_dir()))
        return isinstance(hit, str)
    except Exception:
        return False


def available() -> dict[str, Any]:
    """Opt-in state and whether a calibrated threshold exists; loads nothing."""
    from engine import decide
    cal = (decide.load_calibration().get("nli") or {})
    return {"enabled": enabled(), "model": model_name(), "cached": cached(), "threshold": cal.get("threshold") if cal.get("model") == model_name() else None,
            "loaded": _session is not None, "reason": _why}


def entailment(premise: str, hypotheses: Sequence[str] = HYPOTHESES) -> list[float]:
    """P(entailment) of each hypothesis given the premise. Raises NLIUnavailable."""
    _load()
    encs = [_tokenizer.encode(premise, h) for h in hypotheses]
    width = max(len(e.ids) for e in encs)
    ids = np.array([e.ids + [0] * (width - len(e.ids)) for e in encs], dtype=np.int64)
    mask = np.array([[1] * len(e.ids) + [0] * (width - len(e.ids)) for e in encs], dtype=np.int64)
    logits = _session.run(None, {"input_ids": ids, "attention_mask": mask})[0]
    p = np.exp(logits - logits.max(axis=1, keepdims=True))
    p /= p.sum(axis=1, keepdims=True)
    return [float(x) for x in p[:, 0]]            # label 0 = entailment (config id2label)


def score(sentence: str) -> float:
    """The larger entailment probability over the two hypotheses (safe/cleared, diagnosis)."""
    return max(entailment(sentence))


if __name__ == "__main__":
    import sys
    if "--fetch" in sys.argv:
        _load(allow_download=True)
        print("NLI model ready:", available())
    else:
        print(json.dumps(available(), indent=1))
