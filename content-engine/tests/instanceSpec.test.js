import { describe, it, expect } from 'vitest';
import {
  INSTANCE_STEPS,
  buildInitialSteps,
  sumInstanceCost,
  costBreakdown,
  addCostToSteps,
  patchStep,
  formatDuration,
} from '../src/utils/instanceSpec.js';

describe('buildInitialSteps', () => {
  it('seeds every pipeline step pending with empty costs', () => {
    const steps = buildInitialSteps();
    expect(steps).toHaveLength(INSTANCE_STEPS.length);
    expect(steps.every((s) => s.status === 'pending' && Array.isArray(s.costs) && s.costs.length === 0)).toBe(true);
    expect(steps.map((s) => s.key)).toContain('stitch');
  });
});

describe('addCostToSteps + sumInstanceCost + costBreakdown', () => {
  it('appends costs immutably and rolls them up per step and total', () => {
    let steps = buildInitialSteps();
    const before = steps;
    steps = addCostToSteps(steps, 'images', { costUsd: 0.84 });
    steps = addCostToSteps(steps, 'animate', { costUsd: 2.1 });
    steps = addCostToSteps(steps, 'images', { costUsd: 0.07 });
    expect(before.find((s) => s.key === 'images').costs).toHaveLength(0); // original untouched
    expect(sumInstanceCost(steps)).toBe(3.01);
    const bd = costBreakdown(steps);
    expect(bd.images).toBe(0.91);
    expect(bd.animate).toBe(2.1);
    expect(bd.voiceover).toBe(0);
  });
});

describe('patchStep', () => {
  it('merges status and artifacts into the named step only', () => {
    let steps = buildInitialSteps();
    steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { driveId: 'abc' } } });
    const stitch = steps.find((s) => s.key === 'stitch');
    expect(stitch.status).toBe('done');
    expect(stitch.artifacts.video.driveId).toBe('abc');
    expect(steps.find((s) => s.key === 'images').status).toBe('pending');
  });
  it('shallow-merges artifacts rather than replacing them', () => {
    let steps = patchStep(buildInitialSteps(), 'images', { artifacts: { a: 1 } });
    steps = patchStep(steps, 'images', { artifacts: { b: 2 } });
    expect(steps.find((s) => s.key === 'images').artifacts).toEqual({ a: 1, b: 2 });
  });
});

describe('formatDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatDuration(47)).toBe('0:47');
    expect(formatDuration(90)).toBe('1:30');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
  });
});
