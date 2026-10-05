# Vapi setup and go-live check

What the platform expects from your Vapi account, what it sends on every call, and how to prove it works with one real call.

## Status: what is verified and what is not

| Item | Status |
| --- | --- |
| `POST /call` fields (`phoneNumberId`, `assistantId`, `customer.number`, `assistantOverrides.{firstMessage, variableValues, metadata, server, artifactPlan, analysisPlan}`) | Checked against Vapi's public docs |
| `analysisPlan.structuredDataPlan.{structuredDataPrompt, structuredDataSchema}` and result at `analysis.structuredData` | Checked against the docs |
| `endedReason` values and how they map to answered / not answered / failed | Checked against the docs (list in `modules/calls/vapi-report.ts`) |
| `DELETE /call/{id}` (used for retention) | Checked against the docs |
| `artifactPlan.recordingEnabled` to switch recording off | Checked for assistants; accepted per call in `assistantOverrides` is **not** confirmed by a real call |
| Webhook secret header (`X-Vapi-Secret`) and `assistantOverrides.server.secret` | **Not confirmed**: Vapi's server-authentication page could not be read. Confirm with the verify script |
| A real end-of-call report from a real call | **Not tested.** Run `pnpm --filter @cs/api vapi:verify --call +<your number>` |

So: the code matches the documentation, but no real call has been placed from it. Do the check below before any live campaign.

## 1. Assistant in the Vapi dashboard (one per region)

Create one assistant and put its id in `VAPI_ASSISTANT_ID`. The platform overrides the first message and passes variables per call, so the assistant needs:

- **System prompt** that uses the two variables the platform fills in:
  - `{{survey}}`: the approved survey questions with their keypad digits, one per line
  - `{{locale}}`: `pa`, `hi` or `en`

  Suggested prompt body (adapt the tone, keep the rules):

  ```
  You are an AI assistant making a short call for a political campaign. You already told the person you are an AI.
  Speak {{locale}}. Be brief and polite. Ask these questions one at a time. Accept an answer by voice or by keypad:
  {{survey}}
  If the person says stop, band karo, do not call, or similar, say you will not call again, and end the call.
  Never ask for money. Never discuss voting dates or booths: tell them to check the official election website.
  Never guess an answer.
  ```
- **Keypad input** enabled (`keypadInputPlan`), so people can press 1 / 2 / 3.
- **Recording** off (the platform also switches it off per call).
- **Model and voice** that support Punjabi / Hindi / English as needed (test each language you will use).

## 2. What the platform sends on every call

- `phoneNumberId`, `assistantId`, `customer.number`
- `assistantOverrides.firstMessage` = the approved script (it starts with the AI disclosure)
- `assistantOverrides.variableValues` = `{ locale, survey }`
- `assistantOverrides.metadata` = `{ tenantId, interactionId, runId }` (this is how the report is matched to our call record)
- `assistantOverrides.server` = `{ url: <PUBLIC_BASE_URL>/webhooks/vapi, secret: <VAPI_WEBHOOK_SECRET> }`
- `assistantOverrides.artifactPlan.recordingEnabled` = `false` unless `VAPI_RECORDING=true`
- `assistantOverrides.analysisPlan.structuredDataPlan`: a JSON schema built from the survey, so Vapi extracts
  `{ "answers": { "<question key>": "<one of the option values>" }, "optOut": true|false }`

## 3. What the platform does with the end-of-call report

- Matches the call by metadata; ignores anything else; a repeated report changes nothing.
- Status from `endedReason`: not answered (`customer-did-not-answer`, `customer-busy`, `voicemail`, `silence-timed-out`, ...), completed (`customer-ended-call`, `assistant-ended-call`, ...), failed (start errors, limits, provider errors, unknown reasons). Failed calls show up in the run instead of looking like unanswered phones.
- Keeps only answers that match the survey that was asked (known question, one of its option values).
- "Said stop" removes the person from every future call at once.
- Cost: taken from the report; if it is missing or 0 (Vapi may not have finalised billing), a job asks `GET /call/{id}` again after a minute, with retries, and then charges it to the campaign's spending register.
- When a campaign's personal data is deleted after the election, each call is also deleted at Vapi (`DELETE /call/{id}`); failures are retried with `POST /api/t/:tenantId/privacy/provider-data`.

## 4. Configuration

```
VAPI_API_KEY=            # private key
VAPI_PHONE_NUMBER_ID=    # Twilio number (CA) / 140-series number (IN) imported into Vapi
VAPI_ASSISTANT_ID=
VAPI_WEBHOOK_SECRET=     # at least 16 characters: openssl rand -hex 24
VAPI_RECORDING=false
PUBLIC_BASE_URL=https://<this region's public address>   # Vapi must be able to reach /webhooks/vapi
```

## 5. Go-live check (about 5 minutes, one real call to your own phone)

```bash
VAPI_API_KEY=... VAPI_PHONE_NUMBER_ID=... VAPI_ASSISTANT_ID=... \
PUBLIC_BASE_URL=https://... VAPI_WEBHOOK_SECRET=... \
pnpm --filter @cs/api vapi:verify --call +91XXXXXXXXXX
```

It reads your phone number and assistant, warns about anything missing (no `{{survey}}` in the prompt, keypad off, recording on), places one test call with a two-question survey, waits for it to end, and prints how the platform would record it: status, answers, cost, whether a recording exists. It then deletes the test call at Vapi (which also proves retention deletion works with your key). Answer one question by keypad and one by voice, then say "stop" on a second run.

Things it cannot prove for you: calling-hours rules and the AI-disclosure wording per language (legal sign-off), and your telecom provider's rules for automated calls in India (the 140 series) and Canada (CRTC).
