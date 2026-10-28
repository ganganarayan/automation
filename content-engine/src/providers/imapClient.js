/**
 * IMAP client (read-only mailbox polling for the LinkedIn relay).
 *
 * Purpose:      Fetch unseen messages from a Gmail mailbox/label and mark chosen
 *               ones seen. Used to watch LinkedIn notification emails.
 * Responsibility: Connect, fetch unseen (parsed), mark seen. No business logic.
 * Dependencies: imapflow + mailparser, both lazy-imported so this module (and the
 *               app/test import graph) don't require them until a poll runs.
 *
 * Auth: Gmail "app password" (same kind the SMTP sender uses) over IMAP SSL.
 */
import { ExternalAPIError } from '../core/errors.js';

async function libs() {
  const [{ ImapFlow }, { simpleParser }] = await Promise.all([
    import('imapflow'),
    import('mailparser'),
  ]);
  return { ImapFlow, simpleParser };
}

export function createImapClient({ host = 'imap.gmail.com', port = 993, user, pass, log } = {}) {
  async function withClient(fn) {
    if (!user || !pass) throw new ExternalAPIError('IMAP not configured (user/app-password missing)');
    const { ImapFlow } = await libs();
    const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  return {
    /** Unseen messages in a mailbox, newest first, parsed to {uid,from,subject,text,html,date}. */
    async fetchUnseen({ mailbox = 'INBOX', limit = 25 } = {}) {
      const { simpleParser } = await libs();
      return withClient(async (client) => {
        const lock = await client.getMailboxLock(mailbox);
        const out = [];
        try {
          const uids = await client.search({ seen: false }, { uid: true });
          if (!uids || !uids.length) return out;
          const recent = uids.slice(-limit).reverse(); // newest first
          for (const uid of recent) {
            const msg = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
            if (!msg || !msg.source) continue;
            const parsed = await simpleParser(msg.source);
            out.push({
              uid,
              from: parsed.from?.text || '',
              subject: parsed.subject || '',
              text: parsed.text || '',
              html: parsed.html || '',
              date: parsed.date || null,
            });
          }
        } finally {
          lock.release();
        }
        return out;
      });
    },

    /** Mark one message (by uid) seen, so it is never relayed twice. */
    async markSeen({ mailbox = 'INBOX', uid }) {
      return withClient(async (client) => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
        } finally {
          lock.release();
        }
      });
    },
  };
}

export default { createImapClient };
