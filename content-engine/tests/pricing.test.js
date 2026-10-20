import { describe, it, expect } from 'vitest';
import { costText, costImages, costAnimation, costTts, costTranscript, sumCosts, DEFAULT_PRICES } from '../src/utils/pricing.js';

describe('costText', () => {
  it('prices real token usage by input/output rate', () => {
    const c = costText({ inputTokens: 1_000_000, outputTokens: 500_000, model: 'gpt-5-mini' });
    // 1M in * 0.25 + 0.5M out * 2.00 = 0.25 + 1.00 = 1.25
    expect(c.costUsd).toBe(1.25);
    expect(c.unit).toBe('tokens');
    expect(c.quantity).toBe(1_500_000);
  });
  it('falls back to the default rate for unknown models', () => {
    expect(costText({ inputTokens: 1_000_000, outputTokens: 0, model: 'mystery' }).costUsd).toBe(0.25);
  });
});

describe('costImages', () => {
  it('prices the real image count at the size rate', () => {
    const c = costImages({ count: 12, size: '1024x1536' });
    expect(c.costUsd).toBe(0.84); // 12 * 0.07
    expect(c.unit).toBe('images');
  });
  it('uses the default image price for an unknown size', () => {
    expect(costImages({ count: 1, size: '99x99' }).costUsd).toBe(0.07);
  });
});

describe('costAnimation', () => {
  it('prices generated seconds per provider', () => {
    expect(costAnimation({ provider: 'kling', seconds: 60 }).costUsd).toBe(2.1); // 60 * 0.035
    expect(costAnimation({ provider: 'runway', seconds: 60 }).costUsd).toBe(3); // 60 * 0.05
  });
});

describe('costTts', () => {
  it('prices characters per 1000 by provider', () => {
    expect(costTts({ provider: 'elevenlabs', chars: 1400 }).costUsd).toBe(0.252); // 1.4 * 0.18
  });
});

describe('costTranscript', () => {
  it('prices audio minutes', () => {
    expect(costTranscript({ provider: 'whisper', minutes: 1.5 }).costUsd).toBe(0.009);
    expect(costTranscript({ provider: 'turboscribe', minutes: 10 }).costUsd).toBe(0);
  });
});

describe('sumCosts', () => {
  it('adds entry costs and tolerates junk', () => {
    expect(sumCosts([{ costUsd: 0.84 }, { costUsd: 2.1 }, {}])).toBe(2.94);
    expect(sumCosts(null)).toBe(0);
  });
});

describe('DEFAULT_PRICES', () => {
  it('is overridable for a tenant', () => {
    const prices = { ...DEFAULT_PRICES, image: { ...DEFAULT_PRICES.image, '1024x1536': 0.1 } };
    expect(costImages({ count: 10, size: '1024x1536' }, prices).costUsd).toBe(1);
  });
});
