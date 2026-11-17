/**
 * Meta webhook connection (check + connect).
 *
 * Purpose:      Make Meta actually send comments and DMs to this app. Two links
 *               must exist, and nothing else in the app creates them:
 *                 1. the Meta app is subscribed to our callback URL for the
 *                    "page" (feed, messages) and "instagram" (comments, messages)
 *                    objects, and
 *                 2. each Facebook Page has the app installed (subscribed_apps)
 *                    with feed + messages.
 *               Without both, Meta sends nothing and no keyword ever gets a DM.
 * Responsibility: Graph calls + a plain status report. No HTML, no DB writes
 *               (the caller saves a generated verify token).
 * Dependencies: httpClient (lazy, injectable for tests). Tokens travel in the
 *               Authorization header, never the URL.
 */
const GRAPH = 'https://graph.facebook.com';
const VERSION = 'v21.0';

export const APP_OBJECTS = [
  { object: 'page', fields: ['feed', 'messages'] },
  { object: 'instagram', fields: ['comments', 'messages'] },
];
export const PAGE_FIELDS = ['feed', 'messages'];

let _httpRequest = null;
async function realRequest(url, opts) {
  if (!_httpRequest) ({ request: _httpRequest } = await import('../core/httpClient.js'));
  return _httpRequest(url, opts);
}

function errText(res) {
  const e = res?.data?.error;
  if (e) return `${e.code ?? res.status}: ${e.message || 'graph error'}`;
  return `graph ${res?.status || '?'}`;
}

/** Which of the wanted fields an app subscription row is missing. */
export function missingFields(row, wanted) {
  const have = new Set((row?.fields || []).map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean));
  return wanted.filter((f) => !have.has(f));
}

export function createMetaConnect({ request = realRequest, log } = {}) {
  const call = async (path, { method = 'GET', token, body } = {}, label = 'meta.connect') => {
    const res = await request(`${GRAPH}/${VERSION}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      label,
      log,
      retries: 0,
    });
    return res;
  };

  /** App-level subscriptions: one line per object, ok when URL + fields match. */
  async function appStatus(cfg, callbackUrl) {
    if (!cfg.appId || !cfg.appSecret) {
      return APP_OBJECTS.map((o) => ({ object: o.object, ok: false, note: 'Meta app id and app secret are not saved in Settings' }));
    }
    const res = await call(`${encodeURIComponent(cfg.appId)}/subscriptions`, { token: `${cfg.appId}|${cfg.appSecret}` }, 'meta.appSubs');
    if (!res.ok) return APP_OBJECTS.map((o) => ({ object: o.object, ok: false, note: `could not read: ${errText(res)}` }));
    const rows = Array.isArray(res.data?.data) ? res.data.data : [];
    return APP_OBJECTS.map((o) => {
      const row = rows.find((r) => r.object === o.object);
      if (!row) return { object: o.object, ok: false, note: 'not subscribed' };
      if (row.active === false) return { object: o.object, ok: false, note: 'subscription is off' };
      if (row.callback_url !== callbackUrl) return { object: o.object, ok: false, note: `sends to ${row.callback_url || '?'}, not this app` };
      const miss = missingFields(row, o.fields);
      if (miss.length) return { object: o.object, ok: false, note: `missing ${miss.join(', ')}` };
      return { object: o.object, ok: true, note: o.fields.join(', ') };
    });
  }

  /** Is this id a Facebook Page (the subscribed_apps edge only exists on Pages)? */
  async function pageName(id, token) {
    const res = await call(`${encodeURIComponent(id)}?fields=name,instagram_business_account`, { token }, 'meta.pageInfo');
    return res.ok ? (res.data?.name || id) : null;
  }

  /** Page installs: every saved Page token's Page must have this app with feed + messages. */
  async function pageStatus(cfg) {
    const out = [];
    for (const [id, token] of Object.entries(cfg.pageTokens || {})) {
      if (!token) continue;
      const name = await pageName(id, token);
      if (!name) continue; // an Instagram account id: covered by its Page
      const res = await call(`${encodeURIComponent(id)}/subscribed_apps`, { token }, 'meta.pageSubs');
      if (!res.ok) { out.push({ id, name, ok: false, note: `could not read: ${errText(res)}` }); continue; }
      const mine = (res.data?.data || []).find((a) => String(a.id) === String(cfg.appId));
      if (!mine) { out.push({ id, name, ok: false, note: 'app not installed on this Page' }); continue; }
      const miss = PAGE_FIELDS.filter((f) => !(mine.subscribed_fields || []).includes(f));
      out.push(miss.length ? { id, name, ok: false, note: `missing ${miss.join(', ')}` } : { id, name, ok: true, note: PAGE_FIELDS.join(', ') });
    }
    return out;
  }

  async function status(cfg, callbackUrl) {
    const [app, pages] = await Promise.all([appStatus(cfg, callbackUrl), pageStatus(cfg)]);
    return { callbackUrl, app, pages };
  }

  /** Create both links. Meta calls our GET verify endpoint during step 1. */
  async function connect(cfg, callbackUrl) {
    const errors = [];
    if (!cfg.appId || !cfg.appSecret) errors.push('Save the Meta app id and app secret in Settings first.');
    else if (!cfg.verifyToken) errors.push('No verify token saved.');
    else {
      for (const o of APP_OBJECTS) {
        const res = await call(`${encodeURIComponent(cfg.appId)}/subscriptions`, {
          method: 'POST',
          token: `${cfg.appId}|${cfg.appSecret}`,
          body: { object: o.object, callback_url: callbackUrl, fields: o.fields.join(','), verify_token: cfg.verifyToken, include_values: true },
        }, 'meta.appSubscribe');
        if (!res.ok) errors.push(`${o.object}: ${errText(res)}`);
      }
    }
    for (const [id, token] of Object.entries(cfg.pageTokens || {})) {
      if (!token) continue;
      const name = await pageName(id, token);
      if (!name) continue;
      const res = await call(`${encodeURIComponent(id)}/subscribed_apps`, {
        method: 'POST', token, body: { subscribed_fields: PAGE_FIELDS.join(',') },
      }, 'meta.pageSubscribe');
      if (!res.ok) errors.push(`${name}: ${errText(res)}`);
    }
    if (!Object.keys(cfg.pageTokens || {}).length) errors.push('No Page tokens saved, so no Page could be connected.');
    return { errors, ...(await status(cfg, callbackUrl)) };
  }

  return { status, connect };
}

export const metaConnect = createMetaConnect();
export default { createMetaConnect, metaConnect, missingFields, APP_OBJECTS, PAGE_FIELDS };
