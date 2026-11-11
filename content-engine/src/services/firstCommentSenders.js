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
 * Instagram is not commented on: its link goes by comment-to-DM (see dmOnly).
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

/** Channels whose link goes by comment-to-DM, not a first comment. */
export function dmOnly(platform = '') {
  return commentPlatform(platform) === 'instagram';
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

/**
 * The Facebook objects a first comment may go on, best first. Post for Me can
 * hand back a bare post id, which Facebook refuses ("(#12) singular statuses
 * API is deprecated"); the page_post form and the video id from the post's
 * own URL (facebook.com/{page}/videos/{video}) are what Facebook accepts.
 */
export function facebookTargets(postId = '', { url = '', pageId = '' } = {}) {
  const id = String(postId || '').trim();
  const m = String(url || '').match(/facebook\.com\/(\d+)\/(?:videos|reel|posts)\/(\d+)/);
  const page = String(pageId || '').trim() || (m ? m[1] : '');
  const out = [];
  if (id.includes('_')) out.push(id);
  else if (id && page) out.push(`${page}_${id}`);
  if (m && m[2]) out.push(m[2]);
  if (id) out.push(id);
  return [...new Set(out.filter(Boolean))];
}

/** Facebook's "wrong object" refusals: try the next id, nothing was posted. */
function fbWrongObject(err) {
  return /\(#12\)|\(#100\)|\(#803\)|Unsupported post request|does not exist/i.test(String((err && err.message) || ''));
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
    async facebook({ postId, token, text, account, url }) {
      const targets = facebookTargets(postId, { url, pageId: (account && account.user_id) || '' });
      let last = null;
      for (const id of targets) {
        try {
          return await call(`https://graph.facebook.com/${FB_VERSION}/${encodeURIComponent(id)}/comments`, { token, body: { message: text } }, 'firstComment.facebook');
        } catch (err) {
          last = err;
          if (!fbWrongObject(err)) throw err;
        }
      }
      throw last || new Error('no Facebook post id to comment on');
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
    async comment({ platform, postId, token, text, account, url = '' }) {
      const key = commentPlatform(platform);
      if (!key) return { state: 'skipped', error: `${platform || 'this platform'} has no comment API` };
      if (!postId) return { state: 'skipped', error: 'Post for Me gave no post id' };
      if (!token) return { state: 'skipped', error: 'no account token from Post for Me' };
      await senders[key]({ postId, token, text, account, url });
      return { state: 'ok' };
    },

    /**
     * Try each token in order until one comments: [{ via, token }]. Returns
     * { state: 'ok', via, tried } or { state: 'skipped' }; when every token
     * fails, throws the last error (retryable only if that one was).
     */
    async commentWithFallback({ platform, postId, tokens = [], text, account, url = '' }) {
      const list = (tokens || []).filter((t) => t && t.token);
      if (!list.length) return this.comment({ platform, postId, token: '', text, account, url });
      const tried = [];
      let last = null;
      for (const { via, token } of list) {
        try {
          const out = await this.comment({ platform, postId, token, text, account, url });
          if (out.state !== 'ok') return out;
          return { ...out, via, tried };
        } catch (err) {
          tried.push(`${via}: ${err.message}`);
          last = err;
        }
      }
      last.message = tried.join(' | ');
      throw last;
    },
  };
}

export default { createFirstCommentSenders, commentPlatform, dmOnly, linkedinUrn, linkedinActors, facebookTargets, COMMENT_PLATFORMS };
