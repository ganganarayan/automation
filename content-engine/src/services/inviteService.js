/**
 * Invite service.
 *
 * Purpose:      Email a new person their sign-in link and one-time password
 *               (docs/agency-build-plan.md, phase 4). The mail goes out on the
 *               workspace's own mail settings, else its agency's.
 * Responsibility: inviteText (pure) and sendInvite.
 * Dependencies: providerFactory, emailHealth, tenantRepository, settings.
 *
 * Never throws: a person can always be told the password on screen instead.
 */
import { buildProviders } from './providerFactory.js';
import { mailMissing } from '../utils/emailHealth.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import { settings } from '../settings/index.js';
import { ROLE_LABEL } from '../utils/workspaceSpec.js';

/** The invite's subject and text (pure, for tests). */
export function inviteText({ workspace = '', access = 'admin', email = '', tempPassword = '', base = '' } = {}) {
  const link = `${String(base || '').replace(/\/+$/, '')}/api/v1/admin/login`;
  const as = ROLE_LABEL[access] || access;
  return {
    subject: `You are invited to ${workspace} on the content engine`,
    text: [
      `Hello,`,
      '',
      `You have been added to the ${workspace} workspace as ${as}.`,
      '',
      `Sign in: ${link}`,
      `Email: ${email}`,
      `One-time password: ${tempPassword}`,
      '',
      'You will choose your own password the first time you sign in.',
      access === 'viewer' ? 'You can see the posts, the Library and the Log; you cannot change anything.' : '',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
  };
}

export async function mailFor(tenantId) {
  const p = await buildProviders(tenantId);
  const mail = { ...p.resolved.mail, smtp: p.resolved.smtp || {} };
  return mailMissing(mail).length ? null : p.mail;
}

/** @returns {Promise<{ sent: boolean, error?: string }>} */
export async function sendInvite({ tenantId, email, tempPassword, access = 'admin' }) {
  try {
    const row = await tenantRepo.findById(String(tenantId));
    let mail = await mailFor(tenantId).catch(() => null);
    if (!mail && row && row.parent_id) mail = await mailFor(row.parent_id).catch(() => null);
    if (!mail) return { sent: false, error: 'email is not set up in Settings' };
    const msg = inviteText({ workspace: (row && row.name) || tenantId, access, email, tempPassword, base: settings.app.publicBaseUrl });
    const out = await mail.send({ to: email, subject: msg.subject, text: msg.text });
    return out && out.ok ? { sent: true } : { sent: false, error: (out && out.error) || 'send failed' };
  } catch (err) {
    return { sent: false, error: String((err && err.message) || err).slice(0, 160) };
  }
}

export default { inviteText, sendInvite };
