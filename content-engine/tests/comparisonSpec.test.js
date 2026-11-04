import { describe, it, expect } from 'vitest';
import { stripCc, parseComparisons, findCompetitor, comparisonFor, thumbRows, comparisonHeadline, comparisonSvg, isNoSpeech } from '../src/utils/comparisonSpec.js';
import { DEFAULT_COMPARISONS } from '../src/utils/comparisonFacts.js';
import { copySystemPrompt, copyUserPrompt } from '../src/utils/aiCopySpec.js';
import { thumbImagePrompt } from '../src/utils/thumbSpec.js';

const list = parseComparisons(DEFAULT_COMPARISONS);

describe('stripCc', () => {
  it('takes the marker out, wherever it sits', () => {
    expect(stripCc('Assess360 vs LeadQuizzes CC.mp4')).toBe('Assess360 vs LeadQuizzes.mp4');
    expect(stripCc('CC my video.mp4')).toBe('my video.mp4');
    expect(stripCc('my_video_cc.mp4')).toBe('my_video.mp4');
    expect(stripCc('my video (CC).mp4')).toBe('my video.mp4');
  });
  it('leaves other words alone', () => {
    expect(stripCc('Accurate BCC success.mp4')).toBe('Accurate BCC success.mp4');
  });
});

describe('the facts list', () => {
  it('holds all 13 competitors, each with a dated difference or shared feature', () => {
    expect(list.map((c) => c.competitor)).toContain('LeadQuizzes');
    expect(list).toHaveLength(13);
    for (const c of list) {
      expect(c.checked).toMatch(/^\d\d-\d\d-\d{4}$/);
      expect(c.rows.length).toBeGreaterThan(0);
      expect(c.rows.every((r) => r.us)).toBe(true);
    }
  });
  it('reads a typed block', () => {
    expect(parseComparisons('Acme (checked 01-01-2026)\nGate | yes | no\n\nBare\nnot a row')).toEqual([
      { competitor: 'Acme', checked: '01-01-2026', rows: [{ label: 'Gate', us: true, them: false }] },
    ]);
  });
});

describe('which comparison a video is', () => {
  const settings = {};
  const named = (name, extra = {}) => comparisonFor({ settings, name, ...extra })?.competitor;

  it('finds it from the file name, however it is written', () => {
    expect(named('Assess360 vs LeadQuizzes CC.mp4')).toBe('LeadQuizzes');
    expect(named('lead_quizzes.mp4')).toBe('LeadQuizzes');
    expect(named('google-forms-alternative.mp4')).toBe('Google Forms');
    expect(named('involve me review.mp4')).toBe('involve.me');
  });
  it('does not take an everyday word for a competitor', () => {
    expect(named('How to interact with your team.mp4')).toBeUndefined();
    expect(named('The riddle of the Gita.mp4')).toBeUndefined();
    expect(named('Assess360 vs Interact.mp4')).toBe('Interact');
  });
  it('a passing mention in speech is not enough', () => {
    expect(named('talk.mp4', { transcript: 'we used Typeform once for a survey' })).toBeUndefined();
    expect(named('talk.mp4', { transcript: 'Assess360 does what Typeform cannot' })).toBe('Typeform');
    expect(findCompetitor('Assess360 beats Typeform and Jotform', list, { brand: 'Assess360', speech: true })).toBeNull();
  });
  it('the choice on the page wins, both ways', () => {
    expect(named('Assess360 vs LeadQuizzes.mp4', { choice: 'off' })).toBeUndefined();
    expect(named('anything.mp4', { choice: 'Marquiz' })).toBe('Marquiz');
    expect(named('anything.mp4')).toBeUndefined();
  });
  it('uses the edited list and brand from Settings', () => {
    const c = comparisonFor({ settings: { list: 'Acme\nGate | yes | no', brand: 'Mine' }, name: 'Acme.mp4' });
    expect(c.brand).toBe('Mine');
    expect(comparisonFor({ settings: { list: 'Acme\nGate | yes | no' }, name: 'LeadQuizzes.mp4' })).toBeNull();
  });
});

describe('copy', () => {
  const comparison = comparisonFor({ name: 'LeadQuizzes CC.mp4' });
  it('keeps CC out of the file name the AI reads', () => {
    expect(copyUserPrompt({ fileName: 'My talk CC.mp4', transcript: 'hello' })).toContain('Video file: My talk.mp4');
  });
  it('a comparison is written from its facts, with no file name, silent videos too', () => {
    const user = copyUserPrompt({ fileName: 'odd name CC.mp4', comparison });
    expect(user).toContain('compares Assess360 with LeadQuizzes');
    expect(user).toContain('Server-side Conversions API: Assess360 yes, LeadQuizzes no');
    expect(user).not.toContain('odd name');
    expect(user).toContain('no speech');
    const sys = copySystemPrompt({ comparison: true });
    expect(sys).toMatch(/name both products/);
    expect(copySystemPrompt({})).not.toMatch(/name both products/);
    expect(copySystemPrompt({ comparison: true, comparisonPrompt: 'MINE' })).toContain('MINE');
  });
});

describe('image rules', () => {
  it('no longer ask for a face, and Settings text replaces them', () => {
    expect(thumbImagePrompt('A chart')).not.toMatch(/face clearly visible/);
    expect(thumbImagePrompt('A chart')).toMatch(/no person unless/);
    expect(thumbImagePrompt('A chart', 'MY RULES')).toBe('A chart\n\nMY RULES');
  });
});

describe('the drawn thumbnail', () => {
  const rows = [
    { label: 'Shared', us: true, them: true },
    { label: 'One', us: true, them: false },
    { label: 'Two', us: true, them: false },
    { label: 'Three', us: true, them: false },
  ];
  it('shows differences first', () => {
    expect(thumbRows(rows).map((r) => r.label)).toEqual(['One', 'Two', 'Three']);
    expect(thumbRows(rows.slice(0, 2)).map((r) => r.label)).toEqual(['One', 'Shared']);
  });
  it('a typed "vs" headline is dropped, the panels already say it', () => {
    expect(comparisonHeadline('Assess360 vs LeadQuizzes')).toBe('');
    expect(comparisonHeadline('Stop paying for bad leads')).toBe('Stop paying for bad leads');
    expect(comparisonHeadline('Canvas tips')).toBe('Canvas tips');
  });
  it('names both sides, escapes text, and draws its marks', () => {
    const svg = comparisonSvg({ w: 1280, h: 720, brand: 'A&B', competitor: 'LeadQuizzes', rows, checked: '27-10-2026' });
    expect(svg).toContain('A&amp;B');
    expect(svg).toContain('LeadQuizzes');
    expect(svg).toContain('Facts checked 27-10-2026');
    expect(svg).not.toMatch(/[✓✔✗✘]/);
    expect((svg.match(/<circle/g) || []).length).toBe(7); // the VS badge + two marks per row
  });
});

describe('no speech', () => {
  const step = (artifacts, status = 'done') => [{ key: 'transcript', status, artifacts }];
  it('only when whisper heard nothing and nobody has acted', () => {
    expect(isNoSpeech(step({ source: 'whisper', text: '' }))).toBe(true);
    expect(isNoSpeech(step({ source: 'whisper', text: 'hello' }))).toBe(false);
    expect(isNoSpeech(step({ source: 'edited', text: '' }))).toBe(false);
    expect(isNoSpeech(step({ source: 'whisper', text: '', approvedAt: 'x' }))).toBe(false);
    expect(isNoSpeech(step({}, 'pending'))).toBe(false);
    expect(isNoSpeech(null)).toBe(false);
  });
});
