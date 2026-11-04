import { describe, it, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { smtpMissing, mailMissing, recipientDomain, sendRecord, parseRecord, healthLines } from '../src/utils/emailHealth.js';
import { parseFrom, buildMailRequest, readMailResponse, messageIdOf, rfc2822Message, DEFAULT_MAIL_PROVIDER } from '../src/utils/mailApis.js';
import { createMailProvider } from '../src/providers/mailProvider.js';

// Same output as formatIst (utils/time), which needs the app env to import.
const fmt = (iso) => DateTime.fromISO(iso).setZone('Asia/Kolkata').toFormat('dd-MM-yyyy HH:mm');
const full = { host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: 'app-pass' };
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const smtpMail = (smtp) => ({ provider: 'smtp', smtp });
const resend = { provider: 'resend', apiKey: 're_123', from: 'Gita <hello@x.com>', smtp: {} };

describe('Gmail', () => {
  const gmail = { provider: 'gmail', gmailReady: true, gmailEmail: 'me@gmail.com', gmailToken: async () => 'tok', smtp: {} };
  const decode64 = (s) => Buffer.from(s.replace(/\r\n/g, ''), 'base64').toString();

  it('is the free default and only needs the connected account', () => {
    expect(DEFAULT_MAIL_PROVIDER).toBe('gmail');
    expect(mailMissing(gmail)).toEqual([]);
    expect(mailMissing({ provider: 'gmail' })[0]).toContain('Connect Google');
  });

  it('builds a real message: encoded subject, html, no header injection', () => {
    const raw = rfc2822Message({ from: 'Gita <me@gmail.com>', to: 'a@x.com, b@y.in', subject: '🟢 Posted\r\nBcc: evil@x.com', html: '<p>héllo</p>' });
    const [head, body] = raw.split(/\r\n\r\n/);
    expect(head).toContain('From: Gita <me@gmail.com>');
    expect(head).toContain('To: a@x.com, b@y.in');
    expect(head).not.toMatch(/^Bcc:/m);
    expect(decode64(head.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1])).toBe('🟢 Posted Bcc: evil@x.com');
    expect(decode64(body)).toBe('<p>héllo</p>');
  });

  it('carries text + html as alternatives, and attachments', () => {
    const raw = rfc2822Message({ from: 'me@gmail.com', to: 'a@x.com', subject: 'S', text: 'hi', html: '<p>hi</p>', attachments: [{ filename: 'a.csv', content: 'x,y' }] });
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('filename="a.csv"');
    expect(raw.trim().endsWith('--ce-mixed-boundary--')).toBe(true);
  });

  it('sends with the account token, from the connected address', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 200 }));
    const r = await createMailProvider({ ...gmail, from: 'Gita <other@x.com>' }, log(), vi.fn(), request).send({ to: 'a@y.com', subject: 'S', text: 'hi' });
    expect(r).toEqual({ ok: true, id: 'm1' });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString()).toContain('From: Gita <me@gmail.com>');
  });

  it("reports Google's own reason", async () => {
    const request = async () => new Response(JSON.stringify({ error: { code: 403, message: 'Gmail API has not been used' } }), { status: 403 });
    await expect(createMailProvider(gmail, log(), vi.fn(), request).send({ to: 'a@y.com', subject: 'S' })).rejects.toThrow('Gmail said 403: Gmail API has not been used');
  });

  it('not connected: skips and says what to press, never crashes an alert', async () => {
    const r = await createMailProvider({ provider: 'gmail', from: 'a@b.com', smtp: {} }, log(), vi.fn()).send({ to: 'a@y.com', subject: 'S' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Connect Google');
  });
});

describe('smtpMissing', () => {
  it('names each empty setting by its Settings label', () => {
    expect(smtpMissing(full)).toEqual([]);
    expect(smtpMissing({ ...full, pass: '' })).toEqual(['SMTP password (app password)']);
    expect(smtpMissing({})).toEqual(['SMTP host', 'SMTP user', 'SMTP password (app password)']);
    expect(smtpMissing({ ...full, host: '  ' })).toEqual(['SMTP host']);
  });
});

describe('mailMissing', () => {
  it('asks an HTTP provider for its key and a From address', () => {
    expect(mailMissing(resend)).toEqual([]);
    expect(mailMissing({ ...resend, apiKey: '' })).toEqual(['Resend API key']);
    expect(mailMissing({ provider: 'brevo' })).toEqual(['Brevo API key', 'From address']);
    expect(mailMissing({ provider: 'nope' })[0]).toContain('unknown');
  });
  it('asks SMTP for host, user and password', () => {
    expect(mailMissing(smtpMail({ ...full, pass: '' }))).toEqual(['SMTP password (app password)']);
  });
});

describe('recipientDomain', () => {
  it('keeps only the domain', () => {
    expect(recipientDomain('a@x.com')).toBe('x.com');
    expect(recipientDomain('a@x.com, b@y.in, c@x.com')).toBe('x.com, y.in');
    expect(recipientDomain(['Me <a@x.com>'])).toBe('x.com');
    expect(recipientDomain('')).toBe('');
  });
});

describe('sendRecord / parseRecord', () => {
  it('stores ISO time, domain only and a trimmed error', () => {
    const r = sendRecord({ ok: false, subject: 'Hi', to: 'a@x.com', error: 'bad', at: new Date('2026-11-02T10:30:00Z') });
    expect(r).toEqual({ at: '2026-11-02T10:30:00.000Z', ok: false, skipped: false, subject: 'Hi', domain: 'x.com', error: 'bad' });
    expect(parseRecord(JSON.stringify(r))).toEqual(r);
    expect(parseRecord('nope')).toBeNull();
    expect(parseRecord(null)).toBeNull();
  });
});

describe('healthLines', () => {
  it('flags a missing key and no attempts yet', () => {
    const lines = healthLines({ mail: { ...resend, apiKey: '' }, last: null, lastError: null, fmt });
    expect(lines[0]).toEqual({ dot: '🔴', text: 'Resend incomplete: set Resend API key, Save, then Send test' });
    expect(lines[1].dot).toBe('🟡');
  });
  it('warns that Railway blocks SMTP', () => {
    const lines = healthLines({ mail: smtpMail(full), last: null, lastError: null, fmt });
    expect(lines[0].dot).toBe('🟢');
    expect(lines[1].text).toContain('Railway blocks outbound SMTP');
  });
  it('shows the last send in DD-MM-YYYY HH:MM IST', () => {
    const last = sendRecord({ ok: true, subject: 'Approve', to: 'a@x.com', at: new Date('2026-11-02T10:30:00Z') });
    const lines = healthLines({ mail: resend, last, lastError: null, fmt });
    expect(lines[0]).toEqual({ dot: '🟢', text: 'Resend is set up (sends over HTTPS)' });
    expect(lines[1]).toEqual({ dot: '🟢', text: 'Last send 02-11-2026 16:00 IST: sent "Approve" to @x.com' });
  });
  it('shows an older error separately, not twice when it is the last send', () => {
    const err = sendRecord({ ok: false, subject: 'A', to: 'a@x.com', error: 'auth', at: new Date('2026-11-01T10:30:00Z') });
    const ok = sendRecord({ ok: true, subject: 'B', to: 'a@x.com', at: new Date('2026-11-02T10:30:00Z') });
    expect(healthLines({ mail: resend, last: ok, lastError: err, fmt })[2].text).toBe('Last error 01-11-2026 16:00 IST: auth');
    expect(healthLines({ mail: resend, last: err, lastError: err, fmt })).toHaveLength(2);
  });
});

describe('mailApis', () => {
  it('parses a From with or without a name', () => {
    expect(parseFrom('Gita <hello@x.com>')).toEqual({ email: 'hello@x.com', name: 'Gita' });
    expect(parseFrom('hello@x.com')).toEqual({ email: 'hello@x.com', name: '' });
  });
  it('builds each provider request with its own auth header', () => {
    const msg = { apiKey: 'K', from: 'Gita <hello@x.com>', to: 'a@y.com', subject: 'S', text: 'hi' };
    const r = buildMailRequest('resend', msg);
    expect(r.url).toBe('https://api.resend.com/emails');
    expect(r.init.headers.Authorization).toBe('Bearer K');
    expect(JSON.parse(r.init.body)).toMatchObject({ from: 'Gita <hello@x.com>', to: ['a@y.com'], subject: 'S', text: 'hi' });
    const b = buildMailRequest('brevo', { ...msg, attachments: [{ filename: 'a.xlsx', content: Buffer.from('xy') }] });
    expect(b.init.headers['api-key']).toBe('K');
    expect(JSON.parse(b.init.body)).toMatchObject({ sender: { email: 'hello@x.com', name: 'Gita' }, to: [{ email: 'a@y.com' }], attachment: [{ name: 'a.xlsx', content: 'eHk=' }] });
    expect(buildMailRequest('sendgrid', msg).init.headers.Authorization).toBe('Bearer K');
    expect(buildMailRequest('postmark', msg).init.headers['X-Postmark-Server-Token']).toBe('K');
    expect(buildMailRequest('smtp2go', msg).init.headers['X-Smtp2go-Api-Key']).toBe('K');
    expect(() => buildMailRequest('smtp', msg)).toThrow();
  });
  it('reads failures, including the ones inside a 200', () => {
    expect(readMailResponse('resend', 200, '{"id":"m1"}')).toBeNull();
    expect(readMailResponse('resend', 403, '{"message":"domain not verified"}')).toBe('Resend said 403: domain not verified');
    expect(readMailResponse('postmark', 200, '{"ErrorCode":400,"Message":"Sender not confirmed"}')).toBe('Postmark error 400: Sender not confirmed');
    expect(readMailResponse('smtp2go', 200, '{"data":{"succeeded":0}}')).toContain('sent nothing');
    expect(messageIdOf('{"id":"m1"}')).toBe('m1');
  });
});

describe('createMailProvider', () => {
  const answer = (status, body) => vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
  it('sends over HTTP and records the success', async () => {
    const l = log(); const onResult = vi.fn(); const request = answer(200, { id: 'm1' });
    const r = await createMailProvider(resend, l, onResult, request).send({ to: 'a@y.com', subject: 'S', text: 'hi' });
    expect(r).toEqual({ ok: true, id: 'm1' });
    expect(request.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(l.info.mock.calls[0][0]).toMatchObject({ via: 'Resend', to_domain: 'y.com' });
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: true, domain: 'y.com' });
  });
  it('logs, records and throws a provider error', async () => {
    const l = log(); const onResult = vi.fn();
    await expect(createMailProvider(resend, l, onResult, answer(401, { message: 'API key is invalid' })).send({ to: 'a@y.com', subject: 'S' }))
      .rejects.toThrow('Resend said 401: API key is invalid');
    expect(l.error).toHaveBeenCalled();
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: false, error: 'Resend said 401: API key is invalid' });
  });
  it('throws a plain reason when the key is missing but a From is set', async () => {
    await expect(createMailProvider({ ...resend, apiKey: '' }, log(), vi.fn()).send({ to: 'a@y.com', subject: 'S' }))
      .rejects.toThrow('Resend not configured: set Resend API key on Settings');
  });
  it('skips with a warning when nothing is set at all', async () => {
    const l = log(); const onResult = vi.fn();
    const r = await createMailProvider({ provider: 'resend', smtp: {} }, l, onResult).send({ to: 'a@x.com', subject: 'S' });
    expect(r.ok).toBe(false);
    expect(l.warn.mock.calls[0][1]).toContain('Resend API key');
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: false, skipped: true, domain: 'x.com' });
  });
  it('SMTP host and user without a password throws the plain reason', async () => {
    await expect(createMailProvider(smtpMail({ ...full, pass: '' }), log(), vi.fn()).send({ to: 'a@x.com', subject: 'S' }))
      .rejects.toThrow('SMTP password (app password)');
  });
  it('skip() records a missing recipient', async () => {
    const l = log(); const onResult = vi.fn();
    await createMailProvider(resend, l, onResult).skip({ subject: 'S', reason: 'no recipient' });
    expect(l.warn).toHaveBeenCalled();
    expect(onResult.mock.calls[0][0]).toMatchObject({ skipped: true, error: 'no recipient' });
  });
});
