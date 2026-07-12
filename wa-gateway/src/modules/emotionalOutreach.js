/**
 * Module: emotional outreach.
 *
 * Purpose:      Accept a lead from Assess360 and run the outreach sequence as a
 *               durable background job (respond 200 immediately).
 * Responsibility: validate payload -> enqueue job; register the job handler.
 * Dependencies: jobRunner, outreachService.
 *
 * Route: POST /api/v1/webhook/gita-emo-outreach
 */
import { z } from 'zod';
import * as jobRunner from '../core/jobRunner.js';
import { run as runOutreach } from '../services/outreachService.js';

const JOB_TYPE = 'emotional_outreach';

const schema = z.object({
  name: z.string().optional(),
  number: z.union([z.string(), z.number()]).optional(),
  phone: z.union([z.string(), z.number()]).optional(),
  assessment_diagnosis: z.string().optional(),
  ai_statement: z.string().optional(),
});

export function register(ctx) {
  const { router } = ctx;

  // The sequence itself is a managed job so a crash/restart is safe.
  jobRunner.registerHandler(
    JOB_TYPE,
    async (job) => {
      await runOutreach(job.tenant_id, job.payload);
    },
    { maxAttempts: 2, backoffSeconds: 120 },
  );

  router.post('/webhook/gita-emo-outreach', (req, res) => {
    const parsed = schema.safeParse(req.body || {});
    res.status(200).json({ accepted: true });
    if (!parsed.success) {
      req.log.warn('emo-outreach invalid payload; ignored');
      return;
    }
    jobRunner
      .enqueueJob({ tenantId: req.tenantId, type: JOB_TYPE, payload: parsed.data })
      .catch((err) => req.log.error({ err: err.message }, 'failed to enqueue outreach job'));
  });
}

export default { register, JOB_TYPE };
