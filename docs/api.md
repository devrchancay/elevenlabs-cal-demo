# HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Railway health check |
| `GET` | `/agent/context` | — | Current date and time in the business timezone |
| `GET` | `/agent/session/:bookingKey` | — | Live booking state, for the landing page |
| `POST` | `/tools/availability` | Bearer | Webhook tool: look up open times |
| `POST` | `/tools/book` | Bearer | Webhook tool: create the booking |
| `POST` | `/webhooks/post-call` | HMAC signature | Conversation log |
| `GET` | `/webhooks/stats` | Bearer | Aggregate counters |

Bearer auth covers everything under `/tools/` plus `/webhooks/stats`. Both
`Authorization: Bearer <token>` and a bare token are accepted, because the
ElevenLabs Secrets Manager replaces the entire header value. Rate limiting is
per IP, with `/health` exempt.

---

## `GET /health`

```json
{ "status": "ok", "version": "0.1.0", "uptime": 12 }
```

Touches neither the network nor Cal.com. If Cal.com is down the service is still
alive and should keep reporting as such.

---

## `GET /agent/context`

```json
{
  "timeZone": "America/Guayaquil",
  "today": "2026-09-04",
  "currentDateTime": "viernes 4 de septiembre de 2026 (2026-09-04), 10:00 hora de America/Guayaquil"
}
```

Sent `cache-control: no-store` — a stale response would make the agent believe
it is yesterday. Sends permissive CORS because the landing page is served from a
different origin. It exposes nothing beyond the clock.

---

## `GET /agent/session/:bookingKey`

What the landing page renders while the caller is talking: the times the agent
just offered, and the appointment once it exists.

```json
{
  "options": [
    {
      "id": "opt_1",
      "spokenLabel": "el martes 8 de septiembre a las nueve de la mañana",
      "startsAt": "2026-09-08T09:00:00-05:00"
    }
  ],
  "searchedDate": "2026-09-08",
  "isAlternativeDate": false,
  "booking": null,
  "revision": 3
}
```

Once booked, `booking` carries `{ optionId, spokenLabel, startsAt, status, bookingUid }`,
where `status` is `booked` or `pending`.

`revision` increments on every write, so the page can decide whether to
re-render by comparing one integer.

An unknown key answers `200` with an empty state, not `404`: the page starts
polling before the agent has looked anything up, and that is the normal first
answer. A key that does not match the `bookingKey` format is a `400`.

**Why it is public.** The key is the ElevenLabs conversation id, an opaque value
only the browser in that conversation holds. The alternative — putting the
shared tool secret into a static page — would be strictly worse: that secret is
the one thing standing between the internet and a real calendar.

**Why that is safe.** The payload carries no personal data on any path: no name,
no email, no `spokenConfirmation` (which quotes both). Someone who guessed a
conversation id would learn three appointment times. The caller's own name and
email reach the page through `show_booking_summary`, a client tool the agent
runs in that same browser, so they never make the round trip. A test asserts
this directly.

Sent `no-store` and permissive CORS, for the same reasons as `/agent/context`.

---

## `POST /tools/availability`

**Request**

```json
{ "date": "2026-09-08", "partOfDay": "morning", "bookingKey": "conv_abc" }
```

| Field | Required | Notes |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`. `"hoy"` and `"mañana"` are also tolerated, in case the model invents them. |
| `partOfDay` | no | `morning` \| `afternoon` \| `any`. Anything unrecognised falls back to `any` instead of failing. |
| `bookingKey` | no | The conversation id. Scopes the returned options so two simultaneous calls do not collide on the same `opt_1`. |

**Response**

```json
{
  "options": [
    {
      "id": "opt_1",
      "spokenLabel": "el martes 8 de septiembre a las nueve de la mañana",
      "startsAt": "2026-09-08T09:00:00-05:00"
    }
  ],
  "found": true,
  "searchedDate": "2026-09-08",
  "isAlternativeDate": false,
  "spokenSummary": "Para el martes 8 de septiembre tengo … ¿Cuál te sirve?"
}
```

If the requested part of day is full, the rest of the day is searched. If the
whole day is full, the following 7 days are searched **in parallel** and
`spokenSummary` says so, with `isAlternativeDate: true`. Sequentially that would
be up to 7 chained round-trips to Cal.com, and that silence is audible.

The agent never receives a bare "nothing available" with no way forward.

---

## `POST /tools/book`

**Request**

```json
{
  "optionId": "opt_1",
  "name": "Ana Pérez",
  "email": "ana@gmail.com",
  "bookingKey": "conv_abc"
}
```

`bookingKey` is **required** here: it is the idempotency key. A second call with
the same key returns the existing booking with `duplicate: true` rather than
creating another one.

**Response**

```json
{
  "booked": true,
  "bookingUid": "rW8kZ3qP2mNvY7bLxT4dCe",
  "spokenConfirmation": "Listo, tu cita quedó agendada para … Te acabo de enviar la confirmación a …"
}
```

**On failure** the status is still `200`:

```json
{
  "booked": false,
  "reason": "slot_taken",
  "spokenConfirmation": "Ese horario se acaba de ocupar. ¿Buscamos otro?"
}
```

| `reason` | Meaning |
|---|---|
| `option_expired` | The `optionId` is no longer in the store (15-minute TTL). |
| `slot_taken` | Someone else booked that time first. |
| `invalid_input` | The payload did not validate. |
| `cal_error` | Cal.com failed or was unreachable. |

A `5xx` here would leave the LLM improvising mid-call, so errors are always
delivered as a readable sentence the agent can speak.

---

## `POST /webhooks/post-call`

Verified by HMAC-SHA256 over `${timestamp}.${raw body}`, with a 30-minute replay
window. No valid signature: `401`.

Fastify keeps the raw body deliberately — re-serialising the JSON changes the
bytes and the signature stops matching.

ElevenLabs retries with a byte-identical body, so events are de-duplicated by
conversation id plus event timestamp. An **unexpected payload answers `200`**,
not an error: after 10 consecutive failures ElevenLabs disables the webhook.

---

## `GET /webhooks/stats`

```json
{ "conversations": 12, "booked": 8, "successful": 11, "averageDurationSeconds": 118 }
```

Same bearer as the tools.
