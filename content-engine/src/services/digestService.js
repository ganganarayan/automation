/**
 * The daily email: one per address, for all funnels.
 *
 * Purpose:      Replace the per-post emails with one digest, built from what the
 *               database already knows, so nothing has to be queued.
 * Responsibility: Read the rows, group them by recipient, send, remember the day.
 *               Timing + layout live in utils/digestSpec.
 * Dependencies: instanceRepository, approvalRepository, workViewRepository,
 *               funnelsRepository, tenantConfigRepository, approvalService,
 *               providerFactory, utils/{digestSpec,approvalButtons}.
 *
 * Runs after every post check, so the GitHub wake-up is all it needs. A failed
 * send is not remembered, so the next check tries again.
 */
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as approvalsRepo from '../repositories/approvalRepository.js';
import * as views from '../repositories/workViewRepository.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { reviewPath } from './approvalService.js';
import { buildProviders } from './providerFactory.js';
import { digestAction, digestDay, buildDigest } from '../utils/digestSpec.js';
import { pendingByInstance, APPROVAL_WAIT_STATUSES } from '../utils/approvalButtons.js';
import { nowIst, formatIst } from '../utils/time.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'digest' });

function parseIds(value) {
  try {
    const ids = JSON.parse(value || '[]');
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function channelsOf(row) {
  const steps = Array.isArray(row.steps) ? row.steps : [];
  const pub = (steps.find((s) => s && s.key === 'publish') || {}).artifacts || {};
  return Array.isArray(pub.channels) ? pub.channels : [];
}

/** The rows to report, each with its channels and approval link. */
async function loadRows(tenantId, base) {
  const [rows, open] = await Promise.all([
    instanceRepo.digestRows({ tenantId }),
    approvalsRepo.openForInstances({ tenantId }),
  ]);
  const approvals = pendingByInstance(open);
  return rows.map((r) => {
    const approval = APPROVAL_WAIT_STATUSES.includes(r.status) ? approvals.get(String(r.id)) : null;
    return { ...r, channels: channelsOf(r), approvalUrl: approval ? `${base}${reviewPath(approval.id)}` : '' };
  });
}

/** Funnels the router could not line up a post for on the next day. */
async function noPostDays(tenantId, day) {
  const days = (await views.routerDays({ tenantId, fromDay: day, toDay: day })) || [];
  return days.filter((d) => d.lane === 'none' && !/not a run day/.test(d.reason || ''));
}

/** Send what is due for one tenant. Returns the action taken ('' for none). */
export async function runDue({ tenantId = 'default', now = nowIst() } = {}) {
  const [eveningOn, morningOn, sent] = await Promise.all([
    tenantConfig.get(tenantId, 'digest_evening_on').catch(() => ''),
    tenantConfig.get(tenantId, 'digest_morning_on').catch(() => ''),
    tenantConfig.get(tenantId, 'digest_approval_ids').catch(() => ''),
  ]);
  const day = digestDay(now);
  // Cheap test first: this runs after every post check.
  if (!digestAction({ now, eveningOn, morningOn, waitingIds: ['?'], sentIds: [] })) return '';

  const base = settings.app.publicBaseUrl || '';
  const rows = await loadRows(tenantId, base);
  const waitingIds = rows.filter((r) => r.approvalUrl).map((r) => String(r.id));
  const action = digestAction({ now, eveningOn, morningOn, waitingIds, sentIds: parseIds(sent) });
  if (!action) return '';

  const nextDay = now.minus({ hours: 8 }).plus({ days: 1 }).toFormat('yyyy-MM-dd');
  const noPost = await noPostDays(tenantId, nextDay);
  const providers = await buildProviders(tenantId);
  const fallback = providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';

  // Each funnel's own approval address, else the tenant's: one email per address.
  const funnelInfo = new Map();
  const infoOf = async (id) => {
    if (!id) return { name: '', to: fallback };
    if (!funnelInfo.has(id)) {
      const funnel = await funnels.get(id).catch(() => null);
      const cfg = funnel ? await funnels.resolve(funnel).catch(() => ({})) : {};
      funnelInfo.set(id, { name: (funnel && funnel.name) || '', to: cfg.approvalEmail || fallback });
    }
    return funnelInfo.get(id);
  };
  const groups = new Map();
  const groupOf = (to) => {
    if (!groups.has(to)) groups.set(to, { rows: [], noPost: [] });
    return groups.get(to);
  };
  for (const r of rows) groupOf((await infoOf(r.funnel_id)).to).rows.push(r);
  for (const d of noPost) {
    const info = await infoOf(d.funnel_id);
    groupOf(info.to).noPost.push({ funnel: info.name || 'A funnel', reason: d.reason });
  }

  for (const [to, group] of groups) {
    const mail = buildDigest({ ...group, base, action, now, fmt: formatIst });
    if (!mail) continue;
    if (!to) {
      await providers.mail.skip?.({ subject: mail.subject, reason: 'no recipient: set the funnel approval email or Settings, Emails, Notification' });
      continue;
    }
    await providers.mail.send({ to, subject: mail.subject, html: mail.html });
    log.info({ tenantId, action, ...mail.counts }, 'daily email sent');
  }

  await tenantConfig.set(tenantId, action === 'evening' ? 'digest_evening_on' : 'digest_morning_on', day);
  await tenantConfig.set(tenantId, 'digest_approval_ids', JSON.stringify(waitingIds));
  return action;
}

export default { runDue };
