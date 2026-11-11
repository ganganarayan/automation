import { describe, it, expect } from 'vitest';
import { ROWS, US, COMPETITORS, VERDICT, REVENUE_PATH, CHECKED_ON } from '../src/utils/compareData.js';
import { compareIndexPage, comparisonPage, competitorForPage } from '../src/utils/comparePages.js';
import { homePage, comparePath } from '../src/utils/publicPages.js';

const keys = ROWS.filter((r) => r.key).map((r) => r.key);
const EM = String.fromCharCode(0x2014);

describe('comparison data', () => {
  it('we answer every row', () => {
    for (const k of keys) {
      expect(US[k], k).toBeTruthy();
      expect(VERDICT[US[k][0]], k).toBeTruthy();
    }
  });
  it('every competitor answers every row with a valid verdict and a source on the web', () => {
    for (const c of COMPETITORS) {
      for (const k of keys) {
        const row = c.rows[k];
        expect(row, `${c.slug}.${k}`).toBeTruthy();
        expect(VERDICT[row[0]], `${c.slug}.${k}`).toBeTruthy();
        expect(row[2], `${c.slug}.${k} source`).toMatch(/^https:\/\//);
      }
      expect(c.theyWin.length).toBeGreaterThan(3);
      expect(c.betterWhen).toBeTruthy();
    }
  });
  it('slugs are unique and the check date is DD-MM-YYYY', () => {
    expect(new Set(COMPETITORS.map((c) => c.slug)).size).toBe(COMPETITORS.length);
    expect(CHECKED_ON).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  });
  it('the revenue path points at real rows', () => {
    for (const [, , key] of REVENUE_PATH) expect(keys).toContain(key);
  });
});

describe('comparison pages', () => {
  it('page names resolve only with the content-engine-vs- prefix', () => {
    expect(competitorForPage('content-engine-vs-buffer')?.name).toBe('Buffer');
    expect(competitorForPage('buffer')).toBeNull();
    expect(competitorForPage('content-engine-vs-nope')).toBeNull();
    expect(comparisonPage(null)).toBe('');
  });
  it('each competitor page has its name, sources, what they do better and no em dash', () => {
    for (const c of COMPETITORS) {
      const h = comparisonPage(c, { email: 'a@b.co' });
      expect(h).toContain(`Content Engine vs <em>${c.name}</em>`);
      expect(h).toContain(c.rows.entryPrice[2]);
      expect(h).toContain(`What ${c.name} does better`);
      expect(h).toContain('mailto:a@b.co');
      expect(h).not.toContain(EM);
      expect(h).not.toContain('undefined');
    }
  });
  it('the index and the home page link to every comparison', () => {
    const idx = compareIndexPage();
    const home = homePage();
    for (const c of COMPETITORS) {
      expect(idx).toContain(`href="${comparePath(c)}"`);
      expect(home).toContain(`href="${comparePath(c)}"`);
    }
    expect(home).toContain('href="/compare"');
    expect(home).toContain('Start revenue from posts');
  });
});
