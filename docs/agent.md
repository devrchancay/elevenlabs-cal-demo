# The agent

Everything about the ElevenLabs side: how it is configured, why the prompt is
shaped the way it is, what the two tools promise, and how it is tested without
burning voice minutes.

The agent is **defined by versioned JSON in `agent/`** and applied with the
ElevenLabs CLI. It is never edited in the dashboard: anything changed there is
overwritten by the next push.

---

## Configuration layout

The CLI does not accept a single `agent.json`. Tools are standalone objects with
their own ids, and the agent references them by `tool_ids`:

```
agent/
  agents.json                        CLI registry: agent id ↔ config file
  tools.json                         CLI registry: tool ids ↔ config files
  agent_configs/
    appointment_scheduler.json       the agent: prompt, ASR, TTS, turn-taking
  tool_configs/
    check_availability.json          webhook tool → POST /tools/availability
    book_appointment.json            webhook tool → POST /tools/book
    show_booking_summary.json        client tool  → runs in the browser
```

Applying a change:

```bash
pnpm agent:setup                  # store the shared secret, write the public URLs
cd agent && elevenlabs tools push # creates/updates tools, writes ids into tools.json
cd .. && pnpm agent:link          # copies those ids into the agent's tool_ids
cd agent && elevenlabs agents push
```

`pnpm agent:setup` exists so the shared secret never has to be pasted by hand: it
stores `TOOLS_SHARED_SECRET` in the ElevenLabs Secrets Manager and writes the
resulting `secret_id` plus `PUBLIC_BASE_URL` into both tool configs.

---

## Runtime configuration

| Block | Setting | Value | Why |
|---|---|---|---|
| `asr` | `provider` / `quality` | `scribe_realtime`, `high` | Names and email addresses dictated by voice are the hardest input in this flow. |
| `asr` | `keywords` | `cita`, `agendar`, `mañana`, `tarde`, `arroba`, `guion`, `punto`, `gmail`, `hotmail`, `outlook` | Biases the transcriber toward the vocabulary this conversation actually uses, especially the spoken spelling of an email address. |
| `turn` | `turn_timeout` | `5` | Long enough that someone dictating an email address is not cut off. |
| `turn` | `turn_eagerness` | `normal` | Move to `patient` if the first real call shows the agent interrupting. |
| `turn` | `soft_timeout_config` | `3s`, static message | Cal.com round-trips are slow enough to produce dead air. A fixed Spanish line ("Un momento, estoy revisando la agenda.") beats an LLM-generated filler, which would add latency to cover latency. |
| `tts` | `model_id` | `eleven_flash_v2_5` | Lowest-latency model; in a booking call, responsiveness beats timbre. |
| `tts` | `optimize_streaming_latency` | `3` | Same trade-off. |
| `conversation` | `max_duration_seconds` | `180` | A booking takes ~2 minutes. The cap bounds the damage of a stuck conversation on a 15-minute monthly budget. |
| `agent` | `language` | `es` | Latin American Spanish. |
| `agent` | `llm` / `temperature` | `claude-sonnet-4-5`, `0` | The agent follows a fixed procedure and reads pre-written strings. There is nothing to be creative about. |
| `platform_settings.overrides` | `text_only` | overridable | Lets the simulation harness run the same agent in text mode. Voice, prompt and language are **not** overridable from the client. |

`first_message` is fixed rather than generated, so every call starts identically
and the first token is instant:

> «Hola, soy el asistente virtual. ¿Te ayudo a agendar una cita?»

---

## Dynamic variables

`{{current_datetime}}` is injected when the conversation starts. **The LLM is never
told to work out what day it is.**

The landing page fetches it from `GET /agent/context` and passes it to the
widget. It is computed on the server on purpose: the visitor's browser clock may
be in a different timezone, and the agent has to reason about the *business* day.

The name is a contract between two deploys: the page sends
`dynamicVariables: { current_datetime }` and the prompt reads
`{{current_datetime}}`. Renaming it means pushing the agent and deploying the
page together, or the variable silently fails to resolve mid-call.

`bookingKey` is wired to the built-in `system__conversation_id` in both tool
schemas, so idempotency and per-conversation option scoping are automatic rather
than something the model has to remember.

---

## The system prompt

Full text in `agent/agent_configs/appointment_scheduler.json`. It is written in
English, and it tells the agent to speak Spanish; the handful of phrases the
agent has to say word for word are quoted in Spanish inside it. The structure:

1. **Role and register.** Assistant for a business in Ecuador, neutral Latin
   American Spanish, informal *tú*, one job only: booking 30-minute
   appointments.
2. **Context.** `{{current_datetime}}` is declared the single source of truth about
   today's date.
3. **How to speak.** Short sentences, one idea each. No lists, bullets,
   asterisks or emoji — everything is read out loud. No echoing the caller, no
   thanking every turn, no greeting twice. If asked whether it is a person, it
   says the truth.
4. **The flow, in order.** Ten numbered steps, described below.
5. **Hard rules.** The invariants that must not bend.
6. **Handling caller data.** Voice-transcribed names and emails are wrong often;
   this is the reason the read-back step exists.

### The flow

| Step | What happens |
|---|---|
| 1 | Listen — the first message already greeted. |
| 2 | Pin down a concrete date. Vague ("next week") gets a follow-up question. Relative ("tomorrow", "Tuesday") is resolved against `{{current_datetime}}`. |
| 3 | Call `check_availability` with `YYYY-MM-DD` and the requested part of day. |
| 4 | Read `spokenSummary` **verbatim**. No rephrasing, no added times, no reordering. If `found` is false, offer another date instead of inventing slots. |
| 5 | Wait for a choice. Changing dates loops back to step 3; changing one's mind is normal and is not commented on. |
| 6 | Ask for the full name, then the email. One at a time. |
| 7 | Call `show_booking_summary` so the details appear on screen, then spell the email back character by character, read the name and the chosen time, and ask literally «¿Está todo correcto?» — and wait. |
| 8 | Only on a clear yes, call `book_appointment`. Silence, "mmm", "creo que sí" or any correction is **not** confirmation: go back to step 7. |
| 9 | Read `spokenConfirmation` verbatim. If `booked` is false the appointment does **not** exist; the string already explains what happened. |
| 10 | One-sentence goodbye. |

### The hard rules

- Never state an available date or time that did not come from
  `check_availability`. No tool call means no knowledge of the calendar.
- Pass `book_appointment` the exact `optionId` (`opt_1`, `opt_2`, `opt_3`).
  Never a date, a time, or a sentence describing one.
- Never call `book_appointment` before step 8. It is the only action in the
  conversation that cannot undo itself.
- `show_booking_summary` and `book_appointment` are different things. The first
  only draws on screen and belongs to step 7; the second creates the
  appointment and belongs to step 8. Calling the first books nothing.
- Never promise anything outside scheduling: no prices, no discounts, no
  outcomes, no medical advice.
- If the caller no longer wants to book, accept it without pushing.
- Never explain a tool failure in technical terms.

---

## The tools

Both are webhook tools pointing at this backend, authenticated with a bearer
token stored in the ElevenLabs Secrets Manager and referenced by `secret_id`.
The full request/response contract is in [`api.md`](./api.md).

### `check_availability` → `POST /tools/availability`

Returns at most three options, already phrased for speech. Called before any
time is ever mentioned.

| Setting | Value | Why |
|---|---|---|
| `response_timeout_secs` | `20` | Cal.com can be slow; a fallback day search fans out over the next 7 days. |
| `interruption_mode` | `allow` | A read-only lookup, safe to abandon mid-flight. |
| `pre_tool_speech` | `auto` | Covers the lookup with a natural filler. |

The tool description tells the model that a full day is handled *by the tool*,
not by the model: if the requested day is booked out, the backend searches the
following days on its own and says so in `spokenSummary`.

### `book_appointment` → `POST /tools/book`

Creates the booking. Takes an `optionId`, never a date.

| Setting | Value | Why |
|---|---|---|
| `response_timeout_secs` | `25` | Booking writes to Cal.com and Google Calendar. |
| `interruption_mode` | `disable_during_tool` | **The one irreversible action.** Letting a caller interrupt mid-write would leave the agent unsure whether the appointment exists. |
| `pre_tool_speech` | `auto` | Fills the write latency. |

The `email` parameter description asks explicitly for lowercase and no spaces,
because dictated addresses arrive with both.

### `show_booking_summary` → the browser

A **client tool**: it has no URL and never touches the backend. ElevenLabs
forwards the call straight to the page, which draws the chosen time, the name
and the email while the agent reads them back.

```json
{ "type": "client", "name": "show_booking_summary", "expects_response": false }
```

Two reasons it is a client tool rather than another webhook:

*It is the fix for the hardest failure in this flow.* Names and emails dictated
by voice are transcribed wrong often, and hearing an address spelled out is a
poor way to check it. Seeing it written while hearing it spelled is a good one.

*The personal data never leaves the browser it was dictated into.* The public
session endpoint deliberately carries no name or email, so this is how the page
learns them — from the agent, in that same browser, with no round trip. The name
must match the page's `clientTools` key exactly, including case.

`expects_response` is `false`: the agent has nothing to wait for, and pausing
mid-confirmation to hear back from a canvas would only add latency.

---

## Evaluation criteria

`platform_settings.evaluation.criteria` scores every conversation
automatically — these are the assertions that matter for a booking agent:

| Id | Passes when |
|---|---|
| `appointment_booked` | `book_appointment` was called and returned `booked: true`. |
| `confirmed_before_booking` | The agent read back time, name and email, asked for confirmation, and got an explicit yes **before** booking. |
| `did_not_invent_slots` | Every time the agent mentioned came from a `check_availability` response. |

> The exact schema of this block is the one part of the configuration that is
> not publicly documented. If `elevenlabs agents push` rejects it, remove the
> block and push again.

---

## Testing without spending voice minutes

The free plan gives **15 voice minutes per month** and they cannot be topped up.
A conversation runs about 2 minutes, so the entire budget is 6–7 calls. All
prompt iteration happens in text.

```bash
pnpm simulate                    # all six scenarios
pnpm simulate happy-path         # just one
```

| Scenario | What it exercises |
|---|---|
| `happy-path` | Books for tomorrow afternoon, accepts the first option. |
| `no-availability` | Fully booked day; the agent must offer alternatives, not invent them. `check_availability` is mocked here. |
| `changes-mind` | Accepts a time, then asks for another before confirming. |
| `ambiguous-date` | "Next week" — the agent must ask for a concrete date. |
| `backs-out` | Caller backs out; the agent must not push. |
| `double-confirmation` | Confirms twice — must not produce two bookings. |

The harness does not just print transcripts. It asserts that
`book_appointment` was always preceded by an explicit confirmation, that no time
was mentioned that the tool did not return, and that confirming twice does not
yield two different `bookingUid` values. It exits non-zero on failure.

Every scenario except `no-availability` hits the real backend, which is the
only way to demonstrate the idempotency of `double-confirmation`.

> ElevenLabs has marked the Simulate Conversations endpoint as deprecated in
> favour of `/v1/convai/agent-testing`. It still works.

**One thing to confirm on the first run.** The simulation has no browser, so
there is nothing on the other end of `show_booking_summary`. With
`expects_response: false` the agent has nothing to wait for and the call should
simply be recorded in the transcript, but the documentation does not say what
the simulation endpoint does with an unfulfillable client tool. The harness
therefore does not assert that this tool was called — turning an unverified
platform behaviour into a red test would only teach you to ignore it. If the
first run shows the call in the transcript, add `show_booking_summary` to
`mustCall` for the scenarios that book.

---

## What only a real call reveals

Six or seven calls' worth of budget, spent on the things text cannot surface:

| Symptom | Where to fix it |
|---|---|
| Cuts you off while you dictate your name | `turn.turn_eagerness` → `patient` |
| Dead silence while it queries the calendar | `turn.soft_timeout_config.timeout_seconds` → lower |
| The voice does not sound natural in Spanish | `tts.voice_id` → try another voice |
| Misreads dictated numbers or emails | `asr.keywords` and step 7 of the prompt |

---

## Post-call telemetry

`POST /webhooks/post-call` receives every finished conversation, verifies the
HMAC signature, and records transcript, duration, outcome, and whether an
appointment was created.

Whether it booked is decided by reading the actual `book_appointment` result,
not by what the agent said. An agent can claim "quedó agendada" and be wrong.

`GET /webhooks/stats` turns that log into the number that makes the MVP
demonstrable: *"12 conversations, 8 appointments."*
