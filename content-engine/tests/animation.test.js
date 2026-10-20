import { describe, it, expect } from 'vitest';
import {
  signKlingToken,
  composePrompt,
  klingDuration,
  runwayDuration,
  hailuoDuration,
  normalizeKling,
  normalizeRunway,
  normalizeHailuoQuery,
  selectProvider,
  resolveAnimationConfig,
} from '../src/utils/animationSpec.js';

const decode = (part) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

describe('signKlingToken', () => {
  it('builds a 3-part HS256 JWT with issuer and validity window', () => {
    const token = signKlingToken('ak_123', 'sk_456', 1_000_000);
    const [header, payload] = token.split('.');
    expect(token.split('.')).toHaveLength(3);
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const p = decode(payload);
    expect(p.iss).toBe('ak_123');
    expect(p.exp).toBe(1_000_000 + 1800);
    expect(p.nbf).toBe(1_000_000 - 5);
  });

  it('is deterministic for the same inputs', () => {
    expect(signKlingToken('a', 'b', 42)).toBe(signKlingToken('a', 'b', 42));
  });

  it('throws when keys are missing', () => {
    expect(() => signKlingToken('', 'b')).toThrow();
  });
});

describe('composePrompt', () => {
  it('appends the motion style', () => {
    expect(composePrompt('a sage speaks', 'cinematic')).toContain('a sage speaks');
    expect(composePrompt('a sage speaks', 'cinematic')).toContain('push-in');
  });
  it('works with an empty prompt', () => {
    expect(composePrompt('', 'subtle')).toContain('drift');
  });
  it('ignores an unknown motion', () => {
    expect(composePrompt('x', 'nope')).toBe('x');
  });
});

describe('duration mapping', () => {
  it('maps clip length per provider', () => {
    expect(klingDuration('10')).toBe('10');
    expect(klingDuration('5')).toBe('5');
    expect(runwayDuration('10')).toBe(10);
    expect(runwayDuration('5')).toBe(5);
    expect(hailuoDuration('10')).toBe(10);
    expect(hailuoDuration('5')).toBe(6);
  });
});

describe('normalizeKling', () => {
  it('reports done with the video url on success', () => {
    const r = normalizeKling({ data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://x/v.mp4' }] } } });
    expect(r).toMatchObject({ done: true, url: 'https://x/v.mp4', status: 'succeed' });
  });
  it('flags failure', () => {
    const r = normalizeKling({ data: { task_status: 'failed', task_status_msg: 'bad image' } });
    expect(r.failed).toBe(true);
    expect(r.done).toBe(false);
    expect(r.error).toBe('bad image');
  });
  it('is not done while processing', () => {
    expect(normalizeKling({ data: { task_status: 'processing' } }).done).toBe(false);
  });
});

describe('normalizeRunway', () => {
  it('reports done on SUCCEEDED with output', () => {
    expect(normalizeRunway({ status: 'SUCCEEDED', output: ['https://x/r.mp4'] })).toMatchObject({ done: true, url: 'https://x/r.mp4' });
  });
  it('flags FAILED', () => {
    expect(normalizeRunway({ status: 'FAILED' }).failed).toBe(true);
  });
  it('is not done while RUNNING', () => {
    expect(normalizeRunway({ status: 'RUNNING' }).done).toBe(false);
  });
});

describe('normalizeHailuoQuery', () => {
  it('reports success with a file id', () => {
    expect(normalizeHailuoQuery({ status: 'Success', file_id: 'f1' })).toMatchObject({ done: true, fileId: 'f1' });
  });
  it('flags Fail', () => {
    expect(normalizeHailuoQuery({ status: 'Fail' }).failed).toBe(true);
  });
});

describe('selectProvider', () => {
  it('defaults to kling and rejects unknowns', () => {
    expect(selectProvider({})).toBe('kling');
    expect(selectProvider({ provider: 'nope' })).toBe('kling');
    expect(selectProvider({ provider: 'runway' })).toBe('runway');
    expect(selectProvider({ provider: 'hailuo' })).toBe('hailuo');
  });
});

describe('resolveAnimationConfig', () => {
  it('maps flat funnel config into the provider shape', () => {
    const cfg = resolveAnimationConfig({
      animation_provider: 'hailuo',
      clip_length: '10',
      motion: 'energetic',
      kling_access_key: 'ak',
      kling_secret_key: 'sk',
      runway_api_key: 'rk',
      hailuo_api_key: 'hk',
      hailuo_group_id: 'g1',
    });
    expect(cfg).toMatchObject({
      provider: 'hailuo',
      clipLength: '10',
      motion: 'energetic',
      kling: { accessKey: 'ak', secretKey: 'sk' },
      runway: { apiKey: 'rk' },
      hailuo: { apiKey: 'hk', groupId: 'g1' },
    });
  });
  it('falls back to defaults on an empty config', () => {
    expect(resolveAnimationConfig()).toMatchObject({ provider: 'kling', clipLength: '5', motion: 'subtle' });
  });
});
