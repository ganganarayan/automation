# QA results: Always-On Brand pricing, prod, 11-11-2026

Prod SHA d749124 (main). Run from Settings > Tenants > QA check as the owner,
on qa-starter (with the paid smoke, 0.04 USD) and qa-agency.

| Workspace | ok | warn | fail | skip | Phase 7 pricing |
|---|---|---|---|---|---|
| qa-starter | 98 | 1 | 0 | 5 | 35 / 35 ok |
| qa-agency | 93 | 0 | 0 | 12 | 35 / 35 ok |

The one warning is old: the owner's ElevenLabs key cannot read its account,
so its balance shows unknown. Skips are fixtures that need the owner (a lead,
a Drive service account, runway and transcript keys) or Agency bringing its
own keys.

## What phase 7 proves on prod

- Margin at least 50% on every plan on sale, both currencies, yearly the
  lowest: Always-On Brand 51.2% INR / 51.5% USD, Agency 60.7% / 60.5%,
  Solo 50.6% / 51.5%.
- Quotes: 1 funnel ₹3,657 with GST; 3 funnels + 2 users yearly ₹1,12,065;
  4 clients + 1 user $181.50; Solo ₹2,005. Each reads back from its Razorpay
  plan key. Custom, old plans, 0 or 51 units and 99 users are refused.
- Migration 030 columns exist (tenants and checkouts: units, extra_users).
- Limits on qa-pricing-brand (2 funnels, 1 extra user): 2 funnels, 60 posts,
  2 users allowed, one more of each refused with "Add a funnel".
- qa-pricing-agency (2 clients): a 3rd client refused; posts pooled at 60
  across 3 workspaces.
- AI keys: the per-client agency and its client run on the owner's OpenAI,
  Claude and ElevenLabs keys (AI is in the price); the flat qa-agency never does.
- Solo: a charge on the Solo plan key moves the workspace to Solo (1 funnel,
  a 2nd refused), and back; an unknown key changes nothing; the offer shows
  just before Cancel, never to a Solo workspace or an agency client.
- Pages: home shows the offer and no old plans or Solo; the buy page opens on
  Agency with 3 clients and never offers Solo; compare shows ₹3,099.
- Doors: /buy/start refuses while payment is closed; the webhook refuses a
  wrong signature; the Solo switch turns a stranger away (401).

## Found and fixed during this QA

1. A client of a per-client agency got no AI keys (its own row has no units,
   so it was judged bring-your-own). Fixed in 2cca78b; rerun green.
2. Plan card said "the list on the left" (it is above); Agency repeated a line.
   Fixed in cd368fc.
3. On phones the value table squeezed and cut off the price column. It now
   stacks row by row below 760px; the buy page's extra-users label follows
   the plan picked. Fixed in d749124, checked at 375px in the browser.

Buy page totals were checked in the browser against the server: 3 clients
₹13,802 a month; 2 funnels + 1 user yearly outside India $735.

## Not proven yet (needs the owner)

- A real payment: enter Razorpay keys (test keys first) under Payments, buy
  once, and see the workspace made, the renewal webhook and a Solo switch on a
  card mandate. QA never opens a real subscription.
- The Tenants panel cannot set funnels bought for a workspace set up by hand
  (units stays empty = 1 funnel). Over-limit users read "ask the owner": there
  is no self-serve "add a user" button yet.
- Fixtures left on prod: qa-pricing-brand, qa-pricing-agency (+ c1, c2), no
  sign-in, no funnels, nothing posts.

## Rerun: currency by IP, new prices (prod bdc199c, 11-11-2026 22:50 IST)

| Workspace | ok | warn | fail | skip | Phase 7 pricing |
|---|---|---|---|---|---|
| qa-starter (paid smoke 0.0421 USD) | 103 | 1 | 0 | 5 | 40 / 40 ok |
| qa-agency | 98 | 0 | 0 | 12 | 40 / 40 ok |

The warning is the same ElevenLabs key permission as before.

- Prices: Always-On Brand ₹3,199 + GST / $37 per funnel, Agency ₹3,999 + GST /
  $47 per client. 1 funnel in India ₹3,775 with GST; 4 clients + 1 user $189.50.
- No currency switch. Phase 7 checks each page in both views (?cur=inr and
  ?cur=usd): the dollar home, buy, compare, SocialPilot and refund pages carry
  no ₹, GST, India, rupee or IST, no currency switch and no Solo, in the page
  or its source; the buy page script holds only the visitor's currency.
- From the owner's PC in India, /api/geo on prod answers IN / inr and the home
  page shows rupees. Railway's X-Real-IP carries the visitor IP (req.ip was a
  proxy hop and showed India as USD on the first staging deploy, fixed in
  bdc199c); a faked X-Real-IP is overwritten by Railway.
