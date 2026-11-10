import { describe, it, expect } from 'vitest';
import { inFolders, guardDrive, NOT_YOURS, NOT_YOURS_FOLDER } from '../src/utils/driveGuard.js';
import { costSplit, ownerOn } from '../src/utils/costUsageView.js';
import { ownerOf } from '../src/services/usageMeter.js';

describe('Drive guard on the shared service account', () => {
  const calls = [];
  const drive = {
    parentsOf: async (id) => ({ mine: ['F1'], theirs: ['OWNER'] }[id] || []),
    download: async (id) => { calls.push(id); return Buffer.from(id); },
    shareAnyone: async () => {},
    renameFile: async () => {},
    listFiles: async () => [],
  };
  const g = guardDrive(drive, async () => ['F1', 'F2']);

  it('inFolders', () => {
    expect(inFolders(['x', 'F2'], ['F1', 'F2'])).toBe(true);
    expect(inFolders(['x'], ['F1'])).toBe(false);
    expect(inFolders([], [])).toBe(false);
  });
  it('a file in the tenant\'s folder downloads', async () => {
    expect(String(await g.download('mine'))).toBe('mine');
  });
  it('another tenant\'s file is refused before any download or share', async () => {
    await expect(g.download('theirs')).rejects.toThrow(NOT_YOURS);
    await expect(g.shareAnyone('theirs')).rejects.toThrow(NOT_YOURS);
    await expect(g.renameFile('theirs', 'x')).rejects.toThrow(NOT_YOURS);
    expect(calls).not.toContain('theirs');
  });
  it('listing asks listOk first when given', async () => {
    const lg = guardDrive(drive, async () => ['F1'], { listOk: async (f) => f !== 'OWNER' });
    await expect(lg.listFiles('OWNER')).rejects.toThrow(NOT_YOURS_FOLDER);
    expect(await lg.listFiles('F1')).toEqual([]);
    expect(await g.listFiles('anything')).toEqual([]);
  });
});

describe('whose key paid, on the day', () => {
  const history = [
    { from: '2026-10-01T00:00:00Z', owners: { openai: 'platform' } },
    { from: '2026-10-15T04:00:00Z', owners: { openai: 'tenant' } },
  ];
  it('ownerOn picks the entry in force at the end of the IST day', () => {
    expect(ownerOn(history, 'openai', '2026-10-10')).toBe('platform');
    expect(ownerOn(history, 'openai', '2026-10-15')).toBe('tenant');
    expect(ownerOn(history, 'openai', '2026-09-01')).toBe('platform');
    expect(ownerOn([], 'openai', '2026-10-10')).toBe(null);
  });
  it('costSplit: kept owner first, then history, then today\'s keys', () => {
    const rows = [
      { tenant_id: 'acme', day: '2026-10-10', month: '2026-10', provider: 'openai', usd: 4 },
      { tenant_id: 'acme', day: '2026-10-20', month: '2026-10', provider: 'openai', usd: 6 },
      { tenant_id: 'acme', day: '2026-10-20', month: '2026-10', provider: 'openai', key_owner: 'platform', usd: 1 },
      { tenant_id: 'acme', day: '2026-10-20', month: '2026-10', provider: 'kling', usd: 2 },
    ];
    const s = costSplit(rows, { acme: { openai: 'tenant', kling: 'tenant' } }, { acme: history });
    expect(s.acme['2026-10']).toMatchObject({ total: 13, onBill: 5, own: 8 });
  });
  it('the meter keeps the owner at the call', () => {
    expect(ownerOf({ keyOwners: { openai: 'tenant' } }, 'openai')).toBe('tenant');
    expect(ownerOf({ keyOwners: { openai: 'platform' } }, 'openai')).toBe('platform');
    expect(ownerOf({}, 'gemini')).toBe('platform');
  });
});
