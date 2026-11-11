import { describe, it, expect } from 'vitest';
import { pickStage, stageFor, autoOpen, sheetIdFrom, wizardIndex, buildPrompt, SHEET_HEADERS, SHEET_SAMPLE, PROMPT_FIELDS } from '../src/utils/tourSpec.js';
import { sheetColumnIndex, extractRow } from '../src/utils/postCompose.js';
import { navHtml } from '../src/utils/adminNav.js';

const basics = { approval_email: 'a@b.c', cta_link: 'https://x.y' };
const accounts = { postforme_accounts: '["spc_1"]' };
const folder = { direct_drive_folder: '1FolderIdFolderIdFolderId' };
const sheet = { sheet_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz' };

describe('onboarding tour stages', () => {
  it('no funnel means add', () => {
    expect(pickStage([])).toEqual({ stage: 'add', funnel: null });
  });

  it('walks basics, accounts, the Drive folder, then the sheet last', () => {
    expect(stageFor({})).toBe('basics');
    expect(stageFor({ ...basics })).toBe('publish');
    expect(stageFor({ ...basics, ...accounts })).toBe('ready');
    expect(stageFor({ ...basics, ...accounts, ...folder })).toBe('image');
    expect(stageFor({ ...basics, ...accounts, ...folder, ...sheet })).toBe('done');
  });

  it('the funnel media folder counts as the ready videos folder', () => {
    expect(stageFor({ ...basics, ...accounts, drive_folder_id: '1MediaFolderMediaFolder' })).toBe('image');
  });

  it('an empty account list is not connected', () => {
    expect(stageFor({ ...basics, postforme_accounts: '[]' })).toBe('publish');
  });

  it('picks the first unfinished funnel, or the one open on the page', () => {
    const list = [
      { id: 1, name: 'Done', cfg: { ...basics, ...accounts, ...folder, ...sheet } },
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
    expect(cols.subhead).not.toBe(-1);
    expect(cols.hashtags).not.toBe(-1);
    for (const row of SHEET_SAMPLE) {
      expect(row).toHaveLength(SHEET_HEADERS.length);
      const f = extractRow(SHEET_HEADERS, row);
      expect(f.hasSchema && f.isReady).toBe(true);
      expect(f.imagePrompt).toContain('no words');
    }
  });

  it('the prompt carries the business details, the headers and the template name', () => {
    const p = buildPrompt({ niche: 'yoga for desk workers', cta: 'Book a free class: https://x.y', website: 'https://site.example' });
    expect(p).toContain('Niche: yoga for desk workers');
    expect(p).toContain('Website: https://site.example');
    expect(p).toContain('Book a free class: https://x.y');
    expect(p).toContain(SHEET_HEADERS.join(', '));
    expect(p).toContain('content-sheet-template.xlsx');
    expect(p).not.toContain(String.fromCharCode(0x2014));
  });

  it('a blank field stays a [placeholder] to fill in the AI', () => {
    const p = buildPrompt({});
    for (const [, label] of PROMPT_FIELDS) expect(p).toContain(`[${label.toLowerCase()}]`);
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
