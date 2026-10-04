"""The free voice router: transcript → typed decisions (engine/decide.py) → the slots engine/voice.py already uses.

This replaces the Gemini call in /voice/intent when no paid API is available (and is the default: Gemini is optional and off).
It never writes a sentence. It returns choices — an intent, an athlete id, a drill id, a change kind, a gear, an intensity —
or, when a decision abstains, the TWO most probable options so the app can ask "Did you mean …?". Every number in a slot is a
number the coach said (minutes) or an index into the plan on screen (a position), checked by ``voice.resolve``; the
engine's /voice/answer then runs the tool and writes the sentence.

CONTRACTS v1.7 (additive): POST /voice/decide (engine/decide_routes.py) → ``route()``'s result.
"""
from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence

from engine import decide, guard, voice, voice_tools

LABEL = "routed locally by an embedding classifier — numbers come from the engine"
INTENT_LABELS = {
    "what_if": "What if I change a drill", "athlete_status": "One athlete's estimate", "field_conditions": "Field conditions",
    "optimize": "Optimize the plan", "plan_summary": "Plan summary", "plan_entry": "Enter or edit the plan",
    "unclear": "Something else",
}
# decide.INTENTS → engine/voice.py intents (plan_entry is handled by /plan/parse_local, not /voice/answer)
ENGINE_INTENT = {"what_if": "what_if", "athlete_status": "athlete_status", "field_conditions": "field_conditions",
                 "optimize": "optimize", "plan_summary": "plan_summary", "plan_entry": "plan_entry", "unclear": "unknown"}

_NUM_WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
              "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
              "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
              "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_NUM_RE = re.compile(r"\b(?:(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|"
                     r"eight|nine)|(" + "|".join(sorted(_NUM_WORDS, key=len, reverse=True)) + r"))\b", re.I)


def words_to_digits(text: str) -> str:
    """"twenty five minutes" → "25 minutes" (spoken numbers, 0-99). Other text is untouched."""
    def sub(m: re.Match) -> str:
        if m.group(1):
            return str(_NUM_WORDS[m.group(1).lower()] + _NUM_WORDS[m.group(2).lower()])
        return str(_NUM_WORDS[m.group(3).lower()])
    return _NUM_RE.sub(sub, text)


# ── slot extraction (rules over the words; the decisions that need a model are in engine/decide.py) ──────────────

_ADD_BREAK = re.compile(r"\b(add|adding|insert|put (?:in|a|an|some)|throw in|include|work in|give (?:us|them)|extra|another|"
                        r"additional)\b", re.I)
_BREAK_WORD = re.compile(r"\bbreaks?\b|\bwater\b|\bhydrat\w*\b", re.I)
_REMOVE = re.compile(r"\b(cut|cutting|drop|dropping|dropped|remove|removing|skip|skipping|scrap|eliminate|delete|take out|"
                     r"taking out|get rid of|lose|nix)\b|\bwithout(?! (?:the )?(?:pads|gear|helmets?|shade|tent|equipment))",
                     re.I)
_MOVE = re.compile(r"\b(move|moving|swap|reorder|switch|put|push)\b.*\b(first|last|start|beginning|end|earlier|later)\b", re.I)
_SHADE = re.compile(r"\b(shade|shaded|tent)\b", re.I)
_GEAR = [
    ("full_pads", re.compile(r"\bfull (?:pads?|gear|equipment|pad)\b", re.I)),
    ("helmet_shoulder_pads", re.compile(r"\b(?:shells?|shoulder pads?|helmets? and (?:shoulder )?pads?|helmets? and shoulders?|"
                                        r"helmet,? shoulder pads?)\b", re.I)),
    ("none", re.compile(r"\b(?:shorts|no pads|no gear|t-?shirts?|without pads|no equipment|jerseys?|no helmets?)\b", re.I)),
    ("helmet", re.compile(r"\b(?:helmets?(?: only)?|just helmets?)\b", re.I)),
]
_INTENSITY_CUE = re.compile(r"\b(walk[- ]?through|walking|lighter|light|easier|easy|jog\w*|slower|slow|half[- ]speed|no contact|"
                            r"rest|harder|hard|moderate|max|all[- ]out|full[- ]speed|tempo)\b", re.I)
_FEWEST = re.compile(r"\b(fewest|fewer|few changes|minimal|minimum|smallest|as little as|least|as few|changes or (?:fewer|less)|"
                     r"six changes|\d+ changes)\b", re.I)
_MINUTES = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(?:min(?:ute)?s?)\b", re.I)


def gear_in(text: str) -> Optional[str]:
    for gear, rx in _GEAR:
        if rx.search(text):
            return gear
    return None


def minutes_in(text: str) -> Optional[float]:
    m = _MINUTES.search(words_to_digits(text))
    return float(m.group(1)) if m else None


def extract_what_if(text: str, plan: Mapping[str, Any], drill_id: Optional[str]) -> tuple[dict[str, Any], list[str]]:
    """The change the coach describes → fields of ``voice.Parsed`` (+ notes: what to ask back). The first matching kind
    wins (add a break, remove, move, shade, gear, duration, intensity); if several matched, the note asks which one."""
    t = words_to_digits(text)
    drills = list(plan.get("drills") or [])
    drill = next((d for d in drills if d["id"] == drill_id), None)
    mins = minutes_in(t)
    half = bool(re.search(r"\bin half\b|\bby half\b|\bhalve\b", t, re.I))
    gear = gear_in(t)
    amount = bool(mins or half or re.search(r"\b(shorten\w*|shorter|trim\w*|reduce\w*|down to|only \d+)\b", t, re.I))
    found: list[tuple[str, dict[str, Any]]] = []
    if _BREAK_WORD.search(t) and _ADD_BREAK.search(t):
        found.append(("add_break", {"duration_min": int(round(mins))} if mins else {}))
    if _REMOVE.search(t) and not amount:
        found.append(("remove", {}))
    if _MOVE.search(t):
        mv: dict[str, Any] = {}
        if re.search(r"\b(first|start|beginning|earlier)\b", t, re.I):
            mv["move_to"] = 0
        elif re.search(r"\b(last|end|later)\b", t, re.I):
            mv["move_to"] = max(len(drills) - 1, 0)
        found.append(("move", mv))
    if _SHADE.search(t):
        found.append(("shade", {"shade": not re.search(r"\b(no|without|out of) (?:the )?(?:shade|tent)\b", t, re.I)}))
    if gear:
        found.append(("gear", {"gear": gear}))
    if (mins or half or re.search(r"\b(shorten\w*|shorter|lengthen\w*|longer|extend\w*|trim\w*|reduce\w*)\b", t, re.I)) \
            and not any(k == "add_break" for k, _ in found):
        f: dict[str, Any] = {}
        if mins:
            f["duration_min"] = int(round(mins))
        elif half and drill:
            f["duration_min"] = max(1, int(round(float(drill["duration_min"]) / 2)))
        found.append(("duration", f))
    cue = _INTENSITY_CUE.search(t)
    if cue and not found:
        word = cue.group(0).lower()
        phrase = {"lighter": "light", "easier": "light", "easy": "light", "slower": "light", "slow": "light",
                  "harder": "hard"}.get(word, word)
        d = decide.decide_intensity(phrase)
        found.append(("intensity", {"intensity": d.choice} if (not d.abstain and d.choice) else {}))
    if not found:
        return {}, []
    kind, f = found[0]
    notes = ["change: (more than one change said)"] if len(found) > 1 else []
    return {"change": kind, **f}, notes


def _drill_labels(plan: Mapping[str, Any]) -> dict[str, str]:
    """Drill id → what "Did you mean …?" shows; two drills with one name get "after <the drill before>"."""
    drills = list(plan.get("drills") or [])
    out: dict[str, str] = {}
    for k, d in enumerate(drills):
        name = str(d.get("name", d["id"]))
        dup = sum(1 for x in drills if str(x.get("name", "")).lower() == name.lower()) > 1
        out[d["id"]] = f"{name} after {drills[k - 1].get('name', '')}" if dup and k > 0 else name
    return out


def _option(label: str, choices: dict[str, Any], p: float) -> dict[str, Any]:
    return {"label": label, "choices": choices, "p": round(float(p), 4)}


def _confirmed(name: str, choice: str, backend: str) -> decide.Decision:
    return decide.Decision(name, choice, {choice: 1.0}, 1.0, False, (choice,), backend, True, None, None,
                           "confirmed by the coach")


def route(text: str, plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]], *,
          choices: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Transcript → ``{transcript, intent, slots, unresolved, abstain, asking, did_you_mean, decisions, labels, ...}``.

    ``choices`` are the coach's answers to an earlier "Did you mean …?" (``intent``, ``athlete_id``, ``drill_id``): each one
    replaces the corresponding decision with a confirmed one. At most ONE question is asked per call, in the order intent →
    athlete → drill."""
    text = (text or "").strip()
    if not text:
        raise ValueError("send text")
    choices = dict(choices or {})
    be = decide.get_backend()
    names = {a["id"]: voice_tools._plain(a.get("name")) for a in roster}
    pos = {a["id"]: a.get("position") for a in roster}
    dnames = _drill_labels(plan)

    d_int = (_confirmed("intent", choices["intent"], be.key) if choices.get("intent") in decide.INTENTS
             else decide.decide_intent(text, roster, plan))
    decisions: dict[str, Any] = {"intent": d_int.as_dict(), "athlete": None, "drill": None, "intensity": None}
    out: dict[str, Any] = {"transcript": guard.check(text, source="voice.transcript", log=False)["redacted_text"],
                           "slots": {}, "unresolved": [], "abstain": False, "asking": None, "did_you_mean": [],
                           "source": "local", "backend": be.key, "decisions": decisions,
                           "labels": [LABEL] + ([] if be.semantic else [f"decision layer: {be.label}"])}
    out["intent"] = ENGINE_INTENT[d_int.choice or "unclear"]
    if d_int.abstain:
        out["abstain"], out["asking"] = True, "intent"
        out["did_you_mean"] = [_option(INTENT_LABELS[i], {"intent": i}, d_int.probabilities.get(i, 0.0)) for i in d_int.top2]
        return out

    intent = d_int.choice
    intent_confirmed = d_int.note == "confirmed by the coach"
    parsed: dict[str, Any] = {"transcript": text, "intent": ENGINE_INTENT[intent] if intent != "plan_entry" else "unknown"}

    def ask_intent_again() -> dict[str, Any]:
        """The entity decision says "nobody / no drill in particular" although the intent needed one: the INTENT is the doubtful
        part, so ask about it (its two most probable options) rather than offer two arbitrary athletes or drills."""
        out["abstain"], out["asking"] = True, "intent"
        out["did_you_mean"] = [_option(INTENT_LABELS[i], {"intent": i}, d_int.probabilities.get(i, 0.0)) for i in d_int.top2]
        return out

    if intent == "athlete_status":
        d = (_confirmed("athlete", choices["athlete_id"], be.key) if choices.get("athlete_id") in names
             else decide.decide_athlete(text, roster))
        decisions["athlete"] = d.as_dict()
        if d.choice == decide.NONE:
            if not intent_confirmed:
                return ask_intent_again()
            out["unresolved"].append("athlete: (none named)")
        elif d.abstain:
            ranked = [i for i in d.probabilities if i in names][:2]
            out["abstain"], out["asking"] = True, "athlete"
            out["did_you_mean"] = [_option(f"{names[i]}" + (f" · {pos[i]}" if pos.get(i) else ""), {"athlete_id": i},
                                           d.probabilities.get(i, 0.0)) for i in ranked]
            return out
        else:
            parsed["athlete"] = d.choice

    if intent == "what_if":
        d = (_confirmed("drill", choices["drill_id"], be.key) if choices.get("drill_id") in dnames
             else decide.decide_drill(text, plan))
        decisions["drill"] = d.as_dict()
        if d.choice == decide.NONE:
            if not intent_confirmed:
                return ask_intent_again()
            out["unresolved"].append("drill: (none named)")
        elif d.abstain:
            ranked = [i for i in d.probabilities if i in dnames][:2]
            out["abstain"], out["asking"] = True, "drill"
            out["did_you_mean"] = [_option(dnames[i], {"drill_id": i}, d.probabilities.get(i, 0.0)) for i in ranked]
            return out
        else:
            parsed["drill"] = d.choice
        fields, notes = extract_what_if(text, plan, parsed.get("drill"))
        parsed.update(fields)
        out["unresolved"] += notes

    if intent == "optimize":
        parsed["preset"] = "fewest_changes" if _FEWEST.search(words_to_digits(text)) else "max_load"

    if intent == "plan_entry":
        out["slots"], out["unresolved"] = {}, []
        return out

    p = voice.Parsed.model_validate({k: v for k, v in parsed.items() if v is not None})
    out["slots"], unresolved = voice.resolve(p, plan, roster)
    out["unresolved"] = [*unresolved, *out["unresolved"]]
    return out
