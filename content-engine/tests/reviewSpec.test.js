import { describe, it, expect } from 'vitest';
import {
  CHECKPOINTS,
  isCheckpoint,
  approveTransition,
  rejectTransition,
  normalizeNote,
  isValidCorrection,
  nextRound,
  driveEmbedUrl,
  driveThumbUrl,
} from '../src/utils/reviewSpec.js';

describe('CHECKPOINTS', () => {
  it('maps each checkpoint to the step it shows', () => {
    expect(CHECKPOINTS.script.stepKey).toBe('script');
    expect(CHECKPOINTS.final.stepKey).toBe('stitch');
  });
});

describe('isCheckpoint', () => {
  it('accepts the two known checkpoints only', () => {
    expect(isCheckpoint('script')).toBe(true);
    expect(isCheckpoint('final')).toBe(true);
    expect(isCheckpoint('images')).toBe(false);
    expect(isCheckpoint('')).toBe(false);
    expect(isCheckpoint(undefined)).toBe(false);
  });
});

describe('approveTransition', () => {
  it('script approve -> running, not locked', () => {
    expect(approveTransition('script')).toEqual({ status: 'running', lock: false });
  });
  it('final approve -> posted + locked', () => {
    expect(approveTransition('final')).toEqual({ status: 'posted', lock: true });
  });
  it('throws on an unknown checkpoint', () => {
    expect(() => approveTransition('nope')).toThrow();
  });
});

describe('rejectTransition', () => {
  it('script reject -> back to script_review', () => {
    expect(rejectTransition('script')).toEqual({ status: 'script_review' });
  });
  it('final reject -> back to running', () => {
    expect(rejectTransition('final')).toEqual({ status: 'running' });
  });
  it('throws on an unknown checkpoint', () => {
    expect(() => rejectTransition('nope')).toThrow();
  });
});

describe('normalizeNote / isValidCorrection', () => {
  it('trims whitespace', () => {
    expect(normalizeNote('  fix the hook ')).toBe('fix the hook');
    expect(normalizeNote(null)).toBe('');
    expect(normalizeNote(undefined)).toBe('');
  });
  it('a correction must be non-empty', () => {
    expect(isValidCorrection('change scene 2')).toBe(true);
    expect(isValidCorrection('   ')).toBe(false);
    expect(isValidCorrection('')).toBe(false);
  });
});

describe('nextRound', () => {
  it('increments a valid round', () => {
    expect(nextRound(1)).toBe(2);
    expect(nextRound(3)).toBe(4);
  });
  it('defaults missing/invalid to round 2 (from 1)', () => {
    expect(nextRound(0)).toBe(2);
    expect(nextRound(null)).toBe(2);
    expect(nextRound('x')).toBe(2);
  });
});

describe('drive URL builders', () => {
  it('embed URL is the /preview player', () => {
    expect(driveEmbedUrl('ABC123')).toBe('https://drive.google.com/file/d/ABC123/preview');
  });
  it('thumbnail URL carries the size', () => {
    expect(driveThumbUrl('ABC123')).toBe('https://drive.google.com/thumbnail?id=ABC123&sz=w600');
    expect(driveThumbUrl('ABC123', 'w640')).toBe('https://drive.google.com/thumbnail?id=ABC123&sz=w640');
  });
  it('encodes an id with unsafe characters', () => {
    expect(driveEmbedUrl('a/b c')).toBe('https://drive.google.com/file/d/a%2Fb%20c/preview');
  });
});
