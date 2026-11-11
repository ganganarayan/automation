/**
 * Onboarding tour (pure).
 *
 * Purpose:      Decide where a new workspace is in its first-run setup, so the
 *               help bot on every admin page can point at the one thing to do
 *               next. Kept short on purpose: add a funnel, fill its basics,
 *               connect the social accounts, bring the Google Sheet. Everything
 *               else (Lane 1 folder, Lane 2 keys) is optional and is mentioned
 *               only on the last screen.
 * Responsibility: Data + decisions only. No DB, no request. The route
 *               (modules/onboardingTour.js) feeds it the funnels and their
 *               wizard completeness; the browser script (tourClient.js) maps
 *               the answer onto the page it is on.
 *
 * Stages, in the order they are asked:
 *   add     no funnel yet                       (tour steps 1 and 2)
 *   basics  wizard page "Shared basics"         (step 3 opens setup, step 4)
 *   publish wizard page "Publish & comments"    (step 5, social accounts)
 *   ready   wizard page "Lane 1: Ready video"   (step 6, the Drive folder)
 *   image   wizard page "Lane 3: Image post"    (step 7, the Google Sheet:
 *           Excel template + an AI prompt that fills it, then the sheet)
 *   done    all of the above saved              (step 8)
 */
import { WIZARD_STEPS, completeness } from '../services/videoWizardManifest.js';

/** Wizard pages the tour walks, in tour order (not wizard order). */
export const TOUR_STAGES = ['basics', 'publish', 'ready', 'image'];

/** The headers a Lane 3 sheet needs in row 1 (postCompose.sheetColumnIndex reads these). */
export const SHEET_HEADERS = ['status', 'headline', 'subheadline', 'image_prompt', 'caption', 'hashtags'];

/** Two example rows for the downloadable template (the AI replaces them). */
export const SHEET_SAMPLE = [
  ['Ready', 'Still guessing what to post?', 'One clear idea a day beats ten random posts',
    'A calm home office at sunrise, a person at a wooden desk looking at a notebook with a small smile, soft warm light from a window on the left, muted blue and sand colours, eye-level shot, wide empty wall space at the top for text, no words or letters anywhere',
    'Most people post when they feel like it and wonder why nothing moves. Pick one problem your buyer has this week and answer it in one picture and three lines. Do that daily and people start to recognise you. Take the free assessment: https://your-link',
    '#smallbusiness #marketingtips #contentideas #growth #socialmedia'],
  ['Ready', 'Your best client is scrolling past', 'Speak to one person, not everyone',
    'Close-up of a hand holding a phone in a busy cafe, the screen glowing softly, shallow depth of field with blurred people behind, warm evening light, teal and orange tones, empty space on the right side for text, no words or letters anywhere',
    'If your post talks to everyone, it lands with no one. Name the exact person you help and the one thing keeping them stuck. They will stop scrolling because it feels written for them. Book a free call: https://your-link',
    '#branding #audience #businessgrowth #marketing #entrepreneur'],
];

/** Download name of the template (generic, not any one brand's sheet). */
export const TEMPLATE_NAME = 'content-sheet-template.xlsx';

/** Fields the prompt maker asks for, in order. key -> label shown on the form. */
export const PROMPT_FIELDS = [
  ['niche', 'Niche', 'e.g. career coaching for mid-level managers'],
  ['audience', 'Audience', 'who you help, as exactly as you can'],
  ['pain_points', 'Pain points', 'what keeps them stuck, a few short lines'],
  ['solutions', 'Solutions', 'how you solve it, your offer'],
  ['cta', 'Call to action', 'e.g. Take the free assessment: https://...'],
  ['website', 'Website', 'https://'],
  ['landing_page', 'Landing page', 'https://'],
];

/**
 * The prompt a customer pastes into their own AI (ChatGPT, Claude, Gemini)
 * together with the template file. An empty field keeps its [placeholder] so
 * they can still fill it in there.
 */
export function buildPrompt(values = {}) {
  const v = (k, label) => {
    const s = String((values && values[k]) || '').trim();
    return s || `[${label.toLowerCase()}]`;
  };
  const cta = v('cta', 'Call to action');
  return [
    'You are a social media content writer for my business.',
    '',
    'About my business:',
    `- Niche: ${v('niche', 'Niche')}`,
    `- Website: ${v('website', 'Website')}`,
    `- Landing page: ${v('landing_page', 'Landing page')}`,
    `- Audience: ${v('audience', 'Audience')}`,
    `- Their pain points: ${v('pain_points', 'Pain points')}`,
    `- How I solve them: ${v('solutions', 'Solutions')}`,
    `- Call to action: ${cta}`,
    '',
    'If you can open links, read my website and landing page first and use their words.',
    '',
    `I have attached an Excel file, ${TEMPLATE_NAME}. Fill it with 30 new rows of image posts for Instagram, Facebook and LinkedIn.`,
    `Keep the header row exactly as it is: ${SHEET_HEADERS.join(', ')}. Delete the two sample rows.`,
    '',
    'For each row:',
    '- status: the word Ready',
    '- headline: 3 to 8 words that stop the scroll and speak to one pain point',
    '- subheadline: one short line, at most 14 words, that points to the solution',
    '- image_prompt: a detailed description for an AI image generator: subject, setting, mood, lighting, colours and camera angle. The picture must contain no words, letters, logos or numbers, and must leave clear empty space (top or one side) where my headline will be placed.',
    `- caption: 60 to 120 words in a warm, plain voice. Open with the pain, give one useful idea, end with the call to action: ${cta}`,
    '- hashtags: 5 to 8 relevant hashtags separated by spaces',
    '',
    'Use a different pain point or angle in every row; no two headlines alike. Write in simple English and do not use long dashes.',
    'Give the filled file back to me as an .xlsx download. If you cannot make files, give one table with exactly these 6 columns that I can copy into a spreadsheet.',
  ].join('\n');
}

/** tenant_config key holding "dismissed" or "done". */
export const TOUR_KEY = 'tour_state';

/** Wizard step index for a stage id ('basics' -> 0), or -1. */
export function wizardIndex(stage) {
  return WIZARD_STEPS.findIndex((s) => s.id === stage);
}

/** First tour stage a funnel's config still needs, or 'done'. */
export function stageFor(cfg) {
  const complete = completeness(cfg || {});
  for (const stage of TOUR_STAGES) {
    const i = wizardIndex(stage);
    if (i !== -1 && !complete[i]) return stage;
  }
  return 'done';
}

/**
 * Pick the funnel the tour works on and the stage it is at.
 *
 * @param {Array<{id:number,name:string,cfg:object}>} list - the workspace's funnels, oldest first.
 * @param {number|string} [preferId] - the funnel open on the page, used when it is in the list.
 * @returns {{stage:string, funnel:{id:number,name:string}|null}}
 */
export function pickStage(list = [], preferId = null) {
  const funnels = Array.isArray(list) ? list : [];
  if (!funnels.length) return { stage: 'add', funnel: null };
  const want = Number(preferId);
  const preferred = Number.isInteger(want) && want > 0 ? funnels.find((f) => Number(f.id) === want) : null;
  const pick = preferred || funnels.find((f) => stageFor(f.cfg) !== 'done') || funnels[0];
  return { stage: stageFor(pick.cfg), funnel: { id: Number(pick.id), name: String(pick.name || '') } };
}

/**
 * Should the bot open by itself? Only while setup is unfinished and nobody
 * pressed Skip or Finish. The Help button is always there either way.
 */
export function autoOpen(stage, saved = '') {
  return stage !== 'done' && saved !== 'dismissed' && saved !== 'done';
}

/** Google Sheet ID from a pasted link or a bare ID ('' when it is neither). */
export function sheetIdFrom(input = '') {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

export default { TOUR_STAGES, SHEET_HEADERS, SHEET_SAMPLE, TEMPLATE_NAME, PROMPT_FIELDS, buildPrompt, TOUR_KEY, wizardIndex, stageFor, pickStage, autoOpen, sheetIdFrom };
