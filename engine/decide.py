"""Free decision layer: a typed stand-in for a "System One" model. It returns CHOICES, never free text.

Every decision is ``Decision(choice, probabilities, confidence, abstain, ...)`` from one mechanism:

    embed the utterance → cosine similarity to labelled exemplars → temperature-scaled softmax over the exemplars, summed
    per class → abstain when the top probability is below a calibrated threshold.

Decisions (the owner's spec):
  (a) ``decide_intent(text)``               ∈ INTENTS (what_if, athlete_status, field_conditions, optimize, plan_entry,
                                              unclear, + plan_summary, which engine/voice.py already routes)
  (b) ``decide_athlete(text, roster)``      a choice over the CURRENT roster's names / aliases / positions (built per call)
  (c) ``decide_drill(text, plan)``          a choice over the CURRENT plan's drills (built per call)
  (d) ``decide_intensity(text)``            ∈ rest | light | moderate | hard | max  (plan entry; low confidence → the
                                              caller states an assumption on the Confirm screen)
  (e) ``guard_assist(text)``                P(text implies a diagnosis, or that someone is "safe"), a second layer next to
                                              engine/guard.py: ``check_two_layer`` blocks when EITHER layer flags.

Embeddings: fastembed (ONNX, no torch), model ``FASTEMBED_MODEL`` (default BAAI/bge-small-en-v1.5), cached in
``FASTEMBED_CACHE_DIR`` (default ``<repo>/.cache/fastembed``, git-ignored). If the model cannot load (not installed, not
cached and no network) the layer degrades to a clearly labelled LEXICAL FALLBACK (hashed word/char n-grams) with its own
calibration; it never raises into the engine. The label travels in every Decision (``backend``).

Calibration: ``engine/data/decide_calibration.json`` (temperature and abstain threshold per decision and backend) is
WRITTEN BY ``python -m validation.voice_decide`` from the committed synthetic dataset
(``engine/data/voice_decide_dataset.json``) — nothing here is hand-set. A backend with no calibration is not used for
decisions (the layer falls back to the calibrated lexical backend and says so).

No network and no paid API anywhere in this module (it does not touch engine/paid_api.py's metered services).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(__file__).with_name("data")
DATASET_PATH = DATA_DIR / "voice_decide_dataset.json"
CALIBRATION_PATH = DATA_DIR / "decide_calibration.json"
DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
LEXICAL_KEY = "lexical-fallback"

INTENTS = ("what_if", "athlete_status", "field_conditions", "optimize", "plan_summary", "plan_entry", "unclear")
INTENSITIES = ("rest", "light", "moderate", "hard", "max")
GUARD_CLASSES = ("flag", "pass")
NONE = "none"          # (b)/(c) only: "nobody / no drill in particular" ("how is he doing", "who is over the line")

# ── design parameters (not physiology; documented in docs/VOICE.md and echoed into validation/results.json) ──
HELDOUT_FRAC = 0.30            # 70/30 split; the 30 % calibrates (temperature, threshold)
SPLIT_SEED = 0                 # the split is assigned in code from this seed: never hand-picked
TARGET_SELECTIVE_ACCURACY = 0.90   # abstain rule: the lowest threshold whose ANSWERED held-out items are ≥ 90 % right
MIN_COVERAGE_FALLBACK = 0.20   # if no threshold reaches the target: best selective accuracy with ≥ 20 % answered
GUARD_MAX_MISS = 0.05          # guard assist: of the items it PASSES, at most 5 % may be true flags (else it abstains = blocks)
ECE_BINS = 10                  # equal-width confidence bins on [0, 1]
TEMPERATURE_BOUNDS = (0.005, 2.0)
ENTITY_LEX_WEIGHT = 0.4        # (b)/(c): cosine += 0.4 × char-n-gram cosine, so a mis-heard name ("Isiah") still matches
TIE_MARGIN = 1e-3              # two options this close in probability are a tie (identical exemplars): always abstain
CROSSFIT_FOLDS = 5
BOOTSTRAP_RESAMPLES = 1000


# ══ typed result ══════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class Decision:
    decision: str                       # intent | athlete | drill | intensity | guard_assist
    choice: Optional[str]               # a label from the closed set (an id for athlete / drill); never free text
    probabilities: dict[str, float]     # every class, descending; sums to 1 (rounded to 4 d.p.)
    confidence: float                   # probabilities[choice]
    abstain: bool                       # confidence below the calibrated threshold → ask, do not act
    top2: tuple[str, ...] = ()          # the two most probable classes (what "Did you mean …?" offers)
    backend: str = ""                   # "fastembed:<model>" or "lexical-fallback"
    calibrated: bool = True             # False → no calibration for this backend/decision (abstain is forced)
    temperature: Optional[float] = None
    threshold: Optional[float] = None
    note: Optional[str] = None          # e.g. "single option", "no calibration"

    def as_dict(self) -> dict[str, Any]:
        d = {"decision": self.decision, "choice": self.choice, "probabilities": self.probabilities,
             "confidence": round(self.confidence, 4), "abstain": self.abstain, "top2": list(self.top2),
             "backend": self.backend, "calibrated": self.calibrated, "temperature": self.temperature,
             "threshold": self.threshold}
        if self.note:
            d["note"] = self.note
        return d

    @property
    def p_flag(self) -> float:
        """Guard assist only: P(the text implies a diagnosis or that someone is "safe")."""
        return float(self.probabilities.get("flag", 0.0))

    @property
    def blocks(self) -> bool:
        """Guard assist only: block when it says flag, or when it is not sure the text passes (fail closed)."""
        return self.choice == "flag" or self.abstain


# ══ dataset and the 70/30 split ═══════════════════════════════════════════════

_dataset_cache: dict[str, Any] = {}


def load_dataset(path: Path = DATASET_PATH) -> dict[str, Any]:
    key = str(path)
    if key not in _dataset_cache:
        _dataset_cache[key] = json.loads(path.read_text())
    return _dataset_cache[key]


def assign_splits(items: Sequence[Mapping[str, Any]], *, frac: float = HELDOUT_FRAC, seed: int = SPLIT_SEED
                  ) -> tuple[list[dict], list[dict]]:
    """Stratified, deterministic split → (train 70 %, heldout 30 %). Items are ordered within each label by
    sha1(seed|text), so the split depends only on the text and the seed (it cannot be tuned by hand)."""
    groups: dict[str, list[dict]] = {}
    for it in items:
        groups.setdefault(str(it.get("label")), []).append(dict(it))
    train: list[dict] = []
    held: list[dict] = []
    for _label, g in sorted(groups.items()):
        g.sort(key=lambda x: hashlib.sha1(f"{seed}|{x['text']}".encode()).hexdigest())
        k = int(round(frac * len(g)))
        if len(g) >= 2:
            k = min(max(k, 1), len(g) - 1)
        held += g[:k]
        train += g[k:]
    return train, held


# ══ embedding backends ════════════════════════════════════════════════════════

_LEX_DIM = 4096


def _lex_vectors(texts: Sequence[str], char_ngrams: bool = True, bigrams: bool = True) -> np.ndarray:
    """Stateless hashed bag of word unigrams/bigrams + char 3-grams (signed hashing, sqrt-TF, L2-normalised)."""
    out = np.zeros((len(texts), _LEX_DIM))
    for r, t in enumerate(texts):
        words = re.sub(r"[^a-z0-9' ]", " ", str(t).lower()).split()
        feats: list[tuple[str, str, float]] = [("w", w, 1.0) for w in words]
        if bigrams:
            feats += [("b", f"{a}_{b}", 1.0) for a, b in zip(words, words[1:])]
        if char_ngrams:
            for w in words:
                p = f"<{w}>"
                feats += [("c", p[i:i + 3], 0.5) for i in range(len(p) - 2)]
        for kind, f, wt in feats:
            h = zlib.crc32(f"{kind}{f}".encode())
            out[r, h % _LEX_DIM] += wt if (h >> 20) & 1 else -wt
    out = np.sign(out) * np.sqrt(np.abs(out))
    n = np.linalg.norm(out, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return out / n


class Backend:
    """An embedder plus its calibration key. ``embed`` caches by text (exemplars are embedded once per process)."""

    def __init__(self, key: str, label: str, embed_fn, *, semantic: bool, model: Optional[str] = None):
        self.key, self.label, self.semantic, self.model = key, label, semantic, model
        self._embed_fn = embed_fn
        self._cache: dict[str, np.ndarray] = {}
        self._lex_cache: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        with self._lock:
            missing = [t for t in dict.fromkeys(texts) if t not in self._cache]
            if missing:
                if len(self._cache) > 20000:
                    self._cache.clear()
                for t, v in zip(missing, self._embed_fn(missing)):
                    self._cache[t] = v
            return np.vstack([self._cache[t] for t in texts]) if texts else np.zeros((0, 1))

    def lex(self, texts: Sequence[str]) -> np.ndarray:
        with self._lock:
            missing = [t for t in dict.fromkeys(texts) if t not in self._lex_cache]
            if missing:
                if len(self._lex_cache) > 20000:
                    self._lex_cache.clear()
                for t, v in zip(missing, _lex_vectors(missing)):
                    self._lex_cache[t] = v
            return np.vstack([self._lex_cache[t] for t in texts]) if texts else np.zeros((0, 1))


def cache_dir() -> Path:
    return Path(os.environ.get("FASTEMBED_CACHE_DIR") or ROOT / ".cache" / "fastembed")


def model_name() -> str:
    return os.environ.get("FASTEMBED_MODEL") or DEFAULT_MODEL


def _make_lexical() -> Backend:
    return Backend(LEXICAL_KEY, "lexical fallback (hashed word/char n-grams; embedding model unavailable)",
                   lambda ts: _lex_vectors(ts), semantic=False)


def _make_fastembed(allow_download: bool = False) -> tuple[Optional[Backend], Optional[str]]:
    """(backend, None) or (None, why not). Offline by default: only a model already in the cache loads."""
    try:
        from fastembed import TextEmbedding
    except Exception as e:  # not installed / broken onnxruntime
        return None, f"fastembed not importable ({type(e).__name__})"
    name = model_name()
    allow = allow_download or os.environ.get("HEATTWIN_DECIDE_DOWNLOAD", "").strip().lower() in ("1", "true", "yes", "on")
    try:
        cache_dir().mkdir(parents=True, exist_ok=True)
        te = TextEmbedding(model_name=name, cache_dir=str(cache_dir()), local_files_only=not allow)
    except Exception as e:
        return None, f"embedding model {name} is not cached ({type(e).__name__}); run `python -m engine.decide --fetch`"

    def embed(texts: Sequence[str]) -> list[np.ndarray]:
        v = np.array(list(te.embed(list(texts))), dtype=np.float64)
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        return list(v)

    return Backend(f"fastembed:{name}", f"fastembed {name}", embed, semantic=True, model=name), None


_backends: dict[str, Backend] = {}
_backend_why: dict[str, str] = {}
_backend_lock = threading.Lock()


def reset_backends() -> None:
    """Tests / env changes: forget loaded models."""
    with _backend_lock:
        _backends.clear()
        _backend_why.clear()
    _calibration_cache.clear()


def get_backend(which: str = "auto", *, allow_download: bool = False) -> Backend:
    """``"lexical"`` → the fallback; ``"fastembed"`` → the embedding model or (if unavailable) the fallback;
    ``"auto"`` → fastembed when it loads AND is calibrated, else the fallback."""
    with _backend_lock:
        lex = _backends.get(LEXICAL_KEY)
        if lex is None:
            lex = _backends[LEXICAL_KEY] = _make_lexical()
        want = os.environ.get("HEATTWIN_DECIDE_BACKEND", "").strip().lower()
        if which == "lexical" or (which == "auto" and want == "lexical"):
            return lex
        fe = next((b for k, b in _backends.items() if k.startswith("fastembed:") and b.model == model_name()), None)
        if fe is None and "fastembed" not in _backend_why:
            fe, why = _make_fastembed(allow_download)
            if fe is not None:
                _backends[fe.key] = fe
            else:
                _backend_why["fastembed"] = why or "unavailable"
        if fe is None:
            return lex
        if which == "auto" and calibration_for(fe.key) is None:
            _backend_why["fastembed"] = (f"no calibration for {fe.key} in engine/data/decide_calibration.json — run "
                                         "`python -m validation.voice_decide` with this FASTEMBED_MODEL")
            return lex
        return fe


def status() -> dict[str, Any]:
    """What GET /voice/status reports: which backend decides, and why a fallback is in use."""
    be = get_backend()
    fallback = not be.semantic
    return {"backend": be.key, "label": be.label, "model": be.model, "semantic": be.semantic, "fallback": fallback,
            "reason": _backend_why.get("fastembed") if fallback else None,
            "calibrated": calibration_for(be.key) is not None,
            "cache_dir": str(cache_dir()), "dataset_synthetic": bool(load_dataset().get("synthetic"))}


# ══ calibration math (used by validation/voice_decide.py and at run time) ══════

def softmax(scores: np.ndarray, temperature: float) -> np.ndarray:
    z = np.asarray(scores, dtype=np.float64) / float(temperature)
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


@dataclass
class Sims:
    """Cosine similarities between queries and labelled exemplars: ``S`` (queries × exemplars), ``idx`` = each exemplar's
    class index, ``k`` = number of classes. ``probs(T)`` is the temperature-scaled softmax over ALL exemplars, summed per
    class (a soft nearest-neighbour vote: T → 0 is "nearest exemplar wins")."""
    S: np.ndarray
    idx: np.ndarray
    k: int

    def take(self, rows: Any) -> "Sims":
        return Sims(self.S[rows], self.idx, self.k)

    def probs(self, temperature: float) -> np.ndarray:
        p = softmax(self.S, temperature)
        out = np.zeros((p.shape[0], self.k))
        for c in range(self.k):
            m = self.idx == c
            if m.any():
                out[:, c] = p[:, m].sum(axis=1)
        return out / np.clip(out.sum(axis=1, keepdims=True), 1e-12, None)


def nll(sims: Sims, y: np.ndarray, temperature: float) -> float:
    p = sims.probs(temperature)
    return float(-np.mean(np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1.0))))


def fit_temperature(sims: Sims, y: np.ndarray, bounds: tuple[float, float] = TEMPERATURE_BOUNDS) -> float:
    """The temperature minimising the held-out negative log-likelihood (golden-section search on log T)."""
    lo, hi = math.log(bounds[0]), math.log(bounds[1])
    g = (math.sqrt(5) - 1) / 2
    a, b = lo, hi
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = nll(sims, y, math.exp(c)), nll(sims, y, math.exp(d))
    for _ in range(80):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = nll(sims, y, math.exp(c))
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = nll(sims, y, math.exp(d))
    return float(math.exp((a + b) / 2))


def expected_calibration_error(conf: np.ndarray, correct: np.ndarray, bins: int = ECE_BINS) -> float:
    conf, correct = np.asarray(conf, float), np.asarray(correct, float)
    if len(conf) == 0:
        return float("nan")
    idx = np.minimum((conf * bins).astype(int), bins - 1)
    ece = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            ece += m.mean() * abs(correct[m].mean() - conf[m].mean())
    return float(ece)


def reliability_table(conf: np.ndarray, correct: np.ndarray, bins: int = ECE_BINS) -> list[dict[str, Any]]:
    conf, correct = np.asarray(conf, float), np.asarray(correct, float)
    idx = np.minimum((conf * bins).astype(int), bins - 1)
    rows = []
    for b in range(bins):
        m = idx == b
        rows.append({"bin": f"{b / bins:.1f}-{(b + 1) / bins:.1f}", "n": int(m.sum()),
                     "mean_confidence": round(float(conf[m].mean()), 4) if m.any() else None,
                     "accuracy": round(float(correct[m].mean()), 4) if m.any() else None})
    return rows


def choose_abstain_threshold(conf: np.ndarray, correct: np.ndarray, target: float = TARGET_SELECTIVE_ACCURACY,
                             min_coverage: float = MIN_COVERAGE_FALLBACK) -> tuple[float, str]:
    """The abstain rule (held-out data only): the LOWEST threshold θ such that the items answered (conf ≥ θ) are ≥ ``target``
    right. If none reaches the target: the θ with the best selective accuracy among those answering ≥ ``min_coverage``
    of the items. Returns (θ, "target_met" | "target_not_met")."""
    conf, correct = np.asarray(conf, float), np.asarray(correct, float)
    cands = sorted({float(c) for c in conf})
    best: Optional[tuple[float, float, float]] = None
    for th in cands:
        m = conf >= th
        acc, cov = float(correct[m].mean()), float(m.mean())
        if acc >= target:
            return th, "target_met"
        if cov >= min_coverage and (best is None or acc > best[1] or (acc == best[1] and cov > best[2])):
            best = (th, acc, cov)
    return (best[0] if best else (cands[-1] if cands else 1.0)), "target_not_met"


def choose_guard_threshold(conf: np.ndarray, pred_pass: np.ndarray, truth_flag: np.ndarray,
                           max_miss: float = GUARD_MAX_MISS) -> tuple[float, str]:
    """Guard assist: the LOWEST θ such that, of the items it PASSES with confidence ≥ θ, at most ``max_miss`` are true
    flags. Items it passes below θ abstain, and abstain blocks (fail closed)."""
    conf = np.asarray(conf, float)
    pred_pass, truth_flag = np.asarray(pred_pass, bool), np.asarray(truth_flag, bool)
    cands = sorted({float(c) for c in conf[pred_pass]})
    for th in cands:
        m = pred_pass & (conf >= th)
        if m.any() and truth_flag[m].mean() <= max_miss:
            return th, "target_met"
    return (cands[-1] + 1e-6 if cands else 1.0), "target_not_met"


# ══ calibration store ═════════════════════════════════════════════════════════

_calibration_cache: dict[str, Any] = {}


def load_calibration() -> dict[str, Any]:
    if "data" not in _calibration_cache:
        try:
            _calibration_cache["data"] = json.loads(CALIBRATION_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            _calibration_cache["data"] = {"backends": {}}
    return _calibration_cache["data"]


def calibration_for(backend_key: str, decision: Optional[str] = None) -> Optional[dict[str, Any]]:
    b = (load_calibration().get("backends") or {}).get(backend_key)
    if not b:
        return None
    return b if decision is None else b.get(decision)


# ══ scoring ═══════════════════════════════════════════════════════════════════

def class_sims(be: Backend, queries: Sequence[str], exemplars: Sequence[tuple[str, str]], labels: Sequence[str], *,
               lex_weight: float = 0.0) -> Sims:
    """Similarities of ``queries`` to ``exemplars`` [(label, text)]. With ``lex_weight`` > 0 (entity decisions, semantic
    backend) the cosine also gets that weight × the char-n-gram cosine, so a mis-heard name still matches."""
    known = set(labels)
    ex = [(lab, t) for lab, t in exemplars if lab in known]
    texts = [t for _, t in ex]
    s = be.embed(list(queries)) @ be.embed(texts).T
    if lex_weight and be.semantic:
        s = s + lex_weight * (be.lex(list(queries)) @ be.lex(texts).T)
    pos = {lab: i for i, lab in enumerate(labels)}
    return Sims(s, np.array([pos[lab] for lab, _ in ex]), len(labels))


def _decide(decision: str, be: Backend, sims: Optional[Sims], labels: Sequence[str]) -> Decision:
    """One query (``sims`` has one row) → a Decision, using the calibration of (backend, decision)."""
    cal = calibration_for(be.key, decision)
    if len(labels) == 0 or sims is None:
        return Decision(decision, None, {}, 0.0, True, (), be.key, bool(cal), note="no options")
    temperature = float(cal["temperature"]) if cal else 1.0
    p = sims.probs(temperature)[0]
    order = np.argsort(-p, kind="stable")
    ranked = [labels[i] for i in order]
    probs = {labels[i]: round(float(p[i]), 4) for i in order}
    conf = float(p[order[0]])
    note = None
    if cal is None:
        abstain, note = True, "no calibration for this backend: abstaining"
    else:
        abstain = conf < float(cal["threshold"])
        if len(order) > 1 and float(p[order[0]] - p[order[1]]) < TIE_MARGIN:
            abstain, note = True, "tie between the top two options"
    return Decision(decision, ranked[0], probs, conf, bool(abstain), tuple(ranked[:2]), be.key, cal is not None,
                    round(temperature, 5) if cal else None, round(float(cal["threshold"]), 5) if cal else None, note)


ATHLETE_TOKEN, DRILL_TOKEN = "the player", "the drill"


def mask_entities(text: str, roster: Optional[Sequence[Mapping[str, Any]]] = None, plan: Optional[Mapping[str, Any]] = None) -> str:
    """Replace the names in ``roster`` and the drill names in ``plan`` with a neutral token, so the INTENT classifier does
    not depend on which names are on screen ("how hot does Priya get" ≈ "how hot does Isaiah get"). The labelled exemplars are
    masked the same way with the fixture roster/plan their utterances were written against."""
    out = str(text)
    for d in sorted((plan or {}).get("drills") or [], key=lambda x: -len(str(x.get("name", "")))):
        name = str(d.get("name", ""))
        for n in dict.fromkeys([name, re.sub(r"\s*\(.*?\)\s*", " ", name).strip(), *re.findall(r"\((.*?)\)", name)]):
            if len(n) >= 4:
                out = re.sub(rf"(?:\bthe\s+)?\b{re.escape(n.strip())}\b", DRILL_TOKEN, out, flags=re.I)
    for a in roster or []:
        full = plain_name(a.get("name"))
        for n in dict.fromkeys([full, *full.split()]):
            if len(n) >= 3:
                out = re.sub(rf"\b{re.escape(n)}(?:'s)?\b", ATHLETE_TOKEN, out, flags=re.I)
    return out


_exemplar_cache: dict[str, list[tuple[str, str]]] = {}


def _fixture_context() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    from engine import fixtures
    return fixtures.roster(), fixtures.plan()


def _train_exemplars(key: str) -> list[tuple[str, str]]:
    if key not in _exemplar_cache:
        train, _ = assign_splits(load_dataset()[key])
        if key == "intent":      # utterances were written against the fixture roster / plan: mask those names
            roster, plan = _fixture_context()
            _exemplar_cache[key] = [(str(i["label"]), mask_entities(str(i["text"]), roster, plan)) for i in train]
        else:
            _exemplar_cache[key] = [(str(i["label"]), str(i["text"])) for i in train]
    return _exemplar_cache[key]


def _classify(decision: str, key: str, labels: Sequence[str], text: str, backend: Optional[Backend]) -> Decision:
    be = backend or get_backend()
    return _decide(decision, be, class_sims(be, [text], _train_exemplars(key), labels), labels)


def decide_intent(text: str, roster: Optional[Sequence[Mapping[str, Any]]] = None, plan: Optional[Mapping[str, Any]] = None, *,
                  backend: Optional[Backend] = None) -> Decision:
    """(a) What the coach is asking for. Names on the current ``roster`` / ``plan`` (and the fixture's, which the labelled
    utterances use) are masked first, so a roster the classifier has never seen routes like the fixture one."""
    froster, fplan = _fixture_context()
    masked = mask_entities(mask_entities(text, roster, plan), froster, fplan)
    return _classify("intent", "intent", INTENTS, masked, backend)


def decide_intensity(text: str, *, backend: Optional[Backend] = None) -> Decision:
    """(d) How hard a drill is, from how the coach names it (plan entry)."""
    return _classify("intensity", "intensity", INTENSITIES, text, backend)


def guard_assist(text: str, *, backend: Optional[Backend] = None) -> Decision:
    """(e) P(the text implies a diagnosis or that someone is "safe"): ``choice`` is "flag" or "pass"; ``.blocks`` is the
    fail-closed verdict (flag, or a pass it is not sure of)."""
    be = backend or get_backend()
    d = _decide("guard_assist", be, class_sims(be, [text], _train_exemplars("guard_assist"), GUARD_CLASSES), GUARD_CLASSES)
    cal = calibration_for(be.key, "guard_assist")
    if cal is None:
        return d
    abstain = d.choice == "pass" and d.confidence < float(cal["threshold"])
    return Decision(d.decision, d.choice, d.probabilities, d.confidence, abstain, d.top2, d.backend, True,
                    d.temperature, d.threshold, d.note)


# ══ entity exemplars: built from the CURRENT roster / plan on every call ═════════════════════════════════════════

POSITION_WORDS = {
    "QB": ["quarterback", "QB"], "RB": ["running back", "tailback"], "FB": ["fullback"], "WR": ["wide receiver", "receiver"],
    "TE": ["tight end"], "OL": ["offensive lineman", "o-lineman", "offensive line"],
    "DL": ["defensive lineman", "d-lineman", "defensive line"], "LB": ["linebacker"],
    "DB": ["defensive back", "cornerback"], "CB": ["cornerback"], "S": ["safety"], "K": ["kicker", "placekicker"],
    "P": ["punter"], "LS": ["long snapper"],
}
_ORDINALS = ("first", "second", "third", "fourth", "fifth")


def plain_name(name: Any) -> str:
    """"Isaiah (fictional)" → "Isaiah"."""
    return re.sub(r"\s*\(fictional\)\s*", "", str(name or "")).strip()


def athlete_exemplars(roster: Sequence[Mapping[str, Any]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for a in roster:
        aid = str(a["id"])
        full = plain_name(a.get("name"))
        parts = full.split()
        names = list(dict.fromkeys([full, *(parts[:1]), *(parts[-1:] if len(parts) > 1 else [])]))
        extra = a.get("aliases") or a.get("nickname") or []
        names += [str(x) for x in ([extra] if isinstance(extra, str) else extra)]
        for n in names:
            out += [(aid, n), (aid, f"how is {n} doing"), (aid, f"{n}'s numbers"), (aid, f"tell me about {n}"),
                    (aid, f"check on {n}")]
        pos = POSITION_WORDS.get(str(a.get("position") or "").upper(), [str(a.get("position") or "").lower()])
        for p in [x for x in pos if x]:
            out += [(aid, p), (aid, f"the {p}"), (aid, f"our {p}"), (aid, f"how is the {p} doing")]
            if names:
                out.append((aid, f"{names[0]} the {p}"))
    return out


# generic football vocabulary → extra names for a drill whose own name matches the key
DRILL_SYNONYMS: list[tuple[re.Pattern, list[str]]] = [
    (re.compile(r"team|scrimm|live|11", re.I), ["eleven on eleven", "11 on 11", "scrimmage", "team drills"]),
    (re.compile(r"individual|position", re.I), ["individuals", "position drills", "position work"]),
    (re.compile(r"special", re.I), ["kicking period", "kicking", "punt and kickoff work", "punting"]),
    (re.compile(r"condition|gasser|sprint", re.I), ["conditioning", "gassers", "sprints", "wind sprints", "running"]),
    (re.compile(r"warm", re.I), ["warm up", "stretching to start", "get loose"]),
    (re.compile(r"cool", re.I), ["cool down", "cool down stretch", "stretch out"]),
    (re.compile(r"inside|run", re.I), ["run game", "run period", "inside zone"]),
    (re.compile(r"water|break|hydrat", re.I), ["hydration break", "drink break", "rest break"]),
]


def drill_exemplars(plan: Mapping[str, Any]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    drills = list(plan.get("drills") or [])
    norm = [re.sub(r"\s*\(.*?\)\s*", " ", str(d.get("name", ""))).strip().lower() for d in drills]
    for i, d in enumerate(drills):
        did = str(d["id"])
        name = str(d.get("name", ""))
        paren = re.findall(r"\((.*?)\)", name)
        bare = norm[i]
        names = list(dict.fromkeys([name, bare, *paren, name.lower()]))
        for syn_re, syn in DRILL_SYNONYMS:
            if syn_re.search(name):
                names += syn
        for n in dict.fromkeys(x for x in names if x):
            out += [(did, n), (did, f"the {n}"), (did, f"{n} drill"), (did, f"what if we change the {n}")]
        same = [j for j, b in enumerate(norm) if b == bare]
        if len(same) > 1:   # the first water break, the second water break
            k = same.index(i)
            if k < len(_ORDINALS):
                out += [(did, f"the {_ORDINALS[k]} {bare}"), (did, f"{_ORDINALS[k]} {bare}")]
        if i > 0:
            out += [(did, f"the {bare} after {norm[i - 1]}"), (did, f"{bare} after the {norm[i - 1]}")]
        if i + 1 < len(drills):
            out.append((did, f"the {bare} before {norm[i + 1]}"))
    return out


# what the coach says when no one / no drill in particular is meant: the "none" class of (b) and (c)
ATHLETE_NONE_FRAMES = ["how is he doing", "how is she doing", "tell me about him", "tell me about her", "check on him", "his numbers",
                       "her numbers", "how is the player doing", "how is the athlete doing", "check on someone", "the whole team",
                       "everyone", "who is over the line", "who crosses the planning line first", "who gets the hottest",
                       "how many players are over the limit", "the plan", "the practice", "the weather", "the forecast",
                       "the field conditions", "the roster"]
DRILL_NONE_FRAMES = ["that one", "it", "this period", "the plan", "everything", "the practice", "the whole practice", "the team",
                     "an athlete", "the player", "the field", "the weather", "the forecast", "who", "how many", "the roster",
                     "how is he doing", "how hot does he get"]


def _entity(decision: str, text: str, exemplars: list[tuple[str, str]], ids: Sequence[str], none_frames: Sequence[str],
            backend: Optional[Backend]) -> Decision:
    be = backend or get_backend()
    labels = [*dict.fromkeys(ids), NONE]
    if len(labels) == 1:
        return _decide(decision, be, None, [])
    ex = [*exemplars, *((NONE, f) for f in none_frames)]
    return _decide(decision, be, class_sims(be, [text], ex, labels, lex_weight=ENTITY_LEX_WEIGHT), labels)


def decide_athlete(text: str, roster: Sequence[Mapping[str, Any]], *, backend: Optional[Backend] = None) -> Decision:
    """(b) Which athlete on THIS roster. ``choice`` is an athlete id, or ``"none"`` when nobody in particular is meant ("how
    is he doing", a question about the whole plan). Ambiguous ("the linebacker" with two) or unknown names abstain."""
    return _entity("athlete", text, athlete_exemplars(roster), [str(a["id"]) for a in roster], ATHLETE_NONE_FRAMES, backend)


_ORDER_CUE = re.compile(r"\b(first|second|third|fourth|fifth|last|next|previous|1st|2nd|3rd|4th|before|after|earlier|later|other|another)\b", re.I)


def decide_drill(text: str, plan: Mapping[str, Any], *, backend: Optional[Backend] = None) -> Decision:
    """(c) Which drill of THIS plan (or ``"none"``). Two drills with the same name ("Water break" twice) can only be told apart
    by their order or neighbours, so if the two most probable options are such twins and the coach gave neither ("the water
    break"), the decision abstains instead of guessing between them."""
    d = _entity("drill", text, drill_exemplars(plan), [str(x["id"]) for x in plan.get("drills") or []], DRILL_NONE_FRAMES, backend)
    if not d.abstain and len(d.top2) == 2 and not _ORDER_CUE.search(text):
        name = {str(x["id"]): re.sub(r"\s*\(.*?\)\s*", " ", str(x.get("name", ""))).strip().lower() for x in plan.get("drills") or []}
        a, b = d.top2
        if a in name and b in name and name[a] == name[b]:
            return Decision(d.decision, d.choice, d.probabilities, d.confidence, True, d.top2, d.backend, d.calibrated,
                            d.temperature, d.threshold, "two drills share this name: say which (first or second, or after …)")
    return d


# ══ guard: engine/guard.py + the assist, blocking when EITHER flags ═════════════════════════════════════════════

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")


def split_sentences(text: str) -> list[tuple[int, int]]:
    """(start, end) of each sentence; a decimal point ("38.6") is not a boundary."""
    spans, pos = [], 0
    for m in _SENT_SPLIT.finditer(text):
        if m.start() > pos:
            spans.append((pos, m.start()))
        pos = m.end()
    if pos < len(text):
        spans.append((pos, len(text)))
    return spans


def check_two_layer(text: str, *, source: str = "", log: bool = True, backend: Optional[Backend] = None) -> dict[str, Any]:
    """engine/guard.py (rules) AND the assist (embedding classifier); blocks when either flags. With
    HEATTWIN_DECIDE_NLI=1 on a laptop (engine/nli_optional.py), a zero-shot NLI model is a third vote.

    → ``{ok, redacted_text, hits[], blocked_by: ["guard.py" | "assist" | "nli", …], assist: {…, hits[]}, nli: {…}}`` — a
    superset of guard.check's result (``hits`` stays guard.py's own). Assist / NLI hits (``rule: "semantic"``) are redacted
    whole-sentence as ``[removed: semantic]`` unless guard.py already redacted words in that sentence, and are logged next to
    guard.py's. A FIXED reviewed script (constants.guard_exceptions.scripts: the Collapse 911 script) is free text to neither
    layer's exception: guard.py applies its scoped rule exception and the assist / NLI are not run on it."""
    from engine import consts, guard, nli_optional

    g = guard.check(text, source=source, log=log)
    allowed = guard._script_exceptions(source) if source else set()
    be = backend or get_backend()
    flagged: list[dict[str, Any]] = []
    nli_flagged: list[dict[str, Any]] = []
    p_max = 0.0
    fixed_script = bool(source) and source in (consts.get("guard_exceptions.scripts", {}) or {})   # reviewed text, not free text
    nli: dict[str, Any] = {"enabled": False}
    nli_th = None
    if not fixed_script and nli_optional.enabled():
        nli_th = nli_optional.available()["threshold"]
        nli = {"enabled": True, "active": False, "model": nli_optional.model_name(),
               "reason": None if nli_th is not None else "no calibrated threshold: run python -m validation.voice_decide"}
    nli_p = 0.0
    for s0, s1 in ([] if fixed_script else split_sentences(text)):
        sent = text[s0:s1]
        if not re.search(r"[A-Za-z]{3}", sent):
            continue
        if allowed and any(p in guard._norm(sent) for p in allowed):
            continue
        d = guard_assist(sent, backend=be)
        p_max = max(p_max, d.p_flag)
        if d.blocks:
            flagged.append({"rule": "semantic", "match": sent, "start": s0, "end": s1, "p_flag": round(d.p_flag, 4),
                            "abstained": d.abstain and d.choice == "pass"})
        if nli.get("enabled") and nli_th is not None and not nli.get("reason"):
            try:
                sc = nli_optional.score(sent)
                nli.update(active=True)
                nli_p = max(nli_p, sc)
                if sc >= nli_th:
                    nli_flagged.append({"rule": "semantic", "match": sent, "start": s0, "end": s1, "p_entail": round(sc, 4)})
            except nli_optional.NLIUnavailable as e:
                nli.update(active=False, reason=str(e))
    if nli.get("active"):
        nli.update(threshold=nli_th, p_entail_max=round(nli_p, 4))
    nli["hits"] = nli_flagged
    blocked_by = (["guard.py"] if g["hits"] else []) + (["assist"] if flagged else []) + (["nli"] if nli_flagged else [])
    # a sentence guard.py already redacted keeps guard.py's own (word-level) redaction; assist/NLI-only ones are replaced whole
    spans = {(h["start"], h["end"]): h for h in [*flagged, *nli_flagged]}
    replace = sorted((h for h in spans.values() if not any(h["start"] <= gh["start"] < h["end"] for gh in g["hits"])),
                     key=lambda h: h["start"])
    if not replace:
        out = dict(g)
    else:
        redacted, pos = [], 0
        for h in replace:
            redacted.append(guard.check(text[pos:h["start"]], source=source, log=False)["redacted_text"] if text[pos:h["start"]]
                            else "")
            redacted.append("[removed: semantic]")
            pos = h["end"]
        redacted.append(guard.check(text[pos:], source=source, log=False)["redacted_text"] if text[pos:] else "")
        out = {"ok": False, "redacted_text": "".join(redacted), "hits": g["hits"]}   # hits: guard.py's, unchanged
    if (flagged or nli_flagged) and log:
        guard._log([*flagged, *nli_flagged], source)
    out["ok"] = not blocked_by
    out["blocked_by"] = blocked_by
    out["assist"] = {"backend": be.key, "p_flag_max": round(p_max, 4), "hits": flagged,
                     "calibrated": calibration_for(be.key, "guard_assist") is not None, "fallback": not be.semantic}
    out["nli"] = nli
    return out


def warm() -> dict[str, Any]:
    """Load the model and embed every exemplar once, so the first question is as fast as the next. Never raises."""
    try:
        be = get_backend()
        for key in ("intent", "intensity", "guard_assist"):
            be.embed([t for _, t in _train_exemplars(key)])
        froster, fplan = _fixture_context()
        decide_athlete("warm up", froster, backend=be)
        decide_drill("warm up", fplan, backend=be)
        return {"backend": be.key, "warm": True}
    except Exception as e:      # a broken cache must not stop the engine
        return {"warm": False, "error": type(e).__name__}


def warm_in_background() -> threading.Thread:
    t = threading.Thread(target=warm, name="decide-warm", daemon=True)
    t.start()
    return t


# ══ CLI: python -m engine.decide --fetch | --status | "what if we cut the gassers" ═════════════════════════════

def _main(argv: Sequence[str]) -> int:
    import sys
    if "--fetch" in argv:
        be, why = _make_fastembed(allow_download=True)
        print("fetched and loaded " + be.label if be else f"could not fetch: {why}")
        return 0 if be else 1
    if "--status" in argv or not argv:
        print(json.dumps(status(), indent=1))
        return 0
    from engine import fixtures
    text = " ".join(a for a in argv if not a.startswith("--"))
    print(json.dumps({"intent": decide_intent(text).as_dict(),
                      "athlete": decide_athlete(text, fixtures.roster()).as_dict(),
                      "drill": decide_drill(text, fixtures.plan()).as_dict(),
                      "intensity": decide_intensity(text).as_dict(), "guard_assist": guard_assist(text).as_dict()}, indent=1))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_main(sys.argv[1:]))
