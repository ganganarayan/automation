# tracking-bridge

Small marketing-data service. It receives Razorpay `payment.captured` webhooks, verifies the HMAC signature, enriches the buyer with Assess360 match data (fbclid/fbp/fbc/ip/ua), and fires a fully-matched **Purchase** event to the Meta Conversions API (with dedup). Separately, a daily cron pulls ad-level Meta insights into a Google Sheet.

Standalone — no dependency on the other two services.

## Architecture

Layered, following [`../docs/architecture.md`](../docs/architecture.md):

- **settings/** — all env vars validated once and exposed as namespaced groups.
- **core/** — logger, errors, external-API retry wrapper, db + migrations, module registry.
- **providers/** — external integrations behind interfaces: mail (SMTP), Google Sheets, Meta Graph (CAPI + insights), Assess360 enrichment.
- **services/** — orchestration (`capiService`, `insightsService`) plus the pure builders.
- **utils/** — pure logic: `signature` (HMAC verify), `hash` (PII hashing).
- **modules/** — plugin-style features toggled by `MODULE_*_ENABLED`.

The pure pieces (`capiBuilder`, `insightsFlatten`, `signature`, `hash`) are dependency-free and unit-tested.

## Endpoints (under `/api/v1`)

| Method & path | Purpose |
|---|---|
| `POST /webhook/razorpay-capi` | Razorpay `payment.captured` → enriched Meta Purchase. Verifies the `x-razorpay-signature` HMAC against the raw body; on mismatch it acks 200 and drops silently. |
| `POST /jobs/insights` | Manual insights pull/backfill |
| `GET /health` · `/ready` · `/live` | Health probes |

## Scheduled jobs (IST)

- 07:00 — pull ad-level insights for the last `LOOKBACK_DAYS` (default 1 = yesterday) and upsert into the sheet keyed on `row_key = "{date_start}|{ad_id}"`, so re-runs are idempotent and raising the lookback backfills.

## Meta CAPI event

`event_name=Purchase`, `event_id=payment_id` (dedup), `currency=INR`, `value=rupees`. Emails and phones from both the payment and Assess360 are SHA-256 hashed into `em[]`/`ph[]`. The `fbc`/`fbp`/`client_ip_address`/`client_user_agent` fields follow preference ladders (enrichment → reconstruction from `fbclid` → notes). Never throws on Meta or enrichment errors.

## Data

Stateless for domain data — dedup is handled by Meta via `event_id`. Owns only the shared `tenants`/`tenant_config` and this service's own `jobs`/`event_log`. Migrations are additive only.

## Environment variables

See [`.env.example`](./.env.example): `DATABASE_URL`, `RAZORPAY_WEBHOOK_SECRET`, `META_PIXEL_ID`, `META_CAPI_TOKEN`, `META_API_VERSION`, `META_TEST_EVENT_CODE`, `EVENT_SOURCE_URL`, `CONTENT_NAME`, `META_AD_ACCOUNT_ID`, `META_ADS_TOKEN`, `INSIGHTS_SHEET_ID`, `LOOKBACK_DAYS`, `ASSESS360_URL`, `ASSESS360_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `ALERT_EMAIL`, `SMTP_*`, `TZ`, `MODULE_*_ENABLED`.

## Develop

```bash
cp .env.example .env      # set DATABASE_URL at minimum
npm install
npm test                  # signature verifier, CAPI builder, insights flattener
npm start                 # runs migrations, then serves on PORT (default 8080)
```

## Deploy (Railway)

Deploy as a service in the `automation` project with **root directory `/tracking-bridge`**. Test with `META_TEST_EVENT_CODE` first, then repoint the Razorpay webhook to `…/api/v1/webhook/razorpay-capi`. The multi-stage `Dockerfile` runs as non-root with a `/live` health check.
