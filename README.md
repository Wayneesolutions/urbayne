# Campaign Technology Suite

One codebase, two editions: India (`IN`) and Canada (`CA`). See the Engineering Build Guide for the full plan; this repo currently contains **Phase 0: Foundations**.

## What is built (Phase 0)

| Package | What it does |
| --- | --- |
| `packages/regions` | Region configs for IN and CA: languages, providers, approval gate, silence window, calling hours, AI disclosure text, donation rules. Unconfirmed legal values are `null` or flagged in `confirmWithCounsel`. |
| `packages/compliance` | The compliance engine. `checkOutbound()` runs all gates (approval/certificate, DLT template, silence window, calling hours, consent and opt-outs, donation rule, AI disclosure, campaign identification, rate limit, spend). 21 unit tests. |
| `packages/db` | Postgres schema (tenants, users, OTP, memberships, geo areas, contacts, consents, content items, audit log), Row-Level Security per tenant, the one-race-one-client unique index, a minimal migrator, and Drizzle types. |
| `apps/api` | Express API: phone OTP login with JWT, campaign (tenant) creation, content drafting and approval (MCMC certificate in IN, owner approval in CA, disclosure check on scripts, edits reset to draft), contacts with consent capture and data-source guardrails, and a compliance dry-run endpoint. 11 integration tests against real Postgres. |
| `scripts/guardrails.mjs` | CI check that fails the build if any WhatsApp automation dependency is added. |

## Run locally without Docker (Windows friendly)

```bash
pnpm install
pnpm pg:local      # real Postgres on localhost:5433 (user cs / password cs), keep this terminal open
# in a second terminal:
export DATABASE_URL=postgres://cs:cs@localhost:5433/campaign_suite
export TEST_DATABASE_URL=$DATABASE_URL TEST_APP_DATABASE_URL=postgres://cs_app:cs_app@localhost:5433/campaign_suite
pnpm db:migrate && pnpm test
```

Set `APP_DATABASE_URL` in `.env` to the `cs_app` URL on port 5433 as well.

## Run locally (Docker)

```bash
pnpm install
cp .env.example .env            # fill PHONE_ENC_KEY / PHONE_HASH_KEY with: openssl rand -base64 32
pnpm db:up                      # Postgres + Redis via docker compose
pnpm db:migrate
pnpm dev:api                    # http://localhost:4000/health
```

OTP codes print to the API console in development (`OTP_PROVIDER=console`).

## Test

```bash
pnpm guardrails
pnpm typecheck
TEST_DATABASE_URL=postgres://cs:cs@localhost:5432/campaign_suite \
TEST_APP_DATABASE_URL=postgres://cs_app:cs_app@localhost:5432/campaign_suite \
pnpm test
```

## API (Phase 0)

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/auth/otp/request` | anyone |
| POST | `/api/auth/otp/verify` | anyone |
| POST | `/api/auth/refresh` | signed-in |
| GET | `/api/auth/me` | signed-in (lists campaigns) |
| POST | `/api/tenants` | signed-in (becomes owner) |
| GET | `/api/tenants/:tenantId` | member |
| PATCH | `/api/tenants/:tenantId/settings` | owner |
| GET/POST | `/api/t/:tenantId/content` | member / owner, manager |
| PATCH | `/api/t/:tenantId/content/:id` | owner, manager (resets to draft) |
| POST | `/api/t/:tenantId/content/:id/approve` | owner |
| POST | `/api/t/:tenantId/contacts` | owner, manager, coordinator |
| POST | `/api/t/:tenantId/compliance/check` | member |

## Must confirm before any live send

- India calling hours (blocked until set) and final disclosure wording in Punjabi and Hindi.
- Canada calling hours and silence rules per jurisdiction (draft values in `packages/regions/src/ca.ts`).
- Consent text versions, retention period, and the evidence pack format, with counsel.

## Phase 1: sell-first modules (built)

| Area | What it does |
| --- | --- |
| `packages/channels` | Voice and SMS behind one interface. `MockVoice`/`MockSms` simulate calls with realistic, repeatable results. `VapiVoice` (live calls, Twilio number in CA, 140-series number in IN) and `TwilioSms` (CA). **Demo campaigns always get the simulated channels, even if live keys are set**, and live campaigns without provider keys fail closed. |
| Calls module | Create a run from an approved script, pick areas, start. The compliance engine checks the run when it starts and **every single call right before it is placed** (consent, opt-out, hours, silence window). Live progress, survey results by area, "said stop" handling that removes the person from all future calls, callback requests, masked call log with transcripts, pause/resume, and a downloadable evidence pack (content, certificate number, gate results, audit trail). Vapi end-of-call webhook for live runs. |
| Voter page `/v/:slug` | Mobile-first page in Punjabi, Hindi or English: pick your area, hear the plan read aloud, sign up with big picture buttons and spoken consent text, and ask the assistant. Opens from share links. |
| Assistant | Answers only from approved content and names its source; voting dates and booths always go to the official election site; anything else is handed to the team. Optional Claude rephrasing (must cite a source or it hands off). |
| Share links and QR | One link per booth worker or poster, counting opens and sign-ups. "Copy message" gives an approved (in India, MCMC-certified) text plus link for people to paste into WhatsApp **by hand**. Printable QR codes. |
| Dashboard `/admin` | React app: sign-in, overview, content and approvals (certificate entry in India), contacts, calls with the rules check panel, share links, assistant questions. |
| Demo seed | Two demo campaigns: Gurpreet Kaur, Ludhiana West (Punjabi) and Alex Martin, Winnipeg Ward 3 (English), with areas, approved pages, FAQs, survey scripts, 220 fake contacts and share links. |

## Run the demo

```bash
pnpm install
cp .env.example .env          # set PHONE_ENC_KEY, PHONE_HASH_KEY (openssl rand -base64 32), DEV_RETURN_OTP=true
pnpm db:up && pnpm demo       # builds dashboard, migrates, seeds, starts the API on :4000
```

- Dashboard: http://localhost:4000/admin (India demo login `+919999900001`, Canada `+12045550001`; with `DEV_RETURN_OTP=true` the code fills itself in)
- Voter pages: http://localhost:4000/v/demo-ludhiana and http://localhost:4000/v/demo-winnipeg-ward3

Demo flow that sells: open the voter page on a phone, pick an area, press the big listen button, ask the assistant a question and then "where is my booth". Switch to the dashboard, create a call run, show the rules check, start it, and watch the survey fill in by area. Download the evidence pack at the end.

Note: the Canada demo follows real CRTC hours in Winnipeg time, so outside 9:00 to 21:30 on weekdays (10:00 to 18:00 on weekends) its run is blocked. That is the product working, and worth showing.


**Evidence pack (PDF):** `GET /api/t/:tenantId/calls/runs/:runId/evidence.pdf` is a readable, sealed document (campaign, approved script and certificate number, rules check, results, audit trail; Punjabi and Hindi text supported). Every download records a seal (SHA-256 of the data + HMAC with `EVIDENCE_SIGNING_KEY`) that anyone can check at `/api/public/evidence/:sealId`. The seal proves the document came from the system and was not altered; it is not a government certificate or a CA digital signature.
## Redis, queues and running several servers (P0 items 2 and 3)

With `REDIS_URL` set (required when `NODE_ENV=production`), everything that must be shared between servers is:

- **Rate limits**: per-IP limits on OTP request/verify and the public voter endpoints are counted in Redis (atomic INCR + expiry), so spreading requests over servers does not help an abuser. If Redis is briefly down the limiter lets requests through and logs; per-phone OTP limits stay in the database.
- **Sessions**: each login creates a session, and a refresh token only works while its session exists. `POST /api/auth/logout` ends one device, `POST /api/auth/logout-all` ends all of them. (The 15-minute access token simply expires.)
- **Call runs and shift reminders** run as BullMQ jobs (`call-runs`, `reminders`). Starting or resuming a run queues one job per run (a second kick is a no-op). `RUN_WORKERS=true` runs workers inside the API process; in production run dedicated workers with `pnpm worker` and set `RUN_WORKERS=false` on API servers.
- **Row locking**: workers claim each call with `SELECT ... FOR UPDATE SKIP LOCKED` and mark it `in_progress` before the provider is called, so two workers can never dial the same voter. The provider call happens outside any database transaction. A call claimed by a worker that then died (no provider reference after 10 minutes) is closed as `failed` and never re-dialled. Shift reminders use the same locking.

Without `REDIS_URL` (local dev, tests) everything runs in memory in one process, as before.

Local Redis without Docker (Windows): download `Redis-x64-5.0.14.1.zip` from github.com/tporadowski/redis/releases, unzip it into `.local-redis/`, run `pnpm redis:local` (port 6380), then `TEST_REDIS_URL=redis://localhost:6380/15 pnpm test`. BullMQ recommends Redis 6.2 or newer, so use Redis 7 in production (the Windows build is 5.0 and only prints a warning).

## Observability (P0 item 10)

- **Logs**: one JSON line per request (`reqId`, method, path without query string, status, ms, tenant and user ids). Request bodies, tokens, OTP codes, transcripts and phone numbers are never logged (redaction list in `lib/logger.ts`, phone numbers inside messages are masked). Every response carries `X-Request-Id`; send your own to trace a call end to end. `LOG_LEVEL` sets the level.
- **Errors**: set `SENTRY_DSN` to send unexpected errors (5xx, failed queue jobs after their last retry) to Sentry, tagged with region, request id and campaign id. Before sending, request bodies, cookies, auth headers, user info and phone numbers are stripped (`scrubEvent`). Expected errors (401, 404, validation) are logged but not reported. Without a DSN nothing is sent.
- **Readiness**: `GET /ready` returns 200 when the database (and Redis, if configured) answer, 503 otherwise, with no details. Use it for the load balancer; `GET /health` stays a plain liveness check.
- **Provider cost dashboard**: `GET /api/t/:tenantId/costs?days=30` (owner, manager, finance agent) shows one campaign's AI call spend by day and by run and its share of the spending limit. `GET /api/admin/costs?days=30` (Wayne E Solutions staff only) shows spend per campaign and per region across the platform. Costs come from the provider's end-of-call report (see call cost in the finance register).

## Known limits (Phase 1)

- Read-aloud uses the phone's built-in voice in the demo; production should ship pre-recorded Punjabi and Hindi audio.
- The voter page and dashboard load Google Fonts; self-host them for low-data users.
- `VapiVoice` request fields and the webhook payload must be checked against current Vapi docs before the first live call.
- India SMS (DLT provider) adapter is not built yet; India live voice stays blocked until calling hours are confirmed.

## Phase 2: ground game and money (built)

| Area | What it does |
| --- | --- |
| Team (`/admin` → Team) | Add people by mobile number with a role. Only the candidate can add managers and finance agents; coordinators can add workers and polling agents. |
| Booth worker / canvassing app `/w` | Installable phone app in Punjabi, Hindi or English. Shows only the worker's own areas, each household with the last 4 digits of the number, and big result buttons (supporter, undecided, not interested, not home, needs help, wants a sign in Canada). **Works with no signal**: visits are stored on the phone and sent when the signal returns; sending twice never creates duplicates. |
| Area lists and results | Managers create area lists, assign workers, and see progress and the latest answer from each household, by area. |
| Events and volunteers | Sabhas, rallies, vehicles, door-knocks, meetings. **India: rallies, sabhas and vehicles cannot be confirmed until permission is granted and its reference number is recorded.** Volunteer shifts, assignment, and SMS reminders only to volunteers who agreed to texts. A finished event's cost is added to the finance register automatically, once. |
| Lawn signs (Canada) | Requests from canvassers and the office, tonight's delivery route (nearest stop first, then shortened), placed and collected status. |
| Expenditure / campaign finance | Expenses and contributions against the spending limit. India: district rate list, flags anything priced below it, missing bills and quantity × rate mismatches. Canada: per-contributor limit, eligibility confirmation, automatic receipt numbers. Flags stay visible for the agent to resolve. The finance agent (or candidate) signs off a period, which locks it; CSV registers export only for signed-off periods. |

Demo logins (seeded): India worker `+919999900002`, Canada canvasser `+12045550002` on `/w`. All limits, rates and permission numbers in the seed are demo values.

## Known limits (Phase 2)

- Register CSV columns are modelled on the day-to-day register idea; confirm the exact format with your election agent / the City before filing.
- Contribution and spending limits are entered per campaign; the demo values are not official figures.
- Sign route uses straight-line distance; a road-routing service can replace it later.
- India shift-reminder SMS needs the DLT provider adapter (Canada and demo work now).

## Next: Phase 3

Poll day and counting / election night results dashboard, constituent service platform for winners, Redis/BullMQ workers, pre-recorded audio, and production deployment per region.
