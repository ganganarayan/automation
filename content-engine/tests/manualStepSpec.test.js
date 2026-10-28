import { describe, it, expect } from 'vitest';
import { MANUAL_STAGES, isEditable, inputKind, prevKey, nextKey, canExecute, nextStage } from '../src/utils/manualStepSpec.js';

const steps = (done = []) => MANUAL_STAGES.map((k) => ({ key: k, status: done.includes(k) ? 'done' : 'pending' }));

describe('order + editability', () => {
  it('has the pipeline order and post last', () => {
    expect(MANUAL_STAGES[0]).toBe('script');
    expect(MANUAL_STAGES[MANUAL_STAGES.length - 1]).toBe('publish');
  });
  it('knows the editable stages and their inputs', () => {
    expect(isEditable('script')).toBe(true);
    expect(inputKind('images')).toBe('prompts');
    expect(inputKind('animate')).toBe('prompt');
    expect(inputKind('publish')).toBe('caption');
    expect(isEditable('voiceover')).toBe(false);
  });
  it('prev/next', () => {
    expect(prevKey('script')).toBeNull();
    expect(nextKey('script')).toBe('images');
    expect(nextKey('publish')).toBeNull();
    expect(prevKey('publish')).toBe('stitch');
  });
});

describe('canExecute / nextStage', () => {
  it('first stage is always executable', () => {
    expect(canExecute(steps([]), 'script')).toBe(true);
    expect(canExecute(steps([]), 'images')).toBe(false);
  });
  it('a stage unlocks once its predecessor is done', () => {
    expect(canExecute(steps(['script']), 'images')).toBe(true);
    expect(canExecute(steps(['script']), 'animate')).toBe(false);
  });
  it('a done stage stays executable (redo)', () => {
    expect(canExecute(steps(['script', 'images']), 'images')).toBe(true);
  });
  it('nextStage points at the first not-done, executable stage', () => {
    expect(nextStage(steps([]))).toBe('script');
    expect(nextStage(steps(['script']))).toBe('images');
    expect(nextStage(steps(['script', 'images', 'animate', 'voiceover', 'transcript', 'stitch']))).toBe('publish');
    expect(nextStage(steps(MANUAL_STAGES))).toBeNull();
  });
});
