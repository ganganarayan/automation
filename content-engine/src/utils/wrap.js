/**
 * Text wrapping for image overlays.
 *
 * Purpose:      Wrap a "hook" line into a fixed number of lines for the AI image
 *               factory's real-text caption bar, with a font-size ladder and an
 *               ellipsis when it overflows.
 * Responsibility: Pure word-wrap logic; no rendering.
 * Dependencies: none.
 */

/**
 * Wrap text to at most `maxLines` lines of about `maxChars` each. Picks a font
 * size from the ladder based on how many lines were needed, and appends an
 * ellipsis to the last line if the text did not fit.
 *
 * @param {string} text
 * @param {object} [opts] - { maxChars=24, maxLines=3, fontLadder=[64,56,46] }
 * @returns {{ lines: string[], fontSize: number, truncated: boolean }}
 */
export function wrapHook(text, opts = {}) {
  const maxChars = opts.maxChars ?? 24;
  const maxLines = opts.maxLines ?? 3;
  const fontLadder = opts.fontLadder ?? [64, 56, 46];

  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  let truncated = false;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    }
  }

  if (!truncated && current && lines.length < maxLines) lines.push(current);
  else if (current && lines.length < maxLines && !lines.includes(current)) {
    // handled above
  }

  if (words.length > 0 && lines.length === 0 && current) lines.push(current);

  // If we broke early with words remaining, mark truncated.
  const usedWords = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (usedWords < words.length) truncated = true;

  const finalLines = lines.slice(0, maxLines);
  if (truncated && finalLines.length > 0) {
    const last = finalLines[finalLines.length - 1];
    finalLines[finalLines.length - 1] = last.replace(/[.,;:\s]+$/, '') + '…';
  }

  const fontSize = fontLadder[Math.min(finalLines.length, fontLadder.length) - 1] || fontLadder[fontLadder.length - 1];

  return { lines: finalLines, fontSize, truncated };
}

export default { wrapHook };
