# content-engine

All content generation and publishing for two brands — **Gita** (applygitawisdom.com) and **VidaPulse** (vidapulse.io): daily image posters with an email approval + rework loop, a VidaPulse content-refill watchdog, the video pipelines, a dual-provider AI image factory, the full Post-for-Me delivery feedback loop, the two daily reports, and an operations dashboard.

Any WhatsApp need goes through **wa-gateway** (`POST /api/v1/send`); this service never calls Evolution directly.

## Architecture

Layered, following [`../docs/architecture.md`](../docs/architecture.md):

- **settings/** — all env vars validated once and exposed as namespaced groups; tenant overrides via `core/tenantSettings.js`.
- **core/** — logger, errors, external-API retry wrapper, db + migrations, generic job runner, module registry.
- **providers/** — external integrations behind interfaces: mail (SMTP), Google Sheets, Google Drive (storage), LLM + AI image (OpenAI + Gemini), publish (Post for Me), video (JSON2Video), and the wa-gateway client.
- **repositories/** — the only place SQL runs: approvals, delivery log, refill state (+ shared tenants/config, jobs/events).
- **services/** — business logic incl. the approval core, posters, refill, delivery/reports, video pipeline, image factory, dashboard.
- **modules/** — plugin-style features toggled by `MODULE_*_ENABLED`.
- **utils/** — pure logic (caption humanizer, scheduling rules, hook word-wrap, report builders).

## Approval + rework loop

Content is emailed with a signed, single-use link to `GET /api/v1/review/{token}` — a hosted page with **Approve & Publish** and **Rework** (+ required note). State lives in the `approvals` table, so restarts are safe; a Rework re-runs generation and re-emails until approved.

## Endpoints (under `/api/v1`)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /webhook/pfm-result` | public | Post-for-Me delivery results |
| `GET/POST /review/:token` | signed link | Approve / rework a piece of content |
| `GET /dashboard` | public | Operations dashboard |
| `POST /jobs/image-factory` | `X-Admin-Key` | Run the AI image factory |
| `POST /jobs/video`, `/jobs/video-simple` | `X-Admin-Key` | Trigger video pipelines |
| `POST /jobs/refill` | `X-Admin-Key` | Trigger the VidaPulse refill |
| `GET /admin/pfm-accounts` | `X-Admin-Key` | List connected Post-for-Me accounts |
| `GET /admin/{jobs,events,approvals,modules,config}` | `X-Admin-Key` | Operational views |
| `GET /health` · `/ready` · `/live` | public | Health probes |

## Scheduled jobs (IST)

- 22:00 — Gita & VidaPulse image generation (→ approval email)
- 08:30 — Gita delivery report; 09:00 — VidaPulse report (26h staleness) + VidaPulse refill watchdog
- Video pipeline is **off by default** (`MODULE_VIDEO_PIPELINE_ENABLED=false`).

## Data (owned tables)

`pfm_delivery_log`, `approvals`, `refill_state` — plus shared `tenants`/`tenant_config` and this service's own `jobs`/`event_log`. Migrations are additive only.

## Environment variables

See [`.env.example`](./.env.example). **Rotate the Post for Me key before deploy** (the previous key leaked). Highlights: `DATABASE_URL`, `APP_SECRET`, `PUBLIC_BASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `POSTFORME_API_KEY`, `PFM_*_ACCOUNTS`, `PFM_ACCOUNT_MAP`, `GOOGLE_SERVICE_ACCOUNT_JSON`, the `*_SHEET_ID`/`*_FOLDER_ID`/`STRIP_FILE_ID`, `JSON2VIDEO_API_KEY`, `SMTP_*`, `APPROVAL_EMAIL_*`, `REPORT_EMAIL`, `IG_*`, `WA_GATEWAY_URL`, `INTERNAL_API_KEY`, `ADMIN_KEY`, `TZ`, `MODULE_*_ENABLED`.

## Develop

```bash
cp .env.example .env      # set DATABASE_URL at minimum
npm install
npm test                  # humanizer, scheduling, reports, word-wrap, video helpers
npm start                 # runs migrations, then serves on PORT (default 8080)
```

## Deploy (Railway)

Deploy as a service in the `automation` project with **root directory `/content-engine`**. Set `PUBLIC_BASE_URL` to the service's public domain (needed for approval links). Repoint the Post-for-Me result webhook to `…/api/v1/webhook/pfm-result`. Set `WA_GATEWAY_URL` to the private hostname (`http://wa-gateway.railway.internal`). The multi-stage `Dockerfile` runs as non-root with a `/live` health check.
