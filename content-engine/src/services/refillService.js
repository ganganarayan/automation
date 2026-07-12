/**
 * VidaPulse content refill watchdog.
 *
 * Purpose:      Keep the VidaPulse content pipeline topped up: when ready rows
 *               fall to <= 5, generate exactly 30 fresh, non-repeating scripts,
 *               email them as an xlsx, and set a flag so the batch is emailed
 *               only once until the queue recovers.
 * Responsibility: run (cron 09:00 IST): count ready rows, generate, build xlsx,
 *               email, and manage the refill flag.
 * Dependencies: providers (sheets, llm, mail), exceljs, prompts, refillState.
 */
import ExcelJS from 'exceljs';
import * as tenantSettings from '../core/tenantSettings.js';
import * as refillState from '../repositories/refillStateRepository.js';
import { VIDAPULSE_SYSTEM, vidapulseDashboardPrompt } from './prompts.js';
import { childLogger } from '../core/logger.js';

const BRAND = 'vidapulse';
const SHEET_TAB = 'Sheet1';
const THRESHOLD = 5;
const BATCH = 30;

export async function run({ providers, tenantId = 'default' }) {
  const log = childLogger({ module: 'vidapulseRefill', tenant_id: tenantId });
  const resolved = await tenantSettings.forTenant(tenantId);
  if (!resolved.sheets.vidapulse) {
    log.warn('VIDAPULSE_SHEET_ID not configured; skipping');
    return;
  }

  const rows = await providers.sheets.readTab(resolved.sheets.vidapulse, SHEET_TAB, { fresh: true });
  if (rows.length < 1) return;
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const data = rows.slice(1);

  const readyCount = data.filter((r) => String(r[col('status')] ?? '').trim().toLowerCase() === 'ready').length;

  if (readyCount > THRESHOLD) {
    await refillState.set({ tenantId, brand: BRAND, value: false });
    log.info({ readyCount }, 'ready above threshold; flag reset');
    return;
  }

  const alreadySent = await refillState.get({ tenantId, brand: BRAND });
  if (alreadySent) {
    log.info('refill already sent for this drought; skipping');
    return;
  }

  // Collect existing angles so nothing repeats.
  const themeCol = col('theme');
  const headlineCol = col('headline');
  const existing = data
    .map((r) => ({ theme: r[themeCol], headline: r[headlineCol] }))
    .filter((x) => x.theme || x.headline);

  const generated = await providers.llm.generateJson({
    system: VIDAPULSE_SYSTEM,
    user:
      `Generate EXACTLY ${BATCH} brand-new VidaPulse posts as JSON ` +
      `{"posts":[{"audience","theme","headline","subheadline","caption","scene"}]}. ` +
      `Every caption MUST end with "Analyze your first video free at vidapulse.io". ` +
      `Do NOT repeat any of these existing angles: ${JSON.stringify(existing).slice(0, 6000)}`,
    maxTokens: 12000,
  });

  const posts = Array.isArray(generated.posts) ? generated.posts.slice(0, BATCH) : [];
  if (posts.length === 0) {
    log.warn('LLM returned no posts');
    return;
  }

  const maxDay = data.reduce((m, r) => Math.max(m, Number(r[col('day')]) || 0), 0);
  const newRows = posts.map((post, i) => ({
    day: maxDay + i + 1,
    format: 'image',
    audience: post.audience || '',
    theme: post.theme || '',
    headline: post.headline || '',
    subheadline: post.subheadline || '',
    image_prompt: vidapulseDashboardPrompt({
      scene: post.scene || '',
      headline: post.headline || '',
      subheadline: post.subheadline || '',
    }),
    caption: ensureCaptionCta(post.caption),
    status: 'Ready',
  }));

  const xlsx = await buildXlsx(newRows);
  await providers.mail.send({
    to: resolved.emails.report,
    subject: `VidaPulse: ${newRows.length} new scripts ready to paste`,
    text: 'Attached are the next VidaPulse scripts. Paste the rows into the VidaPulse content sheet (append below the last row).',
    attachments: [{ filename: 'VidaPulse_next_scripts.xlsx', content: xlsx }],
  });

  await refillState.set({ tenantId, brand: BRAND, value: true });
  log.info({ generated: newRows.length }, 'refill batch emailed and flag set');
}

function ensureCaptionCta(caption) {
  const cta = 'Analyze your first video free at vidapulse.io';
  const text = String(caption || '').trim();
  return text.endsWith(cta) ? text : `${text}\n\n${cta}`;
}

async function buildXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('VidaPulse');
  const columns = ['day', 'format', 'audience', 'theme', 'headline', 'subheadline', 'image_prompt', 'caption', 'status'];
  ws.addRow(columns);
  for (const r of rows) ws.addRow(columns.map((c) => r[c] ?? ''));
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export default { run };
