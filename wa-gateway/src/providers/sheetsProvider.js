/**
 * Google Sheets provider (interface + googleapis implementation).
 *
 * Purpose:      Read message templates and append relay log rows.
 * Responsibility:
 *               - readTab(sheetId, tab): string[][] with a short cache.
 *               - appendRow(sheetId, tab, values): append a log row.
 * Dependencies: googleapis, settings (service account), logger.
 */
import { google } from 'googleapis';

/**
 * @typedef {object} SheetsProvider
 * @property {(sheetId: string, tab: string) => Promise<string[][]>} readTab
 * @property {(sheetId: string, tab: string, values: any[]) => Promise<void>} appendRow
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Build a Sheets provider. Falls back to a no-op reader when no service account
 * is configured (local smoke tests), returning empty data instead of throwing.
 * @param {object} cfg - { serviceAccount }
 * @param {import('pino').Logger} log
 * @returns {SheetsProvider}
 */
export function createGoogleSheetsProvider(cfg, log) {
  const cache = new Map(); // `${sheetId}:${tab}` -> { at, rows }

  if (!cfg.serviceAccount) {
    return {
      async readTab() {
        log.warn('Google service account not configured; returning no sheet rows');
        return [];
      },
      async appendRow() {
        log.warn('Google service account not configured; sheet append skipped');
      },
    };
  }

  const auth = new google.auth.GoogleAuth({
    credentials: cfg.serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheetsApi = google.sheets({ version: 'v4', auth });

  return {
    async readTab(sheetId, tab) {
      const key = `${sheetId}:${tab}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
      const res = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: tab,
      });
      const rows = res.data.values || [];
      cache.set(key, { at: Date.now(), rows });
      return rows;
    },

    async appendRow(sheetId, tab, values) {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: tab,
        valueInputOption: 'RAW',
        requestBody: { values: [values] },
      });
    },
  };
}

export default { createGoogleSheetsProvider };
