/**
 * First-comment senders (one per platform).
 *
 * Purpose:      Post the first comment under a just-published post, as the
 *               account that published it, with that account's own token
 *               (Post for Me hands it back on GET /social-accounts/{id}).
 * Responsibility: Build each platform's comment request and classify the
 *               response: err.retryable on 5xx / 429 only.
 * Dependencies: httpClient (lazy, injectable for tests). Tokens travel in the
 *               Authorization header, never the URL.
 *
 *   facebook:  POST graph.facebook.com/{post-id}/comments        { message }
 *   instagram: POST graph.facebook.com|graph.instagram.com/{media-id}/comments { message }
 *   threads:   POST graph.threads.net/me/threads (TEXT, reply_to_id) → /me/threads_publish
 *   linkedin:  POST api.linkedin.com/v2/socialActions/{urn}/comments { actor, message }
 *   youtube:   POST youtube/v3/commentThreads?part=snippet
 *   x:         POST api.x.com/2/tweets { text, reply.in_reply_to_tweet_id }
 * Anything else (TikTok, Pinterest, …) has no comment API: skipped.
 */
const FB_VERSION = 'v21.0';

let _httpRequest = null;
async function realRequest(url, opts) {
  if (!_httpRequest) ({ request: _httpRequest } = await import('../core/httpClient.js'));
  return _httpRequest(url, opts);
}

export const COMMENT_PLATFORMS = ['facebook', 'instagram', 'threads', 'linkedin', 'youtube', 'x'];

/** Post for Me platform name → our key ('twitter' is X). */
export function commentPlatform(platform = '') {
  const p = String(platform || '').toLowerCase();
  if (p === 'twitter' || p === 'x') return 'x';
  return COMMENT_PLATFORMS.find((k) => p.includes(k)) || '';
}

function errorText(res) {
  const d = res?.data || {};
  const e = d.error || (Array.isArray(d.errors) ? d.errors[0] : null);
  const msg = (e && (e.message || e.detail)) || d.message || d.detail || String(res?.text || '').slice(0, 200);
  return `${res?.status || '?'}: ${msg || 'comment failed'}`;
}

/** LinkedIn post URN: Post for Me may hand back the URN or the bare id. */
export function linkedinUrn(id = '') {
  const s = String(id || '');
  return s.startsWith('urn:') ? s : `urn:li:ugcPost:${s}`;
}

/** Who comments on LinkedIn: the account's URN, else its org then person form. */
export function linkedinActors(userId = '') {
  const s = String(userId || '');
  if (!s) return [];
  return s.startsWith('urn:') ? [s] : [`urn:li:organization:${s}`, `urn:li:person:${s}`];
}

export function createFirstCommentSenders({ request: req = realRequest, log } = {}) {
  async function call(url, { method = 'POST', token, body, headers = {} }, label) {
    const res = await req(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body,
      label,
      log,
      retries: 0,
    });
    if (!res.ok) {
      const err = new Error(errorText(res));
      err.status = res.status;
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return res.data || {};
  }

  const senders = {
    async facebook({ postId, token, text }) {
      return call(`https://graph.facebook.com/${FB_VERSION}/${encodeURIComponent(postId)}/comments`, { token, body: { message: text } }, 'firstComment.facebook');
    },

    // Instagram Login tokens (IG…) live on graph.instagram.com, Facebook Login ones on graph.facebook.com.
    async instagram({ postId, token, text }) {
      const host = String(token).startsWith('IG') ? 'graph.instagram.com' : 'graph.facebook.com';
      return call(`https://${host}/${FB_VERSION}/${encodeURIComponent(postId)}/comments`, { token, body: { message: text } }, 'firstComment.instagram');
    },

    async threads({ postId, token, text }) {
      const q = new URLSearchParams({ media_type: 'TEXT', text, reply_to_id: String(postId) });
      const made = await call(`https://graph.threads.net/v1.0/me/threads?${q}`, { token }, 'firstComment.threads.create');
      if (!made.id) throw new Error('Threads did not return a reply container');
      return call(`https://graph.threads.net/v1.0/me/threads_publish?${new URLSearchParams({ creation_id: made.id })}`, { token }, 'firstComment.threads.publish');
    },

    async linkedin({ postId, token, text, account = {} }) {
      const urn = linkedinUrn(postId);
      const actors = linkedinActors(account.user_id);
      if (!actors.length) throw new Error('LinkedIn account id unknown');
      let last = null;
      for (const actor of actors) {
        try {
          return await call(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(urn)}/comments`, {
            token, body: { actor, message: { text } }, headers: { 'X-Restli-Protocol-Version': '2.0.0' },
          }, 'firstComment.linkedin');
        } catch (err) {
          last = err;
          if (err.retryable) throw err;
        }
      }
      throw last;
    },

    async youtube({ postId, token, text }) {
      return call('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
        token, body: { snippet: { videoId: String(postId), topLevelComment: { snippet: { textOriginal: text } } } },
      }, 'firstComment.youtube');
    },

    async x({ postId, token, text }) {
      return call('https://api.x.com/2/tweets', { token, body: { text, reply: { in_reply_to_tweet_id: String(postId) } } }, 'firstComment.x');
    },
  };

  return {
    /** Comment on one published post. Returns { state: 'ok' } or { state: 'skipped', error }; throws on failure. */
    async comment({ platform, postId, token, text, account }) {
      const key = commentPlatform(platform);
      if (!key) return { state: 'skipped', error: `${platform || 'this platform'} has no comment API` };
      if (!postId) return { state: 'skipped', error: 'Post for Me gave no post id' };
      if (!token) return { state: 'skipped', error: 'no account token from Post for Me' };
      await senders[key]({ postId, token, text, account });
      return { state: 'ok' };
    },
  };
}

export default { createFirstCommentSenders, commentPlatform, linkedinUrn, linkedinActors, COMMENT_PLATFORMS };
