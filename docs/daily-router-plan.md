# Daily post router: plan

Drafted 01-11-2026. Status: **design only, nothing built.** Decisions D1 to D5 at the end are open.

## Goal

Something posts **every day**, on every channel of every funnel. You set up the channels once. After that you only top up content (ready videos, API credit, the image sheet). A daily router picks the best lane that can deliver. If a lane can't deliver, the router drops to the next one.

## Daily timeline (IST)

| Time | What happens |
|---|---|
| **16:00** | **Router check** for tomorrow's post, per funnel: Lane 1 → Lane 2 → Lane 3. Anything that needs you goes out in **one approval email** (a digest, not one email per item). |
| 21:00 | One reminder, only if something is still unapproved. |
| 07:30 (next day) | **Approval cutoff.** If nothing approved, the fail-safe kicks in (see Lane 3). |
| 08:02 (publish_time) | Post for Me publishes. |
| 08:02 onwards | Post for Me's webhook (plus a 5-minute check as backup) marks each channel ✅/❌ and sends the **go-live email**. This applies to every lane, not just ready videos. |
| **10:00** | **Nudge check**, after the day's posts are live. If both video lanes are empty for tomorrow, you get a one-line email: *"Video lanes are empty. Upload ready videos or top up the video APIs so I can create videos and auto-post."* |

## Lane 1: Ready video (first priority)

1. Look in the funnel's ready-video Drive folder for a video that has **not been posted on this funnel**. The check uses the Drive file ID, as it does today. **Oldest first** (D3).
2. **Thumbnail + caption present?** The convention: a file with the same name next to the video (my-video.jpg and my-video.txt). If both exist, use them and schedule the post. No approval needed.
3. **Missing?** Generate them automatically: transcribe → AI caption + thumbnail headline → thumbnail image. Then put the result in the 16:00 approval email with **Approve / Edit** links. Once you approve, it's scheduled.
4. After posting, the file is renamed to "POSTED - …" (as today).

## Lane 2: Auto research + AI video

1. **Credit check, only for the video-generation providers** (Kling, Runway, Hailuo). Try them in your order of preference and use the first one with credit.
   - Where a provider has a balance API, read it.
   - Where it doesn't, treat an "insufficient credit" error as *exhausted for today* and try the next provider.
2. **All exhausted** → you get one email ("Video API credit is used up: Kling, Runway, Hailuo"). It's sent **once per drought**, not daily, and the reminder resets when credit comes back. Then Lane 3 runs.
3. Otherwise: research a topic → script → approval (D4) → render → schedule for 08:02.

## Lane 3: Image post (fail-safe)

1. Take the next row with status Ready from the funnel's sheet. **Mark it "Pending approval" straight away.** Today it's only marked once posted, so the same row can be picked twice.
2. **Sheet empty, or under 7 rows left?** The app writes **7 days of new image prompts + captions into the sheet itself**. This is mandatory, not a reminder to you. Generated rows are marked "Auto" so you can tell them apart and edit them.
3. Generate the image, using OpenAI or Gemini if OpenAI fails. It goes in the 16:00 approval email.
4. Once approved, it posts to **all channels of the funnel** (D1 covers "all funnels").
5. **Fail-safe reserve:** Lane 3 always keeps **2 approved images in reserve** per funnel. If you miss the cutoff, or both image APIs fail, a reserve image posts and the reserve is refilled at the next 16:00 check. This is how "approval required" and "something posts every day" fit together.

## Why the go-live email didn't come (found 01-11-2026)

🔴 **Production has SCHEDULER_MODE=external.** That switches off the 5-minute check that confirms posts and sends the go-live email. The GitHub Actions wake-up schedule meant to replace it has been **disabled since 09-09-2026** (.github/workflows/run-due.yml). So the check only runs when you open the Instances page or an instance. Post for Me published fine, but the app never looked, so it never emailed you.

Two more gaps:
- The go-live email exists only for ready videos. AI-generated videos are locked as "posted" the moment they're sent, and image posts create no instance, so neither ever gets ✅/❌ or a go-live email.
- If the funnel's approval email and the fallback approval_email_gita are both empty, the email is skipped silently.

## Conflicts and errors found in the current app

1. 🔴 **There's no reliable clock in production.** The 16:00 and 10:00 router checks, the go-live email and auto-retry all need one. **Fix:** run on an always-on host (SCHEDULER_MODE=internal) and have the Post for Me webhook trigger the post check the moment a post finishes. GitHub cron can run 5 to 30 minutes late or be skipped, which is not good enough for a fail-safe (D5).
2. 🔴 **There's no balance or quota check anywhere.** Today an out-of-credit provider just fails the run, with no fallback and no email. Lane 2 needs this built.
3. 🔴 **"Research" doesn't exist yet.** Today's AI-video topic is just the funnel name or title. Lane 2 needs a real topic step: an LLM over a topic list or trends, deduped against past posts.
4. 🟡 **Lane 2 has other paid dependencies besides video.** It also needs voice (ElevenLabs/HeyGen), images and the LLM. If only the video credit is checked, a run can start and die halfway at the voice step. **Change:** check them all before choosing Lane 2, but name only the one that's out in the email.
5. 🟡 **Ready videos are never picked automatically today.** You tick them by hand. The current flow also forces an in-app transcript review where you must type the headline. The router replaces that with automatic generation plus email approval.
6. 🟡 **Image approval email has no fallback recipient.** If the funnel's approval email is blank, it silently sends nothing. **Fix:** one central notification address in Settings → Workspace, used by every email.
7. 🟡 **Old schedulers will double-post.** These all have to be switched off when the router goes live:
   - the image poster's own generate_time cron
   - image_when
   - the VidaPulse refill at 09:00
   - the hardcoded brand times in the scheduling utils
8. 🟡 **Too many emails.** Today you get one approval email per item, plus a "Scheduled" email, plus a go-live email. **Change:** one 16:00 digest, one go-live digest per day and one nudge. That's at most 3 a day, plus the one-time credit alert.

## Open decisions

- **D1: Per funnel or one post to all funnels?** "Posts to all funnels" could mean either:
  - **Recommended:** each funnel runs its own lanes and posts its own item every day.
  - One item is chosen per day and posted to every funnel.
- **D2: Missed approval by 07:30:**
  - **Recommended:** post a reserve image.
  - Skip the day.
- **D3: Ready-video order:**
  - **Recommended:** oldest uploaded first.
  - Newest first.
- **D4: Lane 2 approvals.** Today there are two email approvals, script and then the final video.
  - **Recommended:** keep only the final-video approval, so it can render overnight.
  - Keep both.
  - Fully automatic.
- **D5: Scheduler:**
  - **Recommended:** always-on Railway (internal mode) plus the Post for Me webhook. Costs a little more than sleeping.
  - Re-enable the GitHub cron every 15 minutes.

## Build order (once decided)

1. Clock + go-live for every lane: internal scheduler, webhook-triggered check, central notification email. Fixes the missing email on its own.
2. Router skeleton + Lane 3 (fail-safe first): sheet auto-fill, Pending approval marking, reserve images, 16:00 digest.
3. Lane 1 automatic pick + generated copy approval.
4. Lane 2 credit checks + research step + the once-per-drought alert.
5. 10:00 nudge. Switch off the old schedulers.
