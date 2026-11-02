import { describe, it, expect } from 'vitest';
import { postedRowPlan, postedLinks, CELL_NEWLINE } from '../src/utils/routerSpec.js';

// A Gita-style sheet with one image row already posted.
const header = ['day', 'image_prompt', 'caption', 'status', 'pfm_post_id'];
const posted = ['7', 'a still river', 'Focus', 'Posted', 'pfm_111'];

describe('postedRowPlan', () => {
  it('plans a Posted row with the links one per line', () => {
    const plan = postedRowPlan([header, posted], {
      title: 'Why focus wins',
      postedAt: '02-11-2026 08:02',
      postRefs: ['pfm_222'],
      links: ['https://a.example/1', 'https://b.example/2'],
    });
    expect(plan.rowNumber).toBe(0); // append, not fill in
    // 'title', 'posted at' and 'posted links' were missing: created in order.
    expect(plan.added.map((a) => a.name)).toEqual(['title', 'posted at', 'posted links']);
    expect(plan.added.map((a) => a.index)).toEqual([5, 6, 7]);
    const v = plan.values;
    expect(v[0]).toBe('8'); // the day column continues 7
    expect(v[3]).toBe('Posted');
    expect(v[4]).toBe('pfm_222');
    expect(v[5]).toBe('Why focus wins');
    expect(v[6]).toBe('02-11-2026 08:02');
    expect(v[7]).toBe(`https://a.example/1${CELL_NEWLINE}https://b.example/2`);
    expect(v).toHaveLength(8);
  });

  it('keeps the image prompt and caption of an appended row empty', () => {
    const plan = postedRowPlan([header, posted], { title: 'T', postedAt: 'x', postRefs: ['pfm_222'] });
    expect(plan.values[1]).toBe('');
    expect(plan.values[2]).toBe('');
  });

  it('fills in the row this post already has instead of appending again', () => {
    const plan = postedRowPlan([[...header, 'posted links'], [...posted, '']], {
      title: 'ignored',
      postedAt: '02-11-2026 09:00',
      postRefs: ['pfm_111'],
      links: ['https://a.example/1'],
    });
    expect(plan.rowNumber).toBe(2);
    expect(plan.values).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.cells.status).toBe('Posted');
    expect(plan.cells['posted at']).toBe('02-11-2026 09:00');
    expect(plan.cells['posted links']).toBe('https://a.example/1');
  });

  it('matches a row whose id cell holds several ids', () => {
    const rows = [header, ['7', 'p', 'c', 'Posted', 'pfm_000, pfm_111']];
    expect(postedRowPlan(rows, { postRefs: ['pfm_111'] }).rowNumber).toBe(2);
  });

  it('plans no links column when no channel gave back a link', () => {
    const plan = postedRowPlan([header, posted], { title: 'T', postedAt: 'x', postRefs: ['pfm_333'], links: [] });
    expect(plan.added.map((a) => a.name)).toEqual(['title', 'posted at']);
    expect(plan.cells['posted links']).toBeUndefined();
  });

  it('continues a dated key when the sheet is not numbered', () => {
    const rows = [['id', 'image_prompt', 'status'], ['auto-20261101-1200-1', 'p', 'Posted']];
    const plan = postedRowPlan(rows, { postRefs: ['pfm_444'] });
    expect(plan.values[0]).toMatch(/^auto-\d{8}-\d{4}-1$/);
  });

  it('does nothing on a sheet with no header', () => {
    const plan = postedRowPlan([], { postRefs: ['p'] });
    expect(plan.header).toEqual([]);
    expect(plan.values).toEqual([]);
    expect(plan.rowNumber).toBe(0);
  });
});

describe('postedLinks', () => {
  it('keeps the posted channels, de-duped, and drops the rest', () => {
    expect(postedLinks([
      { state: 'ok', url: 'https://a/1' },
      { state: 'ok', url: 'https://a/1' },
      { state: 'ok', url: '' },
      { state: 'failed', url: 'https://b/2' },
      { state: 'waiting' },
    ])).toEqual(['https://a/1']);
  });

  it('survives rubbish', () => {
    expect(postedLinks(null)).toEqual([]);
    expect(postedLinks(undefined)).toEqual([]);
    expect(postedLinks('nope')).toEqual([]);
  });
});
