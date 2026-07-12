/**
 * Emotional outreach service.
 *
 * Purpose:      Run the band-matched voice-note + AI-statement bubble sequence
 *               for a single lead. Upstream (Assess360) rate-limits calls, so
 *               this service does no throttling of its own — but it does check
 *               connectionState before sending.
 * Responsibility:
 *               1. Map diagnosis -> band and pick a random audio URL.
 *               2. Send intro text.
 *               3. Wait 8-12s, send the voice note.
 *               4. Wait 50-70s, split the AI statement into bubbles and send
 *                  each with its per-bubble typing delay.
 *               5. Send the final CTA bubble.
 * Dependencies: WhatsAppProvider, text utils, tenantSettings.
 *
 * These sends bypass the wa_queue gap throttle (spacing is inherent in the
 * sequence) but still verify the instance is open first.
 */
import { createEvolutionProvider } from '../providers/whatsappProvider.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { splitIntoBubbles } from '../utils/text.js';
import { hasMinDigits } from '../utils/phone.js';
import { childLogger } from '../core/logger.js';

const INSTANCE = 'gita';

const BAND_KEYWORDS = [
  { band: 'critical', re: /(crisis|severe|critical|breakdown|suicid)/i },
  { band: 'overwhelmed', re: /(overwhelm|anxious|anxiety|panic|burnout)/i },
  { band: 'strained', re: /(strain|stress|struggl|tension|pressure)/i },
  { band: 'stable', re: /(stable|balanced|calm|mild|manage)/i },
];

/** Map a free-text diagnosis to a band; default 'strained'. */
export function bandForDiagnosis(diagnosis) {
  const text = String(diagnosis || '');
  for (const { band, re } of BAND_KEYWORDS) if (re.test(text)) return band;
  return 'strained';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const randMs = (loS, hiS) => Math.round((loS + Math.random() * (hiS - loS)) * 1000);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

/**
 * @param {string} tenantId
 * @param {object} lead - { name, number, assessment_diagnosis, ai_statement }
 */
export async function run(tenantId, lead) {
  const log = childLogger({ module: 'emotionalOutreach', tenant_id: tenantId });
  const number = String(lead.number || lead.phone || '').replace(/\D+/g, '');
  if (!hasMinDigits(number, 12)) {
    log.warn('lead number too short; skipping');
    return { skipped: true, reason: 'short number' };
  }

  const resolved = await tenantSettings.forTenant(tenantId);
  const bands = resolved.outreach.audioBands || {};
  const band = bandForDiagnosis(lead.assessment_diagnosis);
  const options = Array.isArray(bands[band]) ? bands[band] : [];
  const audioUrl = options.length ? options[Math.floor(Math.random() * options.length)] : null;
  if (!audioUrl) {
    log.warn({ band }, 'no audio URL for band; skipping');
    return { skipped: true, reason: 'no audio' };
  }

  const wa = createEvolutionProvider(resolved.evolution, log);
  const state = await wa.connectionState(INSTANCE).catch(() => 'unknown');
  if (state !== 'open') {
    log.warn({ state }, 'instance not open; aborting outreach');
    return { skipped: true, reason: 'not open' };
  }

  const fn = firstName(lead.name);

  // 2. intro text
  await safeSend(wa, number, `Namaste ${fn}, this is Ganga Narayan Das. I looked at what you shared and wanted to reach out personally.`, log);

  // 3. voice note after 8-12s
  await wait(randMs(8, 12));
  await wa.sendAudio(INSTANCE, number, audioUrl).catch((err) => log.warn({ err: err.message }, 'audio send failed'));

  // 4. AI statement bubbles after 50-70s
  await wait(randMs(50, 70));
  const bubbles = splitIntoBubbles(lead.ai_statement);
  for (const bubble of bubbles) {
    await wait(bubble.delaySeconds * 1000);
    await safeSend(wa, number, bubble.text, log, bubble.delaySeconds * 1000);
  }

  // 5. final CTA
  await wait(randMs(4, 6));
  await safeSend(wa, number, 'If even part of this felt true, just reply here and we can take the next small step together.', log);

  log.info({ band, bubbles: bubbles.length }, 'outreach sequence complete');
  return { skipped: false, band, bubbles: bubbles.length };
}

async function safeSend(wa, number, text, log, delayMs) {
  try {
    await wa.sendText(INSTANCE, number, text, delayMs ? { delay: delayMs } : {});
  } catch (err) {
    log.warn({ err: err.message }, 'outreach send error (continuing)');
  }
}

export default { run, bandForDiagnosis };
