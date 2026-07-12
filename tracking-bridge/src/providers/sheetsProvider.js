/**
 * Google Sheets provider (interface + googleapis implementation).
 *
 * Purpose:      Read content rows and write status/append rows for the posters,
 *               refill, and factory.
 * Responsibility:
 *               - readTab(sheetId, tab): string[][] with a short cache.
 *               - findRowIndex(sheetId, tab, colName, value): 1-based row number.
 *               - updateCells(sheetId, range, values): write a range.
 *               - appendRow(sheetId, tab, values): append.
 *               - upsertByKey(sheetId, tab, keyCol, rows): idempotent upsert.
 * Dependencies: googleapis, logger.
 *
 * Falls back to a no-op reader/writer when no service account is configured so
 * the service boots for local smoke tests.
 */
import { google } from 'googleapis';

const CACHE_TTL_MS = 2 * 60 * 1000;

export function createGoogleSheetsProvider(cfg, log) {
  if (!cfg.serviceAccount) {
    return {
      async readTab() {
        log.warn('Google service account not configured; returning no sheet rows');
        return [];
      },
      async findRowIndex() {
        return -1;
      },
      async updateCells() {
        log.warn('Sheets not configured; update skipped');
      },
      async appendRow() {
        log.warn('Sheets not configured; append skipped');
      },
      async upsertByKey() {
        log.warn('Sheets not configured; upsert skipped');
      },
    };
  }

  const auth = new google.auth.GoogleAuth({
    credentials: cfg.serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const api = google.sheets({ version: 'v4', auth });
  const cache = new Map();

  async function readTab(sheetId, tab, { fresh = false } = {}) {
    const key = `${sheetId}:${tab}`;
    if (!fresh) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    }
    const res = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: tab });
    const rows = res.data.values || [];
    cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '_');

  return {
    readTab,

    /** Return the 1-based sheet row index whose column `colName` equals value. */
    async findRowIndex(sheetId, tab, colName, value) {
      const rows = await readTab(sheetId, tab, { fresh: true });
      if (rows.length < 1) return -1;
      const header = rows[0].map(norm);
      const col = header.indexOf(norm(colName));
      if (col === -1) return -1;
      for (let i = 1; i < rows.length; i += 1) {
        if (String(rows[i][col] ?? '').trim() === String(value).trim()) return i + 1; // 1-based
      }
      return -1;
    },

    async updateCells(sheetId, range, values) {
      await api.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values },
      });
      cache.clear();
    },

    async appendRow(sheetId, tab, values) {
      await api.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: tab,
        valueInputOption: 'RAW',
        requestBody: { values: [values] },
      });
      cache.clear();
    },

    /**
     * Idempotent upsert keyed on a column. Existing keys are overwritten in
     * place; new keys are appended. Header row is preserved.
     */
    async upsertByKey(sheetId, tab, keyCol, incoming) {
      const rows = await readTab(sheetId, tab, { fresh: true });
      const header = rows.length ? rows[0] : Object.keys(incoming[0] || {});
      const headerNorm = header.map(norm);
      const keyIdx = headerNorm.indexOf(norm(keyCol));
      const existing = new Map();
      for (let i = 1; i < rows.length; i += 1) existing.set(String(rows[i][keyIdx] ?? ''), i);

      const toAppend = [];
      for (const obj of incoming) {
        const line = header.map((h) => obj[h] ?? obj[norm(h)] ?? '');
        const k = String(obj[keyCol] ?? obj[norm(keyCol)] ?? '');
        if (existing.has(k)) {
          const rowNumber = existing.get(k) + 1; // 1-based
          await api.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `${tab}!A${rowNumber}`,
            valueInputOption: 'RAW',
            requestBody: { values: [line] },
          });
        } else {
          toAppend.push(line);
        }
      }
      if (toAppend.length) {
        await api.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: tab,
          valueInputOption: 'RAW',
          requestBody: { values: toAppend },
        });
      }
      cache.clear();
    },
  };
}

export default { createGoogleSheetsProvider };
