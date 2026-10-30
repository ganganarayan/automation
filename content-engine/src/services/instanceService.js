/**
 * Instance service.
 *
 * Purpose:      Create and advance a pipeline execution record, and record the
 *               REAL per-step AI cost as each stage runs. The stage workers
 *               (image gen, animation, voiceover, transcript, stitch, publish)
 *               call recordCost / updateStep against the instance they belong to;
 *               the two review checkpoints and locking land in later slices.
 * Responsibility: Orchestrate repository + pure helpers; recompute the cost
 *               total whenever a cost is added.
 * Dependencies: instanceRepository, utils/instanceSpec, crypto, logger.
 */
import { randomUUID } from 'node:crypto';
import * as repo from '../repositories/instanceRepository.js';
import { buildInitialSteps, addCostToSteps, patchStep, sumInstanceCost, costBreakdown } from '../utils/instanceSpec.js';
import { costText, costImages, costAnimation, costTts, costTranscript } from '../utils/pricing.js';
import { childLogger } from '../core/logger.js';

/** Start a new instance for a funnel run. Returns the created row. */
export async function createForFunnel({ tenantId = 'default', funnel, title = '', scheduledFor = null, status = 'script_review', sourceType = null, sourceId = null, sourceRef = null }) {
  const id = randomUUID();
  const row = await repo.create({
    id,
    tenantId,
    funnelId: funnel?.id ?? null,
    funnelName: funnel?.name ?? '',
    title,
    status,
    steps: buildInitialSteps(),
    scheduledFor,
    sourceType,
    sourceId,
    sourceRef,
  });
  childLogger({ module: 'instance', tenant_id: tenantId }).info({ instance: id, funnel: funnel?.name }, 'instance created');
  return row;
}

function parseSteps(instance) {
  const s = instance?.steps;
  if (Array.isArray(s)) return s;
  if (typeof s === 'string') {
    try { return JSON.parse(s); } catch { return buildInitialSteps(); }
  }
  return buildInitialSteps();
}

/**
 * Record a real cost entry (from utils/pricing) against a step, then persist
 * the updated steps and the recomputed instance total. Returns the new total.
 */
export async function recordCost(instanceId, stepKey, costEntry) {
  const instance = await repo.get(instanceId);
  if (!instance) throw new Error(`instance ${instanceId} not found`);
  const steps = addCostToSteps(parseSteps(instance), stepKey, { ...costEntry, at: new Date().toISOString() });
  const total = sumInstanceCost(steps);
  await repo.saveSteps(instanceId, steps, total);
  return total;
}

/** Merge a patch (status / artifacts / error / timestamps) into one step. */
export async function updateStep(instanceId, stepKey, patch = {}) {
  const instance = await repo.get(instanceId);
  if (!instance) throw new Error(`instance ${instanceId} not found`);
  const steps = patchStep(parseSteps(instance), stepKey, patch);
  const total = sumInstanceCost(steps);
  await repo.saveSteps(instanceId, steps, total);
  return steps;
}

/** The per-step and total cost breakdown for an instance. */
export async function costsFor(instanceId) {
  const instance = await repo.get(instanceId);
  if (!instance) return { total: 0, byStep: {} };
  const steps = parseSteps(instance);
  return { total: sumInstanceCost(steps), byStep: costBreakdown(steps) };
}

export async function setMeta(instanceId, meta) {
  return repo.setMeta(instanceId, meta);
}

export async function get(instanceId) {
  return repo.get(instanceId);
}

export async function list(args) {
  return repo.list(args);
}

export async function logRows(args) {
  return repo.logRows(args);
}

export async function remove(instanceId) {
  return repo.remove(instanceId);
}

/**
 * Create a sample instance with representative artifacts and real-formula costs,
 * so the table / detail / preview UI can be seen before the stage workers exist.
 * The media drive ids are placeholders (the embeds won't play real video until a
 * run produces real files). Not locked, so it can be deleted.
 */
export async function createSample({ tenantId = 'default' } = {}) {
  const at = new Date().toISOString();
  const withAt = (c) => ({ ...c, at });
  let steps = buildInitialSteps();

  steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: 'Sample 90-second script.\nHook. Body. CTA: take the assessment.' } });
  steps = addCostToSteps(steps, 'script', withAt(costText({ inputTokens: 3200, outputTokens: 420, model: 'gpt-5-mini' })));

  const images = [0, 1, 2, 3].map((i) => ({ driveId: `SAMPLE_IMG_${i}`, prompt: `scene ${i + 1}` }));
  steps = patchStep(steps, 'images', { status: 'done', artifacts: { images } });
  steps = addCostToSteps(steps, 'images', withAt(costImages({ count: images.length, size: '1024x1536' })));

  const clips = images.map((im, i) => ({ driveId: `SAMPLE_CLIP_${i}`, sourceImageId: im.driveId }));
  steps = patchStep(steps, 'animate', { status: 'done', artifacts: { clips } });
  steps = addCostToSteps(steps, 'animate', withAt(costAnimation({ provider: 'kling', seconds: 20 })));

  steps = patchStep(steps, 'voiceover', { status: 'done', artifacts: { audio: { driveId: 'SAMPLE_AUDIO', durationSec: 47 } } });
  steps = addCostToSteps(steps, 'voiceover', withAt(costTts({ provider: 'elevenlabs', chars: 1400 })));

  steps = patchStep(steps, 'transcript', { status: 'done', artifacts: { text: '[00:00] Sample line one\n[00:06] Sample line two' } });
  steps = addCostToSteps(steps, 'transcript', withAt(costTranscript({ provider: 'whisper', minutes: 0.8 })));

  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { driveId: 'SAMPLE_REEL', durationSec: 47 } } });

  const id = randomUUID();
  const total = sumInstanceCost(steps);
  await repo.create({ id, tenantId, funnelName: 'Sample', title: 'SAMPLE — delete me', status: 'final_review', steps });
  await repo.saveSteps(id, steps, total);
  await repo.setMeta(id, { durationSeconds: 47 });
  return id;
}

export { parseSteps };
export default {
  createForFunnel, recordCost, updateStep, costsFor, setMeta, get, list, logRows, remove, createSample,
};
