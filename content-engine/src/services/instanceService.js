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
import { childLogger } from '../core/logger.js';

/** Start a new instance for a funnel run. Returns the created row. */
export async function createForFunnel({ tenantId = 'default', funnel, title = '', scheduledFor = null }) {
  const id = randomUUID();
  const row = await repo.create({
    id,
    tenantId,
    funnelId: funnel?.id ?? null,
    funnelName: funnel?.name ?? '',
    title,
    status: 'script_review',
    steps: buildInitialSteps(),
    scheduledFor,
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

export { parseSteps };
export default { createForFunnel, recordCost, updateStep, costsFor, setMeta, get, list, logRows };
