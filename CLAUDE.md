# Project instructions

A conversational voice agent that books 30-minute appointments: ElevenLabs
Agents for voice, a Fastify backend for the logic, Cal.com for the calendar.

Read the documentation before implementing anything:

| Document | What is in it |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | System design, why the backend exists, failure policy, timezone, security, project layout |
| [`docs/agent.md`](./docs/agent.md) | The ElevenLabs agent: prompt, runtime settings, tools, evaluation, simulation |
| [`docs/api.md`](./docs/api.md) | HTTP endpoint contracts |
| [`docs/deployment.md`](./docs/deployment.md) | Railway, ElevenLabs CLI, webhook, landing page |
| [`docs/build-plan.md`](./docs/build-plan.md) | Phase checklist and what was verified in each |

---

## Hard rules

1. **Never hardcode secrets.** `.env` locally, environment variables on Railway.
   `.env` is in `.gitignore`.
2. **Never spend voice minutes to test logic.** The free plan gives 15 minutes a
   month and they cannot be bought. Use `pnpm simulate`.
3. **The agent confirms before booking.** `/tools/book` is only called after the
   caller has explicitly confirmed the details read back to them.
4. **The current date and time are injected as a dynamic variable.** The LLM
   never works out what day it is.
5. **The server listens on `0.0.0.0` and `process.env.PORT`.** Railway injects
   the port; a hardcoded `localhost` means the deploy never passes the health
   check.
6. **Agent changes are made by editing `agent/agent_configs/agendador.json`** and
   pushing with the CLI, not by clicking in the dashboard. Dashboard edits are
   lost on the next push.
7. **All date arithmetic lives in `src/lib/time.ts`.** No other file converts
   timezones.

---

## Working in this repo

- One phase per session. `/clear` between phases.
- Read the relevant official documentation before writing configuration.
- If an API schema does not match what is documented, say so instead of
  inventing fields.
- After each phase, update the checklist in [`docs/build-plan.md`](./docs/build-plan.md).

---

## Environment variables

```
PORT=                    # injected by Railway
CAL_API_KEY=
CAL_EVENT_TYPE_ID=
BUSINESS_TIMEZONE=America/Guayaquil
TOOLS_SHARED_SECRET=
ELEVENLABS_WEBHOOK_SECRET=
ELEVENLABS_API_KEY=      # CLI and scripts only, never the server
ANTHROPIC_API_KEY=       # phase 9 only
```

Full list with defaults in `.env.example`.

---

## Reference documentation

Read these pages before writing configuration. Do not guess the schemas.

- Webhook tools: https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools
- Conversation flow: https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow
- Dynamic variables: https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables
- CLI: https://elevenlabs.io/docs/eleven-agents/operate/cli
- Simulate conversations: https://elevenlabs.io/docs/eleven-agents/guides/simulate-conversation
- Post-call webhooks: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
- Custom LLM: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
- Cal.com API v2: the slots and bookings sections
