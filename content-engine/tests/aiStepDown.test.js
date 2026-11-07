import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { stepDownOf, stepDownPicture, stepDownText, stepDownCaption, stepDownSize, stepDownPrompt, stepDownNote } from '../src/utils/stepDownSpec.js';
import { retryAction } from '../src/utils/retrySpec.js';
import { buildTimeline, stepEvent } from '../src/utils/stepTimeSpec.js';
import { normalizeResearch, researchPrompt } from '../src/utils/routerSpec.js';
import { headlineImage } from '../src/services/imageComposer.js';

const repo = { get: vi.fn(), transition: vi.fn(() => true), setStatus: vi.fn(async () => true), saveSteps: vi.fn(), bumpRound: vi.fn(), markScheduled: vi.fn() };
const fun = { get: vi.fn(), resolve: vi.fn(), getConfig: vi.fn(() => Promise.resolve({ clip_length: '5' })) };
const log = { start: vi.fn(), end: vi.fn(), fail: vi.fn(), mark: vi.fn(), span: vi.fn() };
const approvals = { createRequest: vi.fn(() => ({ id: 'ap1' })) };
const posterMock = { generate: vi.fn(), slug: (s) => s, markSheetRow: vi.fn(), tabFor: vi.fn(), armPostExtras: vi.fn() };
const createPost = vi.fn(() => ({ id: 'pfm1' }));
const providers = { storage: { download: vi.fn(), uploadPng: vi.fn() }, sheets: {}, resolved: { openai: { apiKey: 'k' }, postformeKey: 'p' } };

vi.mock('../src/repositories/instanceRepository.js', () => repo);
vi.mock('../src/repositories/funnelsRepository.js', () => fun);
vi.mock('../src/repositories/approvalRepository.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/services/instanceService.js', () => ({ parseSteps: (r) => r.steps || [] }));
vi.mock('../src/services/approvalService.js', () => approvals);
vi.mock('../src/services/stepLogService.js', () => log);
vi.mock('../src/services/funnelPosterService.js', () => posterMock);
vi.mock('../src/services/firstCommentService.js', () => ({ queue: vi.fn(), ensureWebhook: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/services/imageShortService.js', () => ({ make: vi.fn() }));
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: vi.fn(() => providers) }));
vi.mock('../src/providers/publishProvider.js', () => ({ createPostForMeProvider: () => ({ createPost, deletePost: vi.fn() }) }));
vi.mock('../src/core/httpClient.js', () => ({ request: vi.fn() }));
vi.mock('../src/core/logger.js', () => ({ childLogger: () => ({ child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} }) }));

const lane = await import('../src/services/imageLaneService.js');

const png = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#336699' } }).png().toBuffer();
const brief = { topic: 'Fear', angle: 'myth vs fact', title: 'Fear is a liar', caption: 'Hook. Act now.', headline: 'Fear is lying to you', subhead: 'Three signs to spot it' };

function failedVideo(over = {}) {
  return {
    id: 'inst-123456',
    tenant_id: 'default',
    funnel_id: 7,
    status: 'failed',
    title: 'Fear is a liar · 08-11-2026',
    scheduled_for: '2030-01-01T02:30:00.000Z',
    round: 1,
    source_type: 'generated',
    steps: [
      { key: 'script', status: 'done', artifacts: { text: 'The script.', brief, router: { lane: 'ai_video', provider: 'kling' } }, costs: [] },
      { key: 'images', status: 'done', artifacts: { images: [{ driveId: 's0', url: 'https://d/s0', prompt: 'a calm mind' }, { driveId: 's1', url: 'https://d/s1', prompt: 'p1' }] }, costs: [{ usd: 0.2 }] },
      { key: 'animate', status: 'failed', error: 'kling animation timed out', artifacts: { provider: 'kling', clips: [] }, costs: [] },
      { key: 'voiceover', status: 'pending', artifacts: {}, costs: [] },
      { key: 'transcript', status: 'pending', artifacts: {}, costs: [] },
      { key: 'stitch', status: 'pending', artifacts: {}, costs: [] },
      { key: 'publish', status: 'pending', artifacts: {}, costs: [] },
    ],
    ...over,
  };
}

const saved = () => repo.saveSteps.mock.calls.at(-1)[1];
const step = (steps, key) => steps.find((s) => s.key === key);

beforeEach(() => {
  vi.clearAllMocks();
  repo.transition.mockResolvedValue(true);
  fun.get.mockResolvedValue({ id: 7 });
  fun.resolve.mockResolvedValue({ id: 7, tenantId: 'default', name: 'gita', accounts: ['a1'], accountMap: { a1: { platform: 'instagram' } }, ctaLink: 'https://x.in', driveFolder: 'F', imageSize: 'portrait', sheetId: '' });
  providers.storage.download.mockResolvedValue(png);
  providers.storage.uploadPng.mockResolvedValue({ id: 'up1', downloadUrl: 'https://d/up1', thumbnailUrl: 'https://t/up1' });
  posterMock.generate.mockResolvedValue(png);
});

describe('stepDownSpec', () => {
  it('reuses the first still that has a file', () => {
    expect(stepDownPicture(failedVideo().steps).driveId).toBe('s0');
    expect(stepDownPicture([{ key: 'images', artifacts: { images: [{ driveId: null, url: null }, { driveId: 'b' }] } }]).driveId).toBe('b');
    expect(stepDownPicture([{ key: 'images', artifacts: {} }])).toBeNull();
  });

  it('prefers the researched headline, and an older brief still gets words', () => {
    expect(stepDownText(brief)).toEqual({ headline: 'Fear is lying to you', subhead: 'Three signs to spot it' });
    expect(stepDownText({ title: 'T', angle: 'an angle' })).toEqual({ headline: 'T', subhead: 'an angle' });
    expect(stepDownText({}, 'Fear is a liar · 08-11-2026').headline).toBe('Fear is a liar');
    expect(stepDownText({ title: 'Same', angle: 'same' }).subhead).toBe('');
    expect(stepDownText({ title: 'T', angle: 'word '.repeat(60) }).subhead.length).toBeLessThanOrEqual(121);
  });

  it('builds the caption the way the video post would', () => {
    expect(stepDownCaption({ brief, ctaLink: 'https://x.in' })).toBe('Hook. Act now.\n\nhttps://x.in');
    expect(stepDownCaption({ brief: {}, audiencePrefix: 'For you', ctaLink: 'https://x.in' })).toBe('For you\nhttps://x.in');
    expect(stepDownCaption({ brief: {}, title: 'T' })).toBe('T');
  });

  it('keeps a tall still inside what a feed image post accepts', () => {
    expect(stepDownSize({ width: 1024, height: 1820 })).toEqual({ w: 1080, h: 1350 });
    expect(stepDownSize({ width: 1024, height: 1024 })).toEqual({ w: 1080, h: 1080 });
    expect(stepDownSize({ width: 1536, height: 1024 })).toEqual({ w: 1280, h: 720 });
  });

  it('says plainly where the picture came from and why', () => {
    expect(stepDownNote('animation failed: timed out')).toBe("Stepped down to an image post, using the video's own still. Why: animation failed: timed out");
    expect(stepDownNote('voiceover: x', 'sheet')).toContain('content sheet');
    expect(stepDownPrompt('a calm mind', 'brighter')).toContain('Revision requested: brighter');
  });
});

describe('headlineImage', () => {
  it('draws on the still at the finished size', async () => {
    const out = await headlineImage(png, { text: 'Fear is lying to you', sub: 'Three signs' });
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1080, 1350]);
    const plain = await sharp(png).resize(1080, 1350).raw().toBuffer();
    const drawn = await sharp(out).removeAlpha().raw().toBuffer();
    expect(Buffer.compare(plain.subarray(0, 300000), drawn.subarray(0, 300000))).not.toBe(0);
  });
});

describe('stepDown', () => {
  it('turns the failed video into an image post from its own still, with no new image', async () => {
    repo.get.mockResolvedValue(failedVideo());
    expect(await lane.stepDown({ instanceId: 'inst-123456', reason: 'animation failed: kling animation timed out' })).toBe(true);

    expect(providers.storage.download).toHaveBeenCalledWith('s0');
    expect(posterMock.generate).not.toHaveBeenCalled();
    expect(repo.transition).toHaveBeenCalledWith('inst-123456', 'failed', 'running');
    expect(providers.storage.uploadPng.mock.calls[0][0]).toBe('F');
    expect(approvals.createRequest.mock.calls[0][0]).toMatchObject({
      kind: 'image_post',
      payload: { instanceId: 'inst-123456', mediaUrl: 'https://d/up1', captionFull: 'Hook. Act now.\n\nhttps://x.in' },
    });

    const steps = saved();
    expect(stepDownOf(steps)).toMatchObject({ from: 'animate', stillDriveId: 's0', headline: 'Fear is lying to you', subhead: 'Three signs to spot it' });
    expect(step(steps, 'images').artifacts.images).toHaveLength(2);
    expect(step(steps, 'images').costs).toHaveLength(1); // no second image charge
    expect(step(steps, 'animate').status).toBe('failed'); // the Log keeps what really happened
    expect(step(steps, 'script').artifacts.text).toBe('The script.');
    for (const k of ['voiceover', 'transcript', 'stitch']) expect(step(steps, k).status).toBe('skipped');
    expect(log.mark.mock.calls[0][2]).toContain('kling animation timed out');
    expect(repo.setStatus).toHaveBeenLastCalledWith('inst-123456', 'image_review', expect.stringContaining('Stepped down'));
  });

  it('records clips already paid for', async () => {
    const row = failedVideo();
    step(row.steps, 'animate').artifacts.clips = [{ driveId: 'c0' }, { driveId: 'c1' }];
    repo.get.mockResolvedValue(row);
    await lane.stepDown({ instanceId: row.id, reason: 'x' });
    expect(step(saved(), 'animate').costs).toHaveLength(1);
  });

  it('does nothing when the instance has moved on', async () => {
    repo.get.mockResolvedValue(failedVideo());
    repo.transition.mockResolvedValue(false);
    expect(await lane.stepDown({ instanceId: 'inst-123456', reason: 'x' })).toBe(false);
    expect(providers.storage.uploadPng).not.toHaveBeenCalled();
  });

  it('throws with no still, leaving the sheet path to the caller', async () => {
    const row = failedVideo();
    step(row.steps, 'images').artifacts.images = [];
    repo.get.mockResolvedValue(row);
    await expect(lane.stepDown({ instanceId: row.id, reason: 'x' })).rejects.toThrow(/no generated still/);
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('goes back to failed and throws when the still cannot be read', async () => {
    providers.storage.download.mockRejectedValue(new Error('not found'));
    const row = failedVideo();
    step(row.steps, 'images').artifacts.images = [{ driveId: 's0', prompt: 'p' }];
    repo.get.mockResolvedValue(row);
    await expect(lane.stepDown({ instanceId: row.id, reason: 'x' })).rejects.toThrow('not found');
    expect(log.fail).toHaveBeenCalledWith(row.id, 'draw_image');
    expect(repo.setStatus).toHaveBeenLastCalledWith(row.id, 'failed', expect.stringContaining('not found'));
  });
});

describe('a stepped-down post after that', () => {
  const stepped = (over = {}) => {
    const row = failedVideo({ status: 'image_review', ...over });
    step(row.steps, 'images').artifacts = {
      ...step(row.steps, 'images').artifacts,
      image: { url: 'https://d/up1', thumbnailUrl: 'https://t/up1', driveId: 'up1' }, row: {}, sheet: {},
      stepDown: { from: 'animate', reason: 'animation failed: boom', note: 'n', stillDriveId: 's0' },
    };
    step(row.steps, 'script').artifacts = { ...step(row.steps, 'script').artifacts, captionFull: 'cap', captionShort: 'cap' };
    return row;
  };

  it('approve posts the drawn image and touches no sheet row', async () => {
    const row = stepped();
    repo.get.mockResolvedValue(row);
    await lane.approve({ id: 'ap1', payload: { instanceId: row.id, mediaUrl: 'https://d/up1' } });
    expect(createPost.mock.calls[0][0]).toMatchObject({ accountIds: ['a1'], mediaUrl: 'https://d/up1', caption: 'cap' });
    expect(posterMock.markSheetRow).not.toHaveBeenCalled();
    expect(posterMock.tabFor).not.toHaveBeenCalled();
    expect(repo.markScheduled).toHaveBeenCalled();
  });

  it('rework makes a new picture from the still prompt and the note, and keeps the reason', async () => {
    const row = stepped({ status: 'running' });
    repo.get.mockResolvedValue(row);
    await lane.rework({ payload: { instanceId: row.id } }, 'make it brighter');
    expect(posterMock.generate.mock.calls[0][1]).toContain('make it brighter');
    expect(providers.storage.download).not.toHaveBeenCalled();
    expect(stepDownOf(saved()).reason).toBe('animation failed: boom');
    expect(step(saved(), 'images').costs).toHaveLength(2); // this one is a new picture
    expect(log.mark).not.toHaveBeenCalled();
  });

  it('retry reopens approval with the image it has', async () => {
    const row = stepped({ status: 'running' });
    repo.get.mockResolvedValue(row);
    await lane.retryStepDown({ instanceId: row.id });
    expect(providers.storage.uploadPng).not.toHaveBeenCalled();
    expect(approvals.createRequest.mock.calls[0][0].payload.mediaUrl).toBe('https://d/up1');
    expect(repo.setStatus).toHaveBeenLastCalledWith(row.id, 'image_review');
  });

  it('Retry on a failed post is the image, not the video', () => {
    const steps = stepped().steps;
    expect(retryAction({ status: 'failed', source_type: 'generated' }, steps)).toBe('stepdown');
    expect(retryAction({ status: 'failed', source_type: 'generated' }, failedVideo().steps)).toBe('stages');
    expect(retryAction({ status: 'image_review', source_type: 'generated' }, steps)).toBe('');
    const pub = steps.map((s) => (s.key === 'publish' ? { ...s, artifacts: { channels: [{ state: 'failed' }] } } : s));
    expect(retryAction({ status: 'partial', source_type: 'generated' }, pub)).toBe('channels');
  });
});

describe('the Log', () => {
  it('shows the step-down as a plain line among the steps', () => {
    const at = '2026-11-07T10:00:00.000Z';
    const log2 = [
      stepEvent('animate', 'fail', { at }),
      stepEvent('step_down', 'mark', { at, note: 'Stepped down to an image post. Why: animation failed' }),
      stepEvent('draw_image', 'start', { at }),
      stepEvent('draw_image', 'end', { at }),
    ];
    const entries = buildTimeline({ status: 'image_review', source_type: 'generated', updated_at: at }, failedVideo().steps, log2);
    const line = entries.find((e) => e.key === 'step_down');
    expect(line).toMatchObject({ kind: 'mark', label: 'Stepped down to an image post. Why: animation failed' });
    expect(entries.find((e) => e.key === 'draw_image').label).toBe('Drawing the headline on the image');
  });
});

describe('research', () => {
  it('asks for and keeps a headline and sub-head', () => {
    expect(researchPrompt({ funnelName: 'G' }).system).toContain('"headline"');
    expect(normalizeResearch({ topic: 'T', headline: ' Big  line ', subhead: 'Small' })).toMatchObject({ headline: 'Big line', subhead: 'Small' });
    expect(normalizeResearch({ topic: 'T' })).toMatchObject({ headline: '', subhead: '' });
  });
});
