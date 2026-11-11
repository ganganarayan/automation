# Agency build plan (content-engine)

Written 11-11-2026. Phases 1 and 2 built on staging 11-11-2026, not tried with a real agency yet.

Goal: an Agency account runs up to 10 clients. Each client is its own workspace
with its own logins, social accounts, Drive, schedule and digest. The agency
works in every client from one sign-in; a client signs in and sees only its own
workspace.

## Decisions (owner, 11-11-2026)

- **10 clients per Agency account.** No cap on posting channels per client: a
  client connects as many channels as it has.
- **Clients get their own login.**
- **No white label.** Every page carries our brand ("<name> - the content
  engine"). No agency logo or colours.
- Product name: open (see the end of this file).

## Before this build

- An Agency is one tenant with 10 funnels, 10 users and its own AI keys
  (utils/planSpec.js). A client would be a funnel.
- A user belongs to one tenant (users.tenant_id, migration 023). No access per
  funnel: every agency user sees every client.
- Drive, the digest email, the Daily time, keys and the Post for Me accounts
  (one external_id) are per tenant, so all clients would share them.
- No client sign-in, no switcher, no per-client cost report (the landing page
  promises a cost log per funnel; it does not exist as a report).

## Approach: a client is a child workspace

Each client is a tenant whose parent is the agency's tenant. Everything that
already keeps tenants apart then keeps clients apart with no new isolation code:
tenantGuard, ownershipRepository, driveGuard, pfmScope (external_id
"<clientTenantId>"), per-tenant settings, the daily router lock and the
Cloudflare waker. The new work is who may enter which workspace, what a child
inherits from its parent, and the agency's own screens.

Rejected: clients as funnels inside one tenant. It needs a second isolation
layer (per-funnel access, accounts, Drive, digest) beside the tenant one, and
every QA leak check written twice.

## Phase 1: parent and child, members, switcher (🟢 on staging 11-11-2026)

Code: migration 026, tenantRepository, accessService, middleware/tenantGuard.js,
utils/adminNav.js.

- tenants.parent_id (null = top level) and tenants.kind: standalone, agency,
  client. A client's parent must be an agency; no grandchildren.
- tenant_members (email, tenant_id, role, added_at). One person may belong to
  many workspaces. users.tenant_id stays as the home workspace; migration fills
  tenant_members from it, so nothing changes for current users.
- auth_sessions.active_tenant_id: the workspace this browser works in.
- decide() in tenantGuard: a signed-in person may work in a workspace they are a
  member of, or in any child of an agency where they are an agency admin.
  Anything else stays 403. The super admin is unchanged.
- Workspace switcher at the top of the nav for anyone with more than one
  workspace. Switching rewrites active_tenant_id and reloads the page.
- Tests: decide() table for member, agency admin on own child, agency admin on
  another agency's child (refused), client on a sibling (refused).
- Built: tenants.kind was dropped; a client is a tenant with parent_id, an agency
  a top-level tenant on the Agency plan. The switcher is the only way in: a
  header, ?tenant= or body.tenant for another workspace is still 403, and a
  record of another workspace is still 404 (switch first). Until phase 3, the
  super admin makes a client from Tenants, New tenant, "Client of ...".

## Phase 2: keys, limits, expiry (🟢 on staging 11-11-2026)

Code: core/tenantSettings.js (providerKey, postformeFor), utils/planSpec.js,
services/planService.js.

- **Keys:** a client uses its own key if it has one, else its agency's key.
  Never the owner's key (a client of an agency counts as BYO_PLANS). A client
  user never sees the agency's key values, only "using the agency's key".
- **Post for Me:** a client on the agency's own Post for Me key, or on the shared
  owner key, posts under external_id "<clientTenantId>", so it lists and posts
  only to its own accounts.
- **Limits** (planSpec agency: clients 10, channels no cap, funnels per client no
  cap, users 10 agency staff plus client logins, posts 300 a month): posts and
  AI videos are counted across the agency and all its clients, per IST month.
  An 11th client is refused with the usual plan message.
- **Expiry:** liveGate reads the parent. An expired or suspended agency makes its
  clients look-only too, and the waker skips them.
- Built: an agency on its own Post for Me key with clients on it no longer
  owns its clients' accounts; a client's webhook events go to its agency's
  webhook. A client cannot change plan; an agency with clients cannot leave the
  Agency plan.
- 🟡 **Cost to watch:** with no channel cap, 300 posts on 15 channels each is
  4,500 Post for Me posts on your key, above its $10 plan's 1,000 a month. Either the agency brings its own Post for
  Me key (already supported, "off your bill"), or the posts cap stays the
  brake. Decide before selling; see docs/pricing-plan.md.

## Phase 3: agency dashboard and Add client

Code: new modules/agencyPages.js, services/agencyService.js.

- Agency home: one row per client with today's posts, pending approvals,
  failures in the last 24 hours, posts used this month and cost this month.
  Click a row to switch into that client.
- **Add client:** name, id, the client owner's email, Daily time. Creates the
  child tenant and copies a template: the agency's chosen funnel settings,
  system prompts, CTA, music box. Accounts, Drive folders and leads are never
  copied.
- **Archive client:** the workspace becomes look-only and drops out of the
  waker and the count of 10.
- Staff assignment: an agency staff member is given a list of clients; they see
  only those in the switcher and on the dashboard.

## Phase 4: client logins and connecting accounts

Code: modules/auth.js, utils/authPages.js, accessService, takeDownService and
publishProvider (connect links), the Gmail API mail path.

Roles in tenant_members:

| Role | Where | Can |
|---|---|---|
| agency_admin | agency | everything in every client, add and archive clients, keys, plan |
| agency_staff | agency | work in the clients assigned to them; no keys, no plan |
| client_owner | client | approve, disapprove and remake, connect accounts, set CTA and Daily time, invite client viewers, see their own Log and cost |
| client_viewer | client | look only: Library, Log, digest |

- **Invite:** the agency adds the client owner's email; an invite email (Gmail
  API, as the digest) carries a one-time code to set a password, the same as
  today's first sign-in.
- **Connect link without a password:** the agency sends the client a link to a
  page that lists the channels and opens each platform's connect flow with the
  client's own external_id. The client signs in to Instagram, YouTube and the
  rest on the platform itself; nobody shares a password.
- A client never sees: the agency's keys, the plan or billing page, the
  Tenants panel, other clients, or the switcher.

## Phase 5: reports, digests, leaving

- **Cost per client:** Log and cost in each client, plus an agency CSV export:
  one row per post with client, funnel, date (DD-MM-YYYY HH:MM IST), channels and
  cost, so the agency can bill its clients. This is the promised cost log.
- **Digest:** each client's daily digest goes to its client owner; the agency
  gets one roll-up email of all clients after 20:00 IST.
- **Detach a client:** the client becomes a standalone tenant on its own plan,
  keeping its accounts, funnels and history; it stops using the agency's keys.
- **Delete a client:** the existing delete path, with the cost kept in the log.

## QA (phase 6 of the QA check)

Add to the Tenants panel QA, using qa-agency with two children (qa-agency-a,
qa-agency-b) and a second agency (qa-agency-2):

- An agency admin of qa-agency is refused in qa-agency-2's clients.
- A client owner of qa-agency-a is refused in qa-agency-b, by session, header,
  ?tenant=, body.tenant and record ids.
- Each client lists only Post for Me accounts with its own external_id.
- A client resolves its keys to its own or the agency's, never the owner's.
- An expired agency makes its clients look-only.
- An 11th client is refused; posts are counted across all clients.
- A client page never shows a key value or the plan page.

## Order and size

Phases 1 and 2 first and together: they are the lock. Then 3, 4, 5, then the QA
phase. Each phase goes to staging and runs its QA before the next.

## Name (open)

The product keeps "the content engine" as its description: "<name> - the content
engine". Candidates are in the chat of 11-11-2026; none checked for trademark or
domain yet.
