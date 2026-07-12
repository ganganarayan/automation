/**
 * Delay Relay drip service.
 *
 * Purpose:      Each day, forward a warm-up-ramped number of validated leads per
 *               account to that account's destination URL, spaced by random
 *               gaps, only within the daytime window, dropping emails whose
 *               domain has no MX record at send time.
 * Responsibility:
 *               - Compute today's quota via the ramp calculator.
 *               - For each lead: wait a random gap, skip if outside the window,
 *                 run a live MX check, POST to destination_url, log to the sheet,
 *                 and update the lead status. Restart-safe (per-lead DB updates).
 * Dependencies: relayControlRepository, contactQueueRepository, ramp calculator,
 *               httpClient (MX + forward), SheetsProvider, time utils.
 */
import * as relayControl from '../repositories/relayControlRepository.js';
import * as contactQueue from '../repositories/contactQueueRepository.js';
import { computeDailyQuota } from '../utils/ramp.js';
import { request } from '../core/httpClient.js';
import { isWithinWindow, nowIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const WINDOW_START = 6;
const WINDOW_END = 22;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live MX lookup via Google DNS. Returns true if the domain has MX answers. */
export async function domainHasMx(domain, log) {
  if (!domain) return false;
  try {
    const res = await request(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
      method: 'GET',
      label: 'dns.mx',
      log,
      retries: 1,
      timeoutMs: 8000,
    });
    return Array.isArray(res.data?.Answer) && res.data.Answer.length > 0;
  } catch {
    return false; // on lookup failure, treat as no-MX (drop the email channel)
  }
}

/**
 * Run the daily drip for one account.
 * @param {object} deps - { sheets: SheetsProvider }
 * @param {object} args - { tenantId, account }
 */
export async function runAccount({ sheets }, { tenantId = 'default', account }) {
  const log = childLogger({ module: 'delayRelay', tenant_id: tenantId, account });
  const control = await relayControl.get({ tenantId, account });
  if (!control) {
    log.warn('no relay_control row; skipping account');
    return { account, sent: 0 };
  }

  const { day, target } = computeDailyQuota(control);
  const leads = await contactQueue.oldestPending({ tenantId, account, limit: target });
  log.info({ day, target, available: leads.length }, 'delay relay run starting');

  let sent = 0;
  for (const lead of leads) {
    // Space the sends.
    const gapSeconds = control.min_seconds + Math.random() * (control.max_seconds - control.min_seconds);
    await wait(Math.round(gapSeconds * 1000));

    // Respect the daytime window; stop early if the window closed.
    if (!isWithinWindow(WINDOW_START, WINDOW_END, nowIst())) {
      log.info('outside send window; stopping run');
      break;
    }

    const channels = new Set((lead.channels || '').split(',').map((c) => c.trim()).filter(Boolean));

    // Live MX check for the email channel.
    if (channels.has('email') && lead.contact_email) {
      const domain = lead.contact_email.split('@')[1];
      const ok = await domainHasMx(domain, log);
      if (!ok) channels.delete('email');
    }

    if (channels.size === 0) {
      await contactQueue.updateStatus(lead.id, { status: 'invalid', invalidReason: 'no_mx' });
      await logRow({ sheets, control, lead, delaySeconds: Math.round(gapSeconds), outcome: 'skipped', status: 0 });
      continue;
    }

    // Forward to the per-account destination (may be this app's own /api/v1/send).
    let httpStatus = 0;
    let outcome = 'failed';
    try {
      const res = await request(control.destination_url, {
        method: 'POST',
        body: {
          contact_name: lead.contact_name,
          contact_email: lead.contact_email,
          contact_phone: lead.contact_phone,
          account,
          send_email: channels.has('email'),
          send_whatsapp: channels.has('whatsapp'),
        },
        label: 'delayRelay.forward',
        log,
        retries: 1,
        timeoutMs: 15000,
      });
      httpStatus = res.status;
      outcome = res.ok ? 'sent' : 'failed';
    } catch (err) {
      log.warn({ err: err.message, lead: lead.id }, 'forward failed');
    }

    await contactQueue.updateStatus(lead.id, {
      status: outcome === 'sent' ? 'sent' : 'failed',
      channels: [...channels].join(','),
    });
    await logRow({ sheets, control, lead, delaySeconds: Math.round(gapSeconds), outcome, status: httpStatus });
    if (outcome === 'sent') sent += 1;
  }

  await relayControl.saveProgress({ tenantId, account, rampDay: day, lastQty: sent });
  log.info({ sent }, 'delay relay run complete');
  return { account, sent };
}

async function logRow({ sheets, control, lead, delaySeconds, outcome, status }) {
  if (!control.log_sheet_id) return;
  try {
    await sheets.appendRow(control.log_sheet_id, 'Sheet1', [
      new Date().toISOString(),
      control.account,
      lead.contact_name || '',
      lead.contact_email || '',
      lead.contact_phone || '',
      delaySeconds,
      outcome,
      status,
    ]);
  } catch {
    /* logging to the sheet is best-effort */
  }
}

/** Run the drip for all configured accounts. */
export async function runAll(deps) {
  const accounts = await relayControl.all();
  const results = [];
  for (const c of accounts) {
    results.push(await runAccount(deps, { tenantId: c.tenant_id, account: c.account }));
  }
  return results;
}

export default { runAccount, runAll, domainHasMx };
