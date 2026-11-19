import { describe, it, expect } from 'vitest';
import { resumeAction, onGithub } from '../src/utils/retrySpec.js';

const boot = '2026-11-19T15:42:15Z';
const before = '2026-11-19T15:41:00Z';
const after = '2026-11-19T15:43:00Z';
const router = { source_type: 'generated' };
const script = { key: 'script', status: 'done', artifacts: { text: 'a script' } };

describe('a run cut off by a restart', () => {
  it('carries on from the picture step when the old server was drawing', () => {
    const steps = [script, { key: 'images', status: 'running', artifacts: {} }];
    expect(resumeAction({ ...router, status: 'running', updated_at: before }, steps, boot)).toBe('stages');
  });

  it('writes the script again when the restart came before it was written', () => {
    const steps = [{ key: 'script', status: 'running', artifacts: {} }];
    expect(resumeAction({ ...router, status: 'running', updated_at: before }, steps, boot)).toBe('script');
  });

  it('leaves a run this server has touched since it started', () => {
    const steps = [script, { key: 'images', status: 'running', artifacts: {} }];
    expect(resumeAction({ ...router, status: 'running', updated_at: after }, steps, boot)).toBe('');
  });

  it('leaves anything not running, and anything locked', () => {
    const steps = [script, { key: 'images', status: 'running', artifacts: {} }];
    expect(resumeAction({ ...router, status: 'image_review', updated_at: before }, steps, boot)).toBe('');
    expect(resumeAction({ ...router, status: 'running', locked: true, updated_at: before }, steps, boot)).toBe('');
  });

  it('leaves a run GitHub Actions is working on', () => {
    const stitch = [script, { key: 'stitch', status: 'running', artifacts: { runner: 'github' } }];
    const images = [script, { key: 'images', status: 'running', artifacts: { runner: 'github', job: { runner: 'github' } } }];
    expect(resumeAction({ ...router, status: 'running', updated_at: before }, stitch, boot)).toBe('');
    expect(resumeAction({ ...router, status: 'running', updated_at: before }, images, boot)).toBe('');
  });

  it('a step-down image post carries on as that post', () => {
    const steps = [script, { key: 'images', status: 'done', artifacts: { stepDown: { from: 'animate' } } }];
    expect(resumeAction({ ...router, status: 'running', updated_at: before }, steps, boot)).toBe('stepdown');
  });

  it('a ready video (its own page has the way forward) is left alone', () => {
    const steps = [script];
    expect(resumeAction({ source_type: 'drive_folder', status: 'running', updated_at: before }, steps, boot)).toBe('');
  });

  it('onGithub: a finished GitHub step does not hold a run', () => {
    expect(onGithub([{ key: 'stitch', status: 'done', artifacts: { video: { runner: 'github' } } }])).toBe(false);
    expect(onGithub([{ key: 'clean', status: 'done', artifacts: { job: { runner: 'github', state: 'running' } } }])).toBe(true);
  });
});
