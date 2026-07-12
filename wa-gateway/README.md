# wa-gateway

Single WhatsApp orchestration service. Every customer-facing message flows through one throttled, connection-checked queue against the existing **Evolution API** (instances `gita` and `vidapulse`). This service also owns the Delay Relay lead intake / validation / drip system, the Evolution connection alert, and queue admin.

**wa-gateway is the only service allowed to call Evolution directly.** Other services send WhatsApp by calling `POST /api/v1/send` with the internal key.

## Architecture

Layered, following the platform conventions in [`../docs/architecture.md`](../docs/architecture.md):

- **settings/** — all env vars loaded/validated once (zod) and exposed as namespaced groups; tenant-aware resolution in `core/tenantSettings.js`.
- **core/** — logger, error taxonomy, external-API retry wrapper, db + migration runner, queue service, generic job runner, module registry.
- **providers/** — external integrations behind interfaces: WhatsApp (Evolution), mail (SMTP), Google Sheets.
- **repositories/** — the only place SQL runs; one module per table, tenant-scoped.
- **services/** — business logic (templates, dispatcher, outreach, relay, send).
- **modules/** — plugin-style features that register routes/jobs, each toggled by a `MODULE_*_ENABLED` flag.
- **utils/ · validators/** — pure logic (phone, time, text/bubbles, ramp, contact validation).

## Endpoints

All under `/api/v1`. A `/t/{tenant}` prefix or `X-Tenant` header selects a tenant (default `default`).

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /webhook/crm-wa-relay` | public | CRM event → template lookup → enqueue |
| `POST /send` | `X-Internal-Key` | Internal send used by other services |
| `POST /webhook/gita-wa`, `/webhook/vidapulse-wa` | public | Raw relays (line-break markers) |
| `POST /webhook/gita-form-booking` | public | Calendar-link message |
| `POST /webhook/gita-emo-outreach` | public | Emotional outreach (async job) |
| `POST /webhook/evolution-connection` | public | Connection alert email |
| `POST /webhook/delay-relay-:account` | public | Lead intake (`sthira`/`vidapulse`/`divineleads`) |
| `GET/POST /upload` | public | CSV bulk intake |
| `POST /admin/queue/purge` | `X-Admin-Key` | Delete queued rows |
| `GET /admin/{queue,jobs,events,modules,config}` | `X-Admin-Key` | Operational views |
| `GET /health` · `/ready` · `/live` | public | Health probes |

## Background work

- **Dispatcher** (module `dispatcher`): every `DISPATCHER_TICK_SECONDS`, sends at most one message per instance, within the IST window, enforcing a randomized gap via the `wa_gate` atomic claim, only when Evolution `connectionState === "open"`. Fails a row after `MAX_SEND_ATTEMPTS`.
- **Delay Relay drip** (module `delay-relay`): 06:00 IST cron; ramped daily quota per account, spaced sends within 06:00–22:00 IST, live MX check, forward to each account's `destination_url`, log to a Google Sheet.
- **Job runner**: durable execution of the emotional-outreach sequence.

## Data (owned tables)

`wa_queue`, `wa_gate`, `contact_queue`, `relay_control` — plus the shared `tenants`/`tenant_config` and this service's own `jobs`/`event_log`. Migrations run on boot, are additive only, and never drop or rename columns.

## Environment variables

See [`.env.example`](./.env.example). Highlights: `DATABASE_URL`, `EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY` (**rotate before deploy**), `TEMPLATES_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `CALENDAR_LINK`, `AUDIO_BANDS`, `ALERT_EMAIL`, `SMTP_*`, `INTERNAL_API_KEY`, `ADMIN_KEY`, `GAP_MIN_SECONDS`, `GAP_MAX_SECONDS`, `SEND_WINDOW_START`, `SEND_WINDOW_END`, `TZ=Asia/Kolkata`, `MODULE_*_ENABLED`.

## Develop

```bash
cp .env.example .env      # set DATABASE_URL at minimum
npm install
npm test                  # phone, contact validator, ramp, bubble splitter
npm start                 # runs migrations, then serves on PORT (default 8080)
```

## Deploy (Railway)

Deploy as a service in the `automation` project with **root directory `/wa-gateway`**. Point `EVOLUTION_BASE_URL` at the private hostname (`http://evolution-api.railway.internal`). Configure Evolution to POST `CONNECTION_UPDATE` events to this service's public `/api/v1/webhook/evolution-connection`. The multi-stage `Dockerfile` runs as a non-root user and exposes a container health check on `/live`.
