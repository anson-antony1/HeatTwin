# Voice, with no paid API

HeatTwin's voice features now run **free**: no Gemini, no ElevenLabs, no key. Gemini is still there as an optional plan
parser and stays **off by default** (`HEATTWIN_DISABLE_PAID_APIS=1`, the engine's kill switch in `engine/paid_api.py`, is on
unless you turn it off). The new layer, `engine/decide.py`, is a free stand-in for a small "System One" model: it makes
**typed choices** (an intent, an athlete, a drill, an intensity, a yes/no on risky wording), says how sure it is, and
**abstains** instead of guessing. It never writes a sentence. Every sentence a coach hears is written by the engine, and every
number in it is an engine number.

## What changed (and what happened before)

Before this branch, with no Gemini key the voice path was dead: the dock recorded audio and sent it to
`POST /plan/parse_audio`, which answered 503 ("GEMINI_API_KEY is not set"), and typed text went to `POST /plan/parse`, which
also answered 503. `POST /voice/intent` (question routing) needed Gemini too and nothing in the web called it, so a coach
could not ask a question by voice at all; the only voice sentence was Kelvin's summary after a plan was confirmed.

Now:

```
mic ─ browser Web Speech API ──────────────┐                        (free; Chrome/Edge/Safari)
    └ no recognizer? POST /voice/transcribe ┤  (offline faster-whisper "base" on the laptop, if installed)
typed text ────────────────────────────────┘
        │  transcript
        ▼
POST /voice/decide   engine/decide.py: intent, athlete, drill  →  {choice, probabilities, confidence, abstain}
        │
        ├─ unsure ─────────► "Did you mean …?"  the TWO most probable options (nothing runs until one is tapped)
        ├─ plan entry/edit ─► POST /plan/parse_local  → a DRAFT on the Confirm sheet (intensity = decision (d);
        │                       low confidence → an assumption the coach sees); Gemini only if the engine has a key
        └─ a question ──────► POST /voice/answer  → the ENGINE's sentence (+ `numbers`, the per-answer ledger)
                                   │
                                   ▼
                              POST /guard = engine/guard.py  AND  the embedding assist (either one blocks)
                              + the per-answer number check in the browser  → shown, then spoken
                                   │
                                   ▼
                              browser speechSynthesis (free); ElevenLabs only if the engine says it has a key
```

`GET /voice/status` reports what is available and why not (decision backend, Whisper, Gemini, ElevenLabs, NLI). The web asks
it before it ever calls `/voice/tts`, so no metered endpoint is touched by default (`GET /health` → `paid_api.attempted`
stays 0; the tests assert it).

## The best uses

1. **Hands-free what-ifs.** "What if we drop the gassers?", "What if team period is helmets only?", "What if we add a water
   break after inside run?" The router picks the drill from the plan on screen, reads the change (remove, gear, minutes, shade,
   move, add a break), and the engine re-simulates every athlete and answers with the team-average peak, how many are over the
   planning line, and the before/after.
2. **Athlete status on the sideline.** "How hot does Isaiah get?", "How's our kicker?" Names, positions and the mis-hearings a
   speech recognizer produces ("Isiah") resolve against **the current roster**. "The linebacker" with two linebackers is a
   tie, so it asks: *Isaiah · LB or Caleb · LB?* Asked "Is Devin safe to keep practicing?" the engine states its boundary
   first (it cannot clear anyone) and then gives the estimate.
3. **Plan entry by voice.** "Practice starts at four, ten minute warmup in helmets, twenty minute team period in full pads, five
   minute water break, then conditioning for twelve minutes." Later: "add fifteen minutes of jumping jacks at the end", "make
   team period twenty five minutes", "drop special teams". Always a draft: the Confirm sheet lists every drill and every
   assumption (gear never said → full pads for every drill; a start time read as afternoon; a break length taken from the FHSAA
   minimum; a drill whose intensity the model is unsure of gets the **harder** of its two most probable intensities, and says so).
   Nothing is simulated until the coach presses Confirm.
4. **Guard assist.** `engine/guard.py` is a list of rules; a paraphrase slips through ("no cause for alarm, he's all good").
   The assist is a second, semantic layer on every sentence checked at `/guard`, in voice answers, and in generated plan notes:
   it blocks when **either** layer flags, and `blocked_by` records which one. The numbers are below.

## The decisions

All five use one mechanism: embed the utterance with fastembed (ONNX, no torch; default `BAAI/bge-small-en-v1.5`, set
`FASTEMBED_MODEL`; ~70 MB cached in `FASTEMBED_CACHE_DIR`, default `~/.cache/heattwin/fastembed`, shared by every checkout; without the model the assist is advisory only and never redacts), take the cosine similarity to labelled
**exemplars**, run a **temperature-scaled softmax over the exemplars summed per class** (a soft nearest-neighbour vote), and
**abstain** when the top probability is below a calibrated threshold (or the top two are tied).

| | decision | options | exemplars come from |
|---|---|---|---|
| (a) | intent | what_if, athlete_status, field_conditions, optimize, plan_summary, plan_entry, unclear | the 70 % train split of the dataset (athlete / drill names masked first, so an unseen roster routes like the fixture one) |
| (b) | athlete | the **current** roster's ids, or `none` ("how is he doing", a whole-team question) | the roster sent in the request: name, first / last name, nicknames (`aliases`), position words ("the kicker", "tight end"), phrased several ways |
| (c) | drill | the **current** plan's drill ids, or `none` | the plan sent: names, parenthetical aliases ("gassers"), ordinals ("the second water break"), neighbours ("the water break after team period"), generic football synonyms |
| (d) | intensity | rest, light, moderate, hard, max | the 70 % train split of the intensity set (rubric from `engine/llm_plan.py`) |
| (e) | guard assist | flag, pass | the 70 % train split of the guard set |

Notes on how it behaves:

* `plan_summary` ("who is over the line?") is a seventh intent: `engine/voice.py` already answered it, and folding it into
  `unclear` would have been wrong.
* For (b) and (c) the char-n-gram similarity (weight 0.4) is added to the embedding cosine so a mis-heard name still matches.
  The ablation without it is in `validation/results.json`.
* Two drills with the same name (the plan has two "Water break"s) are told apart only by order or neighbours; "the water break"
  alone abstains and offers both, labelled *Water break after Individual period* / *… after Team period*.
* When the athlete or drill decision says `none` although the intent needed one, the intent was probably wrong, so the dock
  asks about the **intent** (its top two options) instead of offering two arbitrary athletes.
* (e) blocks when it says `flag`, or when it passes a sentence it is not sure about (abstain = block, fail closed). The Collapse 911
  script is a fixed reviewed text under its own scoped exception in `constants.yaml → guard_exceptions`; the assist is not run on it
  and `/guard` cannot claim that source.
* Wording: the engine's own deterministic labels and sentences still pass `guard.py` where they are written; the assist
  adds a second look at voice sentences, `/guard`, `/voice/tts` and plan notes. All engine voice sentences are in the test
  matrix and pass both layers.

## Calibration results

Everything below is **computed by `validation/voice_decide.py`** from `engine/data/voice_decide_dataset.json` and the engine code; the
tables are regenerated into this file by `make voice-validate` (`python -m validation.voice_decide --write-doc`).

**The dataset is synthetic.** The utterances were written by the developers for this repo (`synthetic: true` in the file and in the
results block): not recorded from coaches, no real athletes (names are the fictional fixture roster plus some that are not on it).
Real speech, accents, sideline noise and real coaches' phrasing will differ; treat these numbers as a measurement of the method on
a small, clean set, not as field accuracy.

**Protocol.**

* *Split.* Intent, intensity and guard assist: stratified 70/30, assigned in code by `sha1(seed|text)` (seed 0), never by hand. The 70 %
  are the exemplars; the 30 % are held out and used **only** to fit the softmax temperature (minimum negative log-likelihood on the
  held-out 30 %) and the abstain threshold. Athlete and drill have no training set (their exemplars come from the roster / plan), so
  every item calibrates and is scored cross-fitted.
* *Abstain rule.* The lowest threshold whose answered held-out items are at least 90 % right (if none reaches that: the best selective
  accuracy among thresholds that answer at least 20 %). Guard assist: the lowest threshold such that at most 5 % of the sentences it
  passes are real flags; a pass below it abstains, and abstain blocks. A tie between the top two options always abstains.
* *Honest numbers.* Because temperature and threshold are fitted on the same held-out items, the headline accuracy-when-answered, ECE
  and abstain rate are **5-fold cross-fitted** (temperature and threshold refit on four fifths, scored on the rest). ECE uses 10
  equal-width confidence bins; the bracket is a 95 % bootstrap interval. Accuracy on seven other seeds of the split is in the JSON
  (`accuracy_on_other_splits`).
* *Leakage.* Names are masked before intent embedding, then exact duplicates and near-duplicates (cosine at least 0.95) between
  exemplars and held-out items are counted on the masked text (`leakage` in the JSON); the dataset was hand-checked, two near-duplicate
  pairs were removed, and `engine/tests/test_decide.py` fails on a duplicate or conflicting label. The athlete / drill sets also report
  how many utterances are identical to an exemplar and the accuracy without them.
* *Bias to know about.* n is small (about 35 to 90 scored items per decision): read the intervals, not the third decimal. The (e)
  negatives include the engine's own sentence templates, which is why a new engine sentence type must be added as a negative exemplar
  (the test matrix of engine voice sentences catches a regression).

<!-- reliability:begin -->
Backend: `fastembed:BAAI/bge-small-en-v1.5`. Dataset (synthetic): 232 intent, 130 athlete, 119 drill, 119 intensity, 207 guard assist utterances. Headline numbers: 5-fold cross-fitted (T and θ refit on four fifths, scored on the rest) on the 30 % held-out (intent, intensity, guard assist) or on all items (athlete, drill: no training set).

| decision | n (scored) | accuracy | ECE (10 bins) | abstain rate | accuracy when answered | T | θ |
|---|---|---|---|---|---|---|---|
| (a) intent | 72 | 82% | 0.088 [0.08–0.20] | 25% | 87% | 0.0276 | 0.69712 |
| (b) athlete | 93 | 94% | 0.061 [0.03–0.11] | 18% | 91% | 0.02005 | 0.5 |
| (c) drill | 89 | 97% | 0.030 [0.01–0.06] | 9% | 91% | 0.02284 | 0.43938 |
| (d) intensity | 35 | 66% | 0.142 [0.12–0.31] | 43% | 80% | 0.03038 | 0.68112 |
| (e) guard assist | 62 | 97% | 0.037 [0.02–0.09] | 0% | 97% | 0.02192 | 0.71538 |

**Reliability, (a) Intent** (top-label confidence vs. accuracy; bins with no items omitted)

| confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.2-0.3 | 2 | 0.28 | 50% |
| 0.3-0.4 | 3 | 0.38 | 67% |
| 0.4-0.5 | 5 | 0.45 | 40% |
| 0.5-0.6 | 7 | 0.56 | 71% |
| 0.6-0.7 | 6 | 0.68 | 67% |
| 0.7-0.8 | 10 | 0.75 | 100% |
| 0.8-0.9 | 12 | 0.84 | 75% |
| 0.9-1.0 | 27 | 0.96 | 96% |

**Reliability, (d) Intensity** (top-label confidence vs. accuracy; bins with no items omitted)

| confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.2-0.3 | 3 | 0.29 | 33% |
| 0.3-0.4 | 2 | 0.36 | 50% |
| 0.4-0.5 | 3 | 0.44 | 67% |
| 0.5-0.6 | 7 | 0.56 | 43% |
| 0.6-0.7 | 2 | 0.66 | 0% |
| 0.7-0.8 | 4 | 0.75 | 75% |
| 0.8-0.9 | 6 | 0.86 | 100% |
| 0.9-1.0 | 8 | 0.97 | 88% |

**Reliability, (b) Athlete** (top-label confidence vs. accuracy; bins with no items omitted)

| confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.2-0.3 | 3 | 0.25 | 100% |
| 0.3-0.4 | 1 | 0.37 | 0% |
| 0.4-0.5 | 3 | 0.48 | 67% |
| 0.5-0.6 | 4 | 0.54 | 75% |
| 0.6-0.7 | 2 | 0.63 | 50% |
| 0.7-0.8 | 1 | 0.72 | 0% |
| 0.8-0.9 | 1 | 0.87 | 100% |
| 0.9-1.0 | 78 | 0.99 | 99% |

**Reliability, (c) Drill** (top-label confidence vs. accuracy; bins with no items omitted)

| confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.3-0.4 | 1 | 0.34 | 0% |
| 0.4-0.5 | 3 | 0.50 | 67% |
| 0.5-0.6 | 2 | 0.52 | 100% |
| 0.8-0.9 | 2 | 0.86 | 100% |
| 0.9-1.0 | 81 | 0.99 | 99% |

**Reliability, (e) Guard assist** (top-label confidence vs. accuracy; bins with no items omitted)

| confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.5-0.6 | 1 | 0.60 | 100% |
| 0.6-0.7 | 2 | 0.68 | 100% |
| 0.7-0.8 | 1 | 0.71 | 100% |
| 0.8-0.9 | 4 | 0.86 | 75% |
| 0.9-1.0 | 54 | 0.99 | 98% |

**Lexical fallback** (used only when the embedding model cannot load), same protocol:

| decision | n (scored) | accuracy | ECE (10 bins) | abstain rate | accuracy when answered | T | θ |
|---|---|---|---|---|---|---|---|
| (a) intent | 72 | 74% | 0.127 [0.10–0.25] | 64% | 81% | 0.05326 | 0.9078 |
| (b) athlete | 93 | 96% | 0.049 [0.03–0.09] | 20% | 91% | 0.02209 | 0.46895 |
| (c) drill | 89 | 93% | 0.039 [0.02–0.07] | 13% | 89% | 0.04094 | 0.47485 |
| (d) intensity | 35 | 77% | 0.213 [0.14–0.34] | 37% | 82% | 0.07315 | 0.54347 |
| (e) guard assist | 62 | 90% | 0.041 [0.03–0.13] | 6% | 91% | 0.04546 | 0.71662 |
<!-- reliability:end -->

### Guard assist against the rules alone

<!-- guard:begin -->
Held-out 30 % of the guard-assist set (n = 62), backend `fastembed:BAAI/bge-small-en-v1.5`. In-sample rows use the fitted temperature and threshold; the cross-fitted assist alone blocks 96% of the flags and 3% of the harmless sentences.

| layer(s) | flags blocked (recall) | harmless sentences blocked |
|---|---|---|
| engine/guard.py alone | 56% of 27 | 3% of 35 |
| embedding assist alone | 96% of 27 | 3% of 35 |
| guard.py OR assist (what ships) | 100% of 27 | 6% of 35 |

Flags that guard.py's rules let through and the assist caught: 12 of 27.

**Optional laptop-only NLI** (`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`, off by default, never on a server), same items, tau = 0.04092, AUROC 0.9587:

| layer(s) | flags blocked | harmless sentences blocked |
|---|---|---|
| NLI alone | 93% | 6% |
| assist OR NLI | 100% | 9% |
| guard.py OR assist OR NLI | 100% | 11% |

Flags missed by guard.py and the assist that the NLI caught: 0.
<!-- guard:end -->

## Speech to text and playback

* **Browser Web Speech API** is the first choice (`web/src/lib/useLiveCaptions.ts`): free, instant captions, and the final text is
  the transcript. Chrome sends the audio to Google's free recognizer; if that matters, use the offline path below.
* **Offline Whisper (laptop only).** `uv pip install faster-whisper` then `python -m engine.stt_local --fetch` (model "base", ~140
  MB, Hugging Face, cached in `.cache/whisper`). The web sends the 16 kHz mono WAV it already records to `POST /voice/transcribe`.
  It installed cleanly here (CTranslate2, no torch) and transcribed a spoken test sentence in under a second. It is never
  required: with it absent the route answers 503, and the engine starts and runs the same.
* **Playback**: `speechSynthesis`. ElevenLabs is used only if the engine reports a key **and** paid APIs are enabled
  (`/voice/status → tts.elevenlabs`); a failure falls back to the browser voice.

## When something is missing

| missing | what happens |
|---|---|
| the embedding model (not installed, not cached, no network) | `decide.py` falls back to a **labelled lexical fallback** (hashed word / char n-grams, calibrated separately; its numbers are in the tables above); every Decision carries `backend`, `/voice/status` says why, and the dock shows a label. It never raises into the engine. Embedding tests skip with the reason |
| a calibration for the configured `FASTEMBED_MODEL` | that model is not used for decisions (the calibrated fallback decides, with a label) until `python -m validation.voice_decide` has been run with it |
| Whisper | `/voice/transcribe` is 503; with no browser recognizer either, the dock says so and offers typing |
| Gemini / ElevenLabs | nothing: both are optional; `/plan/llm_status.configured` is false by default |
| the engine's `/guard` | the web holds the reply (nothing shown or spoken), as before |

## Setup

```bash
make setup            # adds fastembed and fetches the model (skipped offline)
make decide-model     # (re)download the embedding model: python -m engine.decide --fetch
make voice-validate   # recompute calibration + results.json["voice_decide"] + the tables above
python -m engine.decide "what if we cut the gassers"        # typed decisions for one utterance (fixture roster/plan)
HF_HUB_OFFLINE=1 …    # tests set this: the model loads from the cache or not at all
```

Hosting (Render or similar): add `fastembed` to the engine's requirements and `python -m engine.decide --fetch` to the build step so the
~70 MB model is in the image (about 170 MB of RAM at run time). Without it the engine still starts and decides with the labelled
lexical fallback. Do not install `faster-whisper` or the NLI model on a server (they are laptop-only and the NLI refuses when `RENDER` is set).

Optional, laptop only: `python -m engine.nli_optional --fetch` and `HEATTWIN_DECIDE_NLI=1` add a zero-shot NLI vote
(DeBERTa-v3, ONNX, about 740 MB, never on Render: the engine refuses when `RENDER` is set). It is off by default because on this
set it catches no flag that the rules plus the assist miss and it adds false blocks (table above).

## Limits, plainly

* Synthetic, small, English-only text; no audio was used in the calibration. Speech recognition errors enter upstream of
  every number here.
* The intent classifier is the weakest decision (see its row), which is why the dock can ask "Did you mean …?". Plan-entry
  edits ("make team period shorter") and what-ifs ("what if team period was shorter") are close in meaning and are the most common confusion.
* Intensity is read from how the coach names a drill ("conditioning", "7 on 7"); it is a planning guess the coach confirms,
  not a measurement.
* The local plan parser handles the common phrasings (durations, gear, order, add / drop / make-N-minutes / replace / move to
  start or end / change start time). Anything else it lists under "Needs input" instead of guessing.
* The assist is a second look at wording. It does not replace the athletic trainer, the rectal-temperature rule, or the
  safety language boundary in `CLAUDE.md`: HeatTwin still never diagnoses, never says an athlete is safe, and never decides when to stop cooling.
