import { describe, it, expect, vi } from 'vitest';

const fakeSettings = {
  google: { serviceAccount: { client_email: 'sa@platform' } },
  sheets: { gita: 'OWNER_SHEET', vidapulse: 'V', video: 'VS', factory: 'F' },
  drive: { gitaFolder: 'OWNER_FOLDER', reelsFolder: 'R' },
  postforme: { apiKey: 'OWNER_PFM', gitaAccounts: ['acc1'], vidapulseAccounts: [], gitaVideoAccounts: [], accountMap: { acc1: {} } },
  emails: { approvalGita: 'owner@x.com', approvalVidapulse: 'owner@x.com', report: 'owner@x.com' },
  links: { gitaAssessment: 'https://owner/assess', gitaSimpleAssessment: 'https://owner/simple' },
  openai: { apiKey: 'OWNER_OPENAI', imageModel: 'gpt-image-1', textModel: 'gpt-5-mini' },
  gemini: { apiKey: 'OWNER_GEMINI', imageModel: 'gemini-img' },
  video: { json2videoApiKey: 'OWNER_J2V' },
  instagram: { automationUrl: 'https://owner/ig', contactEmail: 'owner@x.com', commentWebhookUrl: 'https://owner/hook' },
  smtp: { host: 'smtp.owner', port: 587, user: 'owner', pass: 'secret', from: 'owner@x.com' },
  modules: { delivery: true },
};
vi.mock('../src/settings/index.js', () => ({ settings: fakeSettings, default: fakeSettings }));
const overrides = { default: {}, acme: {}, own: { openai_api_key: 'OWN_OPENAI' }, big: {} };
const plans = { acme: 'growth', own: 'growth', big: 'agency' };
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({ getAll: async (t) => ({ ...(overrides[t] || {}) }), get: async () => '', set: async () => {} }));
vi.mock('../src/repositories/tenantRepository.js', () => ({
  list: async () => [{ id: 'default' }, { id: 'acme' }, { id: 'own' }, { id: 'big' }],
  findById: async (id) => ({ id, plan: plans[id] || 'custom' }),
}));

const ts = await import('../src/core/tenantSettings.js');

describe('env fallbacks are the owner\'s only', () => {
  it('the default tenant still gets every env default', async () => {
    const r = await ts.forTenant('default');
    expect(r.sheets.gita).toBe('OWNER_SHEET');
    expect(r.openai.apiKey).toBe('OWNER_OPENAI');
    expect(r.smtp.pass).toBe('secret');
  });

  it('another tenant gets none of the owner\'s sheets, folders, emails, links or mail login', async () => {
    const r = await ts.forTenant('acme');
    const flat = JSON.stringify(r);
    for (const leak of ['OWNER_SHEET', 'OWNER_FOLDER', 'owner@x.com', 'https://owner/', 'smtp.owner', 'secret', 'acc1']) {
      expect(flat, leak).not.toContain(leak);
    }
  });

  it('paid AI keys: own key first, else the platform key (owner pays), none on Agency', async () => {
    const acme = await ts.forTenant('acme');
    expect(acme.openai.apiKey).toBe('OWNER_OPENAI');
    expect(acme.keyOwners.openai).toBe('platform');
    const own = await ts.forTenant('own');
    expect(own.openai.apiKey).toBe('OWN_OPENAI');
    expect(own.keyOwners.openai).toBe('tenant');
    expect(own.keyOwners.gemini).toBe('platform');
    const big = await ts.forTenant('big');
    expect(big.openai.apiKey).toBe('');
    expect(big.keyOwners.openai).toBe('none');
    expect(JSON.stringify(big)).not.toContain('OWNER_OPENAI');
  });

  it('providerKey rules', () => {
    expect(ts.providerKey('k', { own: { k: ' mine ' }, owner: { k: 'o' } })).toEqual(['mine', 'tenant']);
    expect(ts.providerKey('k', { own: {}, owner: { k: 'o' }, envValue: 'e' })).toEqual(['o', 'platform']);
    expect(ts.providerKey('k', { own: {}, owner: {}, envValue: 'e' })).toEqual(['e', 'platform']);
    expect(ts.providerKey('k', { own: {}, owner: { k: 'o' }, byo: true })).toEqual(['', 'none']);
    expect(ts.providerKey('k', { own: { k: 'x' }, isOwner: true })).toEqual(['x', 'platform']);
    expect(ts.providerKey('k', { own: {}, isOwner: true })).toEqual(['', 'none']);
  });

  it('platform pieces are shared: model names, SMTP port, the service account', async () => {
    const r = await ts.forTenant('acme');
    expect(r.openai.imageModel).toBe('gpt-image-1');
    expect(r.gemini.imageModel).toBe('gemini-img');
    expect(r.smtp.port).toBe(587);
    expect(r.google.serviceAccount).toEqual({ client_email: 'sa@platform' });
  });

  it('the Post for Me key is the shared one, scoped to the tenant', async () => {
    const r = await ts.forTenant('acme');
    expect(r.postformeKey).toBe('OWNER_PFM');
    expect(r.postformeScope).toMatchObject({ tenantId: 'acme', owner: false });
  });

  it('env module flags are the owner\'s; another tenant turns a module on itself', async () => {
    expect(await ts.moduleEnabled('default', 'delivery')).toBe(true);
    expect(await ts.moduleEnabled('acme', 'delivery')).toBe(false);
  });

  it('envFor returns the env as is for the owner', () => {
    expect(ts.envFor('default', fakeSettings)).toBe(fakeSettings);
    expect(ts.envFor('acme', fakeSettings).openai.apiKey).toBe('');
  });
});
