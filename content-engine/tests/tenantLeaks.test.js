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
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({ getAll: async () => ({}), get: async () => '', set: async () => {} }));
vi.mock('../src/repositories/tenantRepository.js', () => ({ list: async () => [{ id: 'default' }, { id: 'acme' }] }));

const ts = await import('../src/core/tenantSettings.js');

describe('env fallbacks are the owner\'s only', () => {
  it('the default tenant still gets every env default', async () => {
    const r = await ts.forTenant('default');
    expect(r.sheets.gita).toBe('OWNER_SHEET');
    expect(r.openai.apiKey).toBe('OWNER_OPENAI');
    expect(r.smtp.pass).toBe('secret');
  });

  it('another tenant gets none of the owner\'s keys, sheets, folders, emails or links', async () => {
    const r = await ts.forTenant('acme');
    const flat = JSON.stringify(r);
    for (const leak of ['OWNER_SHEET', 'OWNER_FOLDER', 'OWNER_OPENAI', 'OWNER_GEMINI', 'OWNER_J2V', 'owner@x.com', 'https://owner/', 'smtp.owner', 'secret', 'acc1']) {
      expect(flat, leak).not.toContain(leak);
    }
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
