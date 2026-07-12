/**
 * Enrichment provider (interface + Assess360 implementation).
 *
 * Purpose:      Enrich a buyer with match signals (fbclid/fbp/fbc/ip/ua).
 * Responsibility: match({ email, phone }) -> { found, ... } (tolerant of any
 *               failure — enrichment is best-effort and must never block CAPI).
 * Dependencies: httpClient.
 */
import { request } from '../core/httpClient.js';

export function createAssess360Provider(cfg, log) {
  return {
    async match({ email, phone }) {
      if (!cfg.url || !cfg.token) return { found: false };
      try {
        const params = new URLSearchParams();
        if (email) params.set('email', email);
        if (phone) params.set('phone', phone);
        const res = await request(`${cfg.url}/api/v1/meta-match?${params.toString()}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${cfg.token}` },
          label: 'assess360.match',
          log,
          retries: 1,
          timeoutMs: 8000,
        });
        if (res.ok && res.data) return { found: !!res.data.found, ...res.data };
        return { found: false };
      } catch (err) {
        log.warn({ err: err.message }, 'assess360 enrichment failed (continuing)');
        return { found: false };
      }
    },
  };
}

export default { createAssess360Provider };
