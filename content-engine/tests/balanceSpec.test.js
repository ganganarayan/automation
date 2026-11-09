import { describe, it, expect } from 'vitest';
import { balanceItem, parseBalance, ESTIMATED } from '../src/utils/balanceSpec.js';

describe('balance strip', () => {
  it('a typed balance counts down with what the app spent since', () => {
    const balance = { usd: 20, at: '2026-11-09T10:00:00Z' };
    expect(balanceItem({ key: 'openai', kind: 'estimated', name: 'OpenAI', balance, spent: 7.555 })).toMatchObject({ text: '≈ $12.45', tone: 'ok', set: true });
    expect(balanceItem({ key: 'openai', kind: 'estimated', name: 'OpenAI', balance, spent: 18 }).tone).toBe('low');
    expect(balanceItem({ key: 'openai', kind: 'estimated', name: 'OpenAI', balance, spent: 25 })).toMatchObject({ text: '≈ $0.00', tone: 'out' });
    expect(balanceItem({ key: 'anthropic', kind: 'estimated', name: 'Claude' })).toMatchObject({ text: 'type balance', tone: 'unknown', set: true });
  });

  it('live balances read in their own unit; unreadable says so', () => {
    expect(balanceItem({ key: 'elevenlabs', kind: 'live', name: 'ElevenLabs', value: 123456, unit: 'chars' })).toMatchObject({ text: '1,23,456 chars', tone: 'ok', set: false });
    expect(balanceItem({ key: 'kling', kind: 'live', name: 'Kling', value: 10, unit: 'units' }).tone).toBe('low');
    expect(balanceItem({ key: 'runway', kind: 'live', name: 'Runway', value: null }).text).toBe('not readable');
    expect(balanceItem({ key: 'gemini', kind: 'none', name: 'Gemini' }).text).toBe('no balance API');
  });

  it('a stored balance must have an amount and a time', () => {
    expect(parseBalance('{"usd":20,"at":"2026-11-09T10:00:00Z"}')).toEqual({ usd: 20, at: '2026-11-09T10:00:00Z' });
    expect(parseBalance('{"usd":"x","at":"2026-11-09"}')).toBeNull();
    expect(parseBalance('nope')).toBeNull();
    expect(parseBalance(null)).toBeNull();
    expect(Object.keys(ESTIMATED)).toEqual(['openai', 'anthropic', 'hailuo']);
  });
});
