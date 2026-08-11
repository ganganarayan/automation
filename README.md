# automation

A commercial, multi-product automation platform. Three independent Node.js services deployed as separate services inside a **single Railway project**, sharing one Postgres database and one internal HTTP contract. Each service is independently deployable, testable, versionable, and sellable.

| Service | Role |
|---|---|
> **Note:** WhatsApp is handled externally (official WhatsApp Cloud API from the CRM); the former `wa-gateway` service has been removed.

| [`content-engine`](./content-engine) | All content generation & publishing for two brands (Gita, VidaPulse): daily image posters with an email approval + rework loop, content refill watchdog, video pipelines, dual-provider AI image factory, delivery feedback loop, daily reports, and an operations dashboard. |
| [`tracking-bridge`](./tracking-bridge) | Marketing-data service. Razorpay `payment.captured` → enriched Meta Conversions API purchase events, plus a daily Meta ad-insights pull into a Google Sheet. Standalone. |

An existing **Evolution API** service (WhatsApp gateway) and a **Postgres** plugin complete the project. Nothing here changes Evolution.

## Design philosophy

This repository is intended to grow into a hosted SaaS. Treat it as production software maintained for years by multiple developers; optimize for long-term maintainability.

- **Independent services.** No shared "common" package or workspace tooling. Some infrastructure duplication across services is intentional — it keeps each service self-contained and separately deployable/sellable. Shared libraries are extracted only when duplication becomes a demonstrated maintenance problem.
- **Consistent conventions.** Every service uses the same layered architecture (API → business logic → data-access → external integrations), the same configuration/settings layer, structured JSON logging with request correlation IDs, a standard error taxonomy, one external-API retry wrapper, a repository data-access layer, a queue abstraction, a generic managed-jobs model, an event log, provider interfaces, and plugin-style feature registration. A developer moves between services with no relearning.
- **Versioned APIs.** Every production endpoint is under `/api/v1`. Internal APIs are designed with future versioning in mind.
- **Tenant-ready from day one.** Every business table carries a `tenant_id` (default `default`); per-brand configuration is resolvable from a `tenant_config` table with environment variables as the default-tenant fallback. No customer auth/billing yet — single operator today, multi-tenant SaaS later without a schema migration.

## Shared Postgres

All three services connect to the same `DATABASE_URL`. Each runs its own **additive, idempotent** migrations on boot and owns a **disjoint** set of tables, so there is no schema contention. Only `tenants` and `tenant_config` are shared (created if absent by whichever service boots first, safe to race). Migrations never delete or rename columns automatically.

| Table(s) | Owner |
|---|---|
| `tenants`, `tenant_config` | shared (any service) |
| `pfm_delivery_log`, `approvals`, `refill_state` | content-engine |
| (stateless domain data; dedup via Meta `event_id`) | tracking-bridge |
| `jobs`, `event_log` | each service owns its own |

## Railway: one project, three services

Deploy all three as services in **one** Railway project (`automation`) with per-service root directories, plus the Postgres plugin and the existing Evolution service. Private networking (`*.railway.internal`) only works **within** one project — this is the main reason to consolidate.

```
Railway Project: automation
├── content-engine    (root dir /content-engine) public webhooks + approval/dashboard pages
├── tracking-bridge   (root dir /tracking-bridge) public webhook + daily cron
├── postgres          (Railway Postgres plugin — shared DB)
└── evolution-api     (existing service — WhatsApp)
```

### Variable placement

| Scope | Variables |
|---|---|
| **Project (shared)** | `DATABASE_URL`, `TZ=Asia/Kolkata`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SMTP_*`, `INTERNAL_API_KEY` |
| **content-engine only** | `POSTFORME_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `JSON2VIDEO_API_KEY`, account/sheet/folder ids, approval/report emails, `WA_GATEWAY_URL`, `PUBLIC_BASE_URL`, `APP_SECRET` |
| **tracking-bridge only** | `RAZORPAY_WEBHOOK_SECRET`, Meta pixel/CAPI/ads tokens, ad account id, insights sheet id, Assess360 url/token |

### Public vs private traffic

| Traffic | Route |
|---|---|
| CRM, Assess360, Google Forms, Razorpay, Post for Me, Evolution webhooks | Public Railway domains |
| wa-gateway → Evolution API | Private (`http://evolution-api.railway.internal`) |
| content-engine → wa-gateway internal send | Private (`http://wa-gateway.railway.internal/api/v1/send`) |
| All services → Postgres | Private (`DATABASE_URL`) |

## Setup & cutover order

Lowest-risk first; each legacy workflow stays on until its replacement is verified.

1. Provision the Railway project and Postgres plugin. Export existing data from the legacy data tables (hold/send queues, gate, contact queue, relay control, delivery log) and import into the new schema. **Dump the relay-control table especially** — it holds per-account destination URLs stored nowhere else.
2. Create a Google Cloud service account; share the content sheets, template sheet, and Drive folders with it. **Rotate the Post for Me key and the Evolution key** (see below).
3. Deploy **tracking-bridge** (simplest, isolated). Test with a Meta test event code, then repoint the Razorpay webhook. Disable the legacy CAPI workflows.
4. Deploy **wa-gateway**. Point one low-traffic webhook first (form booking), verify sends + throttling, then repoint the CRM relay, the raw relays, emotional outreach, and the Evolution connection webhook. Disable the legacy WhatsApp/relay workflows.
5. Deploy **content-engine**. Run one full Gita and one VidaPulse approval cycle in parallel, repoint the Post for Me result webhook, then disable the legacy content workflows.
6. Watch the daily reports for a week, then cancel the legacy subscription.

## Security rotations (do during migration)

- **Rotate the Post for Me API key** — the previous key leaked in plain text inside a legacy workflow. Set the new key only as a Railway service variable on content-engine.
- **Rotate the Evolution API key** that was hardcoded in several legacy workflows. Set it only as a service variable on wa-gateway.
- Move all remaining secrets (Razorpay webhook secret, Meta CAPI token, pixel ids, Sheet/Drive ids) to environment variables. No secret is ever hardcoded.
- Use a Google Cloud **service account** for Sheets/Drive/SMTP so nothing depends on expiring personal OAuth tokens.

## Local development

Each service is standalone:

```bash
cd wa-gateway        # or content-engine / tracking-bridge
cp .env.example .env # fill in values; point DATABASE_URL at a local Postgres
npm install
npm test
npm start            # runs migrations on boot, then serves
```

See `docs/architecture.md` for the full architecture reference and each service's README for its endpoints and environment variables.
