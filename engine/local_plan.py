"""Plan entry with no AI service: the coach's words → a DRAFT PracticePlan, in the same shape engine/llm_plan.py returns.

Rules read what the coach said (durations, gear, order, "add / drop / make … minutes"); the one judgement that needs a model —
how hard a drill is — is decision (d) of engine/decide.py (``decide_intensity``). Where that decision abstains, the drill gets
the HARDER of its two most probable intensities (a planning estimate that leans toward more heat load) and an assumption
("Not sure how hard … is — assumed …") is written for the coach's Confirm screen. Nothing is invented silently: gear that was
never said, a start time read as afternoon, a break length taken from the FHSAA minimum, a position that defaulted to the end
are each listed as an assumption. Drills with no stated duration are left out and named in ``unclear``, as with Gemini.

The draft always needs the coach's confirmation (``needs_confirmation: true``); nothing is simulated before that.
CONTRACTS v1.7 (additive): POST /plan/parse_local (engine/decide_routes.py).
"""
from __future__ import annotations

import re
from typing import Any, Mapping, Optional

from engine import decide, llm_plan, voice_tools
from engine.voice_local import gear_in, words_to_digits

LOCAL_LABEL = "parsed locally (no AI service) — coach must confirm"
LOCAL_MODEL = "local-rules + embedding intensity"
GEAR_SAY = {"none": "no pads", "helmet": "helmets only", "helmet_shoulder_pads": "shells", "full_pads": "full pads"}
DEFAULT_GEAR = "full_pads"        # planning default when the coach never says: the most conservative (highest heat load)

_HOURS = [(re.compile(r"\bhalf an hour\b|\bthirty minute block\b", re.I), "30 minutes"),
          (re.compile(r"\ban hour and a half\b|\bhour and a half\b", re.I), "90 minutes"),
          (re.compile(r"\ban hour\b|\bone hour\b", re.I), "60 minutes")]
_DUR = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(hours?|hrs?|min(?:ute)?s?)\b", re.I)
_SPLIT = re.compile(r"\s*(?:[,;.!?]|\bthen\b|\band then\b|\bfollowed by\b|\bafter that\b|\bnext\b|\bafterwards\b)\s*", re.I)
_EDIT_VERB = r"add|put in|insert|include|throw in|tack on|work in|make|change|set|extend|shorten|lengthen|trim|reduce|increase|" \
             r"bump|cut|drop|remove|skip|delete|take out|get rid of|scrap|lose|move|swap|switch|replace|push"
_STARTS_EDIT = re.compile(rf"\b(?:{_EDIT_VERB})\b", re.I)
_AND_EDIT = re.compile(rf"\s+and\s+(?=(?:{_EDIT_VERB})\b)", re.I)
_START = re.compile(r"\b(?:(?:practice\s+)?(?:starts?|starting|begins?|beginning|kick(?:s|ing)? off|from|at|around)\s+(?:at\s+)?|"
                    r"(?:push|move|shift|slide)\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:practice|session|start)\s+(?:back\s+|up\s+|"
                    r"forward\s+)?to\s+)(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?\b(?!\s*(?:min|hour|hr))", re.I)
_BREAK = re.compile(r"\b(?:water|hydration|rest|drink|shade|shaded)\s*breaks?\b|\bbreaks?\b|\bwater\b|\bhydrate\b|\brest\b", re.I)
_SHADE = re.compile(r"\b(shade|shaded|tent)\b", re.I)
_FIRST = re.compile(r"\b(first|always (?:start|open|begin)|to (?:start|open|begin)|at the (?:start|beginning))\b", re.I)
_LAST = re.compile(r"\b(always (?:end|finish|close)|to (?:end|finish|close)|at the end|last)\b", re.I)
_MUST = re.compile(r"\b(must|can'?t cut|cannot cut|have to|need to|non[- ]negotiable|essential|has to happen)\b", re.I)
_OPTIONAL = re.compile(r"\b(optional|if (?:we have )?time|if there'?s time|can cut|if we can|maybe)\b", re.I)
_GEAR_WORDS = re.compile(r"\b(?:in |with |wearing |all in |everything in )?(?:full (?:pads?|gear|equipment)|shells?|shoulder pads?|"
                         r"helmets? and (?:shoulder )?pads?|helmets? and shoulders?|helmets?(?: only)?|shorts|no pads|no gear|"
                         r"t-?shirts?|jerseys?|no equipment|pads)\b", re.I)
_LEAD = re.compile(r"^(?:\s*(?:okay|ok|so|um|uh|alright|all right|guys|everyone|everybody|folks|y'?all|boys|girls|"
                   r"first|also|today|tonight|we(?:'re|'ll|'d)?|let'?s|going to|gonna|will|do|"
                   r"doing|run|running|start(?:ing)?|begin(?:ning)?|open(?:ing)?|have|having|go|get|put|add|make|plan|practice|"
                   r"then|and|please|can you|could you|new|short|quick|little)\b)+", re.I)
_FILLER = re.compile(r"\b(?:with|of|for|a|an|the|about|around|some|just|like|maybe|plus|to|in|at|our|their|into|straight|"
                     r"after|before|that|it|is|are|be|and|then|up to)\b", re.I)
_POSITION = re.compile(r"\b(?:at|to|on)\s+the\s+(?:very\s+)?(?:end|start|beginning)\b|\bat the very end\b|\blast\b|\bfirst\b|"
                       r"\bto (?:start|open|finish|end|close)\b|\balways (?:start|open|begin|end|finish|close)(?: with)?\b", re.I)
_FOR_NUM = re.compile(r"\bfor\s+(\d{1,3})\b(?!\s*(?:yards?|reps?|plays?|snaps?|times|rounds?|min|hours?|hrs?))", re.I)


# ── what the coach says about effort: read it before the embedding model guesses from the drill's name ───────────
# Order matters: negations, then an intensifier on a hard word ("super intense" → max), then the plain words. Each entry
# is (level, pattern); the matched words are also removed from the drill title.
_INT_WORD = r"(?:intense|intensity|hard|tough|heavy|brutal|grueling|gruelling|demanding|strenuous|vigorous)"
_MAX_WORD = r"(?:brutal|grueling|gruelling|killer|insane|punishing|exhausting|all[- ]?out)"     # strong on their own
_BOOST = r"(?:super|very|really|extremely|incredibly|insanely|crazy|seriously|ultra|extra|mega)"
_INTENSITY_RULES: list[tuple[str, "re.Pattern[str]"]] = [(lvl, re.compile(rx, re.I)) for lvl, rx in [
    ("light", rf"\bnot\s+(?:too|very|that|super|so|overly)?\s*{_INT_WORD}\b"),
    ("light", r"\bnice and (?:easy|light|slow)\b|\btake it easy\b|\blow[- ]?(?:intensity|effort|key)\b"),
    ("max", rf"\b{_BOOST}[- ]?{_INT_WORD}\b|\b(?:max(?:imum)?|all[- ]?out|flat[- ]?out|full[- ]?(?:speed|go|tilt|blast|effort|send))"
            r"(?:\s+(?:effort|intensity|speed|pace))?\b|\b(?:100|hundred)\s*(?:percent|%)|\bas hard as (?:you|they|we) can\b|"
            rf"\bmaximal\b|\ball in\b|\bgo(?:ing)? all\b|\bbeast mode\b|\bleave it all\b|\b{_MAX_WORD}\b"),
    ("hard", r"\bhigh[- ]?(?:intensity|effort|tempo)\b|\bgame[- ]?(?:speed|tempo|intensity)\b|\bpretty (?:hard|intense|tough)\b|"
             r"\b(?:fast|quick|up)[- ]?(?:paced?|tempo)\b|\blive\b|\bcompetitive\b"),
    ("moderate", r"\b(?:moderate(?:ly)?|medium|mid|middle|regular|normal|average|steady|half[- ]?speed|three[- ]?quarter(?:s)?"
                 r"(?:[- ]?speed)?|75\s*(?:percent|%))(?:[- ]?(?:intensity|effort|pace|speed|level|tempo))?\b"),
    ("light", r"\b(?:light(?:ly)?|easy|easier|gentle|chill|relaxed|mellow|slow|low|recovery|soft)(?:[- ]?(?:intensity|effort|pace|"
              r"speed|level|tempo))?\b"),
    ("hard", r"\b(?:intense|hard|tough|heavy|brutal|grueling|gruelling|demanding|strenuous|vigorous)\b"),   # bare word, last
]]
_EFFORT_WORDS = re.compile(r"\b(?:intensity|effort|pace|speed|tempo|level|pretty|kinda|kind of|sort of|nice|going|gonna|"
                           r"finish(?:ing)?|end(?:ing)?|wrap(?:ping)? up|close out|closing|work(?:ing)? on|session of|"
                           r"shade|shaded|tent|under|percent)\b", re.I)


def explicit_intensity(clause: str) -> tuple[Optional[str], str]:
    """(level said by the coach | None, the clause with those effort words removed)."""
    for level, rx in _INTENSITY_RULES:
        m = rx.search(clause)
        if m:
            return level, (clause[:m.start()] + " " + clause[m.end():])
    return None, clause


def short_title(name: str, is_break: bool) -> str:
    """A short drill title (≤ 4 words, sentence case) from what is left of the coach's clause."""
    t = _EFFORT_WORDS.sub(" ", name)
    t = re.sub(r"\b(\d+|one) on (?:(\d+)|ones?)(s?)\b", lambda m: f"{1 if m.group(1) == 'one' else m.group(1)}-on-"
               f"{m.group(2) or 1}{'s' if (m.group(3) or m.group(0).endswith('ones')) else ''}", t)
    t = re.sub(r"\bwarm[- ]up\b", "warmup", t)
    t = re.sub(r"\s+", " ", t).strip(" -'")
    if is_break:
        t = re.sub(r"\b(?:water|hydration|drink|rest)?\s*breaks?\b", " ", t).strip()
        kind = "water break" if re.search(r"\b(?:water|hydrat|drink)", name) or not re.search(r"\brest\b", name) else "rest"
        t = kind if not t or t in ("water", "rest", "hydration") else f"{t} {kind}"
    words = t.split()
    if len(words) > 4:
        words = words[-4:]                     # the drill noun is usually last ("… position drills")
    t = " ".join(words) or ("water break" if is_break else "drill")
    return t[:1].upper() + t[1:]


def _norm(text: str) -> str:
    t = words_to_digits(text.lower())
    for rx, rep in _HOURS:
        t = rx.sub(rep, t)
    return re.sub(r"\s+", " ", t).strip()


def _minutes(clause: str) -> Optional[float]:
    m = _DUR.search(clause)
    if not m:
        f = _FOR_NUM.search(clause)          # "seven on seven for twenty": a bare number after "for" is minutes
        return float(f.group(1)) if f else None
    v = float(m.group(1))
    return v * 60 if m.group(2).lower().startswith(("h")) else v


def _strip(clause: str) -> str:
    c = _DUR.sub(" ", clause)
    c = _FOR_NUM.sub(" ", c)
    c = _GEAR_WORDS.sub(" ", c)
    c = _START.sub(" ", c)
    c = _POSITION.sub(" ", c)
    c = re.sub(r"[^a-z0-9'\- ]", " ", c)
    c = re.sub(r"\s+", " ", c).strip()
    c = _LEAD.sub(" ", c).strip()
    c = _FILLER.sub(" ", c)
    c = re.sub(r"\s+", " ", c).strip(" -'")
    return _LEAD.sub(" ", c).strip()


def _start_time(t: str, assumptions: list[str]) -> tuple[Optional[str], str]:
    """(HH:MM | None, text without the start-time phrase)."""
    m = _START.search(t)
    if not m:
        return None, t
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower().replace(".", "")
    if h > 24 or mi > 59:
        return None, t
    if ap.startswith("p") and h < 12:
        h += 12
    elif ap.startswith("a") and h == 12:
        h = 0
    elif not ap or ap.startswith("o"):
        if 1 <= h <= 7:
            h += 12
            assumptions.append("Read the start time as an afternoon time.")
    if h > 23:
        return None, t
    return f"{h:02d}:{mi:02d}", (t[:m.start()] + " " + t[m.end():])


def _intensity(name: str, is_break: bool, assumptions: list[str], said: Optional[str] = None) -> str:
    if is_break:
        return "rest"
    if said:                                  # the coach said how hard it is: that wins over any model guess
        return said
    d = decide.decide_intensity(name)
    if not d.abstain and d.choice:
        return d.choice
    top = [x for x in d.top2 if x in decide.INTENSITIES] or ["moderate"]
    pick = max(top, key=decide.INTENSITIES.index)       # lean toward more heat load when unsure
    assumptions.append(f"Not sure how hard \"{name}\" is — assumed {pick}. Check the intensity chip.")
    return pick


def _drill(clause: str, gear: Optional[str], assumptions: list[str], unclear: list[str]) -> Optional[dict[str, Any]]:
    mins = _minutes(clause)
    said, without_effort = explicit_intensity(clause)
    raw = _strip(without_effort)
    is_break = bool(_BREAK.search(clause)) or bool(_BREAK.fullmatch(raw or ""))
    if is_break and said == "light" and re.search(r"\brest\b", clause, re.I) and not re.search(r"\blight\b", clause, re.I):
        said = None                           # "rest" is a break, not an effort word
    if not raw and mins is None:
        return None
    name = short_title(raw, is_break) if (raw or is_break) else "Drill"
    return {"name": name[:80], "duration_min": mins or 0.0, "intensity": _intensity(raw or name, is_break, assumptions, said),
            "gear": gear or DEFAULT_GEAR, "is_break": is_break, "shade": bool(is_break and _SHADE.search(clause)),
            "priority": 1 if _MUST.search(clause) else 3 if _OPTIONAL.search(clause) else 2,
            "movable": not (_FIRST.search(clause) or _LAST.search(clause)), "_gear_said": gear is not None}


def _new_plan(t: str, assumptions: list[str], unclear: list[str]) -> list[dict[str, Any]]:
    clauses = [c for c in _SPLIT.split(t) if c and c.strip()]
    pieces: list[str] = []
    for c in clauses:
        if len(_DUR.findall(c)) >= 2:
            pieces += [p for p in re.split(r"\band\b", c) if p.strip()]
        else:
            pieces.append(c)
    drills: list[dict[str, Any]] = []
    gear: Optional[str] = None
    said_gear = False
    for piece in pieces:
        g = gear_in(piece)
        if g:
            gear, said_gear = g, True
        d = _drill(piece, g or gear, assumptions, unclear)
        if d is None:
            continue
        if not _strip(piece) and d["duration_min"] == 0 and g:      # "everything in helmets": a gear statement, not a drill
            continue
        if d["is_break"] and drills:
            d["gear"] = drills[-1]["gear"]                           # breaks keep the gear of the drill before them
        drills.append(d)
    if drills and not said_gear:
        assumptions.insert(0, "Gear was not said — assumed full pads for every drill. Check the gear chips.")
    if drills and drills[0]["name"].find("warm") >= 0:
        drills[0]["movable"] = False
    return drills


# ── edits to the plan already in use ─────────────────────────────────────────

def _view(cur: list[dict[str, Any]]) -> dict[str, Any]:
    return {"drills": [{"id": d["_id"], "name": d["name"]} for d in cur]}


def _find(cur: list[dict[str, Any]], phrase: str) -> tuple[Optional[int], decide.Decision]:
    d = decide.decide_drill(phrase, _view(cur))
    if d.abstain or d.choice in (None, decide.NONE):
        return None, d
    return next(i for i, x in enumerate(cur) if x["_id"] == d.choice), d


def _edit(t: str, current_plan: Mapping[str, Any], assumptions: list[str], unclear: list[str], changes: list[str]
          ) -> list[dict[str, Any]]:
    keep = ("name", "duration_min", "intensity", "gear", "is_break", "shade", "priority", "movable")
    cur = [{**{k: d[k] for k in keep if k in d}, "_id": f"c{i}"} for i, d in enumerate(current_plan["drills"])]
    seq = [0]
    parts: list[str] = []
    for c in _SPLIT.split(t):
        parts += [p for p in _AND_EDIT.split(c) if p and p.strip()]
    for part in parts:
        p = part.strip()
        mins = _minutes(p)
        amount = bool(mins is not None or re.search(r"\b(in half|by half|shorter|longer|shorten|lengthen|trim|reduce|extend)\b", p))
        add = re.search(r"\b(add|put in|insert|include|throw in|tack on|work in)\b", p)
        remove = re.search(r"\b(cut|drop|remove|skip|delete|take out|get rid of|scrap|lose)\b", p)
        if re.search(r"\breplace\b", p):
            m = re.search(r"\breplace\s+(.+?)\s+with\s+(.+)$", p)
            if not m:
                unclear.append(f"Say what to replace and what to replace it with: \"{p}\".")
                continue
            i, _ = _find(cur, m.group(1))
            new = _drill(m.group(2), gear_in(m.group(2)) or (cur[i]["gear"] if i is not None else None), assumptions, unclear) \
                if i is not None else None
            if i is None or new is None or not new["duration_min"]:
                unclear.append(f"Couldn't tell what to swap in for \"{m.group(1)}\": say the drill and how long.")
                continue
            new["_id"] = f"n{seq[0]}"; seq[0] += 1
            old = cur[i]
            cur[i] = new
            changes.append(f"Replaced {old['name']} with {new['name']}.")
        elif add:
            _add(p, cur, assumptions, unclear, changes, seq)
        elif remove and not amount:
            i, d = _find(cur, p)
            if i is None:
                unclear.append("Which drill should be dropped? " + _ask(d, cur))
                continue
            changes.append(f"Dropped {cur[i]['name']}.")
            cur.pop(i)
        elif amount:
            i, d = _find(cur, _DUR.sub(" ", p))
            if i is None:
                unclear.append("Which drill should change length? " + _ask(d, cur))
                continue
            old = float(cur[i]["duration_min"])
            if re.search(r"\b(in half|by half)\b", p):
                new = round(old / 2)
            elif mins is None:
                unclear.append(f"By how long should {cur[i]['name']} change?")
                continue
            elif re.search(r"\b(by|shorter|less|longer|more)\b", p) and not re.search(r"\b(to|for|only)\b", p):
                new = old - mins if re.search(r"\b(shorter|less|shorten|trim|reduce|cut)\b", p) else old + mins
            else:
                new = mins
            if new <= 0:
                unclear.append(f"{cur[i]['name']} would have no time left; say 'drop' to remove it.")
                continue
            cur[i]["duration_min"] = float(new)
            changes.append(f"Set {cur[i]['name']} to {new:g} minutes.")
        elif gear_in(p):
            i, d = _find(cur, _GEAR_WORDS.sub(" ", p))
            if i is None:
                unclear.append("Which drill should change gear? " + _ask(d, cur))
                continue
            cur[i]["gear"] = gear_in(p)
            changes.append(f"Set {cur[i]['name']} to {GEAR_SAY[gear_in(p)]}.")
        elif re.search(r"\b(move|swap|switch)\b", p) and re.search(r"\b(first|start|beginning|last|end)\b", p):
            i, d = _find(cur, p)
            if i is None:
                unclear.append("Which drill should move? " + _ask(d, cur))
                continue
            d_ = cur.pop(i)
            to_start = bool(re.search(r"\b(first|start|beginning)\b", p))
            cur.insert(0 if to_start else len(cur), d_)
            changes.append(f"Moved {d_['name']} to the {'start' if to_start else 'end'}.")
        elif re.search(r"\b(harder|lighter|easier|walk[- ]?through|light|hard)\b", p):
            i, d = _find(cur, p)
            if i is None:
                unclear.append("Which drill should change intensity? " + _ask(d, cur))
                continue
            word = re.search(r"\b(harder|lighter|easier|walk[- ]?through|light|hard)\b", p).group(1)
            phrase = {"lighter": "light", "easier": "light", "harder": "hard"}.get(word, word)
            di = decide.decide_intensity(phrase)
            if di.abstain or not di.choice:
                unclear.append(f"How hard should {cur[i]['name']} be?")
                continue
            cur[i]["intensity"] = di.choice
            changes.append(f"Set {cur[i]['name']} to {di.choice}.")
        else:
            unclear.append(f"Couldn't tell what to change for: \"{p}\".")
    return cur


def _ask(d: decide.Decision, cur: list[dict[str, Any]]) -> str:
    names: dict[str, str] = {}
    for k, x in enumerate(cur):
        dup = sum(1 for y in cur if y["name"].lower() == x["name"].lower()) > 1
        names[x["_id"]] = f"{x['name']} after {cur[k - 1]['name']}" if dup and k > 0 else x["name"]
    opts = [names[i] for i in d.probabilities if i in names][:2]
    return ("Did you mean " + " or ".join(opts) + "?") if opts else ""


def _add(p: str, cur: list[dict[str, Any]], assumptions: list[str], unclear: list[str], changes: list[str], seq: list[int]) -> None:
    where = None
    pos_end = None
    m_after = re.search(r"\b(after|before)\s+(?:the\s+)?(.+)$", p)
    body = p
    if m_after:
        body = p[:m_after.start()]
        where = (m_after.group(1), m_after.group(2))
    elif _LAST.search(p):
        pos_end = "end"
    elif _FIRST.search(p):
        pos_end = "start"
    d = _drill(body, gear_in(body), assumptions, unclear)
    if d is None:
        unclear.append(f"Say what to add: \"{p}\".")
        return
    d["movable"] = True
    if d["is_break"] and not d["duration_min"]:
        d["duration_min"] = float(voice_tools.fhsaa_break_min())
        assumptions.append("Break length was not said — used the FHSAA minimum rest-break length.")
    if not d["duration_min"]:
        unclear.append(f"No duration for \"{d['name']}\".")
        return
    idx = len(cur)
    if where:
        i, dec = _find(cur, where[1])
        if i is None:
            unclear.append(f"Which drill should \"{d['name']}\" go {where[0]}? " + _ask(dec, cur))
            return
        idx = i + 1 if where[0] == "after" else i
    elif pos_end == "start":
        idx = 0
    elif pos_end is None:
        assumptions.append(f"Position was not said — added \"{d['name']}\" at the end.")
    if not d.pop("_gear_said") and cur:
        neighbour = cur[max(0, min(idx, len(cur)) - 1)]
        d["gear"] = neighbour["gear"]
        assumptions.append(f"Gear for \"{d['name']}\" was not said — carried over from \"{neighbour['name']}\".")
    d["_id"] = f"n{seq[0]}"
    seq[0] += 1
    cur.insert(idx, d)
    changes.append(f"Added {d['name']} ({d['duration_min']:g} minutes).")


def _looks_like_edit(t: str, current_plan: Optional[Mapping[str, Any]]) -> bool:
    if not current_plan or not current_plan.get("drills"):
        return False
    return bool(_STARTS_EDIT.search(t)) and not re.search(r"\b(today we|new plan|from scratch|start over)\b", t)


# ── public ───────────────────────────────────────────────────────────────────

def parse_text(text: str, current_plan: Optional[Mapping[str, Any]] = None, **plan_kw: Any) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        raise ValueError("text is empty")
    t = _norm(text)
    assumptions: list[str] = []
    unclear: list[str] = []
    changes: list[str] = []
    hhmm, rest = _start_time(t, assumptions)
    start_only = bool(current_plan and current_plan.get("drills") and hhmm and not _strip(rest))   # "push practice to 5 o'clock"
    editing = start_only or _looks_like_edit(rest, current_plan)
    if start_only:
        cur = [{**{k: v for k, v in d.items()}, "_id": f"c{i}"} for i, d in enumerate(current_plan["drills"])]
        changes.append("Changed the start time.")
        drills = [{k: v for k, v in d.items() if not k.startswith("_")} for d in cur]
    elif editing:
        cur = _edit(rest, current_plan, assumptions, unclear, changes)
        drills = [{k: v for k, v in d.items() if not k.startswith("_")} for d in cur]
    else:
        drills = [{k: v for k, v in d.items() if not k.startswith("_")} for d in _new_plan(rest, assumptions, unclear)]
        if not drills and not unclear:
            unclear.append("Didn't catch any drills. Say each drill, how long it runs, and the gear.")
    parsed_drills = []
    for d in drills:
        if d["duration_min"] > 240:
            unclear.append(f"\"{d['name']}\" is longer than four hours; check the minutes.")
            d["duration_min"] = 0.0
        parsed_drills.append(llm_plan.ParsedDrill(**d))
    parsed = llm_plan.Parsed(transcript=text, start_time_local=hhmm, drills=parsed_drills, assumptions=assumptions[:5],
                             unclear=unclear, changes=changes)
    out = llm_plan.draft_plan(parsed, current_plan=dict(current_plan) if editing else None, **plan_kw)
    out["labels"] = [LOCAL_LABEL]
    out["model"] = LOCAL_MODEL
    out["source"] = "local"
    return out
