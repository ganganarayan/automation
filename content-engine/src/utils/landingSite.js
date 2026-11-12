/**
 * Landing site on Cloudflare.
 *
 * Purpose:      The public pages (home, compare, policies) rendered once into
 *               plain HTML and served by one Cloudflare Worker on the owner's
 *               own domain, so visitors never wait for the Railway app.
 * Responsibility:
 *               - renderLanding: every public page, in rupees and in dollars
 *                 where the page shows a price.
 *               - pagesModule / LANDING_WORKER_SOURCE: the Worker. A landing
 *                 path is answered from the pages; any other path (Sign in,
 *                 /buy, the app) is sent on to the app's own address.
 *               - landingWorkerName, cleanDomain, zoneCandidates, landingRequests.
 * Dependencies: utils/{publicPages,comparePages,compareData,kbPages,kbData}.
 */
import * as publicPages from './publicPages.js';
import * as comparePages from './comparePages.js';
import { COMPETITORS } from './compareData.js';
import * as kbPages from './kbPages.js';
import { kbArticles } from './kbData.js';

const API = 'https://api.cloudflare.com/client/v4';
export const LANDING_DEPLOY_KEY = 'landing_deployed';
export const LANDING_DOMAIN_KEY = 'landing_domain';
export const LANDING_APP_KEY = 'landing_app_domain';

/**
 * { path: { inr, usd } } or { path: { all } } for a page with no price.
 * A page that is not HTML carries its content type: { all, type }.
 * `origin` (https://host) makes canonical links, the sitemap and llms.txt absolute.
 */
export function renderLanding({ email = '', origin = '', appUrl = '' } = {}) {
  const both = (fn) => ({ inr: fn('inr'), usd: fn('usd') });
  const pages = {
    '/': both((cur) => publicPages.homePage({ email, cur })),
    '/compare': both((cur) => comparePages.compareIndexPage({ email, cur })),
    '/privacy': { all: publicPages.privacyPage({ email }) },
    '/terms': { all: publicPages.termsPage({ email }) },
    '/refund': both((cur) => publicPages.refundPage({ email, cur })),
    '/shipping': { all: publicPages.shippingPage({ email }) },
  };
  for (const c of COMPETITORS) pages[publicPages.comparePath(c)] = both((cur) => comparePages.comparisonPage(c, { email, cur }));
  pages['/kb'] = both((cur) => kbPages.kbIndexPage({ email, cur, origin }));
  for (const a of kbArticles()) pages[kbPages.kbPath(a)] = both((cur) => kbPages.kbArticlePage(a.slug, { email, cur, origin }));
  const text = 'text/plain; charset=utf-8';
  pages['/llms.txt'] = { all: kbPages.llmsTxt({ origin }), type: text };
  pages['/llms-full.txt'] = { all: kbPages.llmsFullTxt({ origin }), type: text };
  pages['/robots.txt'] = { all: kbPages.robotsTxt({ origin }), type: text };
  pages['/sitemap.xml'] = { all: kbPages.sitemapXml({ origin }), type: 'application/xml; charset=utf-8' };
  if (appUrl) {
    for (const p of Object.values(pages)) {
      if (p.type) continue;
      for (const k of ['all', 'inr', 'usd']) if (p[k]) p[k] = appLinks(p[k], appUrl);
    }
  }
  return pages;
}

/** Sign in and Buy link straight to the app's own address instead of bouncing through the landing domain. */
export function appLinks(html, appUrl) {
  const a = String(appUrl).replace(/\/+$/, '');
  return String(html)
    .split('href="/api/v1/').join(`href="${a}/api/v1/`)
    .split('href="/buy?').join(`href="${a}/buy?`)
    .split("a.href='/buy?").join(`a.href='${a}/buy?`);
}

/** The pages as the Worker's second module. */
export function pagesModule(pages) {
  return `export default ${JSON.stringify(pages)};\n`;
}

/** The Worker: a landing path from the pages, anything else on to the app. */
export const LANDING_WORKER_SOURCE = `import PAGES from './pages.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\\/+$/, '') || '/';
    const page = PAGES[path];
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (!page || !read) return Response.redirect(String(env.APP_URL) + url.pathname + url.search, read ? 302 : 307);
    let cur = String(url.searchParams.get('cur') || '').toLowerCase();
    if (cur !== 'inr' && cur !== 'usd') cur = (request.cf && request.cf.country) === 'IN' ? 'inr' : 'usd';
    const html = page.all || page[cur];
    return new Response(request.method === 'HEAD' ? null : html, {
      headers: { 'content-type': page.type || 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-robots-tag': 'all' },
    });
  },
};
`;

/** A bare host name from whatever the owner typed: no scheme, path or trailing dot. */
export function cleanDomain(input = '') {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/\.+$/, '');
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : '';
}

/** The zones a host could sit in, longest first: a.b.example.com, b.example.com, example.com. */
export function zoneCandidates(host = '') {
  const parts = String(host).split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i <= parts.length - 2; i += 1) out.push(parts.slice(i).join('.'));
  return out;
}

/** One landing Worker per deployment, named from the app's public address like the waker. */
export function landingWorkerName(baseUrl = '') {
  let host = '';
  try { host = new URL(String(baseUrl)).hostname; } catch { host = ''; }
  const label = (host.split('.')[0] || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `landing-${label || 'app'}`.slice(0, 63).replace(/-$/, '');
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

/** The Cloudflare API calls the landing deploy makes (url + init). */
export const landingRequests = {
  putScript: (account, token, name, { appUrl, pages }) => {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      main_module: 'worker.js',
      compatibility_date: '2025-06-01',
      bindings: [{ type: 'plain_text', name: 'APP_URL', text: appUrl }],
    })], { type: 'application/json' }));
    form.append('worker.js', new Blob([LANDING_WORKER_SOURCE], { type: 'application/javascript+module' }), 'worker.js');
    form.append('pages.js', new Blob([pagesModule(pages)], { type: 'application/javascript+module' }), 'pages.js');
    return { url: `${API}/accounts/${account}/workers/scripts/${name}`, init: { method: 'PUT', headers: auth(token), body: form } };
  },
  findZone: (token, zoneName) => ({ url: `${API}/zones?name=${encodeURIComponent(zoneName)}`, init: { headers: auth(token) } }),
  listDomains: (account, token, hostname) => ({ url: `${API}/accounts/${account}/workers/domains?hostname=${encodeURIComponent(hostname)}`, init: { headers: auth(token) } }),
  putDomain: (account, token, { hostname, service, zoneId = '', zoneName = '' }) => ({
    url: `${API}/accounts/${account}/workers/domains`,
    init: {
      method: 'PUT',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: 'production', hostname, service, ...(zoneId ? { zone_id: zoneId } : { zone_name: zoneName }) }),
    },
  }),
};

export default { appLinks, LANDING_DEPLOY_KEY, LANDING_DOMAIN_KEY, LANDING_APP_KEY, renderLanding, pagesModule, LANDING_WORKER_SOURCE, cleanDomain, zoneCandidates, landingWorkerName, landingRequests };
