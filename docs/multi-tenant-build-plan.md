# Multi-tenant build plan (content-engine)

Written 10-11-2026 from a whole-app review. Goal: one login, many tenants who pay
the owner; the owner pays the providers.

## Done

- 🟢 **Post for Me on the owner's one account** (staging 657a21c, 10-11-2026).
  A tenant with no key uses the owner's key. Accounts belong to a tenant by
  external_id "<tenantId>" or "<tenantId>:x" (utils/pfmScope.js). On the shared key a
  tenant only lists, posts to, reads, takes down or comments on its own accounts.
  One webhook for the shared key. Connect an account button on the funnel account
  picker. The Tenants panel shows successful posts per tenant per month.
  Not tried with a real second tenant yet.

## Root cause behind most gaps

The tenant came from the X-Tenant header or a /t/{id}/ path prefix
(middleware/requestContext.js), never from the signed-in user. Users had no tenant.
keyOk only checks the role. So any admin could act as any tenant.

## Phase 1: lock the doors (🟢 on staging 10-11-2026, not tried with a real second tenant)

Code: middleware/tenantGuard.js, repositories/ownershipRepository.js, migration 023.
Drive file ids (added later): a tenant on the platform's shared service account may
only download, share or rename a file in one of its own funnel folders (utils/driveGuard.js),
and a pasted folder another tenant already uses is refused. A folder of the owner's that
no funnel uses is not caught: give such tenants their own service account or Google sign-in.
Approval review links stay on their unguessable emailed token, by design.

- users.tenant_id (migration 023); a tenant's owner_email moves to that tenant.
- The session sets req.tenantId. Only the super admin (or the machine admin key)
  may ask for another tenant by header, path, ?tenant= or body.tenant; anyone else
  gets 403.
- Super admin only: change role, change plan, read billing. A tenant admin sees only
  its own tenant's users.
- Every funnel, instance, capture rule and lead id in a path, query or body is
  checked against the tenant: 404 when it is another tenant's. The super admin is
  switched to the record's tenant instead.
- Tests for the cross-tenant refusals.

## Phase 2: stop leaks (🟢 on staging 10-11-2026, not tried with a real second tenant)

Kept shared on purpose: the Google service account (it reads only what a tenant
shares with it), model names, the SMTP port. A clean of the same Drive file in
two workspaces at once: the second is told to wait.

- Env fallbacks in core/tenantSettings.js only for the default tenant (Google
  service account, sheets, Drive folders, OpenAI, Gemini, json2video, SMTP, emails,
  links, moduleEnabled).
- Daily router: one run in flight per tenant (routerService.js), not one for all.
- In-memory job maps in readyPostService keyed by tenant and id.
- Crons that only run default (delivery reports, LinkedIn relay, disapprove
  finalize) loop over every active tenant.

## Phase 3: lifecycle (🟢 on staging 10-11-2026, not tried with a real second tenant)

Code: utils/planSpec.js, services/planService.js, migration 024 (tenants.plan,
default custom = no limits). Limits are checked when a funnel is made, when accounts
are ticked, when the router lines up a post or an AI video, and on Schedule/Post.
Users: a workspace admin adds users on the Users panel (one-time password), within the
plan's users limit (POST /admin/users/add).

- Enforce tenant status and expires_at on pages and on scheduled jobs
  (funnels.listActive, the waker's due tenants). An expired tenant gets a read-only page.
- Super admin: New tenant form that creates the tenant, its owner user and an invite
  to set a password.
- Plan limits from the pricing plan (funnels, channels per funnel, posts a month,
  AI videos a month, users).

## Phase 4: billing (🟢 on staging 10-11-2026, not tried with a real second tenant)

Code: migration 025 (usage_ledger), repositories/usageRepository.js, utils/costUsageView.js,
tenantSettings providerKey and keyOwners. Keys: a tenant's own key wins; without one it
uses the owner's key (the platform key, on the owner's bill); an Agency tenant gets no
platform key and must bring its own. Credit balances show only for the tenant's own keys.
The Tenants panel has an "AI cost per tenant" box: on-bill cost for three months, this
month in rupees (88 to the dollar), plan price and margin, own-key spend shown apart.
Costs come from run steps (also deleted and remade runs) plus the ledger. Every paid call
outside a run writes to the ledger (services/usageMeter.js: image gate, Lane 2 research,
sheet refill, image factory, the older video images and funnel poster), with the key owner
at the call. Run costs are split by the tenant's key history (tenant_config key_history,
a new entry each time its key owners change), so old spend stays where it was paid.

Planned:

- A usage ledger written for every paid provider call (OpenAI, Claude, Kling, Runway,
  MiniMax, ElevenLabs, Gemini, transcript), including calls outside an instance.
- A monthly report per tenant, with the markup.
- Per provider: the owner's platform key (metered) or the tenant's own key.

## Phase 5: shared integrations (🟢 on staging 10-11-2026, not tried with a real second tenant)

Code: utils/metaRoute.js, captureConfig.accountOwners, tenantSettings (google, clean, comparison).
- Meta: the owner's app on the plain webhook URL serves every tenant. Each entry goes to
  the live tenant whose account ids or page tokens (Comment capture) claim its Page / IG id;
  an unclaimed id, or one two tenants claim, stays the owner's. A tenant with its own Meta
  app keeps using /t/{id}/... with its own secret.
- Google: a tenant without its own OAuth client id and secret uses the owner's whole set
  (also the picker key and project number). The state ticket already carries the tenant;
  the callback now refuses a ticket for another workspace. The owner's Google consent
  screen must be published (or list the tenant's Google account as a test user).
- Clean: the GitHub runner is the platform's. A tenant without its own token uses the
  owner's token, repo and ref; the job ticket carries the tenant. The wake schedule
  variable stays the owner's only.
- Owner content: the built-in Assess360 comparison list and brand are the owner's only, also
  as form defaults. The super admin email stays in code on purpose: a setting could be
  edited to take over the platform. Gita links were already owner-only (phase 2).

Planned:

- Meta capture webhook routed to a tenant by page or IG account id.
- One shared Google OAuth client, the tenant carried in the OAuth state.
- Decide whether the GitHub Clean runner token is the platform's or the tenant's.
- Hardcoded owner content (super admin email, Assess360, Gita links) moved to
  platform settings.
- The same fixes in tracking-bridge.
