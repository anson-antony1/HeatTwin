# Live-demo profiles

`profiles/local/*.json` holds a **real person's** profile for the laptop live demo (strap → "Anson (live)"). The whole
`profiles/local/` folder is git-ignored: it never goes into the repo. Fill in every `null`; the engine refuses an
incomplete profile and falls back to the fictional one.

Without a complete local profile (and always on Render), the engine uses the fictional
`fixtures/profiles/demo_athlete_live.json`, "Demo athlete (live)", labelled synthetic.

Fields (CONTRACTS.md `Athlete`): `id`, `name`, `position`, `height_m`, `mass_kg`, `age_yr`, `sex` ("male" | "female",
a physiology-model input), `hr_rest_bpm`, `acclimatization_day` (1 = first day of heat exposure this season; 14 or
more = fully acclimatized), optional `hr_max_bpm`, `vo2max_ml_kg_min`, `days_since_last_heat_session`.

Pick one with `HEATTWIN_PROFILE`: unset → the first complete `profiles/local/*.json`, else the fictional one;
`demo` → always the fictional one; a file stem (e.g. `anson`) → that local file.
