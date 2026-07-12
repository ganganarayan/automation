/**
 * Module: CRM relay + internal send.
 *
 * Purpose:      Accept CRM relay events, resolve a template, and enqueue the
 *               message; also expose the internal send endpoint other services
 *               use so they never call Evolution directly.
 * Responsibility: HTTP wiring only; delegates to templateService/sendService.
 * Dependencies: templateService, sendService, tenantSettings, SheetsProvider.
 *
 * Routes:
 *   POST /api/v1/webhook/crm-wa-relay   (public)
 *   POST /api/v1/send                   (internal, X-Internal-Key)
 */
import { z } from 'zod';
import { buildMessage } from '../services/templateService.js';
import { enqueueMessage } from '../services/sendService.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { settings } from '../settings/index.js';
import { requireInternalKey } from '../middleware/auth.js';
import { ValidationError } from '../core/errors.js';

const relaySchema = z.object({
  event_type: z.string().min(1),
  day_step: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  number: z.union([z.string(), z.number()]).optional(),
  result_link: z.string().optional(),
});

const internalSchema = z.object({
  instance: z.string().min(1),
  number: z.union([z.string(), z.number()]),
  message: z.string().min(1),
});

export function register(ctx) {
  const { router, providers } = ctx;

  // Public CRM relay: respond 200 immediately, process asynchronously.
  router.post('/webhook/crm-wa-relay', (req, res) => {
    const parsed = relaySchema.safeParse(req.body || {});
    res.status(200).json({ accepted: true });
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, 'crm-wa-relay invalid payload; ignored');
      return;
    }
    processRelay(req.tenantId, parsed.data, providers, req.log).catch((err) =>
      req.log.error({ err: err.message }, 'crm relay processing failed'),
    );
  });

  // Internal send used by other services.
  router.post('/send', requireInternalKey, async (req, res, next) => {
    try {
      const parsed = internalSchema.safeParse(req.body || {});
      if (!parsed.success) throw new ValidationError('Invalid send payload', parsed.error.issues);
      const row = await enqueueMessage({
        tenantId: req.tenantId,
        instance: parsed.data.instance,
        number: parsed.data.number,
        message: parsed.data.message,
      });
      if (!row) return res.status(422).json({ error: { code: 'dropped', message: 'empty message or invalid number' } });
      res.status(202).json({ queued: true, id: row.id });
    } catch (err) {
      next(err);
    }
  });
}

async function processRelay(tenantId, event, providers, log) {
  const resolved = await tenantSettings.forTenant(tenantId);
  const message = await buildMessage(
    { sheets: providers.sheets, sheetId: resolved.templates.sheetId, tab: resolved.templates.sheetTab },
    event,
  );
  if (!message) {
    log.info({ event_type: event.event_type }, 'no template match / empty message; dropped');
    return;
  }
  const row = await enqueueMessage({
    tenantId,
    instance: 'gita',
    number: event.number,
    message,
  });
  if (row) log.info({ id: row.id }, 'crm relay enqueued');
  else log.info('crm relay dropped (invalid number)');
}

export default { register };
