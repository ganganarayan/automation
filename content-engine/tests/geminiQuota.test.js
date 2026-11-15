import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delaySeconds, geminiQuotaOf, geminiQuotaReason, quotaRetryWait } from '../src/utils/geminiQuota.js';

// The error prod logged on 15-11-2026 18:43 UTC (instance 1fd22ad2), trimmed.
const PROD_429 = '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent: [429 Too Many Requests] You exceeded your current quota, please check your plan and billing details. '
  + '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-flash-image, description: Generate content input tokens per minute limit exceeded on Free Tier.'
  + '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-image, description: Generate content requests per day limit exceeded on Free Tier.'
  + '\nPlease retry in 13h16m28.410734592s. [{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"47788s"}]';

const PER_MINUTE = '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent: [429 Too Many Requests] You exceeded your current quota. '
  + '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_requests, limit: 10, model: gemini-3.1-flash-image, description: Generate content requests per minute limit exceeded.'
  + '\nPlease retry in 12.5s. [{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}]';

describe('geminiQuota', () => {
  it('reads the retry delay from either form', () => {
    expect(delaySeconds('"retryDelay":"47788s"')).toBe(47788);
    expect(delaySeconds('Please retry in 13h16m28.4s.')).toBe(47789);
    expect(delaySeconds('Please retry in 12.5s.')).toBe(13);
    expect(delaySeconds('nothing here')).toBe(null);
  });

  it('reads the prod error as Free Tier, limit 0, never worth a retry', () => {
    const q = geminiQuotaOf(new Error(PROD_429));
    expect(q).toMatchObject({ freeTier: true, zeroLimit: true, model: 'gemini-3.1-flash-image', retrySec: 47788 });
    expect(quotaRetryWait(q)).toBe(null);
    const why = geminiQuotaReason(q);
    expect(why).toContain('limit 0, Free Tier');
    expect(why).toContain('Turn on billing');
    expect(why.length).toBeLessThan(240);
    expect(why).not.toContain(String.fromCharCode(0x2014));
  });

  it('a per-minute limit waits Google\'s delay once', () => {
    const q = geminiQuotaOf(new Error(PER_MINUTE));
    expect(q).toMatchObject({ zeroLimit: false, perDay: false, retrySec: 12 });
    expect(quotaRetryWait(q)).toBe(12);
    expect(quotaRetryWait({ ...q, retrySec: 600 })).toBe(null);
    expect(geminiQuotaReason(q)).toContain('per-minute');
  });

  it('a spent daily quota is not retried', () => {
    const q = geminiQuotaOf(new Error('[429 Too Many Requests] quota, limit: 50, requests per day limit exceeded. "retryDelay":"30000s"'));
    expect(quotaRetryWait(q)).toBe(null);
    expect(geminiQuotaReason(q)).toContain('resets in about 8 h');
  });

  it('other errors are not quota errors', () => {
    expect(geminiQuotaOf(new Error('500 Internal'))).toBe(null);
    expect(geminiQuotaOf(null)).toBe(null);
  });
});

// ---- provider: retry once on per-minute, plain reason on limit 0 ----------

const generateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class { getGenerativeModel() { return { generateContent }; } },
}));
vi.mock('openai', () => ({ default: class {} }));

const { createLlmProvider } = await import('../src/providers/llmProvider.js');
const png = { response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('img').toString('base64') } }] } }] } };

describe('generateImageGemini on a 429', () => {
  beforeEach(() => { generateContent.mockReset(); vi.useRealTimers(); });
  const llm = () => createLlmProvider({ openai: {}, gemini: { apiKey: 'g', imageModel: 'models/gemini-3.1-flash-image' } }, { warn() {} });

  it('limit 0 fails on the first call with the plain reason and geminiQuota set', async () => {
    generateContent.mockRejectedValue(new Error(PROD_429));
    const err = await llm().generateImageGemini({ prompt: 'p' }).catch((e) => e);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(err.message).toContain('Turn on billing');
    expect(err.geminiQuota.zeroLimit).toBe(true);
  });

  it('a per-minute limit waits and retries once', async () => {
    vi.useFakeTimers();
    generateContent.mockRejectedValueOnce(new Error(PER_MINUTE)).mockResolvedValueOnce(png);
    const p = llm().generateImageGemini({ prompt: 'p' });
    await vi.advanceTimersByTimeAsync(12000);
    expect((await p).toString()).toBe('img');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('a second per-minute 429 stops after one retry', async () => {
    vi.useFakeTimers();
    generateContent.mockRejectedValue(new Error(PER_MINUTE));
    const p = llm().generateImageGemini({ prompt: 'p' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(12000);
    const err = await p;
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(err.message).toContain('per-minute');
  });
});
