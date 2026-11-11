# Starter price review (11-11-2026)

Question: the tools that cost less than our Starter (₹2,499), what do they give,
and can a Starter with no AI videos (image posts and voiced image videos only)
be priced below them and still earn a healthy margin?

Exchange rate ₹88 to the dollar, as in docs/pricing-plan.md. Competitor prices
were checked on their pricing pages on 11-11-2026, except SocialPilot, whose
page did not load: its figures are from compareData.js, checked the same day.

## 1. The cheaper tools, entry plan against our Starter

| | Content Engine Starter | SocialPilot Standard | Later Starter | Metricool Starter | Predis.ai Core | Buffer Essentials |
|---|---|---|---|---|---|---|
| Price a month | ₹2,499 | ₹2,000 (₹1,700 yearly) | $18.75 yearly, about ₹1,650 | $25 (≈ ₹2,200), $20 yearly (≈ ₹1,760) | $32 (≈ ₹2,820), $19 yearly (≈ ₹1,690) | $6 a channel; 5 channels $30 (≈ ₹2,640), $25 yearly (≈ ₹2,200) |
| Priced in rupees | yes | yes | no | no | no | no |
| Brands | 1 funnel | per accounts | 1 social set | up to 5 | 1 | per channel |
| Channels | 5 | not checked | 8 profiles, one per platform | per brand | 10 | 5 (you pay per channel) |
| Posts | 30 a month, every channel | not checked | 30 per profile | unlimited (fair use) | 1,300 credits ("about 325 images or 33 videos") | unlimited |
| Makes the picture for you | yes, every post | no | no | no | yes | no |
| AI copy | yes, every post | captions | 5 credits a month (1 credit = 1 caption) | 20 credits a brand | yes | yes, "unlimited credits" |
| Voiced video from the post | yes, 3 sizes, with music | no | no | no | video maker up to 30 s; voice not listed | no |
| Publishes on its own | yes | yes | yes | yes | **no: "No Auto Posting" on Core** | yes |
| Posts every day with nothing from you | yes (daily router) | no | no | no | no | no |
| Link as the first comment | yes | not checked | not checked | not checked | no | not checked |
| Free plan | 7-day trial | 14-day trial | 14-day trial | free: 1 brand, 20 posts | 3-day trial, charged at the end | free: 3 channels, 10 posts each |

Where they beat us today: every one of them is cheaper on yearly billing;
Metricool and Buffer have a free plan; Metricool covers 5 brands at its entry
price; Predis makes more pictures (about 325 a month); SocialPilot also prices
in rupees. Where we beat all of them: the post is made and published for you
every day, picture, copy, voice and video, with no input. None of the five does
that at any price. Predis is the only one that makes the creative, and its
entry plan cannot even publish it.

## 2. What one Starter post costs us

### Today's build

From the app's price table (utils/pricing.js) and the image lane code. Real prod
costs so far: Ready video posts averaged **$0.12** over 37 posts (range $0.04 to
$0.22); one sheet image post cost $0.07; festival posts $0.02. No voiced
image-post video has run on prod yet, so the line below is worked out, not
measured.

| Image post, as built | Cost |
|---|---|
| 3 pictures, one per size (9:16, 4:5, 16:9), $0.07 each | $0.21 |
| Claude: copy and placing the text on the picture | about $0.05 |
| ElevenLabs voice, about 500 characters at $0.18 per 1,000 | about $0.09 |
| Post for Me, 5 channels at $0.01 | $0.05 |
| **One post** | **about $0.40 (₹35)** |
| **30 posts a month** | **about $12 (₹1,050)** |

At ₹2,499 that is about a 58% margin. At a price below the competitors (about
₹1,499) it would fall to about 30% before GST and the payment fee: too thin.

### A lean Starter build (the change that makes a low price work)

| Change | Saving per post |
|---|---|
| Draw **one** tall 9:16 picture and cut the 4:5 from it, placing the text per size. Image posts reach YouTube as Shorts (vertical), so the 16:9 picture is not needed on Starter | $0.21 → $0.07 |
| A cheaper image quality for Starter (medium instead of high), if it looks right on a phone | $0.07 → about $0.04 |
| A cheaper voice for Starter: ElevenLabs' low-cost model, or OpenAI's text-to-speech at about $0.015 per 1,000 characters | $0.09 → $0.01 to $0.05 |
| Sonnet instead of Opus for Starter's copy and text placement | $0.05 → about $0.015 |
| Post for Me stays | $0.05 |
| **One post** | **about $0.13 to $0.20 (₹11 to ₹18)** |
| **30 posts a month** | **about $4 to $6 (₹350 to ₹530)** |

These are list prices; check them against a week of real Starter posts on Log
and cost before changing the public price.

## 3. Price to beat them

The cheapest yearly price among the five is about ₹1,650 a month (Later,
SocialPilot, Predis); the cheapest monthly one is SocialPilot at ₹2,000.

**Recommendation: Starter at ₹1,499 a month, ₹14,990 a year (₹1,249 a month).**

| At ₹1,499 a month | Today's build | Lean build |
|---|---|---|
| Less 18% GST, if the price includes it | ₹1,270 | ₹1,270 |
| Less a payment fee of about 2% | ₹1,245 | ₹1,245 |
| Less provider cost, 30 posts | ₹1,050 | ₹350 to ₹530 |
| **Left per customer** (share of what we keep after GST and fee) | **about ₹195 (16%)** | **about ₹715 to ₹895 (57% to 72%)** |

- Below every cheaper tool on monthly billing, and below them on yearly too
  (₹1,249 against about ₹1,650), while being the only one that makes and posts
  the content.
- Works only with the lean build. On today's build, keep ₹2,499.
- Optional entry rung: **Starter Lite at ₹999, 15 posts a month** (about ₹175 to
  ₹265 cost), to answer Metricool's and Buffer's free plans without giving
  posts away.
- Keep the 7-day trial; the comparison pages should then say "from ₹1,249 a
  month billed yearly".

## 4. Open before changing the price

- Are our prices GST-inclusive? The table above assumes they are.
- Build the lean Starter: one picture, cheaper voice and model, plan-aware.
  Nothing in the app does this yet.
- Post for Me: Starter at 30 posts x 5 channels is 150 a month per customer; the
  $10 plan covers about 1,000 for the whole account, so about 6 Starter
  customers. Get a custom plan before selling at volume.
- Server, database and email are shared and small per customer today; recheck
  once there are 20 or more customers.
- SocialPilot's channel and post limits were not checked (its page did not load).
