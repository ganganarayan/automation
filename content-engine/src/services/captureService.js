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

  // (3) Match against active rules for this post. Rules are created at publish
  // anchored to the Post-for-Me id with no native post id yet; the first matching
  // comment teaches us the native post id (bindNativePost), so later comments
  // match directly.
  const active = await rules.activeForPost({ tenantId, platformPostId: e.postId });
  let rule = firstMatchingRule(e.text, active);
  if (!rule && rules.activeUnlinkedForPlatform) {
    const unlinked = await rules.activeUnlinkedForPlatform({ tenantId, platform: e.platform });
    rule = firstMatchingRule(e.text, unlinked);
    if (rule) await rules.bindNativePost({ ruleId: rule.id, platformPostId: e.postId, accountId: e.accountId });
  }
  // No rule for this post: still record the comment so it is visible and can be
  // answered by hand. No DM, no public reply, no keyword — it is not a lead.
  if (!rule) {
    const unmatchedAbuse = detectAbuse(e.text, abuseWords);
    const seen = await leads.insertIfNew({
      tenantId,
      platform: e.platform,
      commentId: e.commentId,
      accountId: e.accountId,
      postId: e.postId,
      commenterId: e.commenterId,
      commenterUsername: e.commenterUsername,
      commentText: e.text,
      commentCreatedAt: e.createdAt || null,
      abuse: unmatchedAbuse.abusive,
      dmStatus: 'no_rule',
      publicReplyStatus: 'skipped',
    });
    if (!seen) return { outcome: 'duplicate' };
    log.info?.({ commentId: e.commentId, postId: e.postId }, 'capture: comment logged, no rule for this post');
    return { outcome: 'no_rule', leadId: seen.id };
  }

  // (1/idempotency) Claim the comment. A duplicate webhook returns null here.
  const lead = await leads.insertIfNew({
    tenantId,
    ruleId: rule.id,
    platform: e.platform,
    commentId: e.commentId,
    accountId: e.accountId,
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

  // The DM is sent AS the account that owns the post; its token is keyed by that
  // account id. No token -> we can't send; record and stop (not retryable).
  const pageToken = tokenFor ? tokenFor(captureCfg, e.accountId) : '';
  if (!pageToken) {
    await leads.updateStatus(lead.id, { dmStatus: 'failed', error: `no access token for account ${e.accountId || '?'}` });
    return { outcome: 'no_token', leadId: lead.id };
  }

  // (5) Send the one private reply. A 4xx that means the window is closed is
  // non-retryable; 5xx bubbles up so the job runner retries with backoff.
  try {
    await senders.sendDm({
      platform: e.platform,
      accountId: e.accountId,
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

/**
 * Process an inbound REPLY to one of our DMs — the follow gate.
 *
 * Meta only grants profile consent once the person messages us, so this is the
 * first (and only) moment we can read follower status. It is also when the 24h
 * window opens, so the follow-up is a normal message, not a second private
 * reply. One follow-up per lead, claimed atomically.
 *
 * The gate withholds ONLY on a definite "not following": an unknown/failed
 * check fails open and delivers, so an API hiccup never costs a real lead.
 * Facebook is never gated (Graph API removed the page-follow check in v2.2).
 */
export async function processMessageEvent({ tenantId = 'default', event, selfIds = [] }, deps) {
  const { rules, leads, senders = null, log = console, tokenFor, captureCfg } = deps;
  const e = event || {};
  if (e.senderId && selfIds.map(String).includes(String(e.senderId))) return { outcome: 'self' };

  const lead = await leads.findAwaitingFollowup({ tenantId, accountId: e.accountId, commenterId: e.senderId });
  if (!lead) return { outcome: 'no_lead' };            // a reply we never prompted

  const claimed = await leads.claimFollowup(lead.id);
  if (!claimed) return { outcome: 'already_handled' }; // duplicate reply webhook

  const rule = rules.get ? await rules.get(lead.rule_id) : null;

  if (!senders) {
    await leads.setFollowup(lead.id, { status: 'pending', repliedAt: e.at });
    return { outcome: 'deferred', leadId: lead.id };
  }

  const pageToken = tokenFor ? tokenFor(captureCfg, e.accountId) : '';
  if (!pageToken) {
    await leads.setFollowup(lead.id, { status: 'failed', repliedAt: e.at, error: `no access token for account ${e.accountId || '?'}` });
    return { outcome: 'no_token', leadId: lead.id };
  }

  let follows = null;
  const gate = !!(rule && rule.require_follow) && e.platform === 'instagram';
  if (gate) {
    try {
      const prof = await senders.getUserProfile({ accountId: e.accountId, pageToken, userId: e.senderId });
      follows = typeof prof?.follows === 'boolean' ? prof.follows : null;
    } catch (err) {
      follows = null; // unknown -> fail open
      log.warn?.({ err: err.message, leadId: lead.id }, 'capture: follow check failed, delivering anyway');
    }
  }

  const deliver = !gate || follows !== false;
  const text = deliver
    ? (rule?.followup_text || rule?.dm_text || '')
    : (rule?.not_following_text || 'Follow the account and reply here — I will send it straight over.');
  const link = deliver ? (rule?.dm_link || null) : null;

  try {
    await senders.sendMessage({ accountId: e.accountId, pageToken, recipientId: e.senderId, text, link });
    await leads.setFollowup(lead.id, { status: deliver ? 'delivered' : 'nudged', follows, repliedAt: e.at });
    log.info?.({ leadId: lead.id, follows, deliver }, 'capture: follow-up sent');
    return { outcome: deliver ? 'delivered' : 'nudged', leadId: lead.id, follows };
  } catch (err) {
    if (err && err.retryable) {
      // back to pending so the runner's retry can claim it again
      await leads.setFollowup(lead.id, { status: 'pending', repliedAt: e.at, error: `followup retry: ${err.message}` });
      throw err;
    }
    await leads.setFollowup(lead.id, { status: 'failed', follows, repliedAt: e.at, error: `followup: ${err.message}` });
    return { outcome: 'followup_failed', leadId: lead.id };
  }
}

export default { processCommentEvent, processMessageEvent };
