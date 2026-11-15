import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/repositories/tenantConfigRepository.js', () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../src/core/tenantSettings.js', () => ({ forTenant: vi.fn() }));
vi.mock('../src/settings/index.js', () => ({ settings: { app: { publicBaseUrl: '' } } }));
vi.mock('../src/core/logger.js', () => ({ childLogger: () => ({ info() {}, warn() {} }) }));

const { shouldAutoDeploy } = await import('../src/services/landingDeployService.js');

describe('landing auto deploy on a new version', () => {
  const live = { ok: true, domain: 'x.com', sha: 'a', env: 'production' };
  it('redeploys a working landing when the build changed', () => {
    expect(shouldAutoDeploy(live, { sha: 'b', env: 'production' })).toBe(true);
    expect(shouldAutoDeploy(live, { sha: 'a', env: 'production' })).toBe(false);
  });
  it('never from another environment, a failed deploy or a local run', () => {
    expect(shouldAutoDeploy(live, { sha: 'b', env: 'staging' })).toBe(false);
    expect(shouldAutoDeploy({ ...live, ok: false }, { sha: 'b', env: 'production' })).toBe(false);
    expect(shouldAutoDeploy(live, { sha: '', env: '' })).toBe(false);
    expect(shouldAutoDeploy(null, { sha: 'b', env: 'production' })).toBe(false);
  });
  it('an old record without env goes to production only', () => {
    const old = { ok: true, domain: 'x.com' };
    expect(shouldAutoDeploy(old, { sha: 'b', env: 'production' })).toBe(true);
    expect(shouldAutoDeploy(old, { sha: 'b', env: 'staging' })).toBe(false);
  });
});
