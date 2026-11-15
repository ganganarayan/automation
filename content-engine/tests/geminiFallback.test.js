import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/repositories/instanceRepository.js', () => ({}));
vi.mock('../src/repositories/funnelsRepository.js', () => ({}));
vi.mock('../src/services/instanceService.js', () => ({}));
vi.mock('../src/services/instanceReviewService.js', () => ({}));
vi.mock('../src/services/stepLogService.js', () => ({}));
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: vi.fn() }));
vi.mock('../src/services/firstCommentService.js', () => ({}));
vi.mock('../src/services/assembleService.js', () => ({}));
vi.mock('../src/core/heartbeat.js', () => ({ during: (_l, fn) => Promise.resolve(fn()) }));
vi.mock('../src/settings/index.js', () => ({ settings: {} }));
vi.mock('../src/core/logger.js', () => ({ childLogger: () => ({ child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} }) }));

const { _test } = await import('../src/services/stageRunnerService.js');

const quotaErr = () => Object.assign(new Error('Gemini gave this key no quota'), { geminiQuota: { zeroLimit: true } });

function providers({ openai = 'k', gemErr = quotaErr() } = {}) {
  return {
    resolved: { openai: { apiKey: openai }, gemini: { apiKey: 'g' } },
    llm: {
      generateImageGemini: vi.fn(() => Promise.reject(gemErr)),
      generateImage: vi.fn(() => Promise.resolve(Buffer.from('openai'))),
    },
  };
}

describe('genRaw falls back to OpenAI when Gemini has no quota', () => {
  it('Image model Gemini, quota refused, OpenAI key set: draws with OpenAI', async () => {
    const p = providers();
    const buf = await _test.genRaw(p, { image_provider: 'gemini' }, 'prompt', '1024x1536');
    expect(buf.toString()).toBe('openai');
    expect(p.llm.generateImage).toHaveBeenCalledWith({ prompt: 'prompt', size: '1024x1536' });
  });

  it('no OpenAI key: the plain Gemini reason fails the stage', async () => {
    const p = providers({ openai: '' });
    await expect(_test.genRaw(p, { image_provider: 'gemini' }, 'prompt', '1024x1024')).rejects.toThrow('no quota');
    expect(p.llm.generateImage).not.toHaveBeenCalled();
  });

  it('a non-quota Gemini error is not hidden behind OpenAI', async () => {
    const p = providers({ gemErr: new Error('safety block') });
    await expect(_test.genRaw(p, { image_provider: 'gemini' }, 'prompt', '1024x1024')).rejects.toThrow('safety block');
    expect(p.llm.generateImage).not.toHaveBeenCalled();
  });
});
