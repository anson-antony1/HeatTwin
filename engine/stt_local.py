"""Offline speech-to-text for a laptop: faster-whisper (CTranslate2, no torch). OPTIONAL, never required on a server.

The browser's Web Speech API is the first choice for the transcript (web/src/lib/useVoicePlan.ts). This is the fallback for
browsers without it (Firefox) and for a laptop with no internet: the web sends the 16 kHz mono WAV it already records and
POST /voice/transcribe returns the text. Nothing leaves the machine and nothing is paid.

    uv pip install faster-whisper                # ~3 packages; model "base" ≈ 140 MB from Hugging Face, cached
    python -m engine.stt_local --fetch           # download the model once (otherwise only a cached model loads)
    WHISPER_MODEL=small|base|tiny.en …           # WHISPER_CACHE_DIR (default <repo>/.cache/whisper, git-ignored)

If faster-whisper is not installed or the model is not cached, ``available()`` says why and the route answers 503; the engine
never fails to start because of it.
"""
from __future__ import annotations

import io
import os
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "base"
MAX_AUDIO_BYTES = 15 * 1024 * 1024

_model: Any = None
_why: str | None = None
_lock = threading.Lock()


class STTUnavailable(RuntimeError):
    pass


def model_name() -> str:
    return os.environ.get("WHISPER_MODEL") or DEFAULT_MODEL


def cache_dir() -> Path:
    return Path(os.environ.get("WHISPER_CACHE_DIR") or ROOT / ".cache" / "whisper")


def _load(allow_download: bool = False) -> Any:
    global _model, _why
    with _lock:
        if _model is not None:
            return _model
        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            _why = f"faster-whisper is not installed ({type(e).__name__})"
            raise STTUnavailable(_why) from e
        allow = allow_download or os.environ.get("HEATTWIN_STT_DOWNLOAD", "").strip().lower() in ("1", "true", "yes", "on")
        try:
            cache_dir().mkdir(parents=True, exist_ok=True)
            _model = WhisperModel(model_name(), device="cpu", compute_type="int8", download_root=str(cache_dir()),
                                  local_files_only=not allow)
        except Exception as e:
            _why = f"whisper model {model_name()!r} is not cached ({type(e).__name__}); run `python -m engine.stt_local --fetch`"
            raise STTUnavailable(_why) from e
        return _model


def available() -> dict[str, Any]:
    """Cheap, no model load: is faster-whisper importable and is the model on disk?"""
    try:
        import importlib.util
        has_pkg = importlib.util.find_spec("faster_whisper") is not None
    except Exception:
        has_pkg = False
    cached = any(cache_dir().glob(f"*whisper-{model_name()}*")) if cache_dir().exists() else False
    return {"installed": has_pkg, "model": model_name(), "cached": cached, "ready": has_pkg and cached,
            "backend": f"faster-whisper:{model_name()}"}


def transcribe_wav(audio: bytes) -> dict[str, Any]:
    """WAV (or any audio PyAV can read) → ``{text, backend, language}``. Raises STTUnavailable / ValueError."""
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise ValueError("audio is empty or too long")
    model = _load()
    try:
        segments, info = model.transcribe(io.BytesIO(audio), language="en", beam_size=1, vad_filter=False)
        text = " ".join(s.text.strip() for s in segments).strip()
    except Exception as e:
        raise ValueError(f"could not read the audio ({type(e).__name__})") from e
    return {"text": text, "backend": f"faster-whisper:{model_name()}", "language": info.language}


if __name__ == "__main__":
    import sys
    if "--fetch" in sys.argv:
        _load(allow_download=True)
        print("whisper model ready:", available())
    else:
        print(available())
