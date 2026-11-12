import { describe, it, expect } from 'vitest';
import { KB_TOPICS, kbArticles, kbDate } from '../src/utils/kbData.js';
import { kbIndexPage, kbArticlePage, sitemapXml, robotsTxt, llmsTxt, llmsFullTxt, kbPath } from '../src/utils/kbPages.js';
import { renderLanding } from '../src/utils/landingSite.js';

const O = 'https://content360.example.com';
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

describe('knowledge base', () => {
  const arts = kbArticles('inr');

  it('every article is well formed, unique, and links only to real articles', () => {
    const slugs = new Set(arts.map((a) => a.slug));
    expect(slugs.size).toBe(arts.length);
    for (const a of arts) {
      expect(KB_TOPICS.some((t) => t.id === a.topic)).toBe(true);
      expect(a.question.endsWith('?')).toBe(true);
      expect(a.short.length).toBeGreaterThan(40);
      for (const s of a.sections) expect(s.q.endsWith('?')).toBe(true);
      for (const r of a.related) expect(slugs.has(r)).toBe(true);
      expect(kbDate(a.updated)).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    }
  });

  it('never writes an em dash', () => {
    const all = JSON.stringify([kbArticles('inr'), kbArticles('usd'), KB_TOPICS]) + llmsFullTxt({ origin: O }) + kbIndexPage({ origin: O });
    expect(all.includes('\u2014')).toBe(false);
  });

  it('prices follow the currency', () => {
    const inr = kbArticles('inr').find((a) => a.slug === 'how-much-does-content-engine-cost');
    const usd = kbArticles('usd').find((a) => a.slug === 'how-much-does-content-engine-cost');
    expect(inr.short).toContain('₹');
    expect(inr.short).toContain('GST');
    expect(usd.short).toContain('$');
  });

  it('index page has search, every article and valid JSON-LD with a SearchAction', () => {
    const html = kbIndexPage({ origin: O });
    expect(html).toContain('id="kb-q"');
    for (const a of arts) expect(html).toContain(`href="${kbPath(a)}"`);
    const ld = ldBlocks(html);
    expect(ld.find((x) => x['@type'] === 'WebSite').potentialAction.target).toBe(`${O}/kb?q={search_term_string}`);
    expect(ld.find((x) => x['@type'] === 'FAQPage').mainEntity.length).toBe(arts.length);
    const data = JSON.parse(/<script type="application\/json" id="kb-data">(.*?)<\/script>/.exec(html)[1]);
    expect(data.length).toBe(arts.length);
    expect(html).toContain(`<link rel="canonical" href="${O}/kb">`);
  });

  it('article page answers first, with Article, FAQPage and breadcrumbs', () => {
    const a = arts[0];
    const html = kbArticlePage(a.slug, { origin: O });
    expect(html.indexOf('kb-answer')).toBeLessThan(html.indexOf('<h2>'));
    const types = ldBlocks(html).map((x) => x['@type']);
    expect(types).toEqual(['Article', 'FAQPage', 'BreadcrumbList']);
    expect(html).toContain(`<link rel="canonical" href="${O}${kbPath(a)}">`);
    expect(kbArticlePage('no-such-answer')).toBe('');
  });

  it('sitemap, robots and llms.txt list the answers with absolute links', () => {
    const map = sitemapXml({ origin: O });
    for (const a of arts) expect(map).toContain(`<loc>${O}${kbPath(a)}</loc>`);
    expect(map).toContain(`<loc>${O}/</loc>`);
    expect(robotsTxt({ origin: O })).toContain(`Sitemap: ${O}/sitemap.xml`);
    expect(robotsTxt({ origin: O })).toContain('User-agent: GPTBot');
    const llms = llmsTxt({ origin: O });
    expect(llms.startsWith('# Content Engine')).toBe(true);
    expect(llms).toContain(`(${O}${kbPath(arts[0])})`);
    expect(llmsFullTxt({ origin: O })).toContain(`## ${arts[0].question}`);
  });

  it('the landing Worker carries the KB and the text files with their types', () => {
    const pages = renderLanding({ origin: O });
    expect(pages['/kb'].inr).toContain('How can we');
    expect(pages[kbPath(arts[0])].usd).toContain(arts[0].question);
    expect(pages['/llms.txt'].type).toContain('text/plain');
    expect(pages['/sitemap.xml'].type).toContain('xml');
  });
});
