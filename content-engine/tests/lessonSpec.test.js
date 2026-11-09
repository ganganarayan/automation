import { describe, it, expect } from 'vitest';
import { tookText, parseLessons, addLesson, lessonsText, lessonsBlock, imagePromptWithRules, holdLeft, NO_TEXT_ON_FACE, HOLD_STATUS, LESSON_MAX } from '../src/utils/lessonSpec.js';
import { libraryStatus } from '../src/utils/libraryStatus.js';

describe('lessons', () => {
  it('are stored one per line and read back, bullets and blanks dropped', () => {
    expect(parseLessons('- text off the face\n\nbigger product\r\n')).toEqual([{ text: 'text off the face' }, { text: 'bigger product' }]);
    expect(parseLessons('')).toEqual([]);
    expect(parseLessons('[]')).toEqual([]);
  });

  it('add skips blanks and repeats, keeps the newest last and caps the list', () => {
    let list = addLesson('', 'Text off the face');
    list = addLesson(list, '  ');
    list = addLesson(list, 'text off the FACE');
    expect(list).toEqual([{ text: 'text off the FACE' }]);
    for (let i = 0; i < LESSON_MAX + 5; i += 1) list = addLesson(list, `rule ${i}`);
    expect(list.length).toBe(LESSON_MAX);
    expect(list[list.length - 1].text).toBe(`rule ${LESSON_MAX + 4}`);
    expect(lessonsText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb');
  });

  it('every image prompt gets the face rule, then what was learned', () => {
    const p = imagePromptWithRules('A man holding a phone', 'person on the left');
    expect(p.startsWith('A man holding a phone')).toBe(true);
    expect(p).toContain(NO_TEXT_ON_FACE);
    expect(p).toContain('- person on the left');
    expect(imagePromptWithRules('x', '')).not.toContain('Corrections');
  });

  it('the video block names videos; nothing learned gives nothing', () => {
    expect(lessonsBlock('slower voice', 'video')).toMatch(/videos[\s\S]*- slower voice/);
    expect(lessonsBlock('', 'video')).toBe('');
  });
});

describe('the Remake minute', () => {
  it('counts down from the disapproval and stops at 0', () => {
    const at = new Date('2026-11-09T10:00:00Z');
    expect(holdLeft({ status: HOLD_STATUS, updated_at: at }, at.getTime() + 15000)).toBe(45);
    expect(holdLeft({ status: HOLD_STATUS, updated_at: at }, at.getTime() + 90000)).toBe(0);
    expect(holdLeft({ status: 'image_review', updated_at: at }, at.getTime())).toBe(0);
  });

  it('a held run stays visible in the Library', () => {
    expect(libraryStatus(HOLD_STATUS)).toMatchObject({ hidden: false, dot: '🟡' });
  });
});

describe('attempt time in the log', () => {
  it('reads as s, min, h, d', () => {
    const t0 = '2026-11-09T10:00:00Z';
    expect(tookText(t0, '2026-11-09T10:00:40Z')).toBe('40 s');
    expect(tookText(t0, '2026-11-09T10:12:00Z')).toBe('12 min');
    expect(tookText(t0, '2026-11-09T12:05:00Z')).toBe('2 h 05 min');
    expect(tookText(t0, '2026-11-12T14:00:00Z')).toBe('3 d 4 h');
  });
});
