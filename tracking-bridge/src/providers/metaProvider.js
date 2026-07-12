/**
 * Meta Graph API provider (CAPI + insights).
 *
 * Purpose:      Send Conversions API events and pull ad-level insights.
 * Responsibility:
 *               - sendEvent(event, { testEventCode }): posts to the pixel.
 *               - fetchInsights({ level, fields, ... }): paged insights.
 * Dependencies: httpClient, errors.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMetaProvider(cfg, log) {
  const graph = (path) => `https://graph.facebook.com/${cfg.apiVersion}/${path}`;

  return {
    /** POST a single CAPI event. Never throws on Meta errors; returns the body. */
    async sendEvent(event, { testEventCode } = {}) {
      if (!cfg.pixelId || !cfg.capiToken) {
        throw new ExternalAPIError('Meta CAPI not configured (pixel id/token missing)');
      }
      const body = { data: [event] };
      if (testEventCode) body.test_event_code = testEventCode;
      const res = await request(`${graph(cfg.pixelId + '/events')}?access_token=${encodeURIComponent(cfg.capiToken)}`, {
        method: 'POST',
        body,
        label: 'meta.capi',
        log,
        retries: 2,
      });
      return { ok: res.ok, status: res.status, data: res.data, text: res.text };
    },

    /**
     * Fetch ad insights, following paging up to maxPages.
     * @returns {Promise<object[]>} raw insight rows
     */
    async fetchInsights({ adAccountId, fields, since, until, limit = 200, maxPages = 25, pageDelayMs = 300 }) {
      if (!adAccountId || !cfg.adsToken) throw new ExternalAPIError('Meta Ads not configured (account id/token missing)');
      const params = new URLSearchParams({
        level: 'ad',
        time_increment: '1',
        use_unified_attribution_setting: 'true',
        fields: fields.join(','),
        limit: String(limit),
        time_range: JSON.stringify({ since, until }),
        access_token: cfg.adsToken,
      });
      let url = `${graph(`${adAccountId}/insights`)}?${params.toString()}`;
      const rows = [];
      for (let page = 0; page < maxPages && url; page += 1) {
        const res = await request(url, { method: 'GET', label: 'meta.insights', log, retries: 2 });
        if (!res.ok) throw new ExternalAPIError(`Meta insights failed (${res.status})`, { details: res.text?.slice(0, 300) });
        if (Array.isArray(res.data?.data)) rows.push(...res.data.data);
        url = res.data?.paging?.next || null;
        if (url) await sleep(pageDelayMs);
      }
      return rows;
    },
  };
}

export default { createMetaProvider };
