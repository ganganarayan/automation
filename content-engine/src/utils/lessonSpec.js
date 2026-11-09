/**
 * Lessons (pure): what the app learns from your Disapprove reasons and Remake
 * corrections, and the fixed image rules every picture follows.
 *
 * Purpose:      Each reason or correction you give is kept (tenant_config
 *               lessons_image / lessons_video, newest last, capped) and added to
 *               every later image or video-script prompt, so the same mistake is
 *               not made twice. Stored one per line, editable under System prompts. The face rule is always added to every image.
 * Dependencies: none.
 */

export const LESSON_MAX = 20;
export const LESSON_CHARS = 240;
export const HOLD_SECONDS = 60;
export const HOLD_STATUS = 'disapproved_hold';

/** Always added to every image prompt: no words over a face. */
export const NO_TEXT_ON_FACE = 'Never put any text, letters, numbers or graphics over a person\'s face: every face stays fully clear and visible. Keep faces out of the top 30% of the frame and the bottom-left corner, where the app later places its headline and label.';

/**
 * tenant_config value → [{ text }]. Stored as plain text, one lesson per line,
 * so the Settings box can show and edit it; an array passes through.
 */
export function parseLessons(raw) {
  if (Array.isArray(raw)) return raw.filter((l) => l && l.text);
  const s = String(raw || '').trim();
  if (!s || s === '[]') return [];
  return s.split(/\r?\n/).map((t) => t.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean).map((text) => ({ text }));
}

/** [{ text }] → the stored text, one per line. */
export function lessonsText(list) {
  return parseLessons(list).map((l) => l.text).join('\n');
}

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, LESSON_CHARS);

/** Add one lesson: blank and repeated ones are skipped; only the newest LESSON_MAX stay. */
export function addLesson(list, text) {
  const t = clean(text);
  const base = parseLessons(list);
  if (!t) return base;
  const rest = base.filter((l) => clean(l.text).toLowerCase() !== t.toLowerCase());
  return [...rest, { text: t }].slice(-LESSON_MAX);
}


/** The block added to a prompt ('' when nothing has been learned). */
export function lessonsBlock(list, what = 'image') {
  const items = parseLessons(list).map((l) => `- ${clean(l.text)}`);
  if (!items.length) return '';
  const head = what === 'video'
    ? 'Corrections from past reviews of these videos. Follow every one that applies:'
    : 'Corrections from past reviews of these pictures. Follow every one that applies:';
  return `${head}\n${items.join('\n')}`;
}

/** An image prompt with the face rule and the learned image lessons after it. */
export function imagePromptWithRules(prompt, lessons = []) {
  const p = String(prompt || '').trim();
  return [p, NO_TEXT_ON_FACE, lessonsBlock(lessons, 'image')].filter(Boolean).join('\n\n');
}

/** Seconds left before a held disapproval moves to the log (0 when due). */
export function holdLeft(row = {}, now = Date.now()) {
  if (!row || row.status !== HOLD_STATUS || !row.updated_at) return 0;
  const left = HOLD_SECONDS - Math.floor((now - new Date(row.updated_at).getTime()) / 1000);
  return Math.max(0, left);
}

/** How long an attempt took, start to end: "40 s", "12 min", "2 h 05 min", "3 d 4 h". */
export function tookText(from, to) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!(ms >= 0)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

export default { tookText, lessonsText, LESSON_MAX, LESSON_CHARS, HOLD_SECONDS, HOLD_STATUS, NO_TEXT_ON_FACE, parseLessons, addLesson, lessonsBlock, imagePromptWithRules, holdLeft };
