/**
 * Caption utilities.
 *
 * Purpose:      Humanize AI-written captions and build per-platform variants.
 * Responsibility: Pure string logic.
 * Dependencies: none.
 */

/**
 * Humanize a caption:
 *  - replace em/en dashes and arrows with plain punctuation
 *  - collapse excess whitespace and blank lines
 *  - prefix an "{audience}:" line when an audience is given
 */
export function humanizeCaption(caption, audience) {
  let text = String(caption || '');
  text = text
    .replace(/[—–]/g, '-') // em/en dash -> hyphen
    .replace(/[→←↔⇒]/g, '->') // arrows
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

  if (audience && String(audience).trim()) {
    return `${String(audience).trim()}:\n${text}`;
  }
  return text;
}

const CHANNELS = ['organic', 'facebook', 'instagram', 'linkedin', 'x', 'threads'];

/**
 * Append a channel-tagged assessment link to a caption for a given platform.
 * @param {string} caption
 * @param {string} baseLink   - e.g. https://applygita.com/assessment
 * @param {string} channel    - one of CHANNELS
 */
export function withChannelLink(caption, baseLink, channel) {
  const ch = CHANNELS.includes(channel) ? channel : 'organic';
  const sep = baseLink.includes('?') ? '&' : '?';
  return `${caption}\n\n${baseLink}${sep}channel=${ch}`;
}

export { CHANNELS };
export default { humanizeCaption, withChannelLink, CHANNELS };
