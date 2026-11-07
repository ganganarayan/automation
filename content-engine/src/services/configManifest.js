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

import { MUSIC_OPTIONS, DEFAULT_MUSIC, SHORT_SECONDS, IMAGE_VIDEO_OPTIONS, IMAGE_VIDEO_SECONDS, IMAGE_VIDEO_MAX_SECONDS, VIDEO_RUNNER_OPTIONS, FAILSAFE_OPTIONS } from '../utils/shortSpec.js';
import { DEFAULT_THUMB_RULES } from '../utils/thumbSpec.js';
import { DEFAULT_COMPARISON_PROMPT } from '../utils/comparisonSpec.js';
import { DEFAULT_COMPARISONS, DEFAULT_COMPARISON_BRAND } from '../utils/comparisonFacts.js';
import { DEFAULT_COPY_PROMPT } from '../utils/aiCopySpec.js';
import { MAIL_PROVIDERS, DEFAULT_MAIL_PROVIDER } from '../utils/mailApis.js';
import { DEFAULT_SCRIPT_PROMPT } from '../utils/stageSpec.js';
import { VIDAPULSE_SYSTEM } from './prompts.js';

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
          { key: 'postforme_api_key', label: 'Post for Me API key', type: 'secret', help: 'One key for every funnel. Each funnel still picks which connected accounts it posts to.' },
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
            key: 'image_video',
            label: 'How image posts go out',
            type: 'select',
            default: 'on',
            options: IMAGE_VIDEO_OPTIONS,
            help: `When a funnel has no video, its image post is made from the sheet's image prompt, drawn in three sizes (9:16 for Instagram, Facebook and YouTube, 4:5 for LinkedIn and Threads, 16:9 for X) and sent to every channel as a video of the picture with the music below. With the voice on, the whole caption is read aloud in the funnel's chosen ElevenLabs voice (its lane setup) with subtitles burned in, and the video is exactly as long as the reading (up to ${IMAGE_VIDEO_MAX_SECONDS} s). Every video has the voice: a funnel with no voice chosen, or no ElevenLabs key, posts nothing and says why.`,
          },
          {
            key: 'image_video_runner',
            label: 'Where the videos are made (pictures, voice, subtitles and videos, all in one place)',
            type: 'select',
            default: 'github',
            options: VIDEO_RUNNER_OPTIONS,
            help: 'GitHub uses no Railway memory and almost no Railway egress: it needs the GitHub token under Video clean, Google Drive connected and an OpenAI key. The finished files go to your Google Drive app folder.',
          },
          {
            key: 'image_video_failsafe',
            label: 'Fail-safe: if it fails there, make it in the other place',
            type: 'select',
            default: 'on',
            options: FAILSAFE_OPTIONS,
            help: 'GitHub counts as failed when it reports an error or has not finished within an hour.',
          },
          {
            key: 'short_music',
            label: 'Music (image-post videos and YouTube Shorts)',
            type: 'select',
            default: DEFAULT_MUSIC,
            options: MUSIC_OPTIONS,
            help: `YouTube takes no image posts through its API, so an image post goes there as a ${SHORT_SECONDS}-second video of the picture. It costs no AI. The built-in tracks are generated by the app, so nothing can be claimed for copyright.`,
          },
          { key: 'short_music_url', label: 'My own music: a public Drive or direct link (used only when picked above)', help: 'Use music you have the rights to. YouTube can claim anything else.' },
        ],
      },
      {
        // Set once here; every funnel and every LLM call uses them. Blank = the
        // built-in default (shown pre-filled).
        title: 'Comparison videos',
        fields: [
          { key: 'comparison_brand', label: 'Your product name', default: DEFAULT_COMPARISON_BRAND },
          { key: 'comparison_logo', label: 'Your logo (image link or a public Drive link; blank = the name is typed)' },
          { key: 'comparison_list', label: 'Facts per competitor', type: 'textarea', default: DEFAULT_COMPARISONS, help: 'One block per competitor: its name and the date checked, then one line per fact as label | yours | theirs, using yes or no. A video is matched from its file name or transcript, or pick it on the video page. The thumbnail shows the first differences, so keep the strongest on top.' },
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
        ],
      },
      {
        // The app sleeps; GitHub Actions (.github/workflows/wake.yml) wakes it
        // at these times, read from the repo variable WAKE_SCHEDULE that the
        // Sync button (and saving here) writes. Blank = the default.
        title: 'Daily schedule (IST)',
        fields: [
          { key: 'router_check_time', label: "Daily check: picks tomorrow's post and sends approvals", type: 'time', default: '16:00' },
          { key: 'nudge_time', label: 'Morning nudge if the video lanes are empty', type: 'time', default: '10:00' },
          { key: 'post_check_times', label: 'Backup checks that posts went live', type: 'time_list', default: '08:20, 20:20', placeholder: '08:20, 20:20', help: 'HH:MM, 24-hour, comma-separated.' },
          { key: 'relay_times', label: 'LinkedIn → WhatsApp relay runs', type: 'time_list', default: '09:30, 21:30', placeholder: '09:30, 21:30', help: 'HH:MM, 24-hour, comma-separated. Each run wakes the app, so a handful of times a day keeps it cheap.' },
          { key: 'wake_schedule_sync', label: 'GitHub wake-up times', type: 'wake_sync' },
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
        key: 'delivery', label: 'Delivery log & daily reports',
        help: 'Records each Post for Me result (posted / failed) and emails the daily delivery reports (08:30 IST). On is recommended.',
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
