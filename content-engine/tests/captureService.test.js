import { describe, it, expect, beforeEach } from 'vitest';
import { processCommentEvent } from '../src/services/captureService.js';

// --- in-memory fakes --------------------------------------------------------

function fakeLeads() {
  const byComment = new Map();
  let seq = 0;
  return {
    rows: byComment,
    async insertIfNew(row) {
      if (byComment.has(row.commentId)) return null; // ON CONFLICT (comment_id) DO NOTHING
      seq += 1;
      const stored = {
        id: seq,
        ...row,
        dm_status: row.dmStatus || 'pending',
        public_reply_status: row.publicReplyStatus || 'pending',
        error: null,
      };
      byComment.set(row.commentId, stored);
      return stored;
    },
    async updateStatus(id, patch = {}) {
      for (const r of byComment.values()) {
        if (r.id !== id) continue;
        if (patch.dmStatus !== undefined) r.dm_status = patch.dmStatus;
        if (patch.dmSentAt !== undefined) r.dm_sent_at = patch.dmSentAt;
        if (patch.publicReplyStatus !== undefined) r.public_reply_status = patch.publicReplyStatus;
        if (patch.error !== undefined) r.error = patch.error;
      }
    },
  };
}

function fakeRules(rules) {
  return {
    async activeForPost({ platformPostId }) {
      return rules.filter((r) => String(r.platform_post_id) === String(platformPostId) && r.active !== false);
    },
  };
}

function fakeSenders({ dmError } = {}) {
  const calls = { dm: 0, reply: 0 };
  return {
    calls,
    async sendDm() { calls.dm += 1; if (dmError) throw dmError; return { ok: true }; },
    async sendPublicReply() { calls.reply += 1; return { ok: true }; },
  };
}

const RULE = {
  id: 10, keyword: 'want', match_mode: 'word', platform_post_id: 'media99', active: true,
  lane: 'gita', dm_text: 'Here is your link', dm_link: 'https://x.co/a', public_reply_variants: ['Sent! 💌', 'Check your DM'],
};

const baseEvent = {
  platform: 'instagram', verb: 'add', commentId: 'c1', accountId: 'acct1', postId: 'media99',
  commenterId: 'u1', commenterUsername: 'alice', text: 'I want this', createdAt: new Date(),
};

// Real usage resolves a per-account token; tests inject a constant one.
const TOKEN_DEPS = { tokenFor: () => 'tok', captureCfg: {} };

describe('processCommentEvent', () => {
  let leads;
  beforeEach(() => { leads = fakeLeads(); });

  it('a duplicate webhook produces exactly one DM', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders();
    const deps = { rules, leads, senders, log: {}, rng: () => 0, ...TOKEN_DEPS };

    const first = await processCommentEvent({ event: baseEvent }, deps);
    const second = await processCommentEvent({ event: baseEvent }, deps); // same comment_id

    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('duplicate');
    expect(senders.calls.dm).toBe(1); // never twice
  });

  it('a comment older than 7 days is skipped (no DM)', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders();
    const old = { ...baseEvent, createdAt: new Date(Date.now() - 8 * 86400 * 1000) };

    const r = await processCommentEvent({ event: old }, { rules, leads, senders, log: {} });

    expect(r.outcome).toBe('skipped_old');
    expect(senders.calls.dm).toBe(0);
    expect(leads.rows.get('c1').dm_status).toBe('skipped_old');
  });

  it('our own comment is ignored (no lead, no DM)', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders();

    const r = await processCommentEvent({ event: baseEvent, selfIds: ['u1'] }, { rules, leads, senders, log: {} });

    expect(r.outcome).toBe('self');
    expect(senders.calls.dm).toBe(0);
    expect(leads.rows.size).toBe(0);
  });

  it('a failed DM leaves a lead row with the error recorded', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders({ dmError: Object.assign(new Error('window closed'), { retryable: false }) });

    const r = await processCommentEvent({ event: baseEvent }, { rules, leads, senders, log: {}, ...TOKEN_DEPS });

    expect(r.outcome).toBe('dm_failed');
    const lead = leads.rows.get('c1');
    expect(lead.dm_status).toBe('failed');
    expect(lead.error).toContain('window closed');
  });

  it('no access token for the account -> captured but not sent', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders();
    // tokenFor returns '' (no token configured for this account)
    const r = await processCommentEvent({ event: baseEvent }, { rules, leads, senders, log: {}, tokenFor: () => '', captureCfg: {} });
    expect(r.outcome).toBe('no_token');
    expect(senders.calls.dm).toBe(0);
    expect(leads.rows.get('c1').dm_status).toBe('failed');
  });

  it('an abusive comment is logged but never DMed', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders();
    const abusive = { ...baseEvent, text: 'I want this chutiya' };

    const r = await processCommentEvent({ event: abusive }, { rules, leads, senders, log: {} });

    expect(r.outcome).toBe('blocked_abuse');
    expect(senders.calls.dm).toBe(0);
    expect(leads.rows.get('c1').dm_status).toBe('blocked_abuse');
  });

  it('no matching rule -> nothing captured', async () => {
    const rules = fakeRules([RULE]);
    const senders = fakeSenders();
    const r = await processCommentEvent({ event: { ...baseEvent, text: 'hello there' } }, { rules, leads, senders, log: {} });
    expect(r.outcome).toBe('no_rule');
    expect(leads.rows.size).toBe(0);
  });

  it('step-3 mode (senders:null) captures as pending, no send', async () => {
    const rules = fakeRules([RULE]);
    const r = await processCommentEvent({ event: baseEvent }, { rules, leads, senders: null, log: {} });
    expect(r.outcome).toBe('captured_pending');
    expect(leads.rows.get('c1').dm_status).toBe('pending');
  });
});
