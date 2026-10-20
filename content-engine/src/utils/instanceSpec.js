/**
 * Instance: pure helpers.
 *
 * Purpose:      The settings-free pieces of the instance model — the canonical
 *               pipeline steps, initial-steps builder, per-step cost roll-up, and
 *               display formatting — kept apart from the repository/service so
 *               they unit-test without a database (like utils/animationSpec).
 * Responsibility: Pure functions only.
 * Dependencies: utils/pricing (pure).
 */
import { sumCosts } from './pricing.js';

/** The artifact-producing stages of one run, in order. Checkpoints (script /
 *  final review) are instance statuses, not steps. */
export const INSTANCE_STEPS = [
  { key: 'script', label: 'Script' },
  { key: 'images', label: 'Images' },
  { key: 'animate', label: 'Image → video' },
  { key: 'voiceover', label: 'Voiceover' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'stitch', label: 'Final reel' },
  { key: 'publish', label: 'Publish' },
];

export const INSTANCE_STATUSES = [
  'script_review', 'running', 'final_review', 'approved', 'posted', 'failed', 'superseded',
];

/** A fresh steps array, every stage pending with no artifacts or costs. */
export function buildInitialSteps() {
  return INSTANCE_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    status: 'pending', // pending | running | done | failed | skipped
    artifacts: {},
    costs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  }));
}

/** Total cost across every step's cost entries. */
export function sumInstanceCost(steps) {
  const all = (Array.isArray(steps) ? steps : []).flatMap((s) => (Array.isArray(s.costs) ? s.costs : []));
  return sumCosts(all);
}

/** Per-step cost totals, keyed by step key (for the cost breakdown). */
export function costBreakdown(steps) {
  const out = {};
  for (const s of Array.isArray(steps) ? steps : []) out[s.key] = sumCosts(s.costs);
  return out;
}

/**
 * Append a cost entry to a step (pure): returns a new steps array. The service
 * uses this, then persists the result and the recomputed total.
 */
export function addCostToSteps(steps, stepKey, costEntry) {
  return (Array.isArray(steps) ? steps : []).map((s) =>
    s.key === stepKey ? { ...s, costs: [...(s.costs || []), costEntry] } : s,
  );
}

/** Merge a patch into a step (status / artifacts / error / timestamps). */
export function patchStep(steps, stepKey, patch = {}) {
  return (Array.isArray(steps) ? steps : []).map((s) => {
    if (s.key !== stepKey) return s;
    const next = { ...s, ...patch };
    if (patch.artifacts) next.artifacts = { ...(s.artifacts || {}), ...patch.artifacts };
    return next;
  });
}

/** mm:ss from seconds (for the posted-log length column). */
export function formatDuration(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default {
  INSTANCE_STEPS,
  INSTANCE_STATUSES,
  buildInitialSteps,
  sumInstanceCost,
  costBreakdown,
  addCostToSteps,
  patchStep,
  formatDuration,
};
