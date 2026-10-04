"""Calibration + validation of the free decision layer (engine/decide.py).

    python -m validation.voice_decide                 # compute, print, write results.json["voice_decide"] + the calibration
    python -m validation.voice_decide --write-doc     # also refresh the reliability tables inside docs/VOICE.md
    python -m validation.voice_decide --check         # exit 1 if the committed results/calibration differ from a recompute
    FASTEMBED_MODEL=<other> python -m validation.voice_decide   # calibrate another embedding model (adds a backend)

Data: engine/data/voice_decide_dataset.json is SYNTHETIC text written by the developers (``synthetic: true``) — not recorded
from coaches. Every number below is computed here from it and from engine/decide.py; nothing is typed in.

Protocol (per decision, per backend):
  * Classifiers — (a) intent, (d) intensity, (e) guard assist: stratified 70/30 split (``decide.assign_splits``). The 70 %
    are the exemplars. The 30 % are held out and used ONLY to fit the softmax temperature (minimum negative log-likelihood)
    and the abstain threshold (the lowest θ whose answered items are ≥ 90 % right; the guard assist's rule is in
    ``decide.choose_guard_threshold``). Because those two numbers are fitted on the same 30 %, the headline numbers are
    5-fold CROSS-FITTED on it (T and θ refit on four fifths, scored on the fifth); the in-sample numbers are listed too.
  * Roster/plan-grounded choices — (b) athlete, (c) drill: the exemplars are built from the names, aliases and positions of
    the fixture roster / the drills of the fixture plan (``fixtures/``), not from the dataset, so there is no training set to
    hold out: all items calibrate T and θ, and the headline numbers are 5-fold cross-fitted the same way. Items labelled null
    (ambiguous, or not on the roster/plan) must abstain; answering one counts as wrong. The embedding-only ablation and the
    count of utterances identical to an exemplar are reported.
  * ECE: 10 equal-width confidence bins; 95 % intervals are bootstrap (1000 resamples, seed 0). n is small — read the
    intervals, not the third decimal.
  * Leakage: exact duplicates and near duplicates (cosine ≥ 0.95) between exemplars and held-out items are counted.
  * Guard assist is also compared with engine/guard.py alone and with both ("either flags").
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Optional

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "validation" / "results.json"
DOC = ROOT / "docs" / "VOICE.md"
sys.path.insert(0, str(ROOT))

from engine import decide, fixtures  # noqa: E402

NEAR_DUP_COSINE = 0.95
CLASSIFIERS = {"intent": decide.INTENTS, "intensity": decide.INTENSITIES, "guard_assist": decide.GUARD_CLASSES}
ENTITIES = ("athlete", "drill")


# ── metrics ─────────────────────────────────────────────────────────────────────

def _rel(conf: np.ndarray, correct: np.ndarray) -> list[dict[str, Any]]:
    """Reliability rows for the bins that hold items (empty bins are omitted)."""
    return [r for r in decide.reliability_table(conf, correct) if r["n"]]


def _r(x: float, n: int = 4) -> Optional[float]:
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), n)


def _bootstrap(values_fn, n: int, resamples: int = decide.BOOTSTRAP_RESAMPLES) -> list[Optional[float]]:
    rng = np.random.RandomState(0)
    vals = [values_fn(rng.randint(0, n, n)) for _ in range(resamples)]
    return [_r(np.percentile(vals, 2.5)), _r(np.percentile(vals, 97.5))]


def _scores(sims: decide.Sims, y: np.ndarray, T: float, theta: float, kind: str, labels: list[str]) -> dict[str, np.ndarray]:
    P = sims.probs(T)
    conf, pred = P.max(axis=1), P.argmax(axis=1)
    if kind == "guard":
        abstain = (pred == labels.index("pass")) & (conf < theta)
    else:
        abstain = conf < theta
    return {"P": P, "conf": conf, "pred": pred, "abstain": abstain, "correct": pred == y}


def _fit(sims: decide.Sims, y: np.ndarray, kind: str, labels: list[str]) -> tuple[float, float, str]:
    valid = y >= 0
    T = decide.fit_temperature(sims.take(valid), y[valid])
    P = sims.probs(T)
    conf, pred = P.max(axis=1), P.argmax(axis=1)
    if kind == "guard":
        th, st = decide.choose_guard_threshold(conf, pred == labels.index("pass"), y == labels.index("flag"))
    else:
        th, st = decide.choose_abstain_threshold(conf, pred == y)
    return T, th, st


def _metrics(sims: decide.Sims, y: np.ndarray, T: float, theta: float, kind: str, labels: list[str],
             *, with_ci: bool = False) -> dict[str, Any]:
    sc = _scores(sims, y, T, theta, kind, labels)
    valid = y >= 0
    n, nv = len(y), int(valid.sum())
    conf_v, corr_v = sc["conf"][valid], sc["correct"][valid]
    answered = ~sc["abstain"]
    out: dict[str, Any] = {
        "n": n, "n_scored": nv,
        "accuracy": _r(corr_v.mean()),
        "ece": _r(decide.expected_calibration_error(conf_v, corr_v)),
        "nll_at_T1": _r(decide.nll(sims.take(valid), y[valid], 1.0)),
        "nll_calibrated": _r(decide.nll(sims.take(valid), y[valid], T)),
        "mean_confidence": _r(conf_v.mean()),
        "abstain_rate": _r(sc["abstain"].mean()),
        "n_answered": int(answered.sum()),
        "selective_accuracy": _r(sc["correct"][answered].mean()) if answered.any() else None,
    }
    if with_ci and nv:
        out["accuracy_ci95"] = _bootstrap(lambda i: corr_v[i].mean(), nv)
        out["ece_ci95"] = _bootstrap(lambda i: decide.expected_calibration_error(conf_v[i], corr_v[i]), nv)
    if (~valid).any():
        out["null_items"] = int((~valid).sum())
        out["null_items_abstained"] = _r(sc["abstain"][~valid].mean())
        out["null_items_wrongly_answered"] = int((answered & ~valid).sum())
    return out


def _crossfit(sims: decide.Sims, y: np.ndarray, texts: list[str], kind: str, labels: list[str]
              ) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    """5-fold: fit T, θ on four fifths of the held-out, score the other fifth; pool the predictions."""
    order = sorted(range(len(y)), key=lambda i: (int(y[i]), hashlib.sha1(f"cf|{texts[i]}".encode()).hexdigest()))
    fold = np.zeros(len(y), int)
    seen: dict[int, int] = {}
    for i in order:
        fold[i] = seen.get(int(y[i]), 0) % decide.CROSSFIT_FOLDS
        seen[int(y[i])] = seen.get(int(y[i]), 0) + 1
    conf = np.zeros(len(y))
    pred = np.zeros(len(y), int)
    abstain = np.zeros(len(y), bool)
    for k in range(decide.CROSSFIT_FOLDS):
        tr, te = fold != k, fold == k
        if not te.any() or (y[tr] >= 0).sum() < 2:
            continue
        T, th, _ = _fit(sims.take(tr), y[tr], kind, labels)
        sc = _scores(sims.take(te), y[te], T, th, kind, labels)
        conf[te], pred[te], abstain[te] = sc["conf"], sc["pred"], sc["abstain"]
    valid = y >= 0
    correct = pred == y
    answered = ~abstain
    out = {"n": len(y), "accuracy": _r(correct[valid].mean()),
           "ece": _r(decide.expected_calibration_error(conf[valid], correct[valid])),
           "ece_ci95": _bootstrap(lambda i: decide.expected_calibration_error(conf[valid][i], correct[valid][i]), int(valid.sum())),
           "abstain_rate": _r(abstain.mean()), "n_answered": int(answered.sum()),
           "selective_accuracy": _r(correct[answered].mean()) if answered.any() else None,
           "reliability": _rel(conf[valid], correct[valid])}
    if kind == "guard":
        flag = labels.index("flag")
        blocks = (pred == flag) | abstain
        out.update(_guard_rates(blocks, y == flag))
    if (~valid).any():
        out.update({"n_scored": int(valid.sum()), "null_items": int((~valid).sum()),
                    "null_items_abstained": _r(abstain[~valid].mean()),
                    "null_items_wrongly_answered": int((answered & ~valid).sum())})
    return out, {"conf": conf, "pred": pred, "abstain": abstain}


def _guard_rates(blocked: np.ndarray, truth_flag: np.ndarray) -> dict[str, Any]:
    return {"recall_flags_blocked": _r(blocked[truth_flag].mean()), "false_block_rate_on_pass": _r(blocked[~truth_flag].mean()),
            "n_flag": int(truth_flag.sum()), "n_pass": int((~truth_flag).sum())}


# ── per-decision evaluation ─────────────────────────────────────────────────────

def _near_duplicates(be: decide.Backend, train: list[dict], held: list[dict]) -> dict[str, Any]:
    norm = lambda s: re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()  # noqa: E731
    tr_norm = {norm(i["text"]) for i in train}
    exact = [i["text"] for i in held if norm(i["text"]) in tr_norm]
    cos = be.embed([i["text"] for i in held]) @ be.embed([i["text"] for i in train]).T
    mx = cos.max(axis=1)
    near = [(held[i]["text"], train[int(cos[i].argmax())]["text"], float(mx[i])) for i in range(len(held)) if mx[i] >= NEAR_DUP_COSINE]
    return {"exact_duplicates": len(exact), f"near_duplicates_cosine_ge_{NEAR_DUP_COSINE}": len(near),
            "max_cosine_to_train": {"median": _r(np.median(mx), 3), "p95": _r(np.percentile(mx, 95), 3), "max": _r(mx.max(), 3)},
            "_pairs": near}


def eval_classifier(key: str, be: decide.Backend) -> tuple[dict[str, Any], dict[str, Any]]:
    labels = list(CLASSIFIERS[key])
    kind = "guard" if key == "guard_assist" else "classifier"
    ds = decide.load_dataset()[key]
    train, held = decide.assign_splits(ds)
    ex = [(str(i["label"]), str(i["text"])) for i in train]
    texts = [str(i["text"]) for i in held]
    S = decide.class_sims(be, texts, ex, labels)
    y = np.array([labels.index(i["label"]) for i in held])
    T, th, st = _fit(S, y, kind, labels)
    in_sample = _metrics(S, y, T, th, kind, labels, with_ci=True)
    sc = _scores(S, y, T, th, kind, labels)
    cf, _ = _crossfit(S, y, texts, kind, labels)
    res: dict[str, Any] = {
        "kind": "classifier", "classes": labels, "n_total": len(ds), "n_train_exemplars": len(train), "n_heldout": len(held),
        "class_counts_heldout": {c: int((y == i).sum()) for i, c in enumerate(labels)},
        "temperature": _r(T, 5), "temperature_at_lower_bound": bool(T <= decide.TEMPERATURE_BOUNDS[0] * 1.01),
        "threshold": _r(th, 5), "threshold_rule": _rule(kind), "threshold_status": st,
        "headline": "crossfit", "crossfit": {k: v for k, v in cf.items()}, "in_sample": in_sample,
    }
    if key == "intent":
        res["per_class_recall_heldout"] = {c: _r((sc["pred"][y == i] == i).mean()) for i, c in enumerate(labels) if (y == i).any()}
        res["confusions_heldout"] = _confusions(sc["pred"], y, labels)
    if key == "guard_assist":
        from engine import guard
        g_ok = np.array([guard.check(t, log=False)["ok"] for t in texts])
        truth_flag = y == labels.index("flag")
        a_block = (sc["pred"] == labels.index("flag")) | sc["abstain"]
        res["guard_py_alone"] = _guard_rates(~g_ok, truth_flag)
        res["assist_alone_in_sample"] = _guard_rates(a_block, truth_flag)
        res["either_layer_in_sample"] = _guard_rates(a_block | ~g_ok, truth_flag)
        res["flags_missed_by_guard_py_caught_by_assist"] = int((truth_flag & g_ok & a_block).sum())
    leak = _near_duplicates(be, train, held)
    res["leakage"] = {k: v for k, v in leak.items() if k != "_pairs"}
    cal = {"temperature": _r(T, 5), "threshold": _r(th, 5), "threshold_status": st, "n_calibration": len(held)}
    res["_pairs"] = leak["_pairs"]
    return res, cal


def _confusions(pred: np.ndarray, y: np.ndarray, labels: list[str]) -> list[dict[str, Any]]:
    c: dict[tuple[str, str], int] = {}
    for p, t in zip(pred, y):
        if p != t:
            c[(labels[t], labels[p])] = c.get((labels[t], labels[p]), 0) + 1
    return [{"true": a, "predicted": b, "n": n} for (a, b), n in sorted(c.items(), key=lambda kv: -kv[1])]


def _rule(kind: str) -> str:
    if kind == "guard":
        return (f"lowest θ such that at most {decide.GUARD_MAX_MISS:.0%} of the items the assist passes with confidence ≥ θ are "
                "true flags; a pass below θ abstains, and abstain blocks")
    return (f"lowest θ such that the answered held-out items (confidence ≥ θ) are ≥ {decide.TARGET_SELECTIVE_ACCURACY:.0%} right; "
            f"else best selective accuracy among θ answering ≥ {decide.MIN_COVERAGE_FALLBACK:.0%}")


def eval_entity(key: str, be: decide.Backend) -> tuple[dict[str, Any], dict[str, Any]]:
    """(b)/(c): nothing is trained on the dataset (the exemplars come from the roster / plan), so there is no training
    set to hold out: every item calibrates T and θ, and the honest numbers are 5-fold cross-fitted."""
    ds = decide.load_dataset()[key]
    if key == "athlete":
        ex, ids = decide.athlete_exemplars(fixtures.roster()), [str(a["id"]) for a in fixtures.roster()]
    else:
        ex, ids = decide.drill_exemplars(fixtures.plan()), [str(d["id"]) for d in fixtures.plan()["drills"]]
    ids = list(dict.fromkeys(ids))
    texts = [str(i["text"]) for i in ds]
    y = np.array([ids.index(i["label"]) if i["label"] is not None else -1 for i in ds])

    def sims_for(lex_weight: float) -> decide.Sims:
        return decide.class_sims(be, texts, ex, ids, lex_weight=lex_weight)

    sims = sims_for(decide.ENTITY_LEX_WEIGHT)
    T, th, st = _fit(sims, y, "entity", ids)
    in_sample = _metrics(sims, y, T, th, "entity", ids, with_ci=True)
    cf, arr = _crossfit(sims, y, texts, "entity", ids)
    cf0, _ = _crossfit(sims_for(0.0), y, texts, "entity", ids)    # ablation: the embedding score alone
    ex_texts = {re.sub(r"[^a-z0-9 ]", "", t.lower()).strip() for _, t in ex}
    exact = np.array([re.sub(r"[^a-z0-9 ]", "", t.lower()).strip() in ex_texts for t in texts])
    valid = y >= 0
    ans_ok = valid & ~exact
    sc = _scores(sims, y, T, th, "entity", ids)
    top2 = np.argsort(-sc["P"], axis=1)[:, :2]
    asked = np.where(arr["abstain"] & valid)[0]
    res = {
        "kind": "roster_grounded", "options": len(ids), "n_total": len(ds), "n_exemplars": len(ex),
        "exemplars_built_from": "the fixture roster (names, first/last name, positions)" if key == "athlete" else
        "the fixture plan (drill names, parenthetical aliases, ordinals, neighbours, generic football synonyms)",
        "lexical_weight": decide.ENTITY_LEX_WEIGHT,
        "temperature": _r(T, 5), "temperature_at_lower_bound": bool(T <= decide.TEMPERATURE_BOUNDS[0] * 1.01),
        "threshold": _r(th, 5), "threshold_rule": _rule("entity"), "threshold_status": st,
        "headline": "crossfit", "crossfit": cf, "in_sample": in_sample,
        "embedding_only_ablation_crossfit": {k: cf0[k] for k in ("accuracy", "ece", "abstain_rate", "selective_accuracy")},
        "utterances_identical_to_an_exemplar": int(exact.sum()),
        "crossfit_accuracy_excluding_those": _r((arr["pred"] == y)[ans_ok].mean()),
        "did_you_mean_top2_contains_answer": _r(np.mean([y[i] in top2[i] for i in asked])) if len(asked) else None,
        "n_asked_did_you_mean": int(len(asked)),
    }
    cal = {"temperature": _r(T, 5), "threshold": _r(th, 5), "threshold_status": st, "n_calibration": len(ds)}
    return res, cal


# ── backends ────────────────────────────────────────────────────────────────────

def run_backend(be: decide.Backend, verbose: bool = True) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    decisions: dict[str, Any] = {}
    cals: dict[str, Any] = {}
    pairs: dict[str, Any] = {}
    for key in CLASSIFIERS:
        decisions[key], cals[key] = eval_classifier(key, be)
        pairs[key] = decisions[key].pop("_pairs")
    for key in ENTITIES:
        decisions[key], cals[key] = eval_entity(key, be)
    info: dict[str, Any] = {"label": be.label, "semantic": be.semantic, "decisions": decisions}
    if be.semantic:
        try:
            import fastembed
            info["model"] = be.model
            info["fastembed_version"] = getattr(fastembed, "__version__", None) or _pkg_version("fastembed")
        except Exception:
            pass
    return info, cals, pairs


def _pkg_version(name: str) -> Optional[str]:
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return None


def compute(verbose: bool = True, lexical_only: bool = False) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    ds = decide.load_dataset()
    ds_sha = hashlib.sha1(decide.DATASET_PATH.read_bytes()).hexdigest()
    backends: dict[str, Any] = {}
    cal_backends: dict[str, Any] = {}
    all_pairs: dict[str, Any] = {}
    todo = [decide.get_backend("lexical")]
    if not lexical_only:
        fe = decide.get_backend("fastembed")
        if not fe.semantic:
            raise SystemExit(f"embedding model unavailable: {decide._backend_why.get('fastembed')}. "
                             "Run `python -m engine.decide --fetch`, or pass --lexical-only.")
        todo.insert(0, fe)
    for be in todo:
        info, cals, pairs = run_backend(be)
        backends[be.key], cal_backends[be.key], all_pairs[be.key] = info, cals, pairs
    block = {
        "synthetic": True,
        "note": "Computed by validation/voice_decide.py from engine/data/voice_decide_dataset.json — synthetic text written by the "
                "developers (no real coaches or athletes). Small n: read the intervals.",
        "dataset": {"file": "engine/data/voice_decide_dataset.json", "synthetic": bool(ds.get("synthetic")), "sha1": ds_sha,
                    "n": {k: len(ds[k]) for k in ("intent", "intensity", "guard_assist", "athlete", "drill")},
                    "split": {"heldout_fraction": decide.HELDOUT_FRAC, "seed": decide.SPLIT_SEED,
                              "rule": "intent / intensity / guard assist: stratified by label; within a label ordered by "
                                      "sha1(seed|text); first 30 % held out. athlete / drill: no training set (exemplars are built "
                                      "from the roster / plan), so every item calibrates and is scored cross-fitted"}},
        "method": {"score": "cosine between the utterance and each labelled exemplar; athlete/drill add "
                            f"{decide.ENTITY_LEX_WEIGHT} × char-n-gram cosine",
                   "probabilities": "softmax(cosine / T) over all exemplars, summed per class",
                   "temperature": "minimises held-out negative log-likelihood", "ece_bins": decide.ECE_BINS,
                   "temperature_bounds": list(decide.TEMPERATURE_BOUNDS), "crossfit_folds": decide.CROSSFIT_FOLDS,
                   "bootstrap_resamples": decide.BOOTSTRAP_RESAMPLES},
        "primary_backend": None if lexical_only else f"fastembed:{decide.model_name()}",
        "backends": backends,
    }
    cal = {"synthetic": True, "generated_by": "python -m validation.voice_decide", "dataset": "engine/data/voice_decide_dataset.json",
           "dataset_sha1": ds_sha, "backends": cal_backends}
    return block, cal, all_pairs


# ── output ──────────────────────────────────────────────────────────────────────

def _pct(x: Optional[float]) -> str:
    return "–" if x is None else f"{100 * x:.0f}%"


def summary_rows(block: dict[str, Any], backend: str) -> list[str]:
    d = block["backends"][backend]["decisions"]
    rows = ["| decision | n (scored) | accuracy | ECE (10 bins) | abstain rate | accuracy when answered | T | θ |", "|---|---|---|---|---|---|---|---|"]
    names = {"intent": "(a) intent", "athlete": "(b) athlete", "drill": "(c) drill", "intensity": "(d) intensity", "guard_assist": "(e) guard assist"}
    for k in ("intent", "athlete", "drill", "intensity", "guard_assist"):
        r = d[k]
        m = r[r["headline"]]
        ece = f"{m['ece']:.3f} [{m['ece_ci95'][0]:.2f}–{m['ece_ci95'][1]:.2f}]" if m.get("ece_ci95") else f"{m['ece']:.3f}"
        n = m.get("n_scored", m["n"])
        rows.append(f"| {names[k]} | {n} | {_pct(m['accuracy'])} | {ece} | {_pct(m['abstain_rate'])} | {_pct(m['selective_accuracy'])} | "
                    f"{r['temperature']} | {r['threshold']} |")
    return rows


def reliability_md(block: dict[str, Any], backend: str, key: str) -> list[str]:
    r = block["backends"][backend]["decisions"][key]
    rel = r[r["headline"]].get("reliability")
    rows = ["| confidence bin | n | mean confidence | accuracy |", "|---|---|---|---|"]
    for b in rel:
        if b["n"]:
            rows.append(f"| {b['bin']} | {b['n']} | {b['mean_confidence']:.2f} | {_pct(b['accuracy'])} |")
    return rows


def render_doc_block(block: dict[str, Any]) -> str:
    primary = block["primary_backend"] or "lexical-fallback"
    out = [f"Backend: `{primary}`. Dataset: synthetic, {block['dataset']['n']}. Headline numbers: 5-fold cross-fitted (T and θ "
           "refit on four fifths, scored on the rest) on the 30 % held-out (intent, intensity, guard assist) or on all items "
           "(athlete, drill: no training set).", ""]
    out += summary_rows(block, primary)
    for k, title in (("intent", "(a) Intent"), ("intensity", "(d) Intensity"), ("athlete", "(b) Athlete"), ("drill", "(c) Drill"),
                     ("guard_assist", "(e) Guard assist")):
        out += ["", f"**Reliability, {title}** (top-label confidence vs. accuracy; bins with no items omitted)", ""]
        out += reliability_md(block, primary, k)
    if "lexical-fallback" in block["backends"] and primary != "lexical-fallback":
        out += ["", "**Lexical fallback** (used only when the embedding model cannot load), same protocol:", ""]
        out += summary_rows(block, "lexical-fallback")
    return "\n".join(out)


def write_doc(block: dict[str, Any]) -> bool:
    if not DOC.exists():
        return False
    text = DOC.read_text()
    new = re.sub(r"(<!-- reliability:begin -->\n).*?(\n<!-- reliability:end -->)",
                 lambda m: m.group(1) + render_doc_block(block) + m.group(2), text, flags=re.S)
    if new != text:
        DOC.write_text(new)
    return "<!-- reliability:begin -->" in text


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--write-doc", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--lexical-only", action="store_true", help="skip the embedding backend (does not touch its entries)")
    a = ap.parse_args(argv)
    block, cal, pairs = compute(lexical_only=a.lexical_only)
    cal_path = decide.CALIBRATION_PATH
    results = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    old_cal = json.loads(cal_path.read_text()) if cal_path.exists() else {"backends": {}}
    old_block = results.get("voice_decide") or {}
    # keep other models' calibrations/results (another FASTEMBED_MODEL, or an embedding run this one skipped)
    merged_cal = {**old_cal, **cal, "backends": {**old_cal.get("backends", {}), **cal["backends"]}}
    block["backends"] = {**{k: v for k, v in (old_block.get("backends") or {}).items() if k not in block["backends"]}, **block["backends"]}
    if a.lexical_only and old_block.get("primary_backend"):
        block["primary_backend"] = old_block["primary_backend"]
    if a.check:
        same = json.loads(json.dumps(block)) == old_block and json.loads(json.dumps(merged_cal)) == old_cal
        print("voice_decide results and calibration reproduce" if same else "voice_decide results or calibration DIFFER")
        return 0 if same else 1
    results["voice_decide"] = block
    RESULTS.write_text(json.dumps(results, indent=2) + "\n")
    cal_path.write_text(json.dumps(merged_cal, indent=2) + "\n")
    primary = block["primary_backend"] or "lexical-fallback"
    print(f"wrote validation/results.json[voice_decide] and {cal_path.relative_to(ROOT)}\n")
    print("\n".join(summary_rows(block, primary)))
    if "lexical-fallback" in block["backends"] and primary != "lexical-fallback":
        print("\nlexical fallback:\n" + "\n".join(summary_rows(block, "lexical-fallback")))
    for be_key, pp in pairs.items():
        for k, lst in pp.items():
            for held, tr, c in lst:
                print(f"near-duplicate ({be_key}, {k}, cos {c:.3f}): held-out {held!r} ~ train {tr!r}")
    if a.write_doc:
        print("docs/VOICE.md reliability block " + ("refreshed" if write_doc(block) else "NOT found (add the markers)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
