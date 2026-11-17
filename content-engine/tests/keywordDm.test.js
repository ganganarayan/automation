import { describe, it, expect } from 'vitest';
import { processMessageEvent } from '../src/services/captureService.js';
import { createMetaConnect, missingFields } from '../src/services/metaConnect.js';

function fakes({ rule }) {
  const rows = new Map();
  const sent = [];
  let seq = 0;
  const leads = {
    rows,
    async findAwaitingFollowup() { return null; },
    async insertIfNew(row) {
      if (rows.has(row.commentId)) return null;
      const r = { id: ++seq, ...row, dm_status: row.dmStatus };
      rows.set(row.commentId, r);
      return r;
    },
    async updateStatus(id, p) { for (const r of rows.values()) if (r.id === id && p.dmStatus) r.dm_status = p.dmStatus; },
    async setFollowup(id, p) { for (const r of rows.values()) if (r.id === id) r.followup_status = p.status; },
  };
  const rules = { async activeForPlatform() { return rule ? [rule] : []; } };
  const senders = {
    async sendMessage(m) { sent.push(m); },
    async getUserProfile() { return { follows: true }; },
  };
  return {
    sent,
    leads,
    deps: { rules, leads, senders, tokenFor: () => 'tok', captureCfg: {}, log: { info() {}, warn() {} } },
  };
}

const RULE = { id: 7, keyword: 'PRICE', match_mode: 'word', active: true, dm_text: 'Here is the offer', dm_link: 'https://x.in/o', lane: 'l1' };
const ev = (text, mid = 'm1') => ({ platform: 'instagram', accountId: 'ig1', senderId: 'u1', messageId: mid, text, at: new Date() });

describe('keyword DM', () => {
  it('a DM with the keyword gets the rule text and link', async () => {
    const f = fakes({ rule: RULE });
    const out = await processMessageEvent({ event: ev('price please') }, f.deps);
    expect(out.outcome).toBe('dm_delivered');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ recipientId: 'u1', text: 'Here is the offer', link: 'https://x.in/o' });
    expect(f.leads.rows.get('dm:m1').dm_status).toBe('sent');
  });

  it('the same message twice is answered once', async () => {
    const f = fakes({ rule: RULE });
    await processMessageEvent({ event: ev('PRICE') }, f.deps);
    const again = await processMessageEvent({ event: ev('PRICE') }, f.deps);
    expect(again.outcome).toBe('duplicate');
    expect(f.sent).toHaveLength(1);
  });

  it('a DM without a keyword is left alone', async () => {
    const f = fakes({ rule: RULE });
    const out = await processMessageEvent({ event: ev('hello there') }, f.deps);
    expect(out.outcome).toBe('no_lead');
    expect(f.sent).toHaveLength(0);
  });
});

describe('Meta connect status', () => {
  it('finds missing fields', () => {
    expect(missingFields({ fields: [{ name: 'comments' }] }, ['comments', 'messages'])).toEqual(['messages']);
  });

  it('reports nothing subscribed when Meta has no subscription', async () => {
    const request = async (url) => {
      if (url.includes('/subscriptions')) return { ok: true, data: { data: [] } };
      if (url.includes('/subscribed_apps')) return { ok: true, data: { data: [] } };
      if (url.includes('?fields=name')) return { ok: true, data: { name: 'My Page' } };
      return { ok: false, status: 404 };
    };
    const mc = createMetaConnect({ request });
    const st = await mc.status({ appId: 'a', appSecret: 's', pageTokens: { p1: 't' } }, 'https://h/api/v1/webhook/meta-comments');
    expect(st.app.every((a) => !a.ok)).toBe(true);
    expect(st.pages).toEqual([{ id: 'p1', name: 'My Page', ok: false, note: 'app not installed on this Page' }]);
  });

  it('says to save the app id first', async () => {
    const mc = createMetaConnect({ request: async () => ({ ok: true, data: {} }) });
    const out = await mc.connect({ appId: '', appSecret: '', pageTokens: {} }, 'https://h/x');
    expect(out.errors[0]).toMatch(/app id/);
  });
});
