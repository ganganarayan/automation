import { describe, it, expect } from 'vitest';
import { pickStage, stageFor, autoOpen, sheetIdFrom, wizardIndex, SHEET_HEADERS } from '../src/utils/tourSpec.js';
import { sheetColumnIndex, extractRow } from '../src/utils/postCompose.js';
import { navHtml } from '../src/utils/adminNav.js';

const basics = { approval_email: 'a@b.c', cta_link: 'https://x.y' };
const accounts = { postforme_accounts: '["spc_1"]' };
const sheet = { sheet_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz' };

describe('onboarding tour stages', () => {
  it('no funnel means add', () => {
    expect(pickStage([])).toEqual({ stage: 'add', funnel: null });
  });

  it('walks basics, then accounts, then the sheet, then done', () => {
    expect(stageFor({})).toBe('basics');
    expect(stageFor({ ...basics })).toBe('publish');
    expect(stageFor({ ...basics, ...accounts })).toBe('image');
    expect(stageFor({ ...basics, ...accounts, ...sheet })).toBe('done');
  });

  it('an empty account list is not connected', () => {
    expect(stageFor({ ...basics, postforme_accounts: '[]' })).toBe('publish');
  });

  it('picks the first unfinished funnel, or the one open on the page', () => {
    const list = [
      { id: 1, name: 'Done', cfg: { ...basics, ...accounts, ...sheet } },
      { id: 2, name: 'New', cfg: {} },
    ];
    expect(pickStage(list)).toEqual({ stage: 'basics', funnel: { id: 2, name: 'New' } });
    expect(pickStage(list, '1')).toEqual({ stage: 'done', funnel: { id: 1, name: 'Done' } });
    expect(pickStage(list, 99).funnel.id).toBe(2);
  });

  it('opens by itself only while unfinished and not skipped', () => {
    expect(autoOpen('basics', '')).toBe(true);
    expect(autoOpen('basics', 'dismissed')).toBe(false);
    expect(autoOpen('done', '')).toBe(false);
  });

  it('maps stages onto wizard pages', () => {
    expect(wizardIndex('basics')).toBe(0);
    expect(wizardIndex('image')).toBeGreaterThan(0);
    expect(wizardIndex('publish')).toBeGreaterThan(0);
  });
});

describe('sheet the tour asks for', () => {
  it('the headers it hands out are a content sheet the poster reads', () => {
    const cols = sheetColumnIndex(SHEET_HEADERS);
    expect(cols.status).not.toBe(-1);
    expect(cols.prompt).not.toBe(-1);
    expect(cols.headline).not.toBe(-1);
    expect(cols.caption).not.toBe(-1);
    expect(extractRow(SHEET_HEADERS, ['Ready', 'h', 'p', 'c']).hasSchema).toBe(true);
  });

  it('keeps only the ID of a pasted sheet link', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123';
    expect(sheetIdFrom(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(sheetIdFrom(id)).toBe(id);
    expect(sheetIdFrom('not a sheet')).toBe('');
  });
});

describe('help bot is on every page with the menu', () => {
  it('the menu loads the tour script', () => {
    expect(navHtml()).toContain('/api/v1/admin/tour.js');
  });
});
