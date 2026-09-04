# Architecture

## What this is

A conversational voice agent that books 30-minute appointments. A visitor opens
a web page, talks to the agent, and hangs up with a confirmed slot on the
business calendar.

```
Browser (ElevenLabs widget)
        │ WebRTC
        ▼
ElevenLabs Agents            STT · turn-taking · LLM · TTS
        │ webhook tools (HTTPS + bearer)
        ▼
Backend (Fastify + TypeScript)
        │
        ▼
Cal.com API v2
        │
        ▼
Google Calendar
```

The backend is the only component that talks to Cal.com. ElevenLabs never sees
the Cal.com API key and never builds a booking payload.

## Why a backend and not a proxy

The backend exists to take work away from the LLM. Every responsibility moved
out of the model is an entire class of bug that disappears.

**Dates.** The agent sends `2026-09-08` and `afternoon`. The backend resolves
timezone, offsets and ISO formats. All of that arithmetic lives in a single
file, `src/lib/time.ts`, covered by tests with a frozen clock.

**Pre-chewed options.** Cal.com returns dozens of raw slots. The backend picks
at most three, spread across the day, and returns them already written out:
*"el martes 8 de septiembre a las diez de la mañana"*. The agent reads the
string verbatim.

**`optionId`, never timestamps.** The agent books by sending `opt_1`. It never
constructs a time. This removes the whole timezone-bug surface from the LLM
side.

**Idempotency.** One `bookingKey` per conversation. If the agent calls the tool
twice, the second call returns the booking that already exists.

**Validation.** Zod rejects malformed payloads before they reach Cal.com.

**Traceability.** One structured log line per call, which is what makes a
conversation that went wrong debuggable after the fact.

## The page shows the booking, not the transcript

The landing page is built on the ElevenLabs **SDK**, not the embedded widget.
The widget is a closed component that brings its own chat bubble, its own
feedback panel and its own floating button; the SDK is transport only — WebRTC,
microphone, callbacks — so every pixel is ours.

That matters beyond aesthetics, because it lets the page show the *booking* as
it happens: the three times the agent just offered, the one that was picked, the
name and email as they were understood, and the confirmation. Those facts reach
the browser through two different channels, and which one carries what is a
deliberate split:

| Fact | Channel | Why |
|---|---|---|
| Offered times, chosen slot, appointment | `GET /agent/session/:id`, polled | These are what Cal.com actually returned. Deriving them from the transcript would mean rendering what the model *said*, which is the one thing this design refuses to trust. |
| Caller name and email | `show_booking_summary`, a client tool | So they never leave the browser they were dictated into — the session endpoint is public and deliberately carries no personal data. |

The key that ties it together already existed: the page reads
`conversation.getId()`, which is the same ElevenLabs conversation id the agent
sends as `bookingKey`, which is what the backend already files every offered
option under.

Polling, not server-sent events: the watched state changes about four times in a
two-minute call, and a two-second poll survives a lid closing or a phone
dropping to 3G with no reconnection logic to get wrong.

## Failure policy

Tool errors are returned as HTTP `200` with `booked: false`, a machine-readable
`reason`, and a `spokenConfirmation` the agent can read out loud. A `5xx` would
leave the LLM improvising in the middle of a live phone call.

## Timezone

Business timezone: `America/Guayaquil` — GMT-5, no daylight saving.

All conversion lives in `src/lib/time.ts`. No other file does date arithmetic.
Offsets are computed with `Intl` rather than hardcoded, so moving the business
to a DST timezone does not break anything.

Two behaviours that came from reading the Cal.com API rather than assuming it:

- `GET /v2/slots` interprets `start` and `end` as **UTC**, but groups the
  response keys by the `timeZone` you request. That is why the range is
  computed with `dayBoundsUtc` and then read back by the local day key.
- Each endpoint requires a different `cal-api-version`: `2024-09-04` for slots,
  `2026-02-25` for bookings. Sending the wrong one does not produce a clear
  error.

## Security

- Both tool endpoints require `Authorization` carrying `TOOLS_SHARED_SECRET`.
  Both `Bearer <token>` and the bare token are accepted, because the ElevenLabs
  Secrets Manager substitutes the entire header value and offers no documented
  way to prepend the prefix.
- The post-call webhook is verified by HMAC-SHA256 over the **raw** body, with
  a 30-minute replay window. No valid signature, no entry: `401`.
- Constant-time comparisons. `authorization` and the signature are redacted from
  the logs.
- Per-IP rate limiting, with `/health` exempt so Railway's probe does not eat
  the quota.
- No Cal.com key ever leaves the backend.

## Project layout

```
src/
  server.ts            boot; listens on 0.0.0.0 and process.env.PORT
  app.ts               Fastify assembly, injectable for tests
  routes/
    health.ts          GET  /health
    context.ts         GET  /agent/context
    session.ts         GET  /agent/session/:bookingKey
    tools.ts           POST /tools/availability · /tools/book
    webhooks.ts        POST /webhooks/post-call · GET /webhooks/stats
  lib/
    cal.ts             Cal.com API v2 client
    slots.ts           option selection and natural-language phrasing
    time.ts            ALL timezone logic
    scheduling.ts      the booking flow, with no HTTP on top
    session.ts         the per-conversation view the page reads
    auth.ts            bearer check and HMAC verification
    store.ts           in-memory store with TTL
    conversations.ts   JSON-file conversation log
    env.ts             configuration validation at boot
  schemas/             Zod input and output schemas
agent/
  agents.json          CLI registry
  tools.json           CLI registry
  agent_configs/       agent configuration
  tool_configs/        two webhook tools and one client tool
web/                   landing page: Vite + TypeScript + Tailwind v4
  index.html
  src/
    main.ts            wiring: state, buttons, lifecycle
    conversation.ts    the ElevenLabs SDK session and the client tool
    session.ts         polls the backend for the live booking state
    ui.ts              state in, DOM out
    orb.ts             the audio-reactive canvas
    config.ts          reads VITE_* and the query-string overrides
    agent-context.ts   asks the backend for the current date and timezone
    style.css          Tailwind import and theme variables
scripts/               smoke tests, simulation, agent setup
Dockerfile             backend image
web/Dockerfile         static build + nginx, from the repo root
docker-compose.yml     both pieces together, locally
```

> `agent/` uses the layout the ElevenLabs CLI requires, not a single
> `agent.json`: tools are separate objects with their own ids, and the agent
> references them through `tool_ids`.

## Language policy

**Code is English**: comments, identifiers, test names, logs, internal errors,
and this documentation.

**Spanish is reserved for what reaches a person**: the sentences the agent
reads out loud (`spokenLabel`, `spokenSummary`, `spokenConfirmation`), the
system prompt, and the visible copy of the landing page.

The reasoning is practical: the Spanish strings are product data, not code. If
only a developer ever sees a string, it is written in English.
