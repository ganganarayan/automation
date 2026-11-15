import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = { get: vi.fn(), transition: vi.fn(() => true), setStatus: vi.fn(), setMeta: vi.fn(), liveOnDate: vi.fn(), supersede: vi.fn() };
const days = { get: vi.fn(), update: vi.fn(), claim: vi.fn(), release: vi.fn() };
const image = { stepDown: vi.fn(), prepare: vi.fn(), retry: vi.fn(), retryStepDown: vi.fn(() => Promise.resolve()) };
const credit = { markExhausted: vi.fn(() => Promise.resolve()) };
const log = { mark: vi.fn() };
const runner = { routerInfo: vi.fn(), runStages: vi.fn(() => Promise.resolve()) };

vi.mock('../src/repositories/instanceRepository.js', () => repo);
vi.mock('../src/repositories/routerDaysRepository.js', () => days);
vi.mock('../src/repositories/funnelsRepository.js', () => ({ get: vi.fn(() => ({ id: 7 })) }));
vi.mock('../src/services/instanceService.js', () => ({ updateStep: vi.fn(), parseSteps: (r) => r.steps || [] }));
vi.mock('../src/services/creditService.js', () => credit);
vi.mock('../src/services/stageRunnerService.js', () => runner);
vi.mock('../src/services/instanceReviewService.js', () => ({}));
vi.mock('../src/services/imageLaneService.js', () => image);
vi.mock('../src/services/stepLogService.js', () => log);
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: vi.fn() }));
vi.mock('../src/core/heartbeat.js', () => ({ during: (_label, fn) => Promise.resolve(fn()) }));
vi.mock('../src/core/logger.js', () => ({ childLogger: () => ({ child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} }) }));

const { onStageFailed, retry, claimFromStepDown } = await import('../src/services/aiLaneService.js');
const instanceService = await import('../src/services/instanceService.js');

const row = { id: 'i1', tenant_id: 'default', funnel_id: 7, status: 'failed', scheduled_for: '2030-01-01T02:30:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  repo.get.mockResolvedValue(row);
  runner.routerInfo.mockReturnValue({ router: { lane: 'ai_video', provider: 'kling', postDate: '2030-01-01' } });
  days.get.mockResolvedValue({ id: 'd1', instance_id: 'i1' });
  image.stepDown.mockResolvedValue(true);
  image.prepare.mockResolvedValue({ id: 'i2' });
});

describe('onStageFailed', () => {
  it('animation failed: the same instance steps down, the sheet is left alone', async () => {
    await onStageFailed('i1', 'animate', new Error('kling animation timed out'));
    expect(image.stepDown).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'i1', reason: 'animation failed: kling animation timed out' }));
    expect(image.prepare).not.toHaveBeenCalled();
    expect(days.update).toHaveBeenCalledWith('d1', expect.objectContaining({ lane: 'image', instanceId: 'i1', reason: expect.stringContaining('own still') }));
  });

  it('a still that cannot be used falls to the next sheet row, and the Log says so', async () => {
    image.stepDown.mockRejectedValue(new Error('no generated still to reuse'));
    await onStageFailed('i1', 'animate', new Error('boom'));
    expect(image.prepare).toHaveBeenCalled();
    expect(days.update).toHaveBeenCalledWith('d1', expect.objectContaining({ lane: 'image', instanceId: 'i2', reason: expect.stringContaining('no generated still') }));
    expect(log.mark.mock.calls[0]).toEqual(['i1', 'step_down', expect.stringContaining('content sheet')]);
  });

  it('nothing posts only when the sheet fails too, and the day says why', async () => {
    image.stepDown.mockRejectedValue(new Error('still gone'));
    image.prepare.mockRejectedValue(new Error('no content sheet on this funnel'));
    await onStageFailed('i1', 'animate', new Error('boom'));
    expect(days.update).toHaveBeenCalledWith('d1', expect.objectContaining({ lane: 'none', reason: expect.stringMatching(/still gone.*no content sheet/) }));
  });

  it('an instance that has moved on is left alone', async () => {
    image.stepDown.mockResolvedValue(false);
    await onStageFailed('i1', 'animate', new Error('boom'));
    expect(image.prepare).not.toHaveBeenCalled();
    expect(days.update).not.toHaveBeenCalled();
  });

  it('other stages keep the sheet path', async () => {
    await onStageFailed('i1', 'voiceover', new Error('tts down'));
    expect(image.stepDown).not.toHaveBeenCalled();
    expect(image.prepare).toHaveBeenCalled();
  });

  it('still marks a provider out of credit for the day', async () => {
    await onStageFailed('i1', 'animate', new Error('insufficient credits'));
    expect(credit.markExhausted).toHaveBeenCalledWith('default', 'kling');
    expect(image.stepDown).toHaveBeenCalled();
  });

  it('a video a re-run already replaced stays replaced', async () => {
    days.get.mockResolvedValue({ id: 'd1', instance_id: 'other' });
    await onStageFailed('i1', 'animate', new Error('boom'));
    expect(image.stepDown).not.toHaveBeenCalled();
  });

  it('leaves a non-router instance alone', async () => {
    runner.routerInfo.mockReturnValue({ router: null });
    await onStageFailed('i1', 'animate', new Error('boom'));
    expect(image.stepDown).not.toHaveBeenCalled();
  });
});

describe('retry stepdown', () => {
  it('runs the image retry and the day stays an image day', async () => {
    await retry({ instanceId: 'i1', action: 'stepdown' });
    expect(image.retryStepDown).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'i1' }));
    expect(days.update).toHaveBeenCalledWith('d1', expect.objectContaining({ lane: 'image' }));
  });
});

// Prod 16-11-2026: two Retry clicks on a video whose images kept failing took two
// more sheet rows. A video steps down once; the first image post keeps the day.
describe('a video steps down to the sheet only once', () => {
  const stepped = { router: { lane: 'ai_video', provider: 'kling', postDate: '2030-01-01', stepDownTo: 'i2' } };
  const imagePost = { id: 'i2', status: 'image_review', source_type: 'sheet', title: 'He can name the whole squad' };

  it('the first step-down remembers its image post on the video', async () => {
    await onStageFailed('i1', 'images', new Error('429'));
    expect(image.prepare).toHaveBeenCalledTimes(1);
    expect(instanceService.updateStep).toHaveBeenCalledWith('i1', 'script', { artifacts: { router: expect.objectContaining({ stepDownTo: 'i2' }) } });
  });

  it('a retry that fails again takes no new row and gives the day back to the image post', async () => {
    runner.routerInfo.mockReturnValue(stepped);
    repo.get.mockImplementation(async (id) => (id === 'i2' ? imagePost : row));
    await onStageFailed('i1', 'images', new Error('429'));
    expect(image.prepare).not.toHaveBeenCalled();
    expect(image.stepDown).not.toHaveBeenCalled();
    expect(days.update).toHaveBeenCalledWith('d1', expect.objectContaining({ lane: 'image', instanceId: 'i2' }));
    expect(log.mark).toHaveBeenCalledWith('i1', 'step_down', expect.stringContaining('no new sheet row'));
  });

  it('a second failure while the first step-down is still being made takes no row either', async () => {
    let finish;
    image.prepare.mockImplementation(() => new Promise((r) => { finish = () => r({ id: 'i2' }); }));
    const first = onStageFailed('i1', 'images', new Error('429'));
    await vi.waitFor(() => expect(image.prepare).toHaveBeenCalledTimes(1));
    await onStageFailed('i1', 'images', new Error('429 again'));
    finish();
    await first;
    expect(image.prepare).toHaveBeenCalledTimes(1);
  });

  it('Retry leaves the day with the image post while the video renders again', async () => {
    runner.routerInfo.mockReturnValue(stepped);
    days.get.mockResolvedValue({ id: 'd1', instance_id: 'i2' });
    repo.get.mockImplementation(async (id) => (id === 'i2' ? imagePost : row));
    await retry({ instanceId: 'i1', action: 'stages' });
    expect(repo.supersede).not.toHaveBeenCalled();
    expect(days.update).not.toHaveBeenCalled();
    expect(runner.runStages).toHaveBeenCalledWith({ instanceId: 'i1', resume: true });
  });

  it('posting the retried video withdraws its waiting image post and takes the day', async () => {
    runner.routerInfo.mockReturnValue(stepped);
    days.get.mockResolvedValue({ id: 'd1', instance_id: 'i2' });
    repo.get.mockImplementation(async (id) => (id === 'i2' ? imagePost : row));
    await claimFromStepDown('i1');
    expect(repo.supersede).toHaveBeenCalledWith('i2', expect.any(String));
    expect(days.update).toHaveBeenCalledWith('d1', expect.objectContaining({ lane: 'ai_video', instanceId: 'i1' }));
  });

  it('an image post already approved stops the video from posting twice', async () => {
    runner.routerInfo.mockReturnValue(stepped);
    repo.get.mockImplementation(async (id) => (id === 'i2' ? { ...imagePost, status: 'scheduled' } : row));
    await expect(claimFromStepDown('i1')).rejects.toThrow('post twice');
    expect(repo.supersede).not.toHaveBeenCalled();
  });

  it('a video that never stepped down posts as before', async () => {
    await claimFromStepDown('i1');
    expect(repo.supersede).not.toHaveBeenCalled();
    expect(days.update).not.toHaveBeenCalled();
  });
});
