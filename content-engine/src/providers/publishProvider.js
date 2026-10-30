/**
 * Publish provider (interface + Post for Me implementation).
 *
 * Purpose:      Publish social posts and list connected accounts.
 * Responsibility:
 *               - createPost({ accounts, caption, mediaUrl, scheduledAt, perAccountCaption }): result
 *               - listAccounts(): connected accounts
 *               - uploadMedia(buffer, contentType): public media_url (Post for Me storage)
 * Dependencies: httpClient, errors.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

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

    /** Upload a file (e.g. a thumbnail) to Post for Me's storage; returns its public URL. */
    async uploadMedia(buffer, contentType = 'image/jpeg') {
      const headers = requireKey();
      const res = await request(`${BASE}/media/create-upload-url`, {
        method: 'POST', headers, body: {}, label: 'postforme.createUploadUrl', log, retries: 1,
      });
      const { media_url: mediaUrl, upload_url: uploadUrl } = res.data || {};
      if (!res.ok || !uploadUrl || !mediaUrl) throw new ExternalAPIError(`Post for Me upload URL failed (${res.status})`);
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buffer });
      if (!put.ok) throw new ExternalAPIError(`Post for Me upload failed (${put.status})`);
      return mediaUrl;
    },

    /** Like uploadMedia, but streams a file from disk (a whole video never sits in memory). */
    async uploadFile(path, contentType = 'video/mp4') {
      const headers = requireKey();
      const res = await request(`${BASE}/media/create-upload-url`, {
        method: 'POST', headers, body: {}, label: 'postforme.createUploadUrl', log, retries: 1,
      });
      const { media_url: mediaUrl, upload_url: uploadUrl } = res.data || {};
      if (!res.ok || !uploadUrl || !mediaUrl) throw new ExternalAPIError(`Post for Me upload URL failed (${res.status})`);
      const { size } = await stat(path);
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
        body: Readable.toWeb(createReadStream(path)),
        duplex: 'half',
      });
      if (!put.ok) throw new ExternalAPIError(`Post for Me upload failed (${put.status})`);
      return mediaUrl;
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
