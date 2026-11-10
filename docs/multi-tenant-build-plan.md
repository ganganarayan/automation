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
Not covered yet: Drive file ids in bodies (checked by Drive access, not tenant),
approval review links (an unguessable emailed token).

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
Not enforced yet: the users limit (there is no add-user flow besides New tenant).

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
Costs come from run steps (also deleted and remade runs) plus the ledger. Only the image
gate writes to the ledger so far; other paid calls outside a run are not counted yet.
The split uses each tenant's current keys, not the key in use on the day.

Planned:

- A usage ledger written for every paid provider call (OpenAI, Claude, Kling, Runway,
  MiniMax, ElevenLabs, Gemini, transcript), including calls outside an instance.
- A monthly report per tenant, with the markup.
- Per provider: the owner's platform key (metered) or the tenant's own key.

## Phase 5: shared integrations

- Meta capture webhook routed to a tenant by page or IG account id.
- One shared Google OAuth client, the tenant carried in the OAuth state.
- Decide whether the GitHub Clean runner token is the platform's or the tenant's.
- Hardcoded owner content (super admin email, Assess360, Gita links) moved to
  platform settings.
- The same fixes in tracking-bridge.
