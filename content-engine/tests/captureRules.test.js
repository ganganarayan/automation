import { describe, it, expect } from 'vitest';
import { dmPlatforms, createForPublish } from '../src/services/captureRules.js';

const accountMap = {
  a1: { platform: 'instagram' },
  a2: { platform: 'facebook' },
  a3: { platform: 'youtube' },
  a4: { platform: 'linkedin' },
  a5: { platform: 'instagram' }, // duplicate platform
};

describe('dmPlatforms', () => {
  it('keeps only Instagram + Facebook, de-duped', () => {
    expect(dmPlatforms(['a1', 'a2', 'a3', 'a4', 'a5'], accountMap).sort()).toEqual(['facebook', 'instagram']);
  });
  it('empty when no DM-capable accounts', () => {
    expect(dmPlatforms(['a3', 'a4'], accountMap)).toEqual([]);
  });
});

function fakeRulesRepo() {
  const made = [];
  return {
    made,
    async upsert(rule) { made.push(rule); return { id: made.length, ...rule }; },
  };
}

describe('createForPublish', () => {
  it('creates one rule per DM platform', async () => {
    const repo = fakeRulesRepo();
    const made = await createForPublish({
      tenantId: 't', funnelId: 1, lane: 'Gita', platforms: ['instagram', 'facebook'],
      postformePostId: 'pfm_1', keyword: 'guide', dmText: 'here', dmLink: 'https://x.co/a',
      publicReplyVariants: ['Sent!'],
    }, { rules: repo });
    expect(made).toHaveLength(2);
    expect(repo.made.map((r) => r.platform).sort()).toEqual(['facebook', 'instagram']);
    expect(repo.made[0]).toMatchObject({ postformePostId: 'pfm_1', keyword: 'guide', dmText: 'here', dmLink: 'https://x.co/a' });
  });

  it('no keyword -> no rule', async () => {
    const repo = fakeRulesRepo();
    const made = await createForPublish({ platforms: ['instagram'], postformePostId: 'pfm_1', keyword: '  ' }, { rules: repo });
    expect(made).toEqual([]);
    expect(repo.made).toHaveLength(0);
  });

  it('no Post-for-Me id -> no rule', async () => {
    const repo = fakeRulesRepo();
    const made = await createForPublish({ platforms: ['instagram'], keyword: 'guide' }, { rules: repo });
    expect(made).toEqual([]);
  });
});
