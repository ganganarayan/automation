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

export const APPS = ['content-engine', 'tracking-bridge'];

export const CONFIG_MANIFEST = {
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
        title: 'AI keys (shared by all funnels)',
        fields: [
          { key: 'openai_api_key', label: 'OpenAI API key', type: 'secret' },
          { key: 'image_model', label: 'OpenAI image model', placeholder: 'gpt-image-2' },
          { key: 'text_model', label: 'OpenAI text model', placeholder: 'gpt-5-mini' },
          { key: 'gemini_api_key', label: 'Gemini API key', type: 'secret' },
          { key: 'gemini_image_model', label: 'Gemini image model', placeholder: 'models/gemini-3.1-flash-image' },
          { key: 'json2video_api_key', label: 'JSON2Video API key', type: 'secret' },
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
          { key: 'meta_app_id', label: 'Meta app ID' },
          { key: 'meta_app_secret', label: 'Meta app secret', type: 'secret', help: 'Used to verify the X-Hub-Signature-256 on every incoming webhook. Never leaves the server.' },
          { key: 'meta_verify_token', label: 'Webhook verify token', type: 'generated_secret', help: 'Click Generate, then paste the SAME value into the Meta webhook setup screen. Meta echoes it back once to confirm the callback URL.' },
          { key: 'meta_page_tokens', label: 'Page / IG access tokens (JSON: id → token)', type: 'json', help: 'Map each Facebook Page ID and Instagram account ID to its long-lived access token, e.g. {"178…":"EAAG…"}. Used to send the DM and public reply. (Step 4.)' },
          { key: 'meta_self_ids', label: 'Our own account IDs (JSON array)', type: 'json', help: 'IG user IDs / Page IDs we post as. Comments FROM these are ignored so we never reply to ourselves.' },
          { key: 'capture_abuse_words', label: 'Extra abuse words to block (comma / new line)', type: 'textarea', help: 'Merged with the built-in Hindi + Hinglish + English blocklist. A comment that matches gets logged but no DM is sent.' },
        ],
      },
      {
        title: 'LinkedIn → WhatsApp relay (notify me; no auto-reply)',
        fields: [
          { key: 'linkedin_imap_user', label: 'Gmail address to watch (blank = SMTP user)' },
          { key: 'linkedin_imap_pass', label: 'Gmail app password (blank = SMTP password)', type: 'secret', help: 'A Gmail app password (same kind as SMTP). The relay reads this mailbox over IMAP, it never sends from it.' },
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
