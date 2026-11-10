# QA results, 11-11-2026 (prod, content-engine)

Run overnight on production (content-engine-production-230f.up.railway.app),
final build **1ff4dba**, from Settings > Tenants > QA check, signed in as super admin.
Total paid spend: about **0.13 US dollars** (three paid runs), shown on the QA starter
row of the AI cost box.

## Verdict

| Workspace | Plan | Passed | To look at | Failed | Skipped |
|---|---|---|---|---|---|
| qa-starter (with paid calls) | Starter | 63 | 1 | 0 | 4 |
| qa-agency | Agency | 47 | 0 | 0 | 12 |

🟢 Every multi-tenant phase (1 to 5) passes on prod, plus the server checks, the paid
providers end to end and the HTTP front door.

## Found and fixed tonight

1. 🔴 to 🟢 **Key history never recorded the paid keys** (phase 4). It was written
   before the paid keys were resolved, so every entry held only Google and GitHub and
   the cost split always fell back to today's key owner: a tenant that changed keys
   would have had its old spend moved on or off your bill. Fixed in 29f94c4, with a
   test that fails without the fix. On prod the QA check now reads "the last matches
   who pays today".
2. 🟡 **ElevenLabs key** answered 401 to the account read. The QA check now tells a
   scoped key from a dead one: your key works (it reads voices) but lacks the
   account permission, so the Keys and credit strip shows its balance as unknown.
   Your step: in ElevenLabs, edit the API key and allow **User: Read**.

## What was proven on prod

- Server: database, ffmpeg 8.0.1, Noto and Devanagari fonts, text drawn on a picture.
- Paid, for real: Claude (claude-opus-5) JSON answer, OpenAI text (gpt-5-mini),
  an OpenAI picture, and that picture made into a 2 s 1080x1920 video by ffmpeg on
  Railway. All 6 paid calls landed on the QA starter ledger.
- Phase 1 doors: a QA user asking for your workspace gets 403; your funnel, run and
  keyword rule ids give "not found"; its funnel and user lists hold only its own; on
  your shared Post for Me key it sees none of your 17 accounts. Through the real
  routes: qa-starter got its one funnel and the second was refused (Starter = 1), and
  pasting your funnel 1 ready folder answered "That folder belongs to another
  workspace."
- Phase 2: none of your settings show in a QA workspace; daily jobs reach it.
- Phase 3: every limit refuses one past the plan; qa-expired can look, cannot
  change, gets no jobs and cannot post.
- Phase 4: who pays per key (Agency gets none of yours), key history, none of your
  balances shown, the cost report, the AI cost box.
- Phase 5: both your Page / IG ids route to you; the Google connect ticket refuses
  one signed elsewhere; the Clean runner is your whole set; Assess360 stays yours.
- HTTP front door, as a stranger: your settings, a QA workspace by path and by
  header, making a funnel, running the QA check, making a tenant and waking the
  router are all turned away; /health, /ready and /api/version answer.

## Not covered (needs you or is not set up)

- **Real posts**: needs throwaway social accounts you make and connect inside
  /t/qa-starter/ (Post for Me tags them qa-starter). See docs/qa-tenant-plan.md round 3.
- **A real tenant user sign-in**: needs a spare email of yours via New tenant (round 4).
- **Drive guard on the shared service account**: prod has no platform service
  account in env, so a tenant reads Drive with the public reader or its own; the
  folder refusal was still proven through the real route.
- **Your lead by id**: you have no captured leads yet.
- **Cloudflare waker**: not deployed; the GitHub schedule stays as the fallback.

## Left in place

- qa-starter (its funnel 8 switched off, so the daily router skips it), qa-agency,
  qa-expired. No sign-in on any of them. Set an expiry in the past to switch one off.

## Notes

- /ready answered 503 once right after the prod start, then 200: the database pool
  warming up, not an outage.
- Builds tonight: staging 230 to 250 s, prod 250 to 260 s.
