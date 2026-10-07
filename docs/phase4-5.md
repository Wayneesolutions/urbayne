# Phase 4 and 5: scale, polish and election-year readiness

What this release adds, how to switch it on, and **what is not done**. The roadmap (docs/Campaign_Suite_Status_and_Roadmap.pdf, section 05) lists eleven items in these two phases; the table says where each one stands.

| # | Roadmap item | Status |
| --- | --- | --- |
| 4.1 | Maps with real tiles and road routing for turfs and signs | **Built** (needs a tile provider and a routing server: see below) |
| 4.2 | Household import from electoral roll copies, with source proof | **Built** for Excel/CSV. A PDF roll is stored as proof and its households are typed in (no PDF text extraction) |
| 4.3 | Pre-recorded audio pipeline (Punjabi, Hindi), self-hosted fonts, lighter voter page | **Built** (audio is uploaded, not recorded in the browser; consent text is still read by the phone's voice) |
| 4.4 | Official filing formats for finance registers | **Mechanism built; the official layouts are drafts** until the election agent / the City confirms them |
| 4.5 | Receipt photo upload (in-region storage), bank statement reconciliation | **Built** (S3 bucket per region in Terraform: not applied anywhere) |
| 4.6 | Multi-campaign agency view (white-label) | **Built** |
| 4.7 | French for the Canada edition, Tagalog voter-page content | **Built**; translations need a native-speaker review |
| 5.1 | India: Punjab Vidhan Sabha 2027 package, Punjabi/Hindi pitch deck, MCMC workflow | **Package, checklist and a first-draft deck built** (`docs/pitch`, regenerate with `node build.cjs`; not rendered or reviewed, translations need a native speaker) |
| 5.2 | Canada: Manitoba provincial 2027 package (provincial rules in region config) | **Built**; the legal figures are deliberately blank |
| 5.3 | Mobile app wrapper (Android first) | **Configured, not built** (no Android SDK here) |
| 5.4 | Pricing, metering and invoicing per campaign | **Built**; the actual prices are not set (they are data you enter) |

Also fixed on the way: post-election data deletion failed for any campaign that had door-knock visits (a database rule needed a house or a contact on every visit), and a new `source-map-js` advisory (via vitest) was failing `pnpm audit`.

New migrations: `0014` to `0019`. New settings: see `.env.example` (`STORAGE_DRIVER`, `FILES_*`, `MAP_*`, `ROUTING_BASE_URL`).

---

## 4.1 Maps and road routing

- `/admin` Lawn signs and Booth workers/Door-to-door now draw a real map (Leaflet). Areas appear once they have a position (Booth workers page, "Put an area on the map": a latitude/longitude, or `PATCH /api/t/:id/geo/:areaId` with a GeoJSON `Point` or `Polygon`). Areas are coloured by visit progress.
- **Tiles**: `MAP_TILE_URL` (default OpenStreetMap's public server). **OpenStreetMap's tile policy allows only light use**: for a real campaign use a tile provider (MapTiler, Stadia, Mapbox...) or your own tile server. The dashboard's CSP allows pictures only from that host.
- **Road routing**: set `ROUTING_BASE_URL` to an [OSRM](https://project-osrm.org) server (self-host with the India and Canada extracts; the public demo server is not for production). `GET /api/t/:id/ops/signs/route` then orders the stops by road distance (OSRM `/trip`) and returns the road line, kilometres and minutes. Up to 99 stops. If the server is missing or fails the route falls back to the old straight-line ordering and says so (`routing: "straight_line"`): sign drops never stop because routing is down.
- Not done: routing for canvassing turfs (roll households have no coordinates, only a house number), turn-by-turn navigation.

## 4.2 Household import from roll copies

- `POST /api/t/:id/field/roll-imports/spreadsheet?areaId=&sourceDescription=` with the Excel/CSV file as the body (the dashboard does this on the Booth workers page). `sourceDescription` (at least 10 characters) says who supplied it, when and under what entitlement. The file itself is kept as the proof (`roll_proof`).
- Only **house number, address and number of electors** are kept. Every other column (names, ages, relatives) is dropped and listed back as "ignored". A file with a caste/religion/community column is **refused**, not trimmed.
- One-row-per-elector lists are grouped into households. Re-importing the same list adds nothing.
- PDF rolls: `POST .../roll-proofs` (PDF as body) then `POST .../roll-imports` with the typed-in rows and the `proofFileId`. There is no PDF text extraction: roll PDFs are scanned or use legacy Gurmukhi/Devanagari fonts, and a wrong read is worse than typing.
- Workers see these houses as doors to knock on (no names, no numbers). They are deleted, with the uploaded copies, in the post-election purge.

## 4.3 Recorded voice, fonts, lighter voter page

- **Voice**: for each approved *page*, upload a recording (`PUT /api/t/:id/content/:pageId/audio`, MP3/M4A/OGG/WAV/WebM, 4 MB). The voter page plays it (with HTTP Range, which iPhones need) and falls back to the phone's own voice for any page without one. A recording is tied to the exact text: if the text changes, the recording is **stale** and is not played until replaced. `GET .../content/audio-coverage` lists pages needing a recording; the Content page shows it.
- **Fonts**: served from this server (`/fonts`, Noto Sans for Latin, Gurmukhi and Devanagari, woff2 only, split by script so a phone downloads only what it shows). The voter and resident pages no longer contact Google at all, and their CSP is `default-src 'self'`.
- Not done: recording in the browser (the page's microphone permission is deliberately off), voice for the consent sentence, a measured page-weight number.

## 4.4 Filing formats

`GET /api/t/:id/finance/formats` lists the layouts for the campaign's region (and province). Export with `GET .../finance/export.csv?kind=expense&format=<id>&as=csv|xlsx` (signed-off period only, as before).

The platform layout (`register-*`) is the default and unchanged. The other layouts (India "day-to-day account", Manitoba schedules, the City's schedule) have the right *kind* of columns but **were written without the official forms in front of us**: they are marked `confirmed: false`, the export says "DRAFT LAYOUT" on its first lines, and the dashboard says so. To confirm one: put the official form beside the export, fix `packages/regions/src/filing.ts`, set `confirmed: true`.

## 4.5 Receipts and bank reconciliation

- **Receipts**: `POST /api/t/:id/finance/entries/:entryId/receipt` with the photo/PDF as the body (JPEG, PNG, WebP or PDF, 8 MB). The type is read from the bytes, not the name. Locked (signed-off) periods refuse changes. Replacing a receipt deletes the old one.
- **Storage**: `STORAGE_DRIVER=s3` in production (enforced), `FILES_BUCKET`, and `FILES_REGION` must equal the deployment's own data region (`ap-south-1` for IN, `ca-central-1` for CA): the app refuses to start otherwise. `infra/terraform/modules/region/files.tf` creates the private, encrypted, versioned bucket and the task permissions. **Terraform was written without being run** (`terraform validate`/`plan` first).
- **Bank statements**: upload the bank's CSV (`POST .../finance/bank-statements`). Date formats (day-first in India, month-first in Canada), separate debit/credit or a signed amount, Dr/Cr, brackets, lakh commas and lines above the table are handled. Lines are paired with entries (same direction, same amount to the paisa, within 10 days; a party name in the description breaks ties). `GET .../finance/reconciliation` lists bank lines with no entry and bank-paid entries absent from the statement. Sign-off returns this summary. Cash entries are not expected on a statement.
- Not done: bank-specific formats beyond generic CSV (tested with typical layouts only, no real bank export), PDF statements, automatic feeds.

## 4.6 Agencies (white-label)

- Platform staff create an agency: `POST /api/admin/agencies {name, slug, adminPhone, brandName?, primaryColor?, supportEmail?}`.
- A campaign owner makes a one-time code (`POST /api/t/:id/agency/invite`, shown once, 7 days); the agency admin redeems it (`POST /api/agencies/:id/link`). The owner can switch white-label on and **revoke at any time**.
- The agency overview (`/admin` > your agency) shows **totals only**: contacts, calls, doors, spending against the limit, items awaiting approval, open/overdue requests and what needs attention. Never contacts, numbers, transcripts or ticket text (tested). To work *inside* a campaign, agency staff are added to its team as usual.
- White-label: the campaign's own dashboard shows the agency's brand name, accent colour and support address. One white-label agency per campaign. Not done: the agency's logo image, white-label on evidence PDFs and voter pages, a custom domain.

## 4.7 French and Tagalog

The voter page, the assistant (disclosure, hand-off, official-link texts) and the Canadian AI-disclosure wording now exist in French and Tagalog. **They are working drafts: have a native speaker and counsel review them** (the disclosure texts are in `confirmWithCounsel`). The dashboard and the resident service page are English, Punjabi and Hindi only.

## 5.1 and 5.2 Election packages

`GET /api/packs`; `POST /api/t/:id/pack/apply {packId}` (owner, once). A package creates **draft** pages, FAQs, a first issue survey per language (scripts begin with the region's AI disclosure; India also gets the shift-reminder SMS template), turns on the modules and gives an onboarding checklist (`/admin` > Election checklist). Text in ⟦ ⟧ is a blank the candidate must fill: **such content cannot be approved**.

- `in-punjab-2027`: Punjabi/Hindi/English. Checklist covers MCMC certification, DLT registration, calling hours, spending limit, roll copies, retention, permissions, a pilot booth.
- `ca-mb-2027`: English/French/Punjabi/Tagalog; province `MB`. Manitoba's spending limit, contribution limit and blackout period are **null on purpose** until taken from Elections Manitoba / counsel; the checklist and the finance page say so. Provincial expense categories apply when a campaign has `province: "MB"` (set at creation).
- Not done: the **Punjabi/Hindi pitch deck**; the per-seat list of the 117 constituencies; the real-world MCMC and Elections Manitoba steps themselves (the checklist guides them, it cannot do them). The ECI/Elections Manitoba rules in the checklist are worded from general knowledge: confirm with counsel.

## 5.3 Mobile wrapper

`apps/mobile`: Capacitor config that wraps `/w/` (one app per region). See `apps/mobile/README.md`. Not built or run on a device.

## 5.4 Pricing, metering and invoicing

- **Packages are data**: `PUT /api/admin/plans/:code` (platform staff) defines price, billing style (`per_campaign` or `monthly`), units included, price per extra unit, and hard caps for `smsSent`, `callMinutes`, `assistantQuestions`, `contacts`, `teamMembers`. `PUT /api/admin/tenants/:id/plan` puts a campaign on one (the terms are *copied*, so later edits never change a deal). **No prices are built in: enter them.**
- **Metering** is computed from the campaign's own records (texts sent, call minutes rounded up per call, assistant questions, contacts, team size). `GET /api/t/:id/billing` (owner/manager) shows use against the package and the invoices.
- **Caps** stop the action with a plain message: adding a team member or contact over the cap (HTTP 402), shift reminders over the SMS cap, and a call run **pauses** (calls stay queued) when call minutes reach the cap. Other texts (resident service texts, results texts) are metered and billed but not capped.
- **Invoicing**: `POST /api/admin/invoices/generate {month}` now handles packages: per-campaign packages bill their price once, in the start month, then only units *beyond the included amount that were not billed before*; monthly packages bill pro rata then per month. Optional discount (on the package price) and tax (only if a rate was set: confirm the rate and invoice format with the accountant). The old service-office subscriptions bill exactly as before.
- Not done: payment collection (payments are still marked by hand), tax invoice formats (GST/HST), credit notes.
