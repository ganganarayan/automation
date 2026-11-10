import { describe, it, expect } from 'vitest';
import { isQaTenant, qaTenantId, leakedSettings, keyFindings, accountFindings, metaFindings, keyHistoryFinding, verdict } from '../src/utils/qaSpec.js';

describe('QA workspace ids', () => {
  it('only qa-* is a QA workspace', () => {
    expect(isQaTenant('qa-starter')).toBe(true);
    expect(isQaTenant('qa-')).toBe(false);
    expect(isQaTenant('default')).toBe(false);
    expect(isQaTenant('acme')).toBe(false);
  });
  it('adds the prefix and refuses bad ids', () => {
    expect(qaTenantId('starter')).toBe('qa-starter');
    expect(qaTenantId('QA-Agency')).toBe('qa-agency');
    expect(qaTenantId('')).toBe('');
    expect(qaTenantId('bad id')).toBe('');
    expect(qaTenantId('a:b')).toBe('');
  });
});

describe('leakedSettings', () => {
  const owner = { sheets: { gita: 'SHEET1' }, emails: { report: 'me@x.com', notify: '' }, smtp: { pass: 'secret' }, comparison: { builtIn: true }, mail: { gmailReady: true } };
  it('a clean tenant leaks nothing', () => {
    const qa = { sheets: { gita: '' }, emails: { report: '', notify: '' }, smtp: { pass: '' }, comparison: { builtIn: false }, mail: { gmailReady: false } };
    expect(leakedSettings(qa, owner)).toEqual([]);
  });
  it('names every owner value that shows up', () => {
    const qa = { sheets: { gita: 'SHEET1' }, emails: { report: '' }, smtp: { pass: 'secret' }, comparison: { builtIn: true }, mail: { gmailReady: true } };
    expect(leakedSettings(qa, owner)).toEqual(['sheets.gita', 'smtp.pass', 'comparison.builtIn', 'mail.gmailReady']);
  });
  it('an empty owner value is not a leak', () => {
    expect(leakedSettings({ emails: { notify: '' } }, owner)).toEqual([]);
  });
  it('a value the tenant set itself is not a leak', () => {
    expect(leakedSettings({ sheets: { gita: 'SHEET1' } }, owner, (p) => p === 'sheets.gita')).toEqual([]);
  });
});

describe('keyFindings', () => {
  it('Agency on the owner\'s key fails', () => {
    const f = keyFindings({ openai: 'platform', anthropic: 'tenant' }, 'agency');
    expect(f.find((c) => c.name === 'key: openai').status).toBe('fail');
    expect(f.find((c) => c.name === 'key: anthropic').status).toBe('ok');
    expect(f.find((c) => c.name === 'key: kling').status).toBe('skip');
  });
  it('Starter may use the platform key', () => {
    expect(keyFindings({ openai: 'platform' }, 'starter').find((c) => c.name === 'key: openai').status).toBe('ok');
  });
});

describe('accountFindings', () => {
  it('only its own accounts is fine, and owner accounts stay hidden', () => {
    const f = accountFindings([{ id: 1, platform: 'instagram', external_id: 'qa-a' }, { id: 2, platform: 'x', external_id: 'qa-a:x' }], 'qa-a', { ownerCount: 7 });
    expect(f.map((c) => c.status)).toEqual(['ok', 'ok']);
  });
  it('another tenant\'s account fails', () => {
    const f = accountFindings([{ id: 1, platform: 'instagram', external_id: '' }], 'qa-a', { ownerCount: 7 });
    expect(f[0].status).toBe('fail');
    expect(f[1].status).toBe('fail');
  });
  it('no owner accounts means hiding was not tested', () => {
    expect(accountFindings([], 'qa-a', { ownerCount: 0 })[1].status).toBe('warn');
  });
});

describe('verdict', () => {
  it('fail beats warn beats ok; skip is fine', () => {
    expect(verdict([{ status: 'ok' }, { status: 'skip' }])).toBe('ok');
    expect(verdict([{ status: 'ok' }, { status: 'warn' }])).toBe('warn');
    expect(verdict([{ status: 'warn' }, { status: 'fail' }])).toBe('fail');
  });
});

describe('metaFindings', () => {
  it('your ids routed to you is fine', () => {
    expect(metaFindings(['1', '2'], new Map([['1', 'default'], ['2', 'default']])).status).toBe('ok');
  });
  it('an id routed to another tenant fails', () => {
    expect(metaFindings(['1'], new Map([['1', 'qa-a']])).status).toBe('fail');
  });
  it('an id two tenants claim stays yours but is flagged', () => {
    expect(metaFindings(['1'], new Map([['1', null]])).status).toBe('warn');
  });
  it('no ids to check is a skip', () => {
    expect(metaFindings([], new Map()).status).toBe('skip');
  });
});

describe('keyHistoryFinding', () => {
  it('last entry matching today is fine', () => {
    expect(keyHistoryFinding([{ owners: { openai: 'tenant' } }, { owners: { openai: 'platform' } }], { openai: 'platform' }).status).toBe('ok');
  });
  it('no history or a stale last entry fails', () => {
    expect(keyHistoryFinding([], { openai: 'platform' }).status).toBe('fail');
    expect(keyHistoryFinding([{ owners: { openai: 'tenant' } }], { openai: 'platform' }).status).toBe('fail');
  });
  it('google and github are not paid keys', () => {
    expect(keyHistoryFinding([{ owners: { openai: 'platform' } }], { openai: 'platform', google: 'platform' }).status).toBe('ok');
  });
});
