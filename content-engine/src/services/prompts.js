/**
 * Brand prompts and prompt templates.
 *
 * Purpose:      Centralize the brand-voice system prompts and image-prompt
 *               scaffolding used across the content modules.
 * Responsibility: Pure constants/builders; no I/O.
 * Dependencies: none.
 */

export const GITA_ORIENTATIONS = [
  'a quiet dawn by a still river',
  'a solitary figure on a mountain ridge at first light',
  'soft morning light through a window onto a wooden desk',
  'a calm seated silhouette in a simple room',
  'an open road under a wide, pale sky',
  'a lamp glowing in gentle darkness',
];

export const GITA_REWORK_SYSTEM = `You are the creative director for "Apply Gita Wisdom", a brand that offers
calm, practical emotional clarity to high-performing professionals. Given a base image prompt, a caption, and a
reviewer note, return STRICT JSON {"image_prompt": string, "caption": string} that honours the note while keeping the
brand's grounded, non-preachy voice. Never mention watching a video.`;

export const VIDAPULSE_SYSTEM = `You are the content strategist for "VidaPulse" (vidapulse.io), an AI video-analysis
product for coaches, trainers, consultants, and B2B/B2C video marketers. Write in a confident, specific, benefit-led
voice. Every caption must end with the exact sentence: "Analyze your first video free at vidapulse.io".`;

/**
 * Build a Gita image prompt: strip fixed orientation phrasing, inject one random
 * orientation, and append the framing constraints.
 */
export function buildGitaImagePrompt(basePrompt, orientation) {
  const cleaned = String(basePrompt || '')
    .replace(/\b(portrait|landscape|close-up|wide shot|orientation)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return `${cleaned}. Scene: ${orientation}. Feature a new distinct individual. ` +
    `Keep the top 20% of the frame an empty band with no important detail. Photorealistic, calm, editorial.`;
}

/** VidaPulse prompt: append the top-margin rule. */
export function buildVidapulseImagePrompt(basePrompt) {
  return `${String(basePrompt || '').trim()}. Keep the top 210 pixels empty for a brand strip overlay.`;
}

/** The dark-dashboard image-prompt template for refill-generated VidaPulse rows. */
export function vidapulseDashboardPrompt({ scene, headline, subheadline }) {
  return `A sleek dark analytics dashboard UI, deep charcoal background, teal accents. ` +
    `Foreground scene: ${scene}. Headline text area reading "${headline}" and a subheadline "${subheadline}". ` +
    `Include a prominent teal "Analyze My Video Free" button. Modern, high-contrast, product-marketing look. ` +
    `Keep the top 210 pixels empty for a brand strip overlay.`;
}

export default {
  GITA_ORIENTATIONS,
  GITA_REWORK_SYSTEM,
  VIDAPULSE_SYSTEM,
  buildGitaImagePrompt,
  buildVidapulseImagePrompt,
  vidapulseDashboardPrompt,
};
