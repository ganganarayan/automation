# Pricing plan (draft, 10-11-2026)

Three plans. Prices are set so the provider cost you pay stays at or below about
half of the price. Costs come from the app's default price table
(content-engine/src/utils/pricing.js) at ₹88 to the dollar. Check them against a
week of real posts on Log and cost before publishing prices.

## What one post costs you (estimates)

| Item | Cost |
|---|---|
| Ready video (your video, AI copy, thumbnails) | about $0.25 |
| Image post (picture in 3 sizes, voice, music) | about $0.35 |
| AI video, 30 s (animation, voice, pictures) | about $2 to $2.50 |
| Post for Me, per channel | $0.01 |

## Plans

| | Starter | Growth | Agency |
|---|---|---|---|
| Price a month | ₹2,499 | ₹8,999 | ₹14,999 + their own AI keys |
| Funnels (brands) | 1 | 3 | 10 clients, each its own workspace and login |
| Channels per funnel | 5 | 6 | no cap |
| Posts a month (one post = all its channels) | 30 | 90 | 300 |
| AI videos a month | none | 4 | as their keys allow |
| Users | 1 | 3 | 10 |
| Your cost | about $12 (₹1,050) | about $45 (₹4,000) | about $25 (₹2,200) |
| Margin | about 58% | about 56% | about 85% |

### Starter: post every day, hands off
- Ready video lane: AI copy, headline thumbnail in every size, end card, Clean check.
- Image posts as voiced videos with music; YouTube Shorts from image posts.
- Daily router; the link as the first comment.
- Approve from the app; one daily digest email.
- Take down a post from every channel at once.
- Connect accounts from the app.

### Growth: grow and capture leads (everything in Starter, plus)
- AI video lane: script, pictures, animation, voice; an image post when an animation fails.
- Comment-to-DM capture (Instagram, Facebook) and lead visit tracking.
- Disapprove and Remake, with learned lessons.
- Festival posts, comparison videos, placed text on pictures.
- A call to action per funnel, with a per-post override.

### Agency: many brands, their own keys (everything in Growth, plus)
- Their own OpenAI, Claude, Kling, MiniMax and ElevenLabs keys (they pay providers).
- Optionally their own Post for Me key (off your bill).
- Cost log per funnel, to bill their own clients.
- Priority support.

## For all plans
- Over the limit: ₹999 for 30 more posts; ₹349 per extra AI video.
- Yearly: pay 10 months, get 12.
- Trial: 7 days of Starter.

## Before selling
- Post for Me's $10 plan covers about 1,000 posts a month for the whole account. One
  Growth tenant uses about 540 (90 posts x 6 channels). Ask Post for Me for a custom plan
  before a second Growth tenant.
- The app does not enforce any plan limit yet (build plan, phase 3).
