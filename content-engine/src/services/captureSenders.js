/**
 * Comment-capture senders (Meta Graph API).
 *
 * Purpose:      The three outbound calls the capture layer makes as the business
 *               account that owns the post: send the one private reply (DM), post
 *               a public reply under the comment, and delete a comment.
 * Responsibility: Build the Graph request and classify the response. Retry policy
 *               is expressed via err.retryable so the job runner backs off on 5xx
 *               / 429 but never retries a 4xx (e.g. the 7-day window closed).
 * Dependencies: httpClient. The access token travels in the Authorization header,
 *               never the URL (so it is never logged or cached in a query string).
 *
 * Endpoints (per the spec):
 *   DM:            POST /{account-id}/messages   { recipient:{comment_id}, message:{text} }
 *   public reply:  POST /{comment-id}/replies    (Instagram) | /{comment-id}/comments (Facebook)
 *   delete:        DELETE /{comment-id}
 */
const GRAPH = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v21.0';

// Lazy-load the real http client so this module (and its unit tests, which
// inject their own request) don't pull in settings/DATABASE_URL at import time.
let _httpRequest = null;
async function realRequest(url, opts) {
  if (!_httpRequest) ({ request: _httpRequest } = await import('../core/httpClient.js'));
  return _httpRequest(url, opts);
}

/** Human-readable error from a Graph error response. */
export function graphErrorMessage(res) {
  const e = res?.data?.error;
  if (e) return `${e.code ?? res.status}/${e.error_subcode ?? '-'}: ${e.message || 'graph error'}`;
  return `graph ${res?.status || '?'}: ${String(res?.text || '').slice(0, 200)}`;
}

/** 5xx and 429 are transient (retry); every other failure (4xx) is not. */
export function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

export function createCaptureSenders({ request: req = realRequest, version = DEFAULT_VERSION, log } = {}) {
  async function call(url, options, label) {
    const res = await req(url, { ...options, label, log, retries: 0 });
    if (!res.ok) {
      const err = new Error(graphErrorMessage(res));
      err.status = res.status;
      err.retryable = isRetryableStatus(res.status);
      throw err;
    }
    return res.data;
  }

  const auth = (pageToken) => ({ Authorization: `Bearer ${pageToken}`, 'content-type': 'application/json' });

  return {
    /** One private reply to the commenter, as the owning account. */
    async sendDm({ accountId, pageToken, recipientCommentId, text, link }) {
      const body = link && !String(text || '').includes(link) ? `${text}\n${link}` : (text || '');
      return call(
        `${GRAPH}/${version}/${encodeURIComponent(accountId)}/messages`,
        { method: 'POST', headers: auth(pageToken), body: { recipient: { comment_id: recipientCommentId }, message: { text: body } } },
        'capture.sendDm',
      );
    },

    /** Public reply under the comment (IG: replies edge, FB: comments edge). */
    async sendPublicReply({ platform, pageToken, commentId, message }) {
      const edge = platform === 'instagram' ? 'replies' : 'comments';
      return call(
        `${GRAPH}/${version}/${encodeURIComponent(commentId)}/${edge}`,
        { method: 'POST', headers: auth(pageToken), body: { message } },
        'capture.publicReply',
      );
    },

    /** A normal message inside the open 24h window (not a private reply). */
    async sendMessage({ accountId, pageToken, recipientId, text, link }) {
      const body = link && !String(text || '').includes(link) ? `${text}
${link}` : (text || '');
      return call(
        `${GRAPH}/${version}/${encodeURIComponent(accountId)}/messages`,
        { method: 'POST', headers: auth(pageToken), body: { recipient: { id: recipientId }, message: { text: body } } },
        'capture.sendMessage',
      );
    },

    /**
     * Does this person follow the business? Instagram only, and ONLY readable
     * once they have messaged us (Meta requires profile consent — a comment
     * alone returns an error). Returns { follows: true|false|null, username }.
     */
    async getUserProfile({ pageToken, userId }) {
      const data = await call(
        `${GRAPH}/${version}/${encodeURIComponent(userId)}?fields=name,username,is_user_follow_business`,
        { method: 'GET', headers: auth(pageToken) },
        'capture.userProfile',
      );
      const follows = typeof data?.is_user_follow_business === 'boolean' ? data.is_user_follow_business : null;
      return { follows, username: data?.username || null, name: data?.name || null };
    },

    /** Delete a comment on the platform (used by the admin delete button). */
    async deleteComment({ pageToken, commentId }) {
      return call(
        `${GRAPH}/${version}/${encodeURIComponent(commentId)}`,
        { method: 'DELETE', headers: auth(pageToken) },
        'capture.deleteComment',
      );
    },
  };
}

export const captureSenders = createCaptureSenders();
export default { createCaptureSenders, captureSenders, graphErrorMessage, isRetryableStatus };
