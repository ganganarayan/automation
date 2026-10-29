import { describe, it, expect, beforeEach } from 'vitest';
import { processMessageEvent } from '../src/services/captureService.js';

function fakeLeads(initial = [{ commenter_id: 'u1', account_id: 'acct1', rule_id: 10 }]) {
  const rows = initial.map((r, i) => ({ id: i + 1, dm_status: 'sent', followup_status: 'pending', follows: null, ...r }));
  return {
    rows,
    async findAwaitingFollowup({ commenterId }) {
      return rows.find((r) => String(r.commenter_id) === String(commenterId)
        && r.dm_status === 'sent' && r.followup_status === 'pending') || null;
    },
    async claimFollowup(id) { // atomic claim: only the first caller wins
      const r = rows.find((x) => x.id === id);
      if (!r || r.followup_status !== 'pending') return null;
      r.followup_status = 'running';
      return r;
    },
    async setFollowup(id, patch = {}) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      if (patch.status !== undefined && patch.status !== null) r.followup_status = patch.status;
      if (patch.follows !== undefined && patch.follows !== null) r.follows = patch.follows;
      if (patch.repliedAt !== undefined) r.replied_at = patch.repliedAt;
      if (patch.error !== undefined && patch.error !== null) r.error = patch.error;
    },
  };
}

const RULE = {
  id: 10, require_follow: true, dm_text: 'hi', dm_link: 'https://x.co/a',
  followup_text: 'Here is your guide', not_following_text: 'Follow first please',
};
const fakeRules = (rule = RULE) => ({ async get() { return rule; } });

function fakeSenders({ follows = true, profileError = null } = {}) {
  const calls = { msg: 0, profile: 0, texts: [] };
  return {
    calls,
    async getUserProfile() { calls.profile += 1; if (profileError) throw profileError; return { follows }; },
    async sendMessage({ text }) { calls.msg += 1; calls.texts.push(text); return { ok: true }; },
  };
}

const EVENT = { platform: 'instagram', accountId: 'acct1', senderId: 'u1', text: 'yes', at: new Date() };
const TOKEN = { tokenFor: () => 'tok', captureCfg: {} };

describe('follow gate', () => {
  let leads;
  beforeEach(() => { leads = fakeLeads(); });

  it('a follower gets the link', async () => {
    const senders = fakeSenders({ follows: true });
    const r = await processMessageEvent({ event: EVENT }, { rules: fakeRules(), leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('delivered');
    expect(senders.calls.texts[0]).toContain('Here is your guide');
    expect(leads.rows[0].followup_status).toBe('delivered');
    expect(leads.rows[0].follows).toBe(true);
  });

  it('a non-follower gets the nudge, not the link', async () => {
    const senders = fakeSenders({ follows: false });
    const r = await processMessageEvent({ event: EVENT }, { rules: fakeRules(), leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('nudged');
    expect(senders.calls.texts[0]).toContain('Follow first please');
    expect(senders.calls.texts[0]).not.toContain('https://x.co/a');
    expect(leads.rows[0].followup_status).toBe('nudged');
  });

  it('gate OFF delivers to everyone and never calls the profile API', async () => {
    const senders = fakeSenders({ follows: false });
    const rules = fakeRules({ ...RULE, require_follow: false });
    const r = await processMessageEvent({ event: EVENT }, { rules, leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('delivered');
    expect(senders.calls.profile).toBe(0);
  });

  it('fails OPEN: an unknown follow check still delivers', async () => {
    const senders = fakeSenders({ profileError: Object.assign(new Error('consent required'), { retryable: false }) });
    const r = await processMessageEvent({ event: EVENT }, { rules: fakeRules(), leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('delivered');
    expect(leads.rows[0].follows).toBeNull();
  });

  it('Facebook is never gated (no page-follow check exists)', async () => {
    const senders = fakeSenders({ follows: false });
    const r = await processMessageEvent({ event: { ...EVENT, platform: 'facebook' } }, { rules: fakeRules(), leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('delivered');
    expect(senders.calls.profile).toBe(0);
  });

  it('a duplicate reply sends exactly one follow-up', async () => {
    const senders = fakeSenders({ follows: true });
    const deps = { rules: fakeRules(), leads, senders, log: {}, ...TOKEN };
    const first = await processMessageEvent({ event: EVENT }, deps);
    const second = await processMessageEvent({ event: EVENT }, deps);
    expect(first.outcome).toBe('delivered');
    expect(second.outcome).toBe('no_lead'); // already claimed, no longer pending
    expect(senders.calls.msg).toBe(1);
  });

  it('a reply we never prompted is ignored', async () => {
    const senders = fakeSenders();
    const r = await processMessageEvent({ event: { ...EVENT, senderId: 'stranger' } }, { rules: fakeRules(), leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('no_lead');
    expect(senders.calls.msg).toBe(0);
  });

  it('our own message is ignored', async () => {
    const senders = fakeSenders();
    const r = await processMessageEvent({ event: EVENT, selfIds: ['u1'] }, { rules: fakeRules(), leads, senders, log: {}, ...TOKEN });
    expect(r.outcome).toBe('self');
    expect(senders.calls.msg).toBe(0);
  });
});
