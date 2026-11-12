import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderLanding, pagesModule, LANDING_WORKER_SOURCE, cleanDomain, zoneCandidates, landingWorkerName, landingRequests,
} from '../src/utils/landingSite.js';

async function loadWorker(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'landing-'));
  writeFileSync(join(dir, 'pages.js'), pagesModule(pages));
  writeFileSync(join(dir, 'worker.js'), LANDING_WORKER_SOURCE);
  return (await import(/* @vite-ignore */ join(dir, 'worker.js'))).default;
}

const ask = (url, { country, method = 'GET' } = {}) => {
  const r = new Request(url, { method });
  Object.defineProperty(r, 'cf', { value: country ? { country } : undefined });
  return r;
};

describe('landing site on Cloudflare', () => {
  const pages = renderLanding({ email: 'hello@example.com' });

  it('renders every public page, priced pages in both currencies', () => {
    expect(Object.keys(pages)).toEqual(expect.arrayContaining(['/', '/compare', '/privacy', '/terms', '/refund', '/shipping', '/compare/content-engine-vs-buffer']));
    expect(pages['/'].inr).toContain('₹');
    expect(pages['/'].usd).toContain('$');
    expect(pages['/privacy'].all).toContain('hello@example.com');
  });

  it('fits a free Worker (under 3 MB)', () => {
    expect(Buffer.byteLength(pagesModule(pages)) + Buffer.byteLength(LANDING_WORKER_SOURCE)).toBeLessThan(3 * 1024 * 1024);
  });

  it('serves a landing path by country and sends the rest to the app', async () => {
    const w = await loadWorker(pages);
    const env = { APP_URL: 'https://app.example.com' };
    const india = await w.fetch(ask('https://site.example.com/', { country: 'IN' }), env);
    expect(india.status).toBe(200);
    expect(await india.text()).toBe(pages['/'].inr);
    const us = await w.fetch(ask('https://site.example.com/compare/', { country: 'US' }), env);
    expect(await us.text()).toBe(pages['/compare'].usd);
    const forced = await w.fetch(ask('https://site.example.com/?cur=inr', { country: 'US' }), env);
    expect(await forced.text()).toBe(pages['/'].inr);
    const login = await w.fetch(ask('https://site.example.com/api/v1/admin/today'), env);
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('https://app.example.com/api/v1/admin/today');
    const buy = await w.fetch(ask('https://site.example.com/buy?plan=brand&bill=mo'), env);
    expect(buy.headers.get('location')).toBe('https://app.example.com/buy?plan=brand&bill=mo');
    const post = await w.fetch(ask('https://site.example.com/', { method: 'POST' }), env);
    expect(post.status).toBe(307);
  });

  it('cleans the typed domain and lists its zones', () => {
    expect(cleanDomain(' https://Content360.Example.com/x ')).toBe('content360.example.com');
    expect(cleanDomain('not a domain')).toBe('');
    expect(zoneCandidates('content360.divineleads.guru')).toEqual(['content360.divineleads.guru', 'divineleads.guru']);
    expect(landingWorkerName('https://content-engine-production-230f.up.railway.app')).toBe('landing-content-engine-production-230f');
  });

  it('attaches by zone id, or by zone name when the id is unknown', () => {
    const byId = JSON.parse(landingRequests.putDomain('a', 't', { hostname: 'h.example.com', service: 's', zoneId: 'z' }).init.body);
    expect(byId).toMatchObject({ hostname: 'h.example.com', service: 's', zone_id: 'z' });
    const byName = JSON.parse(landingRequests.putDomain('a', 't', { hostname: 'h.example.com', service: 's', zoneName: 'example.com' }).init.body);
    expect(byName).toMatchObject({ zone_name: 'example.com' });
  });
});

describe('landing domain lookup', () => {
  it('asks Cloudflare which Worker holds the hostname', () => {
    expect(landingRequests.listDomains('a', 't', 'h.example.com').url).toBe('https://api.cloudflare.com/client/v4/accounts/a/workers/domains?hostname=h.example.com');
  });
});
