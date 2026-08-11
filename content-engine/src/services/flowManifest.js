/**
 * Flow manifests.
 *
 * Purpose:      Describe a service's pipeline as an ordered set of phases and
 *               step-boxes for the flowchart config view. Each box references
 *               existing manifest field keys and a module key — no field or
 *               value duplication; the flowchart is purely a layout over the
 *               same config the flat form edits.
 * Responsibility: Pure data.
 * Dependencies: none.
 *
 * Box shape: { title, desc?, moduleKey?, fieldKeys?: string[], info? }
 * Phase shape: { label, columns?: boolean, boxes: Box[] }
 */

export const FLOW_MANIFEST = {
  'tracking-bridge': {
    intro:
      'Turns a Razorpay purchase into a fully-matched Meta Conversions API event, and pulls daily ad insights. Configure each step below.',
    phases: [
      {
        label: 'Inbound',
        boxes: [
          {
            title: 'Razorpay webhook',
            desc: 'Receives payment.captured and verifies the signature (invalid → silently dropped).',
            moduleKey: 'capi',
            fieldKeys: ['razorpay_webhook_secret'],
            info: 'Generate the secret here, paste it into your Razorpay dashboard, and point the webhook at this service /api/v1/webhook/razorpay-capi (event: payment.captured).',
          },
        ],
      },
      {
        label: 'Enrich',
        boxes: [
          {
            title: 'Assess360 match',
            desc: 'Looks up the buyer to fetch fbclid / fbp / fbc / ip / ua (best-effort; falls back to the payment notes).',
            fieldKeys: ['assess360_url', 'assess360_token'],
          },
        ],
      },
      {
        label: 'Send to Meta',
        boxes: [
          {
            title: 'Meta Conversions API',
            desc: 'Builds a Purchase event (hashed email+phone, fbc/fbp/ip/ua ladders, payment id as event_id for dedup) and posts to your pixel.',
            fieldKeys: ['meta_pixel_id', 'meta_capi_token', 'meta_api_version', 'event_source_url', 'content_name'],
          },
        ],
      },
      {
        label: 'Daily insights',
        boxes: [
          {
            title: 'Ad insights → Sheet',
            desc: 'Daily 07:00 IST: pulls ad-level Meta insights for the lookback window and upserts them into a Google Sheet (idempotent).',
            moduleKey: 'insights',
            fieldKeys: ['meta_ad_account_id', 'meta_ads_token', 'insights_sheet_id'],
          },
        ],
      },
    ],
  },
};

export function hasFlow(app) {
  return !!FLOW_MANIFEST[app];
}

export default { FLOW_MANIFEST, hasFlow };
