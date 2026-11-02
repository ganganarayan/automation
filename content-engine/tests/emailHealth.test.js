import { describe, it, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { smtpMissing, recipientDomain, sendRecord, parseRecord, healthLines } from '../src/utils/emailHealth.js';
import { createSmtpMailProvider } from '../src/providers/mailProvider.js';

// Same output as formatIst (utils/time), which needs the app env to import.
const fmt = (iso) => DateTime.fromISO(iso).setZone('Asia/Kolkata').toFormat('dd-MM-yyyy HH:mm');
const full = { host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: 'app-pass' };
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('smtpMissing', () => {
  it('names each empty setting by its Settings label', () => {
    expect(smtpMissing(full)).toEqual([]);
    expect(smtpMissing({ ...full, pass: '' })).toEqual(['SMTP password (app password)']);
    expect(smtpMissing({})).toEqual(['SMTP host', 'SMTP user', 'SMTP password (app password)']);
    expect(smtpMissing({ ...full, host: '  ' })).toEqual(['SMTP host']);
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
  it('flags missing SMTP fields and no attempts yet', () => {
    const lines = healthLines({ smtp: { ...full, pass: '' }, last: null, lastError: null, fmt });
    expect(lines[0].dot).toBe('🔴');
    expect(lines[0].text).toContain('SMTP password (app password)');
    expect(lines[1].dot).toBe('🟡');
  });
  it('shows the last send in DD-MM-YYYY HH:MM IST', () => {
    const last = sendRecord({ ok: true, subject: 'Approve', to: 'a@x.com', at: new Date('2026-11-02T10:30:00Z') });
    const lines = healthLines({ smtp: full, last, lastError: null, fmt });
    expect(lines[1]).toEqual({ dot: '🟢', text: 'Last send 02-11-2026 16:00 IST: sent "Approve" to @x.com' });
  });
  it('shows an older error separately, not twice when it is the last send', () => {
    const err = sendRecord({ ok: false, subject: 'A', to: 'a@x.com', error: 'auth', at: new Date('2026-11-01T10:30:00Z') });
    const ok = sendRecord({ ok: true, subject: 'B', to: 'a@x.com', at: new Date('2026-11-02T10:30:00Z') });
    expect(healthLines({ smtp: full, last: ok, lastError: err, fmt })[2].text).toBe('Last error 01-11-2026 16:00 IST: auth');
    expect(healthLines({ smtp: full, last: err, lastError: err, fmt })).toHaveLength(2);
  });
});

describe('createSmtpMailProvider', () => {
  it('skips with a warning naming the missing setting when host/user are empty', async () => {
    const l = log(); const onResult = vi.fn();
    const r = await createSmtpMailProvider({}, l, onResult).send({ to: 'a@x.com', subject: 'S' });
    expect(r.ok).toBe(false);
    expect(l.warn.mock.calls[0][1]).toContain('SMTP host');
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: false, skipped: true, domain: 'x.com' });
  });
  it('throws a plain reason when only the password is missing', async () => {
    const l = log(); const onResult = vi.fn();
    await expect(createSmtpMailProvider({ ...full, pass: '' }, l, onResult).send({ to: 'a@x.com', subject: 'S' }))
      .rejects.toThrow('SMTP password (app password)');
    expect(l.error).toHaveBeenCalled();
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: false, skipped: false });
  });
  it('skip() records a missing recipient', async () => {
    const l = log(); const onResult = vi.fn();
    await createSmtpMailProvider(full, l, onResult).skip({ subject: 'S', reason: 'no recipient' });
    expect(l.warn).toHaveBeenCalled();
    expect(onResult.mock.calls[0][0]).toMatchObject({ skipped: true, error: 'no recipient' });
  });
});
