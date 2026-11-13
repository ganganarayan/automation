/**
 * Configuration manifest.
 *
 * Purpose:      Describe, for each app, the tenant-scoped settings and module
 *               toggles the config UI should render. This is the single source
 *               of truth that drives the forms and the save/validation logic.
 * Responsibility: Pure data + tiny helpers; no I/O.
 * Dependencies: none.
 *
 * Settings `key` values are the flat tenant_config keys the services' resolvers
 * already read (so edits take effect live). Module `key` values are the
 * camelCase module names; they are stored per-app as `module.<app>.<name>` and
 * honored at runtime with the env flag as the default (see moduleGate).
 *
 * Field types: 'text' (default) | 'secret' (masked) | 'json' | 'textarea' |
 * 'time' (HH:MM) | 'time_list' (comma list of HH:MM).
 */

import { IMAGE_VIDEO_MAX_SECONDS, VIDEO_RUNNER_OPTIONS, FAILSAFE_OPTIONS } from '../utils/shortSpec.js';
import { DEFAULT_THUMB_RULES } from '../utils/thumbSpec.js';
import { DEFAULT_COMPARISON_PROMPT } from '../utils/comparisonSpec.js';
import { DEFAULT_COMPARISONS, DEFAULT_COMPARISON_BRAND } from '../utils/comparisonFacts.js';
import { DEFAULT_COPY_PROMPT } from '../utils/aiCopySpec.js';
import { MAIL_PROVIDERS, DEFAULT_MAIL_PROVIDER } from '../utils/mailApis.js';
import { DEFAULT_SCRIPT_PROMPT } from '../utils/stageSpec.js';
import { VIDAPULSE_SYSTEM } from './prompts.js';
import { CTA_PLATFORMS, DEFAULT_CTA, CTA_SEC_OPTIONS, CTA_MAX_LINES, CTA_MAX_CHARS } from '../utils/ctaSpec.js';

const CTA_LABELS = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', linkedin: 'LinkedIn', threads: 'Threads', x: 'X' };

export const APPS = ['api-keys', 'content-engine', 'tracking-bridge'];

export const CONFIG_MANIFEST = {
  // Every provider credential lives HERE, once, for the whole tenant. Funnels
  // never store keys: a funnel only picks which provider/model to use for each
  // action, and the key is taken from this page.
  'api-keys': {
    label: 'Keys and credit',
    blurb: 'All provider keys in one place. Funnels choose the provider/model; the key comes from here.',
    groups: [
      {
        title: 'AI: text & image models',
        fields: [
          { key: 'openai_api_key', label: 'OpenAI API key', type: 'secret' },
          { key: 'image_model', label: 'OpenAI image model', type: 'model_select', catalog: 'openai_image', placeholder: 'gpt-image-2' },
          { key: 'text_model', label: 'OpenAI text model', type: 'model_select', catalog: 'openai_text', placeholder: 'gpt-5-mini' },
          { key: 'anthropic_api_key', label: 'Claude API key (Ready video copy and image prompts; blank = the OpenAI text model)', type: 'secret', help: 'From console.anthropic.com. This is API billing, separate from a Claude chat subscription.' },
          {
            key: 'claude_model', label: 'Claude model', type: 'select', default: 'claude-opus-5',
            options: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }, { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (newer, costs less)' }],
          },
          { key: 'gemini_api_key', label: 'Gemini API key', type: 'secret' },
          { key: 'gemini_image_model', label: 'Gemini image model', type: 'model_select', catalog: 'gemini_image', placeholder: 'models/gemini-3.1-flash-image' },
        ],
      },
      {
        title: 'Animation (image → video)',
        fields: [
          { key: 'kling_access_key', label: 'Kling access key', type: 'secret' },
          { key: 'kling_secret_key', label: 'Kling secret key', type: 'secret' },
          { key: 'runway_api_key', label: 'Runway API key', type: 'secret' },
          { key: 'hailuo_api_key', label: 'Hailuo / MiniMax API key', type: 'secret' },
          { key: 'hailuo_group_id', label: 'Hailuo / MiniMax GroupId', placeholder: 'a long number, e.g. 1234567890123456789', help: 'MiniMax console (platform.minimax.io): Account, Basic information, GroupID. A number, not your email. Hailuo needs it to download each finished clip.' },
        ],
      },
      {
        title: 'Voice & transcript',
        fields: [
          { key: 'elevenlabs_api_key', label: 'ElevenLabs API key', type: 'secret' },
          { key: 'heygen_api_key', label: 'HeyGen API key', type: 'secret' },
          { key: 'transcript_api_key', label: 'Whisper / TurboScribe API key (blank = use the OpenAI key)', type: 'secret' },
        ],
      },
      {
        title: 'Publishing & video',
        fields: [
          { key: 'postforme_api_key', label: 'Post for Me API key', type: 'secret', help: 'One key for every funnel. Leave it blank to post through the shared Post for Me account; connect accounts with Connect an account on a funnel. Each funnel still picks which connected accounts it posts to.' },
          { key: 'json2video_api_key', label: 'JSON2Video API key', type: 'secret' },
        ],
      },
      {
        // Keep Railway until the GitHub run is tested; then switch the default.
        title: 'Video clean (✂ Clean on the ready-video page)',
        fields: [
          {
            key: 'clean_runner',
            label: 'Default place ✂ Clean runs',
            type: 'select',
            default: 'railway',
            options: [{ value: 'railway', label: 'Railway (this server)' }, { value: 'github', label: 'GitHub Actions (cleaned file goes to your Google Drive)' }],
          },
          { key: 'github_actions_token', label: 'GitHub token (fine-grained: this repo only; Actions and Variables = Read and write)', type: 'secret' },
          { key: 'github_repo', label: 'GitHub repo (owner/name)', placeholder: 'ganganarayan/automation' },
          { key: 'github_ref', label: 'Branch the clean runs from (blank = the branch this server was deployed from)', placeholder: 'orbitq on staging, main on production' },
        ],
      },
      {
        title: 'Meta (comment → DM)',
        fields: [
          { key: 'meta_app_id', label: 'Meta app ID' },
          { key: 'meta_app_secret', label: 'Meta app secret', type: 'secret', help: 'Verifies the X-Hub-Signature-256 on every incoming webhook.' },
          { key: 'meta_verify_token', label: 'Webhook verify token', type: 'generated_secret', help: 'Click Generate, then paste the SAME value into the Meta webhook setup screen.' },
          {
            key: 'meta_page_tokens',
            label: 'Page / IG access tokens (JSON: id → token)',
            type: 'secret_json',
            placeholder: '{ "<instagram business account id>": "<page token>", "<page id>": "<page token>" }',
            help: 'Write-only: once saved the tokens are hidden and only the ids are shown; paste fresh JSON to replace them, blank keeps the current value. Map BOTH the Instagram business account id and the Page id to the same Page access token.',
          },
        ],
      },
      {
        title: 'Gmail (LinkedIn relay)',
        fields: [
          { key: 'linkedin_imap_pass', label: 'Gmail app password (blank = use the SMTP password)', type: 'secret' },
        ],
      },
      {
        title: 'Image posts as video',
        fields: [
          {
            key: 'image_video_runner',
            label: 'Where the videos are made (pictures, voice, subtitles and videos, all in one place)',
            type: 'select',
            default: 'github',
            options: VIDEO_RUNNER_OPTIONS,
            help: `Every image post goes out as a video, YouTube Shorts included: the sheet's image prompt drawn in three sizes (9:16 for Instagram, Facebook and YouTube, 4:5 for LinkedIn and Threads, 16:9 for X), the whole caption read aloud in the funnel's chosen ElevenLabs voice (its lane setup) with subtitles burned in, and the music below. The video is exactly as long as the reading (up to ${IMAGE_VIDEO_MAX_SECONDS} s). No voice chosen, or no ElevenLabs key: nothing is posted and the post says why. GitHub uses no Railway memory and almost no Railway egress: it needs the GitHub token under Video clean, Google Drive connected and an OpenAI key. The finished files go to your Google Drive app folder.`,
          },
          {
            key: 'image_video_failsafe',
            label: 'Fail-safe: if it fails there, make it in the other place',
            type: 'select',
            default: 'on',
            options: FAILSAFE_OPTIONS,
            help: 'GitHub counts as failed when it reports an error or has not finished within an hour.',
          },
          { key: 'short_music_url', label: 'Music for every video, with its copyright credit', type: 'textarea', musicList: true, musicPreview: true, rows: 6, placeholder: 'https://drive.google.com/drive/folders/...\nhttps://drive.google.com/file/d/.../view | Song by Artist, CC BY 4.0', help: 'Every video the app makes takes its music from here, for all funnels and lanes (ready videos keep their own sound). Paste a Drive folder link: put the audio files in it, each with a .txt of the same name holding its copyright credit (song.mp3 and song.txt), and share the folder Anyone with the link; add music to it any time. Single file links work too, each with its credit. Each video gets one at random; if it will not load, the next is tried. The credit of the music used is always added as the last line of the post caption (on X only when it still fits). YouTube, Spotify or SoundCloud links are web pages, not files, and are skipped. With no music that loads, the video goes out with the voice only.' },
        ],
      },
      {
        title: 'Call to action on the video',
        fields: [
          {
            key: 'video_cta', label: 'Show a call to action in the middle of each video', type: 'select', default: 'off',
            options: [{ value: 'on', label: 'Yes: each channel gets its own line' }, { value: 'off', label: 'No' }],
            help: 'Ready videos and image-post videos (not festival greetings). Each channel gets its own copy of the video with its line shown as text in the middle, so YouTube can say Subscribe while Instagram says Follow or DM. Nothing is spoken and the video never pauses. On videos over 3 minutes a floating like, follow and bell animation in that channel\'s own look plays 10 seconds before the line, with a click on each tap and a bell, mixed under the video\'s sound. Each video takes the next line in each list, so they rotate. Copies that would be the same are made once; every other copy is one more re-encode on Railway before it posts, so a long video posted to many channels takes several minutes longer. If a copy fails, that channel posts the video without it.',
          },
          { key: 'video_cta_sec', label: 'How long it shows', type: 'select', default: '4', options: CTA_SEC_OPTIONS.map((s) => ({ value: String(s), label: `${s} seconds` })) },
          ...CTA_PLATFORMS.map((p) => ({
            key: `video_cta_${p}`,
            label: `${CTA_LABELS[p]}: one line per video, up to ${CTA_MAX_LINES}, rotated`,
            type: 'textarea', rows: 3, default: DEFAULT_CTA[p].join('\n'), ctaPreview: p,
            ...(p === 'youtube' ? { help: `Up to ${CTA_MAX_CHARS} characters a line. Blank = the lines shown.` } : {}),
          })),
        ],
      },
      {
        // Set once here; every funnel and every LLM call uses them. Blank = the
        // built-in default (shown pre-filled).
        title: 'Comparison videos',
        fields: [
          { key: 'comparison_brand', label: 'Your product name', default: DEFAULT_COMPARISON_BRAND, ownerDefault: true },
          { key: 'comparison_logo', label: 'Your logo (image link or a public Drive link; blank = the name is typed)' },
          { key: 'comparison_list', label: 'Facts per competitor', type: 'textarea', default: DEFAULT_COMPARISONS, ownerDefault: true, help: 'One block per competitor: its name and the date checked, then one line per fact as label | yours | theirs, using yes or no. A video is matched from its file name or transcript, or pick it on the video page. The thumbnail shows the first differences, so keep the strongest on top.' },
        ],
      },
      {
        title: 'System prompts (used by every LLM call)',
        fields: [
          { key: 'system_prompt_global', label: 'Global system prompt: added before every LLM call', type: 'textarea', help: 'House rules for all AI text: voice, language, words to avoid. Leave blank for none.' },
          { key: 'claude_context', label: 'Claude background: what Claude should know, sent with every video', type: 'textarea', help: 'Paste what your Claude chats worked out: who you are, who each funnel is for, your rules, and above all image prompts that gave pictures you liked, with a note on why. Claude reads all of it before writing each video. About 33,000 tokens (roughly 25,000 words) adds about $0.17 a video on Opus 5. Used only when a Claude API key is set.' },
          { key: 'system_prompt_copy', label: 'Ready video copy writer (title, description, captions, thumbnail hook + image prompt)', type: 'textarea', default: DEFAULT_COPY_PROMPT, help: 'The app always adds the JSON output keys, the funnel comment keyword, brand brief and audience after this.' },
          { key: 'system_prompt_thumbnail', label: 'Thumbnail image rules: added after every image prompt', type: 'textarea', default: DEFAULT_THUMB_RULES, help: 'Layout and style for the AI thumbnail picture. The prompt for each video is in its Image prompt box. Comparison videos use no AI picture.' },
          { key: 'system_prompt_comparison', label: 'Comparison video copy writer: added after the copy writer for comparison videos', type: 'textarea', default: DEFAULT_COMPARISON_PROMPT, help: 'The app adds the two product names and the facts from the list below.' },
          { key: 'system_prompt_script', label: 'Video script writer (automated pipeline)', type: 'textarea', default: DEFAULT_SCRIPT_PROMPT, help: "The funnel's script tone is added after this." },
          { key: 'lessons_image', label: 'Learned picture corrections (one per line): added after every image prompt', type: 'textarea', help: 'Filled by your ✕ Disapprove reasons and 🔁 Remake corrections, newest last, the last 20 kept. Edit or delete a line to change what the app follows. Every picture also follows a fixed rule: no text over a face.' },
          { key: 'lessons_video', label: 'Learned video corrections (one per line): added to the video script writer', type: 'textarea', help: 'Filled by your 🎬 Video corrections, newest last, the last 20 kept. Edit or delete a line to change what the app follows.' },
          { key: 'system_prompt_refill', label: 'VidaPulse post refill', type: 'textarea', default: VIDAPULSE_SYSTEM },
          { key: 'transcript_glossary', label: 'Transcript glossary: names and terms to spell exactly (one per line)', type: 'textarea', help: 'Passed to Whisper as its prompt so names like STHIRA or PrATS come out right, and given to the copy writer as the correct spellings. Example: STHIRA, PrATS, Apply Gita Wisdom.' },
        ],
      },
    ],
    modules: [],
  },

  'content-engine': {
    // Only settings shared by every funnel live here. Per-funnel content
    // sources, accounts and schedules are set in each funnel's setup.
    label: 'Settings',
    blurb: 'Settings shared by every funnel: Google access, email, reports, comment capture, LinkedIn relay.',
    groups: [
      {
        title: 'Google (Sheets & Drive access)',
        fields: [
          {
            key: 'google_service_account_json',
            placeholder: 'paste the service-account JSON here',
            label: 'Service account JSON',
            type: 'secret_json',
            help: 'Paste the downloaded Google service-account JSON once. Then share each funnel\'s content sheet and Drive upload folder (Editor) with the service-account email shown above. Blank keeps the current value. (Env GOOGLE_SERVICE_ACCOUNT_JSON is only a fallback.)',
          },
          // "Sign in with Google" + Drive picker for the ready-video pages: the
          // operator signs in in the browser and picks videos; the app then acts
          // only on the picked files (drive.file scope). No client secret needed.
          {
            key: 'google_oauth_client_id',
            label: 'Sign in with Google. OAuth client ID',
            placeholder: '1234567890-abc….apps.googleusercontent.com',
            help: 'Web-application OAuth client. Its Authorized JavaScript origins must include this app\'s address. Used by "📂 Pick from Drive" on the ready-video pages. Also used by "Connect Google Drive" below.',
          },
          {
            key: 'google_oauth_client_secret',
            label: 'OAuth client secret (only for "Connect Google Drive")',
            type: 'secret',
            help: 'The same OAuth client\'s secret. It stays on the server; the browser never sees it.',
          },
          { key: 'google_drive_connect', label: 'Google account (Drive for cleaned videos, Gmail for email)', type: 'drive_connect' },
          {
            key: 'google_picker_api_key',
            label: 'Sign in with Google. Picker API key',
            placeholder: 'AIza…',
            help: 'An API key restricted to the Google Picker API and to this app\'s address (it is visible in the browser, as Google intends).',
          },
          {
            key: 'google_project_number',
            label: 'Sign in with Google. Cloud project number',
            placeholder: 'e.g. 123456789012',
            help: 'The numeric project number from the Google Cloud dashboard (not the project ID).',
          },
        ],
      },
      {
        title: 'Emails',
        fields: [
          { key: 'notify_email', label: 'Notification email', help: 'The daily email (every post, its status and approval link) and alerts go here whenever a funnel has no approval email of its own.' },
          { key: 'report_email', label: 'Report email', help: 'Where the daily delivery reports are sent.' },
          { key: 'public_email', label: 'Public contact email', help: 'Shown to visitors on the website, buy page and policies (trial and contact links). Empty = the notification email.' },
        ],
      },
      {
        // The app sleeps; the owner's Cloudflare waker (Tenants panel) wakes it
        // once a day at this time. Saving a changed time updates Cloudflare.
        title: 'Daily schedule (IST)',
        fields: [
          { key: 'daily_time', label: "Daily time: picks tomorrow's posts, sends the one email with every approval, checks posts, relays LinkedIn", type: 'time', default: '19:00', help: 'The router triggers once a day at this time and is idle the rest of the day. The email goes once every post for tomorrow is ready, usually within minutes. Approve each post before its time; a late approval posts at once.' },
          { key: 'wake_schedule_sync', label: 'Wake-up timer', type: 'wake_sync' },
        ],
      },
      {
        title: 'Comment capture (Meta: Instagram & Facebook auto-DM)',
        fields: [
          { key: 'meta_self_ids', label: 'Our own account IDs (JSON array)', type: 'json', help: 'IG user IDs / Page IDs we post as. Comments FROM these are ignored so we never reply to ourselves. (Meta app ID/secret, verify token and page tokens live under Keys and credit.)' },
          { key: 'capture_abuse_words', label: 'Extra abuse words to block (comma / new line)', type: 'textarea', help: 'Merged with the built-in Hindi + Hinglish + English blocklist. A comment that matches gets logged but no DM is sent.' },
        ],
      },
      {
        title: 'LinkedIn → WhatsApp relay (notify me; no auto-reply)',
        fields: [
          { key: 'linkedin_imap_user', label: 'Gmail address to watch (blank = SMTP user)', help: 'The Gmail app password for this mailbox lives under Keys and credit.' },
          { key: 'linkedin_imap_host', label: 'IMAP host', placeholder: 'imap.gmail.com' },
          { key: 'linkedin_imap_mailbox', label: 'Mailbox / label to watch', placeholder: 'INBOX (or a Gmail label like LinkedIn)' },
          { key: 'linkedin_wa_instance', label: 'WhatsApp (Evolution) instance name' },
          { key: 'linkedin_wa_to', label: 'WhatsApp number to notify (with country code)' },
        ],
      },
      {
        title: 'Email (for approval & status notifications)',
        fields: [
          {
            key: 'mail_provider',
            label: 'Send email through',
            type: 'select',
            default: DEFAULT_MAIL_PROVIDER,
            options: MAIL_PROVIDERS.map(({ value, label }) => ({ value, label })),
            help: 'Railway blocks outbound SMTP. Gmail is free: press Connect Google under Google above and emails go out from that account; no key needed. The others need their own account and a verified domain.',
          },
          { key: 'mail_api_key', label: 'Email API key (not needed for Gmail)', type: 'secret' },
          { key: 'mail_from', label: 'From address (verified with the provider)', placeholder: 'Gita <hello@yourdomain.com>', help: 'Blank = the SMTP From or SMTP user below. Gmail always sends from the connected account and only takes the name from here.' },
          { key: 'smtp_host', label: 'SMTP host (only when sending through SMTP)', placeholder: 'smtp.zoho.com / smtp.gmail.com' },
          { key: 'smtp_port', label: 'SMTP port', placeholder: '587' },
          { key: 'smtp_user', label: 'SMTP user (your email)' },
          { key: 'smtp_pass', label: 'SMTP password (app password)', type: 'secret' },
          { key: 'smtp_from', label: 'SMTP From address (defaults to user)' },
          { key: 'smtp_test', label: 'Test', type: 'smtp_test' },
        ],
      },
    ],
    // Only toggles that tenantSettings.moduleEnabled() checks at runtime belong
    // here. Funnel posters/video/capture always run; the legacy video pipeline,
    // image factory, dashboard and admin routes are env-gated at boot only.
    // (Legacy ig_* / video_* / factory_* keys are no longer edited here; any
    // stored values are still read by tenantSettings.forTenant.)
    modules: [
      {
        key: 'delivery', label: 'Delivery log & failure alerts',
        help: 'Records each Post for Me result (posted / failed) and emails you at once when a post fails. On is recommended.',
      },
    ],
  },

  'tracking-bridge': {
    label: 'tracking-bridge',
    blurb: 'Razorpay → Meta CAPI purchases and daily ad insights.',
    groups: [
      {
        title: 'Razorpay',
        fields: [
          {
            key: 'razorpay_webhook_secret',
            label: 'Razorpay webhook secret',
            type: 'generated_secret',
            help: 'Click Generate, copy the value, and paste it as the "Secret" when you create the webhook in your Razorpay dashboard (point the webhook URL at your tracking-bridge domain + /api/v1/webhook/razorpay-capi, event: payment.captured).',
          },
        ],
      },
      {
        title: 'Meta Conversions API',
        fields: [
          { key: 'meta_pixel_id', label: 'Meta pixel ID' },
          { key: 'meta_capi_token', label: 'Meta CAPI token', type: 'secret' },
          { key: 'meta_api_version', label: 'Meta API version', placeholder: 'v21.0' },
          { key: 'event_source_url', label: 'Event source URL' },
          { key: 'content_name', label: 'Content name' },
        ],
      },
      {
        title: 'Meta Ads insights',
        fields: [
          { key: 'meta_ad_account_id', label: 'Ad account ID (act_...)' },
          { key: 'meta_ads_token', label: 'Meta Ads token', type: 'secret' },
          { key: 'insights_sheet_id', label: 'Insights sheet ID' },
        ],
      },
      {
        title: 'Enrichment (Assess360)',
        fields: [
          { key: 'assess360_url', label: 'Assess360 URL' },
          { key: 'assess360_token', label: 'Assess360 token', type: 'secret' },
        ],
      },
    ],
    modules: [
      { key: 'capi', label: 'Razorpay → CAPI' },
      { key: 'insights', label: 'Daily ad insights' },
    ],
  },
};

/** The tenant_config key used to store a module toggle for an app. */
export function moduleKey(app, name) {
  return `module.${app}.${name}`;
}

/** All settings field keys for an app. */
export function settingKeys(app) {
  const m = CONFIG_MANIFEST[app];
  if (!m) return [];
  return m.groups.flatMap((g) => g.fields.map((f) => f.key));
}

/** Look up a field descriptor by key within an app. */
export function fieldByKey(app, key) {
  const m = CONFIG_MANIFEST[app];
  if (!m) return null;
  for (const g of m.groups) {
    const f = g.fields.find((x) => x.key === key);
    if (f) return f;
  }
  return null;
}

export default { APPS, CONFIG_MANIFEST, moduleKey, settingKeys, fieldByKey };
