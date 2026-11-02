# Daily post router: plan

Drafted 01-11-2026, decisions recorded 01-11-2026. Status: **design agreed, nothing built.**

## Goal

**Posting positive:** every funnel posts something every day, on all of its channels. You set up the channels once. After that you only top up content: ready videos, API credit and the image sheet. A daily router picks the best lane that can deliver. If a lane can't deliver, the router drops to the next one.

## Decisions

| # | Decision |
|---|---|
| D1 | **Per funnel.** Each funnel runs its own lanes and posts its own item every day to all of its channels. |
| D2 | **Late approval posts immediately.** If you approve after the scheduled time, it posts at once. Nothing is skipped and there are no reserve images. |
| D3 | **Ready videos go oldest first.** |
| D4 | **AI videos need two approvals.** You approve the script, then the final video. |
| D5 | **Wake, work, sleep.** The app is not always on. It wakes for a job, keeps a heartbeat until the job is handed to Post for Me (or is waiting on your approval link), then sleeps. |
| — | **Email volume is fine.** Work has to happen, and you delete the emails once posts are live. |
| — | **AI video is narrated.** Images are animated by Kling, Runway or Hailuo, with **no lip sync**. An ElevenLabs voice-over plays as a third-person narrator in the background. **ffmpeg on GitHub Actions** assembles it, the same way Clean works. |
| — | **Image sheet statuses** are Ready → Approved → Posted, with a column for the Post for Me post ID. |
| — | **When fewer than 2 Ready rows are left, generate 7 new rows.** |
| — | **Research is per funnel.** It is based on that funnel's **landing page link** plus its **post history**, so topics don't repeat or get monotonous. |

## Wake / sleep model

The app is asleep by default. These things wake it with an incoming HTTP request, and Railway starts the service on that request:

| Wake trigger | Time (IST) | What it does |
|---|---|---|
| GitHub Actions cron | **16:00** | Router check for tomorrow, per funnel. |
| GitHub Actions cron | **10:00** | Nudge check, after the day's posts are live. |
| GitHub Actions cron | ~08:20 | Backup post check, in case a Post for Me webhook was missed. |
| GitHub Actions cron | **09:30, 21:30** | LinkedIn → WhatsApp relay. |
| Post for Me webhook | when a post finishes | Marks each channel ✅/❌ and sends the **go-live email**. |
| Your approval link in an email | when you click it | Approves the item and continues the job. |
| GitHub ffmpeg callback | when an assembly finishes | Continues the AI-video or Clean job. |

**Heartbeat:** while any job is active, the app keeps itself awake. Active means generating images, waiting on Kling, Runway or Hailuo, or waiting on the GitHub ffmpeg run. The job ends when the post is created on Post for Me, or when the job is parked waiting for your approval. Then the app may sleep. Your click on the approval link wakes it again.

⚠ **To verify before building:** Railway's current sleep rule. As far as I know it sleeps a service after about 10 minutes with no outbound traffic, and an active outbound heartbeat keeps it up. Confirm on Railway's docs/settings; don't assume.

**The times are editable** in Setup → Settings → **Daily schedule (IST)**: the daily check (default 16:00), the morning nudge (10:00), the backup post checks (08:20, 20:20) and the LinkedIn → WhatsApp relay runs (09:30, 21:30). Saving a changed time, or pressing **Sync wake-up times**, writes them to the GitHub repository variable WAKE_SCHEDULE. One workflow, .github/workflows/wake.yml, runs every 15 minutes and pings each job whose time fell in the last 30 minutes, so a time fires about 15–30 minutes after it is set. A job may be pinged twice in that window; router_days and the one-at-a-time post check make that harmless. On an always-on host (SCHEDULER_MODE=internal) an in-process 15-minute cron runs the daily check from the same settings.

GitHub cron can start 5 to 30 minutes late. That's acceptable for 16:00 and 10:00. The go-live email relies on the Post for Me webhook, not the cron.

## Daily timeline (IST)

| Time | What happens |
|---|---|
| **16:00** | The router picks tomorrow's lane for each funnel (Lane 1 → 2 → 3) and sends the approval emails needed. |
| evening | You approve. Each click wakes the app and continues that job. For Lane 2: script approval → render → final-video approval. |
| **08:02** (publish_time) | Approved items go out through Post for Me. |
| after 08:02 | An item approved late posts **the moment you approve it** (D2). |
| on publish | The webhook marks channels ✅/❌, then the **go-live email** goes out for every lane. |
| **10:00** | If **both video lanes** are empty for tomorrow, you get a one-line nudge: *"Video lanes are empty. Upload ready videos or top up the video APIs so I can create videos and auto-post."* |

## Lane 1: Ready video (first priority)

1. Take the **oldest** video in the funnel's ready-video Drive folder that has **not been posted on this funnel**. The check uses the Drive file ID, as it does today.
2. **Thumbnail + caption present?** The convention is files with the same name next to the video, for example my-video.jpg and my-video.txt. If both exist, the video is scheduled straight away with no approval.
3. **Missing?** The app generates them: transcribe → AI caption + thumbnail headline → thumbnail. The result comes to you in an approval email with **Approve / Edit** links. Once you approve, the video is scheduled for 08:02, or posts now if it's later than that.
4. After posting, the file is renamed "POSTED - …" (as today).

## Lane 2: Researched AI video (narrated, no lip sync)

1. **Credit check.** First the video providers (Kling, Runway, Hailuo) in your order of preference, using the first one with credit. Then the other things Lane 2 needs: the ElevenLabs voice, the image API and the LLM.
   - Where a provider has a balance API, read it.
   - Where it doesn't, treat an "insufficient credit" error as *exhausted for today*.
2. **Everything needed is exhausted** → you get one email naming what's out. It's sent **once per dry spell**, and resets when credit comes back. Then Lane 3 runs for that funnel.
3. **Research.** The app reads the funnel's landing page and its post history (past titles and captions), and picks a topic that is new and differs in angle and format from the last posts.
4. Script → **approval email 1** (script).
5. Render the video:
   - images (OpenAI or Gemini)
   - animated with the chosen provider, no lip sync
   - ElevenLabs narrator voice-over
   - **ffmpeg on GitHub Actions** assembles it into your Google Drive
6. **Approval email 2** (final video) → scheduled for 08:02, or posts now if later.
7. **A failure midway** (credit runs out during the render, or a provider error) drops that funnel to Lane 3 for the day, and you get an email saying why.

## Lane 3: Image post (fail-safe)

1. Take the next **Ready** row from the funnel's sheet. A row already attached to an open job is skipped, so it is never picked twice.
2. **Fewer than 2 Ready rows?** The app writes **7 new rows** into the sheet: image prompt, caption and headline. It uses the same landing page + history research as Lane 2.
3. Generate the image (OpenAI, falling back to Gemini) → approval email → on approval, the sheet row becomes **Approved**.
4. It posts to all channels of the funnel at 08:02, or at once if approved late. The row becomes **Posted** and its **Post for Me ID** is written in.

## Go-live email (the bug found 01-11-2026)

🟢 **Resolved 02-11-2026:** wake.yml carries the schedule, and it is the only schedule the app needs. run-due.yml is manual-only on purpose: the router owns all three lanes, so a cron there would post a second item for the same funnel and day. The relay moved to wake.yml too, so no job is left waiting for a hand.

🔴 **Cause:** production has SCHEDULER_MODE=external, and the GitHub wake-up schedule has been disabled since 09-09-2026. So the post check only ran when you opened the Instances page. Post for Me published fine, but the app never looked.

**Fix in this plan:**
- The Post for Me webhook wakes the app and runs the check at once, with the 08:20 cron as a backup.
- Every lane goes through the same instance → Post for Me → check → email path. Today AI videos and image posts never get a go-live email.
- One central notification address in Setup → Settings is used by every email, so a funnel with a blank approval address no longer goes silent.

## What's resolved and what's left

🟢 **Resolved by your answers:**
- per funnel vs. all funnels
- late approval
- ready-video order
- AI-video approvals
- scheduler cost
- email volume
- sheet statuses
- the refill threshold
- research input
- no lip sync

🟡 **Still open or to confirm:**

1. **Replying to an email can't wake the app.** A reply goes to your mailbox, not to the app. Approval works by **clicking the Approve link** in the email, which wakes it. Reply-to-approve would need an inbound-mail service; I don't recommend it.
2. **You are the only thing that can stop a day's post.** If the 16:00 approval email waits, that funnel posts whenever you approve (D2). That is by design, just be aware of it.
3. **The sheet needs edit access.** For the ready → approved → posted statuses and the Post for Me ID column, the connected Google account (or service account) must be able to **edit** each funnel's sheet, not just read it. This will be checked when you save a funnel.
4. **Post history only covers what this app posted.** Posts made by hand or by other tools before the app aren't in its history. Optionally, the app can also pull past posts from Post for Me to widen it.
5. **Same-name thumbnail/caption files** (my-video.jpg + my-video.txt) is my proposal for Lane 1. Tell me if you want a different convention.
6. **Railway's sleep rule** needs confirming before the heartbeat is built (see Wake / sleep model).
7. **New settings per funnel:**
   - landing page link
   - video-provider order (Kling / Runway / Hailuo)
   - the ElevenLabs narrator voice

   All of these are set in the app UI, not in env.
8. **The old schedulers are switched off at go-live,** or they will double-post:
   - the image poster's generate_time cron
   - image_when
   - the VidaPulse refill at 09:00
   - the hardcoded brand times
   - the run-due-video endpoint's own schedule

## Build order

**Step 1 status (01-11-2026): built, on staging.** The Post for Me webhook and an /api/v1/jobs/check-posts wake-up run the post check (one run at a time). Every boot catches up on what went live while asleep. The heartbeat holds the app awake during Clean, AI-video renders and post checks. The job runner goes idle when its queue is empty; its 5-second database poll used to keep the app from ever sleeping. AI videos go through scheduled → post check → go-live email, and post at once if approved late. There is a central Notification email under Setup → Settings → Emails. The backup post check (08:20 and 20:20 IST by default) now runs from .github/workflows/wake.yml, which replaced post-check.yml and router-check.yml. Its secrets still need setting, and it only runs from main. Production still has Serverless (sleep) **off**. Turn it on in Railway once this is on main.

**Steps 3–5 status (01-11-2026): built, on staging.** The router now tries Lane 1 → Lane 2 → Lane 3 per funnel and keeps each lane's reason for passing on router_days.reason.
- **Lane 1:** the oldest unposted video in the funnel's ready-video folder. When the same-name .jpg/.png and .txt files are there, it is scheduled with no approval. Otherwise the router transcribes it, writes the AI copy and thumbnail, and sends one approval email (the transcript gate is passed by the router; you approve the finished copy). The instance status is video_review.
- **Lane 2:** a credit check, then research, the script and approval 1, then images, animation with no lip sync, the ElevenLabs narrator and **ffmpeg on GitHub Actions**, then approval 2.
  - The assembly reuses clean-video.yml with a ticket of kind 'assemble'.
  - The provider order is a per-funnel setting: Video setup → Image → video → Daily router provider order.
  - Balances read live: Runway's /v1/organization creditBalance, Kling's /account/costs resource packs (field names unconfirmed, parsed leniently), ElevenLabs' /v1/user/subscription. Hailuo, OpenAI and Gemini have no balance API: an "out of credit" error marks them out for the rest of the IST day.
  - One email per dry spell. Status is on Keys and credit.
  - A failure mid-render drops that funnel to Lane 3, with an email.
- **Nudge:** POST /api/v1/jobs/nudge, at most one email a day per tenant.
- **Re-run:** a super admin gets "Re-run tomorrow's check" per funnel on Today. It replaces what was not approved yet (an image row is freed; a ready video is only unlinked) and decides again.
- 🟡 **Not switched off yet:** the old schedulers in item 8 above.

1. **Clock + go-live for every lane:**
   - GitHub cron wakes at 16:00, 10:00 and 08:20
   - Post for Me webhook triggers the post check
   - heartbeat while jobs run
   - central notification email
   - go-live email for every lane

   This step alone fixes the missing email.
2. **Router skeleton + Lane 3:**
   - sheet statuses + Post for Me ID column
   - fewer than 2 rows → 7 generated
   - approval → post, or post now if late
3. **Lane 1:** automatic oldest-first pick + generated copy with approval.
4. **Lane 2:**
   - credit checks
   - landing-page + history research
   - narrated render with ffmpeg on GitHub
   - two approvals
   - once-per-dry-spell credit email
5. **10:00 nudge;** switch off the old schedulers.
