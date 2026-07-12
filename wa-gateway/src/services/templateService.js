/**
 * Template service.
 *
 * Purpose:      Resolve a WhatsApp message from the "WA Msg Templates" sheet for
 *               a CRM relay event and produce the final substituted text.
 * Responsibility:
 *               - Match a row by event_type (spaces->underscores) + Day + active.
 *               - Substitute {{name}}, {{email}}, and [link] (result_link wins
 *                 over the sheet's own link column).
 * Dependencies: SheetsProvider, text utils.
 *
 * The sheet is expected to have a header row; column matching is case- and
 * space-insensitive so minor sheet edits don't break lookups.
 */
import { substituteTemplate } from '../utils/text.js';

const normKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '_');
const normEvent = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Build a message from the templates sheet.
 * @param {object} deps - { sheets: SheetsProvider, sheetId, tab }
 * @param {object} event - { event_type, day_step, name, email, result_link }
 * @returns {Promise<string|null>} final message text, or null if no match/empty
 */
export async function buildMessage({ sheets, sheetId, tab }, event) {
  if (!sheetId) return null;
  const rows = await sheets.readTab(sheetId, tab);
  if (!rows || rows.length < 2) return null;

  const header = rows[0].map(normKey);
  const idx = (name) => header.indexOf(name);

  const iEvent = idx('event_type');
  const iDay = idx('day');
  const iActive = idx('active');
  const iMessage = idx('message');
  const iLink = idx('link');

  if (iEvent === -1 || iMessage === -1) return null;

  const wantEvent = normEvent(event.event_type);
  const wantDay = event.day_step !== undefined && event.day_step !== null && `${event.day_step}` !== ''
    ? String(event.day_step).trim()
    : null;

  const match = rows.slice(1).find((r) => {
    const rowEvent = normEvent(r[iEvent]);
    if (rowEvent !== wantEvent) return false;
    if (iActive !== -1 && normKey(r[iActive]) !== 'yes') return false;
    if (wantDay !== null && iDay !== -1) {
      if (String(r[iDay] ?? '').trim() !== wantDay) return false;
    }
    return true;
  });

  if (!match) return null;

  const template = match[iMessage] || '';
  const sheetLink = iLink !== -1 ? match[iLink] || '' : '';
  const link = event.result_link || sheetLink;

  const message = substituteTemplate(template, {
    name: event.name || '',
    email: event.email || '',
    link,
  });

  return message && message.trim() ? message.trim() : null;
}

export default { buildMessage };
