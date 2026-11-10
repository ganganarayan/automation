/**
 * Publish provider (interface + Post for Me implementation).
 *
 * Purpose:      Publish social posts and list connected accounts.
 * Responsibility:
 *               - createPost({ accounts, caption, mediaUrl, scheduledAt, perAccountCaption }): result
 *               - listAccounts(): connected accounts
 *               - uploadMedia(buffer, contentType): public media_url (Post for Me storage)
 *               - authUrl({ platform, permissionOverrides, externalId }): connect link
 *
 *               cfg.scope (utils/pfmScope): a tenant on the owner's shared key
 *               only ever sees, posts to, reads or comments on its own accounts
 *               (external_id "<tenantId>" or "<tenantId>:..."). Every guard is
 *               here, so no caller can reach another tenant's account.
 * Dependencies: httpClient, errors, pfmScope.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { filterAccounts, ownsAccount, ownsPost, connectExternalId } from '../utils/pfmScope.js';

const BASE = 'https://api.postforme.dev/v1';
const PAGE = 100;
const MAX_PAGES = 50;
const OWNED_TTL_MS = 60_000;

/** Not this tenant's: never retried, never shown with another tenant's details. */
export class NotYourAccountError extends ExternalAPIError {
  constructor(what = 'account') {
    super(`That Post for Me ${what} is not connected to this workspace`, { status: 403 });
    this.code = 'pfm_not_yours';
    this.retryable = false;
  }
}

export function createPostForMeProvider(cfg, log) {
  const scope = cfg.scope || null;
  let owned = null; // { at, ids: Set } cache of this tenant's account ids
  const requireKey = () => {
    if (!cfg.apiKey) throw new ExternalAPIError('Post for Me not configured (POSTFORME_API_KEY missing)');
    return { Authorization: `Bearer ${cfg.apiKey}` };
  };

  /** Every connected account on the key, all pages (Post for Me pages at offset/limit). */
  async function allAccounts() {
    const headers = requireKey();
    const out = [];
    for (let page = 0, offset = 0; page < MAX_PAGES; page += 1) {
      const res = await request(`${BASE}/social-accounts?${new URLSearchParams({ limit: String(PAGE), offset: String(offset) })}`, {
        method: 'GET', headers, label: 'postforme.listAccounts', log, retries: 1,
      });
      if (!res.ok) throw new ExternalAPIError(`Post for Me accounts lookup failed (${res.status})`, { details: res.text?.slice(0, 300) });
      const rows = Array.isArray(res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
      out.push(...rows);
      const total = Number(res.data?.meta?.total);
      offset += rows.length;
      if (rows.length < PAGE || !res.data?.meta?.next || (Number.isFinite(total) && offset >= total)) break;
    }
    return out;
  }

  async function ownedIds() {
    if (owned && Date.now() - owned.at < OWNED_TTL_MS) return owned.ids;
    const ids = new Set(filterAccounts(scope, await allAccounts()).map((a) => String(a.id)));
    owned = { at: Date.now(), ids };
    return ids;
  }

  /** Refuse any account id this tenant does not own (shared key only). */
  async function guardAccounts(ids = []) {
    if (!scope) return;
    const mine = await ownedIds();
    const bad = ids.map(String).filter((id) => !mine.has(id));
    if (bad.length) {
      log?.warn?.({ tenant: scope.tenantId, accounts: bad }, 'refused a Post for Me account of another tenant');
      throw new NotYourAccountError(bad.length > 1 ? 'accounts' : 'account');
    }
  }

  async function guardPost(id) {
    if (!scope) return;
    const res = await request(`${BASE}/social-posts/${encodeURIComponent(id)}`, { headers: requireKey(), label: 'postforme.getPost', log, retries: 1 });
    if (res.ok && !ownsPost(scope, res.data)) throw new NotYourAccountError('post');
  }

  return {
    scope,
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
      await guardAccounts(accountIds || []);
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
      // Tag the post with its tenant (the shared key's posts are told apart by it).
      if (scope) body.external_id = scope.tenantId;
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

    /** One post: { id, status: draft | scheduled | processing | processed, scheduled_at, ... }. */
    async getPost(id) {
      const res = await request(`${BASE}/social-posts/${encodeURIComponent(id)}`, { headers: requireKey(), label: 'postforme.getPost', log, retries: 1 });
      if (!res.ok) throw new ExternalAPIError(`Post for Me post lookup failed (${res.status})`, { details: res.text?.slice(0, 300) });
      if (!ownsPost(scope, res.data)) throw new NotYourAccountError('post');
      return res.data;
    },

    /** Per-account outcome of a processed post: [{ social_account_id, success, error }]. */
    async postResults(postId) {
      const res = await request(`${BASE}/social-post-results?post_id=${encodeURIComponent(postId)}&limit=50`, { headers: requireKey(), label: 'postforme.postResults', log, retries: 1 });
      if (!res.ok) throw new ExternalAPIError(`Post for Me results lookup failed (${res.status})`, { details: res.text?.slice(0, 300) });
      const rows = Array.isArray(res.data?.data) ? res.data.data : [];
      if (!scope) return rows;
      // Only this tenant's channels: another tenant's result is never seen.
      const mine = await ownedIds();
      return rows.filter((r) => r && mine.has(String(r.social_account_id)));
    },

    /** Delete a post that hasn't gone out yet (a scheduled one). */
    async deletePost(id) {
      await guardPost(id);
      const res = await request(`${BASE}/social-posts/${encodeURIComponent(id)}`, { method: 'DELETE', headers: requireKey(), label: 'postforme.deletePost', log, retries: 0 });
      if (!res.ok && res.status !== 404) throw new ExternalAPIError(`Post for Me delete failed (${res.status})`, { details: res.text?.slice(0, 300) });
      return true;
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

    /** One connected account, with its platform user_id and current access_token. */
    async getAccount(id) {
      const res = await request(`${BASE}/social-accounts/${encodeURIComponent(id)}`, { headers: requireKey(), label: 'postforme.getAccount', log, retries: 1 });
      if (!res.ok) throw new ExternalAPIError(`Post for Me account lookup failed (${res.status})`, { details: res.text?.slice(0, 300) });
      if (!ownsAccount(scope, res.data)) throw new NotYourAccountError('account');
      return res.data;
    },

    /** Register a webhook: { id, url, secret, event_types }. The secret comes back in each call's Post-For-Me-Webhook-Secret header. */
    async createWebhook({ url, eventTypes }) {
      const res = await request(`${BASE}/webhooks`, { method: 'POST', headers: requireKey(), body: { url, event_types: eventTypes }, label: 'postforme.createWebhook', log, retries: 1 });
      if (!res.ok) throw new ExternalAPIError(`Post for Me webhook create failed (${res.status})`, { details: res.text?.slice(0, 300) });
      return res.data;
    },

    /**
     * The URL that (re)connects an account on its platform: { url }. Passing the
     * account's own external_id refreshes that connection in place. On the
     * shared key the link always carries this tenant's external_id.
     */
    async authUrl({ platform, permissionOverrides, externalId }) {
      const body = { platform };
      if (permissionOverrides && permissionOverrides.length) body.platform_data = { [platform]: { permission_overrides: permissionOverrides } };
      const ext = connectExternalId(scope, externalId);
      if (ext) body.external_id = ext;
      const res = await request(`${BASE}/social-accounts/auth-url`, { method: 'POST', headers: requireKey(), body, label: 'postforme.authUrl', log, retries: 1 });
      if (!res.ok || !res.data?.url) throw new ExternalAPIError(`Post for Me connect link failed (${res.status})`, { details: res.text?.slice(0, 300) });
      return res.data;
    },

    /** This tenant's connected accounts, every page: { data, meta: { total } }. */
    async listAccounts() {
      const data = filterAccounts(scope, await allAccounts());
      owned = { at: Date.now(), ids: new Set(data.map((a) => String(a.id))) };
      return { data, meta: { total: data.length } };
    },
  };
}

export default { createPostForMeProvider, NotYourAccountError };
