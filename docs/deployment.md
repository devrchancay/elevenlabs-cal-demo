# Deployment

From the repo to a working voice call. Order matters: the agent needs the public
URL of the backend, so Railway comes before ElevenLabs.

---

## 0. Before you start

What you need on hand:

| Value | Where it comes from |
|---|---|
| `CAL_API_KEY` | Cal.com → Settings → Developer → API Keys. Starts with `cal_live_`. |
| `CAL_EVENT_TYPE_ID` | The **numeric** id of the 30-minute event type, not the slug. Visible in the URL while editing it. |
| `TOOLS_SHARED_SECRET` | You generate it: `openssl rand -hex 32` |
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard. Used only by the CLI and the scripts, never by the server. |

Check that Cal.com answers before going further:

```bash
cp .env.example .env      # then fill it in
pnpm install
pnpm smoke:slots          # reads tomorrow's availability, books nothing
pnpm smoke:book -- --yes  # creates ONE real booking; check it in Google Calendar, then cancel it
```

If `smoke:slots` returns nothing, check that the event type has availability
configured and that `CAL_EVENT_TYPE_ID` is the numeric id.

### Exercise the whole stack before deploying

```bash
pnpm compose:up
```

```
backend   http://localhost:3000/health
landing   http://localhost:8080
```

This is the same image Railway will build, so if it does not come up here it
will not come up there. `pnpm compose:down` tears it down.

---

## 1. Backend on Railway

### Create the service

1. Railway: **New Project → Deploy from GitHub repo**, pick this repo.
2. Railway detects the `Dockerfile` and uses it. No build configuration needed.

### Load the variables

Under **Variables**:

```
CAL_API_KEY=cal_live_...
CAL_EVENT_TYPE_ID=123456
BUSINESS_TIMEZONE=America/Guayaquil
APPOINTMENT_DURATION_MINUTES=30
TOOLS_SHARED_SECRET=...
LOG_LEVEL=info
```

Do **not** set `PORT`: Railway injects it, and the server already listens on
`process.env.PORT` and `0.0.0.0`.

`ELEVENLABS_WEBHOOK_SECRET` is added in step 4, once ElevenLabs generates it.

### Generate the domain

**Settings → Networking → Generate Domain**. Note the URL; that is your
`PUBLIC_BASE_URL`.

### Verify

```bash
BASE=https://your-service.up.railway.app
SECRET=the-same-TOOLS_SHARED_SECRET

curl -s $BASE/health
# {"status":"ok","version":"0.1.0","uptime":12}

curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/tools/availability \
  -H 'content-type: application/json' -d '{"date":"2026-09-08"}'
# 401  ← correct: no token, no entry

curl -s -X POST $BASE/tools/availability \
  -H "authorization: Bearer $SECRET" \
  -H 'content-type: application/json' \
  -d '{"date":"2026-09-08","partOfDay":"morning"}' | jq
```

If `/health` does not answer it is almost always a missing variable: check the
logs, the process dies at boot naming exactly which one.

### Persisting the conversation log

The container filesystem is ephemeral, so `data/conversations.json` is lost on
every redeploy. To keep it, mount a volume at `/app/data`
(**Settings → Volumes**) and set
`CONVERSATIONS_LOG_PATH=/app/data/conversations.json`.

---

## 2. Agent on ElevenLabs

### Install the CLI

```bash
brew install elevenlabs/tap/elevenlabs   # or: npm install -g @elevenlabs/cli
elevenlabs auth login
```

### Prepare the configuration

Add to your local `.env`:

```
PUBLIC_BASE_URL=https://your-service.up.railway.app
ELEVENLABS_API_KEY=...
```

Then run:

```bash
pnpm agent:setup
```

This stores `TOOLS_SHARED_SECRET` in the ElevenLabs Secrets Manager and writes
the resulting `secret_id` and the public URL into both tool configs. No JSON is
edited by hand and the secret is never pasted into the dashboard.

### Apply

```bash
cd agent
elevenlabs tools push          # creates the tools, writes their ids into tools.json
cd ..
pnpm agent:link                # copies those ids into the agent's tool_ids
cd agent
elevenlabs agents push         # creates the agent
```

The agent id lands in `agent/agents.json`. Save it as `ELEVENLABS_AGENT_ID` in
your `.env`: the simulation script and the landing page both use it.

> If `agents push` complains about `platform_settings.evaluation.criteria`,
> delete that block and push again. It is the only part of the configuration
> whose exact schema is undocumented; everything else comes from the official
> CLI template.

### Later changes

Edit `agent/agent_configs/appointment_scheduler.json` and run `elevenlabs agents push`.
**Do not** touch the dashboard: anything changed there is lost on the next push.

---

## 3. Test in text before spending voice

The free plan gives 15 voice minutes a month and they cannot be topped up. A
conversation is about 2 minutes, so that is 6 or 7 calls in total. All prompt
iteration happens in text.

```bash
pnpm simulate                    # all six scenarios
pnpm simulate happy-path         # just one
```

The script checks what the eye cannot:

- that `book_appointment` is only ever called after an explicit confirmation
- that the agent never invents times the tool did not return
- that confirming twice does not create two bookings

If something fails, adjust the system prompt and push the agent again. Only once
all six pass is it worth making the first voice call. See
[`agent.md`](./agent.md) for the scenario list.

---

## 4. Post-call webhook

1. ElevenLabs: **Settings → Webhooks → Create Webhook**.
2. URL: `https://your-service.up.railway.app/webhooks/post-call`
3. Copy the secret it gives you (starts with `wsec_`).
4. In Railway, add `ELEVENLABS_WEBHOOK_SECRET=wsec_...` and redeploy.
5. In the agent, link the webhook under
   `platform_settings.workspace_overrides.webhooks.post_call_webhook_id` and
   push again.

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/webhooks/post-call \
  -H 'content-type: application/json' -d '{}'
# 401  ← correct: no valid signature, no entry

curl -s $BASE/webhooks/stats -H "authorization: Bearer $SECRET"
# {"conversations":12,"booked":8,"successful":11,"averageDurationSeconds":118}
```

---

## 5. Landing page with the widget

`web/` is a Vite project with TypeScript and Tailwind v4, configured through
environment variables rather than by editing code:

```bash
cp web/.env.example web/.env
```

```
VITE_ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxx
VITE_BACKEND_URL=https://your-service.up.railway.app
```

Locally:

```bash
pnpm web:dev        # Vite on http://localhost:5173
```

To publish:

```bash
pnpm web:build      # static output in web/dist/
```

`web/dist/` is plain HTML, CSS and JS with no server behind it: upload it to
Netlify, Vercel, Cloudflare Pages or GitHub Pages. If the provider asks for
commands, they are `pnpm install && pnpm web:build` with output directory
`web/dist`. Remember to set both `VITE_*` variables there too — Vite inlines
them at build time, so changing one requires a rebuild.

To point at another agent or a local backend without rebuilding, the page
accepts query-string overrides:

```
https://your-landing/?agent=agent_xxx&backend=http://localhost:3000
```

Two implementation details:

- The current date is fetched from `/agent/context` and handed to the agent as a
  dynamic variable. It is computed server-side on purpose: the visitor's clock
  may be in another timezone, and the agent has to reason about the business
  day. That endpoint carries CORS because the landing lives on another origin,
  and it returns the business timezone too, which the page uses to format slot
  times.
- The ElevenLabs SDK is a ~600 kB WebRTC bundle, so it is reached through a
  dynamic import and warmed up once the page is idle. First paint costs 10 kB of
  JavaScript and the button still responds instantly.
- The page polls `GET /agent/session/:bookingKey` while a conversation is live,
  to draw the offered times and the appointment. Nothing to configure: the key
  is the conversation id the browser already holds.

---

## Rotating the shared secret

1. Generate a new one: `openssl rand -hex 32`
2. Change it in Railway and wait for the redeploy.
3. Delete the old secret in the ElevenLabs Secrets Manager.
4. `pnpm agent:setup && cd agent && elevenlabs tools push`

There is a window of a few seconds where the tools fail. Do it outside business
hours.
