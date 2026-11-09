/**
 * An image post's sheet prompt split in two (pure: no I/O).
 *
 * Purpose:      The sheet prompt asks the image model to draw the picture AND
 *               write the headline into it, which puts words on faces and
 *               misspells them. Claude splits it: a picture prompt with no text
 *               and one empty area, and the words the app writes on afterwards.
 * Responsibility:
 *               - SPLIT_SCHEMA, splitSystem(), splitUser(prompt, row)
 *               - splitResult(data, row): { picture, headline, sub, tag } or null
 * Dependencies: none.
 */

export const SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    picture: { type: 'string' },
    headline: { type: 'string' },
    sub: { type: 'string' },
    tag: { type: 'string' },
  },
  required: ['picture', 'headline', 'sub', 'tag'],
  additionalProperties: false,
};

/** Added to every picture prompt Claude wrote: the model must leave the text out. */
export const NO_TEXT_PICTURE = 'No text anywhere in the image: no words, letters, numbers, captions, logos or watermarks. Leave the empty area described above truly empty: the headline is added afterwards. Keep the bottom quarter of the frame calm and free of faces: subtitles run there.';

export function splitSystem() {
  return [
    'You turn an image-post brief into two parts.',
    '1. picture: the complete prompt for an image model that draws the picture with NO text of any kind. Keep the subject, people, setting, style, colour and light the brief asks for, and drop every instruction to write, render or show words, headlines, call-outs, captions or logos. Compose it so one large calm empty area (plain background, sky, wall or soft blur, at least a third of the frame) is left for a headline, and choose where it goes to suit this subject: left, right or top, not always the same place. Say in the prompt exactly where that area is, and keep every face and the main subject fully out of it. Keep the bottom quarter calm too: subtitles run there. Write it in English, under 3000 characters.',
    '2. headline, sub, tag: the three lines written on the picture. tag is the audience line above the headline (who the post is for, 2 to 6 words, at most 40 characters, such as "For NRI parents"), headline is the big line (at most 8 words), sub is the smaller line under it (at most 10 words, the promise or the twist). Copy each one the brief or the sheet gives exactly, character for character; write the ones it does not give from what the brief is about and who it speaks to. All three are always filled. No hashtags, no emojis.',
    'If the brief has a revision request, apply it to the picture or to the words, whichever it is about.',
  ].join('\n');
}

export function splitUser(prompt, row = {}) {
  const given = [
    row.headline ? `HEADLINE: "${row.headline}"` : '',
    row.subhead ? `SUBHEAD: "${row.subhead}"` : '',
    row.callout ? `AUDIENCE CALL-OUT: "${row.callout}"` : '',
    !row.callout && row.audience ? `AUDIENCE: "${row.audience}"` : '',
  ].filter(Boolean).join('\n');
  return `<brief>\n${String(prompt || '').trim()}\n</brief>${given ? `\n\nThe sheet's own words:\n${given}` : ''}`;
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The split, checked: the sheet's own words always win over Claude's copy of
 * them. null when there is no picture prompt or no headline (the old one-step
 * drawing is used).
 */
export function splitResult(data, row = {}) {
  if (!data || typeof data !== 'object') return null;
  const picture = String(data.picture || '').trim().slice(0, 3500);
  const headline = clean(row.headline, 120) || clean(data.headline, 120);
  if (!picture || !headline) return null;
  return {
    picture: `${picture}\n\n${NO_TEXT_PICTURE}`,
    headline,
    sub: clean(row.subhead, 160) || clean(data.sub, 160),
    // A long audience column is a description for the writer, not a line to draw.
    tag: clean(row.callout, 40) || (clean(row.audience, 99).length <= 40 ? clean(row.audience, 40) : '') || clean(data.tag, 40),
  };
}

export default { SPLIT_SCHEMA, NO_TEXT_PICTURE, splitSystem, splitUser, splitResult };
