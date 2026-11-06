import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryAction, parseRetryDate, retryDateDefaults, retitleForDate, RETRY_PICK_SCRIPT } from '../src/utils/retrySpec.js';
import { imageAccounts } from '../src/utils/routerSpec.js';

const repo = { get: vi.fn(), transition: vi.fn(), setStatus: vi.fn(), setMeta: vi.fn(), liveOnDate: vi.fn(), supersede: vi.fn(), releaseSlot: vi.fn() };
const days = { get: vi.fn(), update: vi.fn(), claim: vi.fn(), release: vi.fn() };
const svc = { updateStep: vi.fn(), parseSteps: (r) => r.steps || [] };
const runner = { routerInfo: vi.fn(), runStages: vi.fn(() => Promise.resolve()), runScriptAndReview: vi.fn(() => Promise.resolve()) };

vi.mock('../src/repositories/instanceRepository.js', () => repo);
vi.mock('../src/repositories/routerDaysRepository.js', () => days);
vi.mock('../src/services/instanceService.js', () => svc);
vi.mock('../src/services/stageRunnerService.js', () => runner);
vi.mock('../src/repositories/funnelsRepository.js', () => ({}));
vi.mock('../src/services/creditService.js', () => ({}));
vi.mock('../src/services/instanceReviewService.js', () => ({ requestReview: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/services/imageLaneService.js', () => ({ retry: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/services/stepLogService.js', () => ({}));
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: vi.fn() }));
vi.mock('../src/core/heartbeat.js', () => ({ during: (_label, fn) => Promise.resolve(fn()) }));
vi.mock('../src/settings/index.js', () => ({ settings: {} }));
vi.mock('../src/core/logger.js', () => ({ childLogger: () => ({ child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} }) }));

const { retry } = await import('../src/services/aiLaneService.js');

const NOW = new Date('2026-11-04T12:00:00.000Z'); // 17:30 IST

describe('parseRetryDate', () => {
  it('reads the picker as IST', () => {
    const m = parseRetryDate('2026-11-06T08:30', NOW);
    expect(m.at.toISOString()).toBe('2026-11-06T03:00:00.000Z');
    expect(m.postDate).toBe('2026-11-06');
    expect(m.text).toBe('06-11-2026');
  });

  it('refuses a past time or nonsense', () => {
    expect(parseRetryDate('2026-11-04T17:00', NOW)).toBeNull();
    expect(parseRetryDate('tomorrow', NOW)).toBeNull();
    expect(parseRetryDate('', NOW)).toBeNull();
  });
});

describe('retryDateDefaults', () => {
  it('starts on tomorrow at the row\'s own time', () => {
    const d = retryDateDefaults({ scheduled_for: '2026-11-03T02:02:00.000Z' }, NOW); // 07:32 IST
    expect(d).toEqual({ min: '2026-11-04T17:30', suggest: '2026-11-05T07:32' });
  });

  it('copes with no date', () => {
    expect(retryDateDefaults({}, NOW).suggest).toBe('2026-11-05T08:00');
  });
});

describe('retitleForDate', () => {
  it('moves the trailing date only', () => {
    expect(retitleForDate('Streaming Beats the RAM Wall · 03-11-2026', '06-11-2026')).toBe('Streaming Beats the RAM Wall · 06-11-2026');
    expect(retitleForDate('A manual run', '06-11-2026')).toBe('A manual run');
  });
});

describe('the date picker script', () => {
  it('parses', () => {
    expect(() => new Function(RETRY_PICK_SCRIPT)).not.toThrow();
  });
});

describe('image posts and YouTube', () => {
  const map = { a: { platform: 'youtube' }, b: { platform: 'facebook' }, c: {} };

  it('leaves YouTube out, and nothing else', () => {
    expect(imageAccounts(['a', 'b', 'c'], map)).toEqual(['b', 'c']);
    expect(imageAccounts(null, map)).toEqual([]);
  });

  it('offers Retry for an image post whose YouTube Short failed', () => {
    const row = { status: 'partial', source_type: 'sheet' };
    const pub = (platform) => [{ key: 'publish', artifacts: { channels: [{ state: 'ok', platform: 'facebook' }, { state: 'failed', platform }] } }];
    expect(retryAction(row, pub('youtube'))).toBe('channels');
    expect(retryAction(row, pub('instagram'))).toBe('channels');
  });

  it('still re-posts a video that YouTube refused', () => {
    const row = { status: 'partial', source_type: 'drive_folder' };
    expect(retryAction(row, [{ key: 'publish', artifacts: { channels: [{ state: 'failed', platform: 'youtube' }] } }])).toBe('channels');
  });
});

describe('retry and its date', () => {
  const row = { id: 'r1', tenant_id: 't', funnel_id: 7, status: 'failed', title: 'Topic · 03-11-2026', scheduled_for: '2026-11-03T02:02:00.000Z' };
  const moved = { at: new Date('2026-11-06T03:00:00.000Z'), postDate: '2026-11-06', text: '06-11-2026' };
  const router = { lane: 'ai_video', provider: 'hailuo', postDate: '2026-11-03' };

  beforeEach(() => {
    vi.clearAllMocks();
    repo.get.mockResolvedValue(row);
    repo.transition.mockResolvedValue(true);
    repo.liveOnDate.mockResolvedValue(null);
    days.get.mockResolvedValue(null);
    runner.routerInfo.mockReturnValue({ router });
  });

  it('asks for a date when an approved post holds the day', async () => {
    days.get.mockResolvedValue({ id: 1, instance_id: 'other' });
    repo.get.mockImplementation(async (id) => (id === 'other' ? { id: 'other', status: 'partial', source_type: 'sheet' } : row));
    await expect(retry({ instanceId: 'r1', action: 'stages' })).rejects.toMatchObject({ dayTaken: true });
    expect(repo.setStatus).toHaveBeenCalledWith('r1', 'failed'); // back as it was
    expect(runner.runStages).not.toHaveBeenCalled();
  });

  it('moves everything to a free date, and leaves the old day to the post holding it', async () => {
    days.get.mockImplementation(async (_f, date) => (date === '2026-11-03' ? { id: 1, instance_id: 'other' } : null));
    await retry({ instanceId: 'r1', action: 'stages', moved });
    expect(days.claim).toHaveBeenCalledWith(expect.objectContaining({ postDate: '2026-11-06', instanceId: 'r1', lane: 'ai_video' }));
    expect(days.release).not.toHaveBeenCalled();
    expect(repo.setMeta).toHaveBeenCalledWith('r1', { scheduledFor: moved.at, title: 'Topic · 06-11-2026' });
    expect(svc.updateStep).toHaveBeenCalledWith('r1', 'script', { artifacts: { router: { ...router, postDate: '2026-11-06' } } });
    expect(runner.runStages).toHaveBeenCalledWith({ instanceId: 'r1', resume: true });
  });

  it('frees the old day when this row held it', async () => {
    days.get.mockImplementation(async (_f, date) => (date === '2026-11-03' ? { id: 1, instance_id: 'r1' } : null));
    await retry({ instanceId: 'r1', action: 'stages', moved });
    expect(days.release).toHaveBeenCalledWith(7, '2026-11-03');
  });

  it('never posts twice on the new date', async () => {
    repo.liveOnDate.mockResolvedValue({ id: 'hand-scheduled' });
    await expect(retry({ instanceId: 'r1', action: 'stages', moved })).rejects.toMatchObject({ dayTaken: true });
    expect(repo.setMeta).not.toHaveBeenCalled();

    repo.liveOnDate.mockResolvedValue(null);
    days.get.mockResolvedValue({ id: 2, instance_id: 'waiting' });
    repo.get.mockImplementation(async (id) => (id === 'waiting' ? { id: 'waiting', status: 'image_review' } : row));
    await expect(retry({ instanceId: 'r1', action: 'stages', moved })).rejects.toMatchObject({ dayTaken: true });
    expect(runner.runStages).not.toHaveBeenCalled();
  });
});
