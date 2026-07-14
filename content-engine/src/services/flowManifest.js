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
 * Box shape: { title, desc?, moduleKey?, fieldKeys?: string[], info?: string }
 * Phase shape: { label, columns?: boolean, boxes: Box[] }
 */

export const FLOW_MANIFEST = {
  'wa-gateway': {
    intro:
      'Every customer WhatsApp message flows through one throttled, connection-checked queue into Evolution. Configure each step below.',
    phases: [
      {
        label: 'Triggers (inbound)',
        columns: true,
        boxes: [
          {
            title: 'CRM relay',
            desc: 'CRM event → look up a template → queue the message.',
            moduleKey: 'crmRelay',
            fieldKeys: ['templates_sheet_id', 'templates_sheet_tab'],
          },
          {
            title: 'Raw relays',
            desc: 'Pre-composed CRM messages (gita / vidapulse) → queue as-is.',
            moduleKey: 'rawRelay',
          },
          {
            title: 'Form booking',
            desc: 'Google Form submit → send the calendar-link message.',
            moduleKey: 'formBooking',
            fieldKeys: ['calendar_link'],
          },
          {
            title: 'Delay Relay',
            desc: 'Lead intake → validation → ramped daily drip. Per-account ramp & destination are set in Delay Relay accounts (not here).',
            moduleKey: 'delayRelay',
          },
        ],
      },
      {
        label: 'Emotional Outreach (separate path)',
        boxes: [
          {
            title: 'Emotional Outreach',
            desc: 'Assess360 calls this per lead. Sequence: intro text → voice note → timed statement bubbles → CTA. It bypasses the queue gap (spacing is built in) but still checks the connection.',
            moduleKey: 'emotionalOutreach',
            fieldKeys: ['audio_bands'],
            info:
              'Audio is chosen by band: the lead’s diagnosis is matched to critical / overwhelmed / strained / stable, then one of that band’s Drive voice-note links is sent. Audio is used ONLY in this flow.',
          },
        ],
      },
      {
        label: 'Queue → send',
        boxes: [
          {
            title: 'Message queue',
            desc: 'All triggered messages land here (wa_queue) as QUEUED, tagged by instance.',
            info: 'No settings — this is the buffer the dispatcher drains.',
          },
          {
            title: 'Dispatcher',
            desc: 'Drains the queue safely into Evolution.',
            moduleKey: 'dispatcher',
            info:
              'Sends at most one message per instance per tick, only 06:00–24:00 IST, with a random 180–240s gap, and only when the WhatsApp instance is connected (state = open). These limits are platform settings.',
          },
          {
            title: 'Evolution → WhatsApp',
            desc: 'The WhatsApp gateway this app sends through. This service is the only one that calls Evolution.',
            fieldKeys: ['evolution_base_url', 'evolution_api_key'],
          },
        ],
      },
      {
        label: 'Monitoring',
        columns: true,
        boxes: [
          {
            title: 'Connection monitor',
            desc: 'Evolution posts CONNECTION_UPDATE here; if the instance drops, you get an alert email.',
            moduleKey: 'connectionMonitor',
            fieldKeys: ['alert_email'],
          },
          {
            title: 'Admin API',
            desc: 'Queue purge and operational endpoints (admin key required).',
            moduleKey: 'admin',
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
