/**
 * WhatsApp client (wa-gateway internal send).
 *
 * Purpose:      Send WhatsApp messages by calling the wa-gateway service. This
 *               service NEVER calls Evolution directly.
 * Responsibility: send({ instance, number, message }).
 * Dependencies: httpClient, errors.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';

export function createWaGatewayClient(cfg, log) {
  return {
    async send({ instance, number, message, tenantId = 'default' }) {
      if (!cfg.url) throw new ExternalAPIError('WA_GATEWAY_URL not configured');
      const path = tenantId && tenantId !== 'default' ? `/t/${tenantId}/api/v1/send` : '/api/v1/send';
      const res = await request(`${cfg.url}${path}`, {
        method: 'POST',
        headers: { 'X-Internal-Key': cfg.internalKey },
        body: { instance, number, message },
        label: 'wa-gateway.send',
        log,
        retries: 1,
      });
      if (!res.ok) throw new ExternalAPIError(`wa-gateway send failed (${res.status})`);
      return res.data;
    },
  };
}

export default { createWaGatewayClient };
