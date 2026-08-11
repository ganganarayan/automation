/**
 * Publish provider (interface + Post for Me implementation).
 *
 * Purpose:      Publish social posts and list connected accounts.
 * Responsibility:
 *               - createPost({ accounts, caption, mediaUrl, scheduledAt, perAccountCaption }): result
 *               - listAccounts(): connected accounts
 * Dependencies: httpClient, errors.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';

const BASE = 'https://api.postforme.dev/v1';

export function createPostForMeProvider(cfg, log) {
  const requireKey = () => {
    if (!cfg.apiKey) throw new ExternalAPIError('Post for Me not configured (POSTFORME_API_KEY missing)');
    return { Authorization: `Bearer ${cfg.apiKey}` };
  };

  return {
    /**
     * @param {object} args
     * @param {string[]} args.accountIds
     * @param {string} args.caption            - default caption
     * @param {string} args.mediaUrl
     * @param {string} args.scheduledAt         - ISO
     * @param {Record<string,string>} [args.perAccountCaption] - accountId -> caption override
     * @param {Record<string,{caption:string}>} [args.platformConfigurations] - per-platform caption (e.g. { linkedin:{caption}, facebook:{caption} })
     */
    async createPost({ accountIds, caption, mediaUrl, scheduledAt, perAccountCaption, platformConfigurations }) {
      const headers = requireKey();
      const usePerAccount = perAccountCaption && Object.keys(perAccountCaption).length > 0;
      const body = {
        caption,
        // Per-account captions -> [{id,caption}]; otherwise an array of ids and
        // (optionally) per-platform captions, matching Post for Me's shape.
        social_accounts: usePerAccount
          ? accountIds.map((id) => ({ id, caption: perAccountCaption[id] || caption }))
          : accountIds,
        media: mediaUrl ? [{ url: mediaUrl }] : undefined,
        scheduled_at: scheduledAt,
      };
      if (platformConfigurations) body.platform_configurations = platformConfigurations;
      const res = await request(`${BASE}/social-posts`, {
        method: 'POST',
        headers,
        body,
        label: 'postforme.createPost',
        log,
        retries: 2,
      });
      if (!res.ok) throw new ExternalAPIError(`Post for Me create failed (${res.status})`, { details: res.text?.slice(0, 500) });
      return res.data;
    },

    async listAccounts() {
      const headers = requireKey();
      const res = await request(`${BASE}/social-accounts?limit=50`, {
        method: 'GET',
        headers,
        label: 'postforme.listAccounts',
        log,
        retries: 1,
      });
      return res.data;
    },
  };
}

export default { createPostForMeProvider };
