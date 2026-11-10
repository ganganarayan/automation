import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  describe('the Worker itself', () => {
    let run;
    let calls;
    const kv = (init = {}) => {
      const store = new Map(Object.entries(init));
      return { store, writes: 0, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { this.writes += 1; store.set(k, v); } };
    };
    // 13:30 UTC = 19:00 IST on 10-11-2026.
    const at = (istHhmm) => Date.parse(`2026-11-10T${istHhmm}:00+05:30`);
    const env = (wake) => ({ WAKE: wake, APP_URL: 'https://app.test', ADMIN_KEY: 'k', RETRY_MS: '1' });

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'waker-'));
      const file = join(dir, 'worker.mjs');
      writeFileSync(file, `${WORKER_SOURCE}\nexport { run };\n`);
      ({ run } = await import(/* @vite-ignore */ file));
    });
    beforeEach(() => {
      calls = [];
      vi.stubGlobal('fetch', async (url, init) => {
        calls.push({ url, key: init.headers['X-Admin-Key'] });
        const answer = globalThis.__answer;
        if (answer === 'throw') throw new Error('down');
        return { ok: answer < 400, status: answer };
      });
      globalThis.__answer = 202;
    });
    afterEach(() => vi.unstubAllGlobals());

    it('pings only tenants whose time has come, once a day', async () => {
      const wake = kv({ tenants: JSON.stringify({ default: '19:00', late: '21:00' }) });
      const out = await run(env(wake), at('19:00'));
      expect(out).toEqual([{ id: 'default', ok: true }]);
      expect(calls).toEqual([{ url: 'https://app.test/api/v1/jobs/daily?tenant=default', key: 'k' }]);
      expect(wake.store.has('ran:default:2026-11-10')).toBe(true);
      expect(await run(env(wake), at('19:05'))).toEqual([]);
    });

    it('runs a time after the last check (23:55) at 23:55', async () => {
      const wake = kv({ tenants: JSON.stringify({ owl: '23:58' }) });
      expect(await run(env(wake), at('23:50'))).toEqual([]);
      expect(await run(env(wake), at('23:55'))).toEqual([{ id: 'owl', ok: true }]);
    });

    it('tries 3 times, then again at the next check, writing the miss once', async () => {
      globalThis.__answer = 'throw';
      const wake = kv({ tenants: JSON.stringify({ default: '19:00' }) });
      expect(await run(env(wake), at('19:00'))).toEqual([{ id: 'default', ok: false }]);
      expect(calls).toHaveLength(3);
      const writes = wake.writes;
      await run(env(wake), at('19:05'));
      expect(wake.writes).toBe(writes);
      globalThis.__answer = 202;
      expect(await run(env(wake), at('19:10'))).toEqual([{ id: 'default', ok: true }]);
    });

    it('treats a refused key as a miss', async () => {
      globalThis.__answer = 401;
      const wake = kv({ tenants: JSON.stringify({ default: '19:00' }) });
      expect(await run(env(wake), at('19:00'))).toEqual([{ id: 'default', ok: false }]);
    });

    it('pings at most 12 tenants a run, so it stays inside the free plan', async () => {
      const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}`, '19:00']));
      const wake = kv({ tenants: JSON.stringify(many) });
      expect(await run(env(wake), at('19:00'))).toHaveLength(12);
      expect(await run(env(wake), at('19:05'))).toHaveLength(8);
    });

    it('ignores a bad or missing tenants list', async () => {
      expect(await run(env(kv({ tenants: 'nope' })), at('19:00'))).toEqual([]);
      expect(await run(env(kv()), at('19:00'))).toEqual([]);
      expect(await run(env(kv({ tenants: JSON.stringify({ x: '7pm' }) })), at('19:00'))).toEqual([]);
    });
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
