/**
 * Mail provider (interface + SMTP implementation).
 *
 * Purpose:      Abstract outbound email (alerts) behind an interface.
 * Responsibility: send({ to, subject, text, html }).
 * Dependencies: nodemailer, logger.
 */
import nodemailer from 'nodemailer';

/**
 * @typedef {object} MailProvider
 * @property {(msg: {to: string, subject: string, text?: string, html?: string}) => Promise<{ok: boolean, id?: string}>} send
 */

/**
 * Build an SMTP-backed MailProvider. If SMTP is not configured the provider is
 * a no-op that logs instead of throwing, so alert paths never crash the app.
 * @param {object} cfg - { host, port, user, pass, from }
 * @param {import('pino').Logger} log
 * @returns {MailProvider}
 */
export function createSmtpMailProvider(cfg, log) {
  if (!cfg.host || !cfg.user) {
    return {
      async send(msg) {
        log.warn({ to: msg.to, subject: msg.subject }, 'SMTP not configured; email skipped');
        return { ok: false };
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  return {
    async send({ to, subject, text, html }) {
      const info = await transport.sendMail({
        from: cfg.from || cfg.user,
        to,
        subject,
        text,
        html,
      });
      log.info({ to, subject, id: info.messageId }, 'email sent');
      return { ok: true, id: info.messageId };
    },
  };
}

export default { createSmtpMailProvider };
