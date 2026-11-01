/**
 * First comment: the post's link in its first comment, on every channel.
 *
 * Purpose:      Every publish path queues its Post for Me post here with the
 *               link. Post for Me has no first-comment option, so once it
 *               reports the post live, each ✅ channel gets the link as its first
 *               comment, posted with that account's own token. Runs on the same
 *               5-minute timer as the scheduled-post check.
 * Responsibility: Queue + orchestration; platform calls in firstCommentSenders.
 * Dependencies: firstCommentsRepository, providerFactory, publishProvider,
 *               firstCommentSenders, laneSpec (postOutcome), logger.
 *
 * Never blocks or fails a post: every error here is logged and kept on the row.
 */
import * as repo from '../repositories/firstCommentsRepository.js';
import { buildProviders } from './providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { createFirstCommentSenders } from './firstCommentSenders.js';
import { postOutcome } from '../utils/laneSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'firstComment' });
const senders = createFirstCommentSenders({ log });

const CHECK_MINUTES = 5;
const MAX_ATTEMPTS = 6;

/** The first comment for a link ('' = nothing to comment). */
export function commentText(link) {
  const s = String(link || '').trim();
  return /^https?:\/\/\S+$/.test(s) ? s : '';
}

/**
 * Queue a just-created Post for Me post. A scheduled post is first checked at
 * its scheduled time. Safe on every path: no link or no post id → nothing.
 */
export async function queue({ tenantId = 'default', postformePostId, link, scheduledAt = null }) {
  const text = commentText(link);
  if (!text || !postformePostId) return null;
  try {
    const at = scheduledAt ? new Date(scheduledAt) : null;
    return await repo.enqueue({ tenantId, postformePostId, text, nextAt: at && !Number.isNaN(at.getTime()) ? at : null });
  } catch (err) {
    log.warn({ err: err.message, postformePostId }, 'first comment queue failed (posted anyway)');
    return null;
  }
}

const later = (minutes) => new Date(Date.now() + minutes * 60000);

/** Work off one tenant's due jobs. Returns how many comments went out. */
export async function runDue({ tenantId = 'default' } = {}) {
  const rows = await repo.due(tenantId).catch(() => []);
  if (!rows.length) return 0;
  const providers = await buildProviders(tenantId);
  if (!providers.resolved.postformeKey) return 0;
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey }, log);
  let sent = 0;
  for (const row of rows) {
    const done = { ...(row.done || {}) };
    const attempts = (row.attempts || 0) + 1;
    try {
      const post = await publish.getPost(row.postforme_post_id);
      if (postOutcome(post) === 'pending') {
        // Not out yet: look again at its scheduled time, else in a few minutes.
        const at = post && post.scheduled_at ? new Date(post.scheduled_at) : null;
        const nextAt = at && at > later(CHECK_MINUTES) ? at : later(CHECK_MINUTES);
        await repo.save(row.id, { status: 'pending', done, attempts: row.attempts || 0, nextAt });
        continue;
      }
      const results = await publish.postResults(row.postforme_post_id);
      let retry = false;
      let lastError = null;
      for (const r of results) {
        const accountId = r.social_account_id;
        // A failed channel gets no comment; its retry is a new post with its own job.
        if (!r.success || !accountId || done[accountId]) continue;
        let platform = '';
        try {
          const account = await publish.getAccount(accountId);
          platform = (account && account.platform) || '';
          const out = await senders.comment({
            platform, postId: r.platform_data && r.platform_data.id, token: account && account.access_token, text: row.text, account,
          });
          done[accountId] = { state: out.state, platform, ...(out.error ? { error: out.error } : {}) };
          if (out.state === 'ok') sent += 1;
        } catch (err) {
          lastError = `${platform || accountId}: ${err.message}`;
          if (err.retryable && attempts < MAX_ATTEMPTS) retry = true;
          else done[accountId] = { state: 'failed', platform, error: String(err.message).slice(0, 200) };
        }
      }
      // Post for Me can lag in writing results: wait for them a few rounds.
      if (!results.length && attempts < MAX_ATTEMPTS) retry = true;
      await repo.save(row.id, {
        status: retry ? 'pending' : (Object.values(done).some((d) => d.state === 'failed') ? 'failed' : 'done'),
        done, attempts, nextAt: retry ? later(CHECK_MINUTES) : null, lastError,
      });
      log.info({ post: row.postforme_post_id, done, retry }, 'first comment pass');
    } catch (err) {
      log.warn({ err: err.message, post: row.postforme_post_id }, 'first comment check failed (will retry)');
      await repo.save(row.id, {
        status: attempts < MAX_ATTEMPTS ? 'pending' : 'failed', done, attempts, nextAt: later(CHECK_MINUTES), lastError: err.message,
      }).catch(() => {});
    }
  }
  return sent;
}

export default { queue, runDue, commentText };
