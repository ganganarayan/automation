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
 * Field types: 'text' (default) | 'secret' (masked) | 'json' | 'textarea'.
 */

export const APPS = ['api-keys', 'content-engine', 'tracking-bridge'];

export const CONFIG_MANIFEST = {
  // Every provider credential lives HERE, once, for the whole tenant. Funnels
  // never store keys — a funnel only picks which provider/model to use for each
  // action, and the key is taken from this page.
  'api-keys': {
    label: 'API Keys',
    blurb: 'All provider keys in one place. Funnels choose the provider/model; the key comes from here.',
    groups: [
      {
        title: 'AI — text & image models',
        fields: [
          { key: 'openai_api_key', label: 'OpenAI API key', type: 'secret' },
          { key: 'image_model', label: 'OpenAI image model', placeholder: 'gpt-image-2' },
          { key: 'text_model', label: 'OpenAI text model', placeholder: 'gpt-5-mini' },
          { key: 'gemini_api_key', label: 'Gemini API key', type: 'secret' },
          { key: 'gemini_image_model', label: 'Gemini image model', placeholder: 'models/gemini-3.1-flash-image' },
        ],
      },
      {
        title: 'Animation (image → video)',
        fields: [
          { key: 'kling_access_key', label: 'Kling access key', type: 'secret' },
          { key: 'kling_secret_key', label: 'Kling secret key', type: 'secret' },
          { key: 'runway_api_key', label: 'Runway API key', type: 'secret' },
          { key: 'hailuo_api_key', label: 'Hailuo / MiniMax API key', type: 'secret' },
          { key: 'hailuo_group_id', label: 'Hailuo / MiniMax GroupId', placeholder: 'from the MiniMax console' },
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
        title: 'Meta (comment → DM)',
        fields: [
          { key: 'meta_app_id', label: 'Meta app ID' },
          { key: 'meta_app_secret', label: 'Meta app secret', type: 'secret', help: 'Verifies the X-Hub-Signature-256 on every incoming webhook.' },
          { key: 'meta_verify_token', label: 'Webhook verify token', type: 'generated_secret', help: 'Click Generate, then paste the SAME value into the Meta webhook setup screen.' },
          { key: 'meta_page_tokens', label: 'Page / IG access tokens (JSON: id → token)', type: 'json' },
        ],
      },
      {
        title: 'Gmail (LinkedIn relay)',
        fields: [
          { key: 'linkedin_imap_pass', label: 'Gmail app password (blank = use the SMTP password)', type: 'secret' },
        ],
      },
    ],
    modules: [],
  },

  'content-engine': {
    label: 'content-engine',
    blurb: 'Content generation, approval, publishing, reports, dashboard.',
    groups: [
      {
        title: 'Google (Sheets & Drive access)',
        fields: [
          {
            key: 'google_service_account_json',
            label: 'Service account JSON',
            type: 'secret_json',
            help: 'Paste the downloaded Google service-account JSON once. Then share each funnel\'s content sheet and Drive upload folder (Editor) with the service-account email shown above. Blank keeps the current value. (Env GOOGLE_SERVICE_ACCOUNT_JSON is only a fallback.)',
          },
        ],
      },
      {
        title: 'Reports & Instagram automation',
        fields: [
          { key: 'report_email', label: 'Report email' },
          { key: 'ig_automation_url', label: 'IG automation URL' },
          { key: 'ig_contact_email', label: 'IG contact email' },
          { key: 'ig_comment_webhook_url', label: 'IG comment webhook URL' },
        ],
      },
      {
        title: 'Comment capture (Meta — Instagram & Facebook auto-DM)',
        fields: [
          { key: 'meta_self_ids', label: 'Our own account IDs (JSON array)', type: 'json', help: 'IG user IDs / Page IDs we post as. Comments FROM these are ignored so we never reply to ourselves. (Meta app ID/secret, verify token and page tokens live under API Keys.)' },
          { key: 'capture_abuse_words', label: 'Extra abuse words to block (comma / new line)', type: 'textarea', help: 'Merged with the built-in Hindi + Hinglish + English blocklist. A comment that matches gets logged but no DM is sent.' },
        ],
      },
      {
        title: 'LinkedIn → WhatsApp relay (notify me; no auto-reply)',
        fields: [
          { key: 'linkedin_imap_user', label: 'Gmail address to watch (blank = SMTP user)', help: 'The Gmail app password for this mailbox lives under API Keys.' },
          { key: 'linkedin_imap_host', label: 'IMAP host', placeholder: 'imap.gmail.com' },
          { key: 'linkedin_imap_mailbox', label: 'Mailbox / label to watch', placeholder: 'INBOX (or a Gmail label like LinkedIn)' },
          { key: 'linkedin_wa_instance', label: 'WhatsApp (Evolution) instance name' },
          { key: 'linkedin_wa_to', label: 'WhatsApp number to notify (with country code)' },
        ],
      },
      {
        title: 'Email (SMTP — for approval & status notifications)',
        fields: [
          { key: 'smtp_host', label: 'SMTP host', placeholder: 'smtp.zoho.com / smtp.gmail.com' },
          { key: 'smtp_port', label: 'SMTP port', placeholder: '587' },
          { key: 'smtp_user', label: 'SMTP user (your email)' },
          { key: 'smtp_pass', label: 'SMTP password (app password)', type: 'secret' },
          { key: 'smtp_from', label: 'From address (defaults to user)' },
          { key: 'smtp_test', label: 'Test', type: 'smtp_test' },
        ],
      },
      {
        title: 'Video & image factory (advanced)',
        fields: [
          { key: 'video_sheet_id', label: 'Video sheet ID' },
          { key: 'voiceover_folder_id', label: 'Voiceover folder ID' },
          { key: 'reels_folder_id', label: 'Reels folder ID' },
          { key: 'factory_sheet_id', label: 'Image factory sheet ID' },
          { key: 'factory_gpt_folder_id', label: 'Factory GPT folder ID' },
          { key: 'factory_gemini_folder_id', label: 'Factory Gemini folder ID' },
        ],
      },
    ],
    modules: [
      { key: 'vidapulseRefill', label: 'Content refill' },
      { key: 'delivery', label: 'Delivery log & reports' },
      { key: 'videoPipeline', label: 'Video pipeline' },
      { key: 'imageFactory', label: 'AI image factory' },
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'admin', label: 'Admin API' },
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
