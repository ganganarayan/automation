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
- **Run free checks** (costs nothing), one group per phase of
  docs/multi-tenant-build-plan.md, run against your real records with the real guards
  (code: services/qaPhases.js):
  - Machine: database, ffmpeg, Noto and Devanagari fonts, text drawn on a picture.
  - Phase 1 doors: a QA user asking for your workspace gets 403; on the plain URL it
    lands in its own; you may switch in. One of your funnels, runs, keyword rules and
    leads asked for by id: "not found". Its funnel and user lists hold only its own.
    On the shared service account a Drive id from your funnel folder is refused before
    any download, and your folder is claimed by you (another tenant pasting it is
    refused). On the shared Post for Me key it sees only its own accounts, none of yours.
  - Phase 2 leaks: none of your settings (sheets, Drive folders, emails, SMTP, mail,
    prompts, lessons, comparison list, Gmail) show in it; daily jobs reach it.
  - Phase 3 lifecycle: every plan limit (funnels, channels, posts, AI videos, users)
    refuses one past the limit. An expired workspace (qa-expired, made once, no
    sign-in) can look, cannot change, gets no daily jobs and cannot post.
  - Phase 4 billing: who pays per key (Agency on your key = fail), the key history's
    last entry matches today, none of your balances show, the cost report reads.
  - Phase 5 shared: every Page / IG id you claim routes to you; Google sign-in uses
    your whole OAuth set; its own connect ticket is accepted and one signed elsewhere
    refused; the Clean runner is your whole set; the Assess360 list stays yours.
  - Keys live: each key is accepted (free model or account reads).
- **Run with paid calls** (about 10 US cents): one Claude JSON answer, one OpenAI
  text answer, one OpenAI picture, and that picture made into a 2 s 1080x1920 video
  with ffmpeg. Costs go to the usage ledger as "qa check" and the check confirms the
  rows landed on the QA workspace (phase 4 end to end).

Nothing in the check posts, emails or changes a funnel. It writes only: the
qa-expired fixture, and the QA workspace's own key history and Google ticket secret.

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
