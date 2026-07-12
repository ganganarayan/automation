/**
 * Module: Delay Relay.
 *
 * Purpose:      Lead intake (webhook + CSV upload), validation, and the daily
 *               ramped drip cron.
 * Responsibility: HTTP + cron wiring; delegates validation to the contact
 *               validator and sending to relayService.
 * Dependencies: contactQueueRepository, relayControlRepository, contactValidator,
 *               relayService, SheetsProvider, node-cron, csv-parse, db.
 *
 * Routes:
 *   POST /api/v1/webhook/delay-relay-:account   (sthira|vidapulse|divineleads)
 *   GET  /api/v1/upload                         (HTML form)
 *   POST /api/v1/upload                         (CSV bulk intake)
 */
import cron from 'node-cron';
import { parse as parseCsv } from 'csv-parse/sync';
import * as contactQueue from '../repositories/contactQueueRepository.js';
import * as relayControl from '../repositories/relayControlRepository.js';
import { validateContact } from '../validators/contactValidator.js';
import { runAll } from '../services/relayService.js';
import { withTransaction } from '../core/db.js';
import { settings } from '../settings/index.js';
import { ZONE } from '../utils/time.js';

const ACCOUNTS = ['sthira', 'vidapulse', 'divineleads'];

function pick(obj, ...names) {
  const map = {};
  for (const [k, v] of Object.entries(obj || {})) map[k.toLowerCase().replace(/\s+/g, '')] = v;
  for (const n of names) {
    const key = n.toLowerCase().replace(/\s+/g, '');
    if (map[key] !== undefined && map[key] !== '') return map[key];
  }
  return undefined;
}

function toContact(raw) {
  return {
    name: pick(raw, 'contact_name', 'name', 'fullname'),
    email: pick(raw, 'contact_email', 'email', 'mail'),
    phone: pick(raw, 'contact_phone', 'phone', 'mobile', 'number', 'whatsapp'),
  };
}

export function register(ctx) {
  const { router, providers, log } = ctx;

  // Per-account intake webhook.
  router.post('/webhook/delay-relay-:account', async (req, res, next) => {
    try {
      const account = req.params.account;
      if (!ACCOUNTS.includes(account)) {
        return res.status(404).json({ error: { code: 'not_found', message: 'unknown account' } });
      }
      await relayControl.ensure({ tenantId: req.tenantId, account });
      const contact = toContact(req.body || {});
      const v = validateContact(contact);
      const row = await contactQueue.insert({
        tenantId: req.tenantId,
        account,
        contactName: contact.name,
        contactEmail: contact.email,
        contactPhone: contact.phone,
        status: v.status,
        channels: v.channels.join(','),
        invalidReason: v.invalidReason,
      });
      res.status(202).json({ id: row.id, status: v.status, channels: v.channels });
    } catch (err) {
      next(err);
    }
  });

  // Minimal upload form.
  router.get('/upload', (_req, res) => {
    res.type('html').send(uploadForm());
  });

  // CSV bulk intake.
  router.post('/upload', async (req, res, next) => {
    try {
      const account = pick(req.body || {}, 'account');
      const csvText = pick(req.body || {}, 'csv', 'data');
      if (!ACCOUNTS.includes(account)) throw Object.assign(new Error('unknown account'), { status: 400 });
      if (!csvText) throw Object.assign(new Error('no csv provided'), { status: 400 });

      const records = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true });
      await relayControl.ensure({ tenantId: req.tenantId, account });

      const prepared = records.map((raw) => {
        const contact = toContact(raw);
        const v = validateContact(contact);
        return {
          tenantId: req.tenantId,
          account,
          contactName: contact.name,
          contactEmail: contact.email,
          contactPhone: contact.phone,
          status: v.status,
          channels: v.channels.join(','),
          invalidReason: v.invalidReason,
        };
      });

      const inserted = await withTransaction((client) => contactQueue.insertMany(client, prepared));
      res.status(202).json({ inserted, total: records.length });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: { code: 'bad_request', message: err.message } });
      next(err);
    }
  });

  // Daily ramped drip at 06:00 IST.
  cron.schedule(
    '0 6 * * *',
    () => {
      runAll({ sheets: providers.sheets }).catch((err) =>
        log.error({ err: err.message }, 'delay relay cron failed'),
      );
    },
    { timezone: ZONE },
  );
  log.info('delay relay drip scheduled for 06:00 ' + ZONE);
}

function uploadForm() {
  return `<!doctype html><meta charset="utf-8"><title>Delay Relay Upload</title>
<style>body{font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem}
label{display:block;margin:.75rem 0 .25rem}textarea{width:100%;height:12rem}
button{margin-top:1rem;padding:.6rem 1.2rem}</style>
<h1>Delay Relay — CSV intake</h1>
<form method="post" action="upload" onsubmit="return toJson(this)">
  <label>Account</label>
  <select name="account">${ACCOUNTS.map((a) => `<option>${a}</option>`).join('')}</select>
  <label>CSV (with header row: name,email,phone)</label>
  <textarea name="csv" placeholder="name,email,phone&#10;Jane,jane@example.com,9876543210"></textarea>
  <button type="submit">Upload</button>
</form>
<script>
async function toJson(f){
  const body={account:f.account.value,csv:f.csv.value};
  const r=await fetch('upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  alert(JSON.stringify(await r.json()));return false;
}
</script>`;
}

export default { register, ACCOUNTS };
