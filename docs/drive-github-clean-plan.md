# Drive connect + GitHub Actions video clean (build while travelling, 2–5 Nov 2026)

Asked on 30-10-2026 ("Posting engine — continue" chat). The plan was a cloud session to build this on 2nd Nov
while the laptop is off, then sync the code on the 5th morning.

Your words: build the GitHub one on the Claude cloud session; GitHub's per-minute rate is cheaper
than Railway's; after GitHub runs ffmpeg it uploads to Google Drive, and the app does the posting.
Since the logo sits in almost the same place every time, trimming from the bottom should be enough.
If not, zoom in, keep the frame top matched, and let the bottom (with the logo) move below the margin.

Status on 01-11-2026: proposed as a card (task_773de0a2, expires about 06-11-2026). It has **not been started**.

## 1. One-time Google Drive connect (one for the whole workspace, not per funnel)
- OAuth web flow, scope drive.file. A "Connect Google Drive" button on Settings → API Keys, a callback route,
  and the refresh token stored in tenant_config (same pattern as configManifest.js / tenantSettings.js).
- An OAuth client secret field next to the existing oauthClientId.
- Create or find one app folder in your Drive.
- The consent screen must be set to **In production**. Tokens from a "Testing" app expire after 7 days.

## 2. Move ✂ Clean off Railway onto GitHub Actions
Today ✂ Clean runs ffmpeg on Railway (startClean/runClean in readyPostService.js, cleanVideoArgs in cleanSpec.js).
It zooms in with the top kept fixed, so the NotebookLM watermark leaves the frame, and it cuts the last N seconds.
- The app sends a workflow_dispatch to a new workflow, using a GitHub fine-grained token saved under API Keys.
  The inputs are: driveId, zoom, trim, callback URL, and a short-lived Drive access token, masked in the logs.
- The workflow installs ffmpeg, downloads the video from its public Drive URL, and runs the same cleanVideoArgs.
- The output is uploaded to the app's Drive folder. Cleaned files can be seen on the phone and are deleted after the posts go live.
- The workflow POSTs { driveId, fileId, durationSec } to a signed app callback, which saves the clean result on the draft instance.
  The callback must stay outside the new sign-in, since it is signed instead (sign-in shipped 31-10-2026).
- Posting then uses the cleaned Drive file.
- Railway stays available as a fallback setting.
- Optional: detect where the NotebookLM outro starts (a scene change in the last 15 s).

## Done means
- node --check passes on every changed file and vitest is green. Pushed to orbitq, and staging /api/version shows the new SHA.
- You get a short setup list: a GCP OAuth client, a GitHub token, and the consent screen set to production.
- No local builds. Dates are DD-MM-YYYY IST.

Related: phase 4 of [content-engine-lanes-plan.md](content-engine-lanes-plan.md).
