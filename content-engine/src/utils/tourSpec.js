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
 *   image   wizard page "Lane 3: Image post"    (step 6, the Google Sheet)
 *   done    all of the above saved              (step 7)
 */
import { WIZARD_STEPS, completeness } from '../services/videoWizardManifest.js';

/** Wizard pages the tour walks, in tour order (not wizard order). */
export const TOUR_STAGES = ['basics', 'publish', 'image'];

/** The headers a Lane 3 sheet needs in row 1 (postCompose.sheetColumnIndex reads these). */
export const SHEET_HEADERS = ['status', 'headline', 'image_prompt', 'caption'];

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

export default { TOUR_STAGES, SHEET_HEADERS, TOUR_KEY, wizardIndex, stageFor, pickStage, autoOpen, sheetIdFrom };
