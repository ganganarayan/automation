# QA tenant plan (content-engine)

Written 10-11-2026. Goal: test the real app, on the real machine (Railway prod),
with real keys, without touching the owner's channels or audience.

## Why not a separate test machine

Railway is the thing that differs: ffmpeg build, fonts, blocked SMTP, wake timing.
A laptop or VM would pass what Railway then fails. So the test machine is the app
itself: QA workspaces on prod, and a check that runs inside the server.

## What is built (Tenants panel, QA check box, super admin only)

- **Make QA workspace**: a tenant named qa-<something> on a chosen plan, with **no
  sign-in** (no account or password is made). The super admin works in it through
  /t/<id>/api/v1/admin/settings.
- **Run free checks** (costs nothing):
  - Machine: database, ffmpeg, Noto and Devanagari fonts, text drawn on a picture.
  - Isolation: no owner setting shows in the QA tenant (sheets, Drive folders,
    emails, SMTP, mail, prompts, lessons, comparison list); its funnel list is its
    own; a QA user asking for an owner funnel id gets "not found"; on the shared
    Post for Me key it sees only its own accounts and none of the owner's.
  - Plan: live, one funnel past the limit is refused, AI videos refused on Starter.
  - Keys: who pays per provider (Agency on the owner's key = fail), and each key is
    accepted (free model or account reads).
- **Run with paid calls** (about 10 US cents): one Claude JSON answer, one OpenAI
  text answer, one OpenAI picture, and that picture made into a 2 s 1080x1920 video
  with ffmpeg. Costs go to the usage ledger as "qa check", so the AI cost box shows
  them on the QA tenant (this also tests the cost-per-tenant split).

Nothing in the check posts, emails or changes a funnel.

## The QA workspaces

| Id | Plan | Proves |
|---|---|---|
| qa-starter | Starter | the platform keys work for a small customer; 1 funnel, no AI videos |
| qa-agency | Agency | brings its own keys: must never use the owner's key (owner's bill) |

Switch one off by setting its expiry to a past date: jobs skip it, the super admin
can still look.

## Rounds

1. 🟢 **Free checks** on both QA workspaces after each prod deploy.
2. 🟢 **Paid smoke** on qa-starter (about 10 US cents a run).
3. 🟡 **Real posts (owner step)**. Make throwaway accounts yourself: a private
   Instagram, an unlisted YouTube channel, a test Facebook page, spare Threads and X.
   In /t/qa-starter/... open a funnel's account picker and press Connect an account;
   Post for Me tags each with external_id qa-starter, so only qa-starter sees them.
   Then run one image post and one ready video through Schedule/Post and check
   Log (per-channel link, first comment, step-downs).
4. 🟡 **A real sign-in (owner step)**: make one tenant user with the New tenant form
   on a spare email of yours, sign in as it in a private window, and try to open an
   owner funnel id: it must say "not found".

## Not covered yet

- Lanes that need a Google Sheet or Drive folder of the tenant's own (refill, ready
  videos) until the QA workspace gets its own test sheet and folder.
- Kling, Runway, MiniMax and ElevenLabs paid calls (key accepted only, no spend).
- The Cloudflare waker for a second tenant (needs the Worker deployed).
