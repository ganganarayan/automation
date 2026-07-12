/**
 * Dispatcher service (the core throttled sender).
 *
 * Purpose:      Drain the WhatsApp queue at a safe, human-like pace so a burst
 *               never triggers WhatsApp rate limiting or bans. This permanently
 *               fixes the legacy problem where messages accumulated with nothing
 *               draining them.
 * Responsibility (per instance, per tick):
 *               - Send AT MOST one message.
 *               - Only between the configured IST window.
 *               - Enforce a randomized gap via the wa_gate atomic claim so two
 *                 concurrent ticks can never double-send.
 *               - Only send when Evolution connectionState === "open"; otherwise
 *                 leave the row QUEUED (protects against a reconnect burst).
 *               - Mark FAILED after maxAttempts.
 * Dependencies: queueService, WhatsAppProvider, time utils, tenantSettings, eventLog.
 */
import * as queue from '../core/queueService.js';
import { createEvolutionProvider } from '../providers/whatsappProvider.js';
import * as tenantSettings from '../core/tenantSettings.js';
import * as eventLog from '../repositories/eventLogRepository.js';
import { isWithinWindow, epochMs, randomGapMs, nowIst } from '../utils/time.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

/**
 * Run a single dispatcher tick across every instance that has queued work.
 * Safe to call repeatedly; does nothing outside the send window.
 */
export async function tick() {
  const cfg = settings.dispatcher;
  if (!isWithinWindow(cfg.sendWindowStart, cfg.sendWindowEnd, nowIst())) return;

  const targets = await queue.pending();
  for (const { tenant_id: tenantId, instance } of targets) {
    await processInstance(tenantId, instance);
  }
}

async function processInstance(tenantId, instance) {
  const cfg = settings.dispatcher;
  const log = childLogger({ module: 'dispatcher', tenant_id: tenantId, instance });
  const now = epochMs();
  const gapMs = randomGapMs(cfg.gapMinSeconds, cfg.gapMaxSeconds);

  // Reserve the gate for exactly one send this window.
  const won = await queue.claimGate({ tenantId, instance, nowMs: now, gapMs });
  if (!won) return;

  let rolledBack = false;
  const rollback = async () => {
    if (!rolledBack) {
      rolledBack = true;
      await queue.releaseGate({ tenantId, instance, nowMs: now });
    }
  };

  try {
    const row = await queue.next({ tenantId, instance });
    if (!row) {
      await rollback(); // nothing to send; don't burn the gap
      return;
    }

    const resolved = await tenantSettings.forTenant(tenantId);
    const wa = createEvolutionProvider(resolved.evolution, log);

    const state = await wa.connectionState(instance).catch(() => 'unknown');
    if (state !== 'open') {
      // Leave the row QUEUED and free the gate so we retry next tick.
      await rollback();
      log.warn({ state }, 'instance not open; holding queue');
      return;
    }

    try {
      const { ok, id } = await wa.sendText(instance, row.number, row.message);
      if (ok) {
        await queue.markSent(row.id);
        await eventLog.append({
          tenantId,
          eventType: 'wa.sent',
          payload: { queue_id: row.id, instance, number: mask(row.number), message_id: id },
        });
        log.info({ queue_id: row.id, message_id: id }, 'message sent');
      } else {
        const result = await queue.retry(row.id, cfg.maxAttempts);
        log.warn({ queue_id: row.id, attempts: result?.attempts, status: result?.status }, 'send returned no id');
      }
    } catch (err) {
      const result = await queue.retry(row.id, cfg.maxAttempts);
      log.warn({ queue_id: row.id, err: err.message, status: result?.status }, 'send failed');
    }
  } catch (err) {
    await rollback();
    log.error({ err: err.message }, 'dispatcher instance error');
  }
}

function mask(number) {
  const s = String(number);
  return s.length <= 4 ? s : `${s.slice(0, 4)}****${s.slice(-2)}`;
}

/**
 * Start the dispatcher on an interval. Returns a stop() function.
 */
export function start() {
  const intervalMs = settings.dispatcher.tickSeconds * 1000;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // prevent overlap
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export default { tick, start };
