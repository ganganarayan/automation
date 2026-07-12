# Architecture reference

This document describes the shared architecture every service in the `automation` monorepo follows. It is the contract that keeps three independently deployable services looking and behaving consistently.

## 1. Goals

- **Independent services** — each folder (`wa-gateway`, `content-engine`, `tracking-bridge`) is a self-contained Node.js 20 application with its own dependencies, Dockerfile, tests, and deploy lifecycle. There is deliberately no shared package.
- **Consistent conventions** — the layering, configuration/settings model, logging, error handling, and testing approach are identical across services.
- **Commercial modularity** — services can be sold, licensed, and scaled separately, and new services (CRM, Assessment, Analytics, Billing, Scheduler, AI Engine, Notification Center) can be added later using the same conventions without modifying existing services.

## 2. Layers

Each service separates concerns into these responsibilities (folder names may vary slightly where it improves clarity, but the separation is always present):

| Layer | Responsibility |
|---|---|
| **API** | HTTP surface. Routers + thin controllers under `/api/v1`. Parse/validate input, call a service, format the response. No business logic. |
| **Services (business logic)** | Orchestration and domain rules. Never executes SQL, never calls external APIs directly — depends on repositories and providers. |
| **Repositories (data access)** | The only place SQL runs. One repository per table, tenant-scoped. |
| **Providers (external integrations)** | Interface + implementation per external system (LLM, mail, storage, WhatsApp, payment, AI image, sheets, publish, video). Business logic depends on the interface. |
| **Settings/config** | Single validated load of environment variables, exported as namespaced settings objects; tenant-aware resolution. Nothing else reads `process.env`. |
| **Middleware** | Request correlation id, request logging, tenant resolution, auth guards, raw-body capture, error handling. |
| **Core/infra** | Cross-cutting building blocks: db pool + migration runner, external-API retry wrapper, queue service, generic job runner, event log, module registry, logger, error classes. |
| **Utils / validators** | Pure helpers and input schemas. |

## 3. Cross-cutting building blocks

Every service implements these (duplicated per service on purpose):

- **Settings layer** — environment variables are loaded and validated once, then exposed as namespaced settings (e.g. `settings.database`, `settings.evolution`, `settings.smtp`). A tenant-aware resolver overlays per-tenant values from `tenant_config` on top of the environment defaults so per-brand configuration can move into the database later without code changes.
- **Structured logging** — JSON logs with a per-request correlation id. Every entry carries: timestamp, request id, tenant id, service, module/endpoint, duration, status, and error (when applicable).
- **Error taxonomy** — dedicated error classes (validation, authentication, external-API, retryable, permanent, not-found). A central error handler maps them to HTTP status codes and structured logs. Business code never throws bare `Error`.
- **External-API retry wrapper** — the single path to every external system. Exponential backoff, retryable-status detection, timeout, and structured logging. No module calls `fetch` against a third party directly.
- **Repository layer** — tenant-scoped data access; business logic never writes SQL.
- **Queue service** — `enqueue`, `dequeue`, `retry`, `purge`, `delay` over the underlying store, so the backing queue could later change (Redis, SQS, RabbitMQ) without touching business logic.
- **Managed jobs** — a generic `jobs` table (id, tenant, type, payload, status, attempts, timestamps, next run, error) drives asynchronous work. No per-module bespoke retry loops.
- **Event log** — a generic `event_log` records important business events for debugging, replay, auditing, and future analytics.
- **Health endpoints** — `/health` (basic), `/ready` (DB + dependency checks), `/live` (process alive).
- **Provider interfaces** — code depends on interfaces, not implementations.
- **Plugin-style modules** — each feature registers its routes and jobs and is independently toggled via a settings flag. A disabled module wires nothing.

## 4. Tenancy

- A `tenants` table seeded with a single `default` row and a `tenant_config(tenant_id, key, value)` table are shared across services.
- Every business table carries `tenant_id` (default `default`).
- Requests resolve a tenant from a `/t/{tenant}` path prefix or an `X-Tenant` header, defaulting to `default`.
- Per-brand/per-customer values that ship today as environment variables are also resolvable from `tenant_config`, with the environment acting as the default-tenant fallback. This is what makes the platform SaaS-ready without a future migration.
- No authentication, signup, billing, or customer dashboards yet.

## 5. Data & migrations

- One shared Postgres; each service owns a disjoint set of tables (plus its own `jobs`/`event_log`).
- Migrations run on boot, are idempotent, and are **additive only** — never automatically drop or rename a column. Use `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.

## 6. Coding standards

- Prefer composition over inheritance; keep functions small and focused.
- Separate orchestration from business logic; keep modules loosely coupled and highly cohesive.
- Use dependency injection where it improves testability.
- Favor readability over cleverness; avoid abstractions used only once.
- Follow SOLID where practical, without unnecessary complexity.
- Document every public module/class with its purpose, responsibility, and dependencies.
- Implement features completely — no TODOs, placeholders, or stubbed business logic.

## 7. Testing

- Unit tests for pure logic, integration tests where appropriate, deterministic fixtures, and mocked external APIs.
- Each service's README lists the specific pieces under test.

## 8. Docker & deployment

- Node 20, multi-stage build, Alpine base, non-root runtime user, container health check, production-only final image.
- Deployed as three services in one Railway project. See the root `README.md` for the project layout, variable placement, public/private routing, cutover order, and required security rotations.
