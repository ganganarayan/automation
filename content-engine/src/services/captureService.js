/**
 * Comment-capture processing.
 *
 * Purpose:      Turn one incoming comment into a decision and a lead row: ignore
 *               our own comments, match an active rule, claim the comment
 *               idempotently, screen for abuse, enforce the 7-day window, then
 *               (step 4) send the DM + public reply.
 * Responsibility: Orchestration only. All pure rules live in utils/captureSpec;
 *               all I/O is injected (repos + senders) so this unit-tests with
 *               fakes and the real senders drop in for step 4.
 * Dependencies: captureSpec (pure). Repos/senders are passed in by the caller.
 *
 * Idempotency: the lead row is inserted (ON CONFLICT (comment_id) DO NOTHING)
 * BEFORE any send. A duplicate webhook gets null back and stops — so a comment
 * can never produce a second DM, even under concurrent deliveries.
 */
import { firstMatchingRule, detectAbuse, isOlderThan7Days, pickVariant } from '../utils/captureSpec.js';

/**
 * Process a single parsed comment event.
 * @param {object} args
 *   - tenantId
 *   - event: { platform, verb, commentId, postId, commenterId, commenterUsername, text, createdAt }
 *   - now: Date (default new Date())
 *   - selfIds: string[] of our own account ids
 *   - abuseWords: extra blocklist words
 * @param {object} deps - { rules, leads, senders, log, rng, tokenFor, captureCfg }
 *   senders may be null (step 3) -> a matched, fresh, clean comment is captured
 *   as dm_status 'pending' and left for the real senders (step 4).
 * @returns {Promise<{outcome, leadId?}>}
 */
export async function processCommentEvent({ tenantId = 'default', event, now = new Date(), selfIds = [], abuseWords = [] }, deps) {
  const { rules, leads, senders = null, log = console, rng, tokenFor, captureCfg } = deps;
  const e = event || {};

  // (2) Ignore edits/removals and our own comments.
  if (e.verb && e.verb !== 'add') return { outcome: 'ignored_verb' };
  if (e.commenterId && selfIds.map(String).includes(String(e.commenterId))) {
    log.info?.({ commentId: e.commentId }, 'capture: own comment ignored');
    return { outcome: 'self' };
  }

  // (3) Match against active rules for this post.
  const active = await rules.activeForPost({ tenantId, platformPostId: e.postId });
  const rule = firstMatchingRule(e.text, active);
  if (!rule) return { outcome: 'no_rule' };

  // (1/idempotency) Claim the comment. A duplicate webhook returns null here.
  const lead = await leads.insertIfNew({
    tenantId,
    ruleId: rule.id,
    platform: e.platform,
    commentId: e.commentId,
    postId: e.postId,
    keyword: rule.keyword,
    lane: rule.lane,
    commenterId: e.commenterId,
    commenterUsername: e.commenterUsername,
    commentText: e.text,
    commentCreatedAt: e.createdAt || null,
    dmStatus: 'pending',
    publicReplyStatus: 'pending',
  });
  if (!lead) {
    log.info?.({ commentId: e.commentId }, 'capture: duplicate comment, already captured');
    return { outcome: 'duplicate' };
  }

  // Abuse screen — log the lead, never DM.
  const abuse = detectAbuse(e.text, abuseWords);
  if (abuse.abusive) {
    await leads.updateStatus(lead.id, { dmStatus: 'blocked_abuse', publicReplyStatus: 'skipped', error: `abuse: ${abuse.word}` });
    log.info?.({ commentId: e.commentId, word: abuse.word }, 'capture: abusive comment blocked');
    return { outcome: 'blocked_abuse', leadId: lead.id };
  }

  // (4) 7-day window, counted from when the comment was CREATED.
  if (isOlderThan7Days(e.createdAt, now)) {
    await leads.updateStatus(lead.id, { dmStatus: 'skipped_old', publicReplyStatus: 'skipped' });
    log.info?.({ commentId: e.commentId }, 'capture: comment older than 7 days, skipped');
    return { outcome: 'skipped_old', leadId: lead.id };
  }

  // No senders yet (step 3): leave as pending for the real senders (step 4).
  if (!senders) return { outcome: 'captured_pending', leadId: lead.id };

  const pageToken = tokenFor ? tokenFor(captureCfg, e.postId) : '';

  // (5) Send the one private reply. A 4xx that means the window is closed is
  // non-retryable; 5xx bubbles up so the job runner retries with backoff.
  try {
    await senders.sendDm({
      platform: e.platform,
      pageToken,
      recipientCommentId: e.commentId,
      commenterId: e.commenterId,
      text: rule.dm_text,
      link: rule.dm_link,
    });
    await leads.updateStatus(lead.id, { dmStatus: 'sent', dmSentAt: new Date() });
  } catch (err) {
    if (err && err.retryable) {
      await leads.updateStatus(lead.id, { error: `dm retry: ${err.message}` });
      throw err; // let the job runner retry (5xx / transient)
    }
    await leads.updateStatus(lead.id, { dmStatus: 'failed', error: `dm: ${err.message}` });
    return { outcome: 'dm_failed', leadId: lead.id };
  }

  // (6) Public reply under the comment, random variant.
  try {
    const message = pickVariant(rule.public_reply_variants, rng);
    if (message) {
      await senders.sendPublicReply({ platform: e.platform, pageToken, commentId: e.commentId, message });
      await leads.updateStatus(lead.id, { publicReplyStatus: 'done' });
    } else {
      await leads.updateStatus(lead.id, { publicReplyStatus: 'skipped' });
    }
  } catch (err) {
    // The DM already went; a failed public reply is logged, not fatal.
    await leads.updateStatus(lead.id, { publicReplyStatus: 'failed', error: `reply: ${err.message}` });
  }

  return { outcome: 'sent', leadId: lead.id };
}

export default { processCommentEvent };
