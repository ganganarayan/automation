/**
 * Take-down senders (one per platform).
 *
 * Purpose:      Remove a live post from a platform, as the account that
 *               published it, with that account's own token (the same tokens
 *               the first comment uses). Post for Me has no way to do this: its
 *               DELETE /social-posts only drops its own record.
 * Responsibility: Build each platform's delete request and classify the
 *               response. A 404 means the post is already gone: that counts as
 *               removed. Tokens travel in the Authorization header, never the URL.
 * Dependencies: httpClient (lazy, injectable for tests), firstCommentSenders
 *               (commentPlatform, linkedinUrn).
 *
 *   facebook:  DELETE graph.facebook.com/{post-id}
 *   instagram: DELETE graph.facebook.com|graph.instagram.com/{media-id}
 *              (Meta may refuse it: then it is removed in the Instagram app)
 *   threads:   DELETE graph.threads.net/v1.0/{media-id} (needs threads_delete)
 *   linkedin:  DELETE api.linkedin.com/rest/posts/{urn}, then v2/ugcPosts/{urn}
 *   youtube:   DELETE youtube/v3/videos?id={video-id}
 *   x:         DELETE api.x.com/2/tweets/{id}
 *   pinterest: DELETE api.pinterest.com/v5/pins/{id}
 * Anything else (TikTok, …) has no delete API: skipped with a note.
 */
import { commentPlatform, linkedinUrn } from './firstCommentSenders.js';

const FB_VERSION = 'v21.0';
const LINKEDIN_VERSION = '202509';

let _httpRequest = null;
async function realRequest(url, opts) {
  if (!_httpRequest) ({ request: _httpRequest } = await import('../core/httpClient.js'));
  return _httpRequest(url, opts);
}

export const TAKE_DOWN_PLATFORMS = ['facebook', 'instagram', 'threads', 'linkedin', 'youtube', 'x', 'pinterest'];

/** Post for Me platform name → our key ('' = no delete API). */
export function takeDownPlatform(platform = '') {
  const p = String(platform || '').toLowerCase();
  if (p.includes('pinterest')) return 'pinterest';
  return commentPlatform(p);
}

function errorText(res) {
  const d = res?.data || {};
  const e = d.error || (Array.isArray(d.errors) ? d.errors[0] : null);
  const msg = (e && (e.message || e.detail)) || d.message || d.detail || String(res?.text || '').slice(0, 200);
  return `${res?.status || '?'}: ${msg || 'delete failed'}`;
}

export function createTakeDownSenders({ request: req = realRequest, log } = {}) {
  async function del(url, { token, headers = {} }, label) {
    const res = await req(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, ...headers }, label, log, retries: 0 });
    if (res.ok || res.status === 404) return { gone: res.status === 404 };
    const err = new Error(errorText(res));
    err.status = res.status;
    throw err;
  }

  const senders = {
    facebook: ({ postId, token }) => del(`https://graph.facebook.com/${FB_VERSION}/${encodeURIComponent(postId)}`, { token }, 'takeDown.facebook'),
    instagram: ({ postId, token }) => {
      const host = String(token).startsWith('IG') ? 'graph.instagram.com' : 'graph.facebook.com';
      return del(`https://${host}/${FB_VERSION}/${encodeURIComponent(postId)}`, { token }, 'takeDown.instagram');
    },
    threads: ({ postId, token }) => del(`https://graph.threads.net/v1.0/${encodeURIComponent(postId)}`, { token }, 'takeDown.threads'),
    async linkedin({ postId, token }) {
      const urn = encodeURIComponent(linkedinUrn(postId));
      try {
        return await del(`https://api.linkedin.com/rest/posts/${urn}`, {
          token, headers: { 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
        }, 'takeDown.linkedin');
      } catch (err) {
        return del(`https://api.linkedin.com/v2/ugcPosts/${urn}`, { token, headers: { 'X-Restli-Protocol-Version': '2.0.0' } }, 'takeDown.linkedin.ugc')
          .catch((e2) => { e2.message = `${err.message} | ${e2.message}`; throw e2; });
      }
    },
    youtube: ({ postId, token }) => del(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(postId)}`, { token }, 'takeDown.youtube'),
    x: ({ postId, token }) => del(`https://api.x.com/2/tweets/${encodeURIComponent(postId)}`, { token }, 'takeDown.x'),
    pinterest: ({ postId, token }) => del(`https://api.pinterest.com/v5/pins/${encodeURIComponent(postId)}`, { token }, 'takeDown.pinterest'),
  };

  return {
    /**
     * Remove one live post, trying each token in order: [{ via, token }].
     * Returns { state: 'ok', via, gone } or { state: 'skipped', error };
     * throws when every token fails (the message lists each try).
     */
    async takeDown({ platform, postId, tokens = [] }) {
      const key = takeDownPlatform(platform);
      if (!key) return { state: 'skipped', error: `${platform || 'this platform'} has no delete API, remove it in its app` };
      if (!postId) return { state: 'skipped', error: 'Post for Me gave no post id, remove it in its app' };
      const list = (tokens || []).filter((t) => t && t.token);
      if (!list.length) return { state: 'skipped', error: 'no account token, remove it in its app' };
      const tried = [];
      let last = null;
      for (const { via, token } of list) {
        try {
          const out = await senders[key]({ postId: String(postId), token });
          return { state: 'ok', via, gone: !!out.gone };
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

export default { createTakeDownSenders, takeDownPlatform, TAKE_DOWN_PLATFORMS };
