/**
 * Lane 2 image step-down (pure).
 *
 * Purpose:      When a router AI video's animation fails, the day's post goes out as
 *               an image instead: the still already made for animating, with the
 *               headline and sub-head drawn on it by the app. These are the
 *               settings-free pieces: which still, what text, what caption, what
 *               size, and the plain words for the Log.
 * Responsibility: Pure functions only. No I/O.
 * Dependencies: none.
 *
 * The step-down lives on the video's own instance, in images.artifacts.stepDown:
 * { from, reason, note, stillDriveId, headline, subhead, at }.
 */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const imagesArt = (steps) => ((Array.isArray(steps) ? steps : []).find((s) => s && s.key === 'images') || {}).artifacts || {};

/** The step-down on this instance's steps, or null. */
export function stepDownOf(steps) {
  return imagesArt(steps).stepDown || null;
}

/** The still to reuse: the first one, which carries the script's opening. Null when none is left. */
export function stepDownPicture(steps) {
  const images = imagesArt(steps).images;
  return (Array.isArray(images) ? images : []).find((i) => i && (i.driveId || i.url)) || null;
}

/**
 * The words drawn on the picture. Research writes a headline and sub-head for this;
 * a brief from before that uses its title and angle.
 */
export function stepDownText(brief = {}, title = '') {
  const b = brief || {};
  const headline = clean(b.headline) || clean(b.title) || clean(b.topic) || clean(title).replace(/ · \d{2}-\d{2}-\d{4}$/, '');
  let subhead = clean(b.subhead) || clean(b.angle);
  if (subhead.length > 120) subhead = `${subhead.slice(0, 120).replace(/\s+\S*$/, '')}…`;
  return { headline, subhead: subhead.toLowerCase() === headline.toLowerCase() ? '' : subhead };
}

/** The post's caption, built the way the video's own post would have been. */
export function stepDownCaption({ brief = {}, ctaLink = '', audiencePrefix = '', title = '' } = {}) {
  const b = brief || {};
  if (b.caption) return [b.caption, ctaLink].filter(Boolean).join('\n\n');
  return [audiencePrefix, ctaLink].filter(Boolean).join('\n') || title;
}

/**
 * The finished image's size, from the still's shape. A tall still becomes 4:5,
 * because feed image posts refuse anything taller than that.
 */
export function stepDownSize({ width = 0, height = 0 } = {}) {
  const ratio = width && height ? width / height : 0.8;
  if (ratio < 0.95) return { w: 1080, h: 1350 };
  if (ratio > 1.05) return { w: 1280, h: 720 };
  return { w: 1080, h: 1080 };
}

/** The image-model prompt when a reviewer sends the picture back with a note. */
export function stepDownPrompt(prompt = '', note = '') {
  return [clean(prompt) || 'A clear, bright image of the post topic', `Revision requested: ${clean(note)}`, 'Do not write any words in the image: the app draws the headline afterwards.'].join('\n\n');
}

/** The Log's plain line. from: 'still' (the video's own) or 'sheet' (the content sheet). */
export function stepDownNote(why = '', from = 'still') {
  const source = from === 'sheet' ? 'the next Ready row of the content sheet' : "the video's own still";
  return `Stepped down to an image post, using ${source}. Why: ${clean(why).slice(0, 240)}`;
}

export default { stepDownOf, stepDownPicture, stepDownText, stepDownCaption, stepDownSize, stepDownPrompt, stepDownNote };
