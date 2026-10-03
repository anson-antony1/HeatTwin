# Talk to the Twin — ElevenLabs agent setup

1. In ElevenLabs → Conversational AI → **Create agent**. Paste `system_prompt` and `first_message` from
   `agent_config.json`. Pick a calm voice. Turn **off** any built-in knowledge base: the agent should know only what
   the tools return.
2. Add the five **client tools** exactly as named in `agent_config.json` (`simulate_plan`, `optimize_plan`,
   `what_if`, `athlete_status`, `field_conditions`), with the same parameters, and "Wait for response" on.
   They run in the browser (`web/src/voice/tools.ts`) and call the engine at `VITE_ENGINE_URL`.
3. Make the agent public (or use a signed URL later), copy its id, and set in `web/.env.local`:
   ```
   VITE_ELEVENLABS_AGENT_ID=agent_…
   VITE_ENGINE_URL=http://localhost:8000
   ```
4. Run the engine (`uvicorn engine.api:app --port 8000`), warm `POST /optimize?demo=1` once, then `npm run dev` in `web/`.

**Without an agent id** the panel runs in **text mode**. Questions route by keyword to the same tools, and the answer
is the engine's own guarded sentence, so the demo still works offline from ElevenLabs.

**Guarding.** Every tool result carries a `say` sentence the engine already passed through `engine/guard.py`. Every agent
reply is checked again in the browser (`POST /guard` plus the number ledger). On a hit the rest of the reply is muted,
the transcript shows the redacted text with the reason, and the agent is told to restate.

The limit, plainly: with a hosted agent the check runs on reply text as it arrives, so the first words of a flagged reply
can already be audible. Text mode is fully gated.

**Test questions.** These are the 8 scripted questions in `testQuestions.ts`, also in the panel's "Test…" menu. Each lists the
tool it should call and what the answer must (and must not) contain.
