import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { workerName, dailyTimeOf, tenantTimesMap, cfRequests, cfError, WORKER_SOURCE, WAKE_CRON } from '../src/utils/cloudflareWake.js';
import { digestAction } from '../src/utils/digestSpec.js';

const ist = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Kolkata' });

describe('cloudflare waker', () => {
  it('names one Worker per deployment from the app host', () => {
    expect(workerName('https://content-engine-production-230f.up.railway.app')).toBe('automation-wake-content-engine-production-230f');
    expect(workerName('https://automation-staging.up.railway.app/')).toBe('automation-wake-automation-staging');
    expect(workerName('')).toBe('automation-wake-app');
    expect(workerName(`https://${'x'.repeat(80)}.example.com`).length).toBeLessThanOrEqual(63);
  });

  it('reads a daily time, defaulting to 19:00', () => {
    expect(dailyTimeOf('7:05')).toBe('07:05');
    expect(dailyTimeOf('19:00')).toBe('19:00');
    expect(dailyTimeOf('')).toBe('19:00');
    expect(dailyTimeOf('25:00')).toBe('19:00');
    expect(dailyTimeOf('soon')).toBe('19:00');
  });

  it('lists only active tenants for the Worker', () => {
    expect(tenantTimesMap([
      { tenantId: 'default', status: 'active', time: '18:30' },
      { tenantId: 'acme', status: 'suspended', time: '10:00' },
      { tenantId: 'beta', time: '' },
    ])).toEqual({ default: '18:30', beta: '19:00' });
  });

  it('ships a Worker that checks every 5 minutes and pings the daily job', () => {
    expect(WAKE_CRON).toBe('*/5 * * * *');
    expect(WORKER_SOURCE).toContain('/api/v1/jobs/daily?tenant=');
    expect(WORKER_SOURCE).toContain("env.WAKE.get('tenants')");
    expect(WORKER_SOURCE).toContain('/^\\d\\d:\\d\\d$/');
    expect(WORKER_SOURCE).not.toContain('\u2014');
  });

  it('builds the Cloudflare calls with the token and the bindings', () => {
    const put = cfRequests.putScript('a'.repeat(32), 'tok', 'automation-wake-x', { kvId: 'kv1', appUrl: 'https://x.app', adminKey: 'k' });
    expect(put.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/automation-wake-x`);
    expect(put.init.method).toBe('PUT');
    expect(put.init.headers.Authorization).toBe('Bearer tok');
    const sch = cfRequests.putSchedules('acc', 'tok', 'w');
    expect(JSON.parse(sch.init.body)).toEqual([{ cron: '*/5 * * * *' }]);
    expect(cfRequests.putValue('acc', 'tok', 'kv1', 'tenants', '{}').url).toMatch(/storage\/kv\/namespaces\/kv1\/values\/tenants$/);
  });

  it('turns a Cloudflare error into words', () => {
    expect(cfError({ errors: [{ code: 10000, message: 'Authentication error' }] }, 403)).toBe('Cloudflare 403: Authentication error');
    expect(cfError(null, 500)).toBe('Cloudflare answered 500');
  });
});

describe('evening email after the daily run', () => {
  const at19 = ist('2026-11-10T19:10:00');
  it('waits while the lanes are still running', () => {
    expect(digestAction({ now: at19, dailyOn: '2026-11-10', quiet: false })).toBe('');
  });
  it('goes once the app is quiet, once a day', () => {
    expect(digestAction({ now: at19, dailyOn: '2026-11-10', quiet: true })).toBe('evening');
    expect(digestAction({ now: at19, dailyOn: '2026-11-10', quiet: true, eveningOn: '2026-11-10' })).toBe('');
  });
  it('does not go on a day the daily run has not run', () => {
    expect(digestAction({ now: at19, dailyOn: '2026-11-09', quiet: true })).toBe('');
  });
});
