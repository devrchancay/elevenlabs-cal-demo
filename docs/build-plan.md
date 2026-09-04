# Build plan

The MVP was built in phases, one phase per working session, each with an
explicit acceptance criterion. This file is both the plan and the log: what was
asked for, what was actually built, and where the two diverged.

---

## Status

All the code is written and verified. What remains are the steps that need real
accounts and credentials.

| Phase | Status |
|---|---|
| 0 · Manual preparation | Pending · needs live accounts |
| 1 · Backend scaffolding | **Done and verified** |
| 2 · Cal.com client and slots | **Done** · reads verified against the live Cal.com API · booking still needs a real key |
| 3 · Tool endpoints | **Done and verified** |
| 4 · Docker and Railway | **Docker done and verified** · deploy pending |
| 5 · ElevenLabs agent | **Configuration written** · not yet pushed with the CLI |
| 6 · Text simulations | **Script written** · not yet run against a live agent |
| 7 · Widget | **Landing done** · rebuilt on the SDK with a custom UI · real call pending |
| 8 · Post-call webhook | **Done and verified** · not yet linked in ElevenLabs |
| 9 · Custom LLM with Claude | Not started (optional) |

The shortest path to unblocking the rest is [`deployment.md`](./deployment.md),
in order.

---

## Phase 0 — Manual preparation

- [ ] Cal.com account, 30-minute event type, Google Calendar connected
- [ ] Cal.com API key and numeric `eventTypeId`
- [ ] ElevenLabs account (free plan)
- [ ] Railway account
- [ ] Local `.env` filled in

**Criterion:** a test booking created with `curl` against Cal.com shows up in
Google Calendar.

---

## Phase 1 — Backend scaffolding

> Node 22 + TypeScript + Fastify with pnpm. `tsx` for development, `tsc` for the
> build, Vitest for tests, eslint. `GET /health` returning
> `{ status: "ok", version }`. The server listens on `0.0.0.0` and
> `process.env.PORT ?? 3000`. Environment loaded and validated with Zod at boot:
> if something is missing, the process dies with a clear message instead of
> failing later.

- [x] Project runs locally
- [x] `/health` answers
- [x] Environment validated at boot

**Criterion:** `pnpm dev` starts and `curl localhost:3000/health` returns 200.

**Verified.** `/health` returns
`{"status":"ok","version":"0.1.0","uptime":4}`. With a variable missing, the
process dies at boot listing exactly which ones.

---

## Phase 2 — Cal.com client and slot logic

The heart of the backend. Fully tested, with no test touching the network.

> `src/lib/cal.ts`: two functions typed against the Cal.com v2 API — fetch
> available slots and create a booking. Read the official docs first; do not
> invent fields.
>
> `src/lib/time.ts`: all timezone logic (`America/Guayaquil`).
> `src/lib/slots.ts`: given raw Cal.com slots, pick at most 3 spread across the
> day and phrase them as natural Spanish for speech.
>
> Vitest with a frozen clock and a Cal.com response fixture. Cover: morning vs
> afternoon, a day with no availability, and a month boundary.

- [x] Typed Cal.com client
- [x] Spanish slot phrasing
- [x] Tests passing with a frozen clock
- [ ] Scripts run against the live API

**Criterion:** a script against the live API returns 3 well-phrased options for
tomorrow, and another script books an appointment that appears in Google
Calendar.

**Status.** The code is in place with tests frozen at 2026-09-04 10:00 in
Guayaquil, plus Cal.com response fixtures. They cover morning vs afternoon, a
day with no availability, a full part of day, a month boundary and a year
boundary.

The **read half of the criterion is already verified against the live API**:
`smoke:slots` was run against a public Cal.com event type (`eventTypeId=1`, no
authentication) and the client parsed the 4 raw slots it returned, converted
them from UTC to `-05:00` and phrased them correctly:

```
Cal.com returned 4 raw slot(s).
  2026-09-08T14:00:00.000Z
  2026-09-08T18:00:00.000Z
  2026-09-08T18:30:00.000Z
  2026-09-08T19:30:00.000Z

  opt_1  el martes 8 de septiembre a las nueve de la mañana
  opt_2  el martes 8 de septiembre a la una y media de la tarde
  opt_3  el martes 8 de septiembre a las dos y media de la tarde
```

So the shape of the Cal.com response, the timezone conversion and the Spanish
phrasing are confirmed against a live API, not only against fixtures. The write
half needs a real API key and event type:

```bash
pnpm smoke:slots                # reads availability; books nothing
pnpm smoke:book -- --yes        # creates ONE real booking
```

Two things that came from reading the spec rather than assuming, both encoded in
the client:

- `GET /v2/slots` interprets `start` and `end` as UTC but groups the response
  keys by the requested `timeZone`.
- Each endpoint requires a different `cal-api-version`: `2024-09-04` for slots,
  `2026-02-25` for bookings.

---

## Phase 3 — Tool endpoints

> `POST /tools/availability` and `POST /tools/book`. Validate input and output
> with Zod. Protect both with `Authorization: Bearer ${TOOLS_SHARED_SECRET}`;
> without it, 401.
>
> `/tools/availability` stores the options it returned against a short id
> (`opt_1`), so `/tools/book` receives only that id and never a timestamp. Use
> an in-memory store with a 15-minute TTL; do not stand up Redis yet.
>
> `/tools/book` is idempotent by `bookingKey`: the same key twice returns the
> existing booking instead of creating another.
>
> Add `@fastify/rate-limit` and structured per-request logging.

- [x] Both endpoints with Zod
- [x] Bearer auth
- [x] Idempotency covered by a test
- [x] Rate limit active

**Criterion:** integration tests covering the happy path, 401 without a token,
an invalid payload, and a double call with the same `bookingKey`.

**Verified.** 25 integration tests, including all four from the criterion.

Three decisions taken along the way:

- `/tools/availability` accepts an **optional** `bookingKey`. Without it, two
  simultaneous conversations would share the same `opt_1` and one could book the
  other's slot. With it, options are scoped per conversation.
- Errors are returned as `200` with a readable `spokenConfirmation`, not as
  `5xx`. An HTTP error leaves the LLM improvising in the middle of a voice call.
- If the requested part of day is full, the rest of the day is offered; if the
  whole day is full, the next 7 are searched **in parallel**. Sequentially that
  would be up to 7 chained round-trips to Cal.com, and that silence is audible.

---

## Phase 4 — Docker and Railway deploy

> Multi-stage Dockerfile: a build stage with pnpm and tsc, a final stage on
> `node:22-alpine` with production dependencies only, a non-root user, and a
> `HEALTHCHECK` pointing at `/health`. Add `.dockerignore`. Verify the image
> starts locally and respects `PORT`.
>
> Document the Railway steps: create the service from the repo, load the
> environment variables, generate the public domain.

- [x] Image builds and runs locally
- [ ] Service deployed on Railway
- [ ] Variables loaded
- [ ] Public domain generated

**Criterion:** `curl https://<domain>.up.railway.app/health` returns 200, and
both tool endpoints answer correctly with the bearer token.

**Verified locally.** The image is 252 MB, runs as the `node` user, respects
`PORT`, and Docker's `HEALTHCHECK` reports `healthy`. Without `CAL_API_KEY` the
container dies at boot with the right message. It ships `dumb-init` so the
`SIGTERM` of each redeploy reaches Node instead of being swallowed.

There is also a `docker-compose.yml` that brings up backend and landing together
with the same image Railway will build:

```bash
pnpm compose:up     # backend on :3000, landing on :8080
```

Verified: both containers reach `healthy`, the landing waits for the backend to
be healthy before starting, the conversation log survives a restart thanks to
the volume, and without a `.env` the container dies naming the missing
variables.

One caveat: the container filesystem is ephemeral, so `data/conversations.json`
is lost on every redeploy. Mount a volume at `/app/data` to keep it.

---

## Phase 5 — ElevenLabs agent

> Create the agent configuration and apply it with the CLI:
>
> - System prompt in Latin American Spanish. Flow: greet and disclose that it is
>   an AI assistant → understand the need → call `check_availability` → read the
>   options exactly as they arrive in `spokenLabel` → confirm the choice → ask
>   for name and email → **read everything back and wait for explicit
>   confirmation** → call `book_appointment` → say goodbye.
> - The prompt must make clear the agent passes `optionId`, never dates or times
>   it built itself.
> - Two webhook tools pointing at the Railway domain, bearer token stored in the
>   ElevenLabs Secrets Manager.
> - `bookingKey` = conversation id, via dynamic variable.
> - Dynamic variable with the current date and time in `America/Guayaquil`.
> - Short, natural first line. Spanish voice, low-latency model.
> - `max_duration_seconds`: 180 · `turn_timeout`: 5 · eagerness: normal ·
>   interruptions on · soft timeout: 3.0s with a static Spanish message.

- [x] Configuration written and versioned
- [ ] Agent pushed from the JSON
- [ ] Tools wired to the Railway backend
- [ ] Dynamic variables working

**Criterion:** the agent exists with exactly the configuration in the JSON, and
the Railway logs show incoming calls from ElevenLabs.

**Status.** The configuration is complete in `agent/`, with every setting this
phase asked for. Full documentation in [`agent.md`](./agent.md).

One deviation from the original spec: it is not a single `agent/agent.json`. The
ElevenLabs CLI requires a different layout, because tools are separate objects
with their own ids that the agent references through `tool_ids`:

```
agent/
  agents.json              CLI registry
  tools.json               CLI registry
  agent_configs/agendador.json
  tool_configs/check_availability.json
  tool_configs/book_appointment.json
  tool_configs/show_booking_summary.json
```

A third tool was added after the fact: `show_booking_summary`, a **client**
tool. It has no URL and never reaches the backend — ElevenLabs forwards it
straight to the page, which draws the chosen time, the name and the email while
the agent reads them back. It is the fix for the one failure this flow could not
otherwise catch: an email misheard by the transcriber is hard to verify by ear
and easy to verify by eye.

To avoid pasting the secret by hand:

```bash
pnpm agent:setup                      # store the secret, write the URLs
cd agent && elevenlabs tools push
cd .. && pnpm agent:link              # copy the tool ids into the agent
cd agent && elevenlabs agents push
```

Two things to watch on the first push:

- The `voice_id` is the CLI's default template voice, which was not chosen for
  Spanish. Change it after hearing the first call.
- `platform_settings.evaluation.criteria` is the only block whose exact schema
  is undocumented. If the push complains, delete it and push again.

---

## Phase 6 — Text simulations, no voice minutes spent

> A script driving the Simulate Conversations API through these scenarios,
> printing transcript and tool calls:
>
> 1. Happy path: asks for tomorrow afternoon and takes the first option
> 2. No availability: asks for a full day, the agent offers alternatives
> 3. Change of mind: accepts a time then asks for another before confirming
> 4. Ambiguous relative date: "next week"
> 5. Backs out and does not want to book
> 6. Confirms twice (must trigger idempotency)
>
> Verify `book_appointment` is only ever called after explicit confirmation.

- [x] Script written with all six scenarios
- [ ] All six run
- [ ] No case books without confirmation
- [ ] Case 6 creates no duplicate

**Criterion:** all six pass. Iterate the system prompt here, not in voice.

**Status.** `pnpm simulate` is ready and needs `ELEVENLABS_AGENT_ID`. It does
more than print transcripts: it asserts automatically that `book_appointment`
was preceded by an explicit confirmation, that the agent mentioned no time the
tool did not return, and that confirming twice does not produce two different
`bookingUid` values. It exits 1 on failure.

The no-availability scenario mocks `check_availability`; the rest hit the real
backend, which is the only way to demonstrate the idempotency of case 6.

Note: ElevenLabs marked this endpoint deprecated in favour of
`/v1/convai/agent-testing`. It still works and it is what the plan called for.

---

## Phase 7 — Widget and the first real call

> A simple landing page embedding the widget, deployable as a static site.

- [x] Page with the widget
- [ ] First real voice call

Budget: **15 minutes a month**. A conversation runs ~2 minutes, so 6 or 7 calls.
What to listen for, because none of it shows up in text:

- Does it cut me off while I dictate my name? → eagerness to `patient`
- Dead silence while it queries the backend? → lower the soft timeout
- Does the voice sound natural in Spanish? → try another voice
- Does it understand numbers and dates spoken aloud? → adjust the prompt

**Criterion:** one end-to-end call that ends with the appointment in Google
Calendar.

**Status.** `web/` is a minimal Vite project with TypeScript and Tailwind v4,
rather than a loose `index.html`. It is configured through `VITE_*` variables
and accepts query-string overrides (`?agent=…&backend=…`) to point at another
agent or a local backend without rebuilding.

**The embedded widget is gone.** It was the obvious first move and the wrong
one: a closed component that brings its own chat bubble, its own star-rating
feedback panel and its own floating button, none of which belong in a booking
flow, and none of which can be styled away. The page now uses
`@elevenlabs/client`, which is transport only — WebRTC, microphone, callbacks —
and ships no interface at all.

What replaced it shows the **booking** rather than a chat log: an orb that
tracks the microphone while the agent listens and the agent's own output while
it speaks, an explicit state line, a discreet subtitle track, and a panel that
fills in as the conversation advances — the three offered times, the one picked,
the name and email as understood, the confirmation.

That panel needed one thing the backend did not expose yet, added in the same
pass: `GET /agent/session/:bookingKey`. It needed no new plumbing, because the
page can read `conversation.getId()` and that is already the `bookingKey` the
backend files every offered option under. Public, and free of personal data on
every path — a test asserts that directly.

Three details that were not in the plan but turned out to be necessary:

- The current date is fetched from the backend at `/agent/context` rather than
  computed in the browser. The visitor may be in another timezone, and the agent
  has to reason about the business day. That endpoint carries CORS because the
  landing lives on another origin. It returns the timezone too, so the page
  formats slot times in the business zone and not the visitor's.
- Slot times on screen are formatted from `startsAt` with `Intl`, not by taking
  the spoken label apart. That label is Spanish prose written to be heard — "a
  la una y media de la tarde" — and regexing it back into fields is string
  surgery on a moving target.
- The SDK is a ~600 kB WebRTC bundle. It is reached through a dynamic import and
  warmed up once the page is idle, so first paint costs 10 kB of JavaScript and
  the button still responds instantly.

---

## Phase 8 — Post-call webhook

> `POST /webhooks/post-call`, verifying the ElevenLabs HMAC signature before
> processing anything. Store transcript, duration, outcome and whether it
> booked. Persist to a JSON file for now; no database yet. Reject anything
> without a valid signature with 401.

- [x] HMAC verification
- [x] Conversation log
- [ ] Webhook linked in ElevenLabs

**Criterion:** being able to say "12 conversations, 8 appointments booked". That
is what makes the MVP demonstrable.

**Verified.** 16 tests: no signature, wrong secret, expired signature, and a
body altered after signing. All rejected with 401.

Details that matter and are handled:

- `${timestamp}.${raw body}` is signed with HMAC-SHA256, 30-minute window.
  Fastify keeps the raw body deliberately: re-serialising the JSON changes the
  bytes and the signature stops matching.
- ElevenLabs retries with an identical body, so events are de-duplicated by
  conversation id plus event timestamp.
- An unexpected payload answers 200, not an error: after 10 consecutive failures
  ElevenLabs disables the webhook.
- Whether it booked is decided from the actual `book_appointment` result, not
  from what the agent said. An agent can claim it booked and be wrong.

`GET /webhooks/stats` returns the number directly, behind the same bearer.

---

## Phase 9 (optional) — Custom LLM with Claude

Only once everything above works. One variable at a time.

> Add `POST /v1/chat/completions` to the same Fastify service: OpenAI-compatible,
> translating to Anthropic's native Messages API with SSE streaming. Translate
> tool calls in both directions: OpenAI `tools` → Anthropic `tools`, and
> `tool_use` back to `tool_calls`. Prompt caching with `cache_control` on the
> system block. Log input and output tokens per turn, time-to-first-token and
> total latency.

- [ ] Streaming working
- [ ] Tool calling translated both ways
- [ ] Agent pointed at the proxy
- [ ] TTFT compared against the native LLM

**Not started, deliberately.** It is optional and comes after everything else
works end to end.

**Criterion:** the full flow works with Claude as the brain and TTFT stays under
800 ms.

Note: Anthropic's OpenAI compatibility layer ignores the `strict` parameter in
tool calling, so tool JSON is not guaranteed. Validate and normalise in the
proxy before responding.

---

## Cost control

- Monthly limit configured at console.anthropic.com before starting
- One phase per session, with `/clear` between phases
- Phase 6 complete before spending the first voice minute
