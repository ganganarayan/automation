/**
 * WhatsApp provider (interface + Evolution implementation).
 *
 * Purpose:      Abstract the WhatsApp gateway so business logic depends on an
 *               interface, not on Evolution's specific HTTP shape.
 * Responsibility:
 *               - connectionState(instance): 'open' | other
 *               - sendText(instance, number, text): { ok, id }
 *               - sendAudio(instance, number, audioUrl): { ok }
 * Dependencies: httpClient, errors.
 *
 * wa-gateway is the ONLY service that talks to Evolution directly.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';

/**
 * @typedef {object} WhatsAppProvider
 * @property {(instance: string) => Promise<string>} connectionState
 * @property {(instance: string, number: string, text: string, opts?: object) => Promise<{ok: boolean, id: string|null}>} sendText
 * @property {(instance: string, number: string, audioUrl: string) => Promise<{ok: boolean}>} sendAudio
 */

/**
 * Build an Evolution-backed WhatsAppProvider.
 * @param {object} cfg - { baseUrl, apiKey }
 * @param {import('pino').Logger} [log]
 * @returns {WhatsAppProvider}
 */
export function createEvolutionProvider(cfg, log) {
  const headers = () => ({ apikey: cfg.apiKey, 'Content-Type': 'application/json' });

  if (!cfg.baseUrl) {
    // A provider that always reports "closed" so the dispatcher safely holds
    // messages when Evolution is not configured (e.g. local smoke tests).
    return {
      async connectionState() {
        return 'unconfigured';
      },
      async sendText() {
        throw new ExternalAPIError('Evolution base URL not configured');
      },
      async sendAudio() {
        throw new ExternalAPIError('Evolution base URL not configured');
      },
    };
  }

  return {
    async connectionState(instance) {
      const res = await request(`${cfg.baseUrl}/instance/connectionState/${instance}`, {
        method: 'GET',
        headers: headers(),
        label: 'evolution.connectionState',
        log,
        retries: 1,
      });
      // Evolution returns { instance: { state } } or { state }
      const state = res.data?.instance?.state ?? res.data?.state ?? null;
      return state || 'unknown';
    },

    async sendText(instance, number, text, opts = {}) {
      const body = { number, text };
      if (opts.delay) body.delay = opts.delay;
      const res = await request(`${cfg.baseUrl}/message/sendText/${instance}`, {
        method: 'POST',
        headers: headers(),
        body,
        label: 'evolution.sendText',
        log,
        retries: 1,
      });
      const id = res.data?.key?.id ?? null;
      return { ok: !!id, id };
    },

    async sendAudio(instance, number, audioUrl) {
      const res = await request(`${cfg.baseUrl}/message/sendWhatsAppAudio/${instance}`, {
        method: 'POST',
        headers: headers(),
        body: { number, audio: audioUrl },
        label: 'evolution.sendAudio',
        log,
        retries: 1,
      });
      return { ok: res.ok };
    },
  };
}

export default { createEvolutionProvider };
