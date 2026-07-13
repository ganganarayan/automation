/**
 * AI image factory.
 *
 * Purpose:      For each Ready row in the factory sheet, generate the image with
 *               BOTH OpenAI and Gemini, overlay the hook as real text, and save
 *               PNGs to two Drive folders.
 * Responsibility: run: read Ready rows, generate + overlay + save both variants,
 *               mark the row Done.
 * Dependencies: providers (sheets, llm, storage), imageComposer, wrap util,
 *               tenantSettings.
 */
import { buildProviders } from './providerFactory.js';
import { factoryCaptionBar } from './imageComposer.js';
import { wrapHook } from '../utils/wrap.js';
import { childLogger } from '../core/logger.js';

const SHEET_TAB = 'Sheet1';

export async function run({ tenantId = 'default' }) {
  const log = childLogger({ module: 'imageFactory', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  if (!resolved.sheets.factory) {
    log.warn('FACTORY_SHEET_ID not configured; skipping');
    return { processed: 0 };
  }

  const rows = await providers.sheets.readTab(resolved.sheets.factory, SHEET_TAB, { fresh: true });
  if (rows.length < 2) return { processed: 0 };
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);

  let processed = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (String(r[col('status')] ?? '').trim().toLowerCase() !== 'ready') continue;

    const id = r[col('id')] || `${i}`;
    const hook = r[col('hook')] || '';
    const prompt = r[col('image_prompt')] || '';
    const rowNumber = i + 1;

    try {
      const wrapped = wrapHook(hook);
      const name = `${id} - ${hook}`.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120) + '.png';

      // OpenAI variant
      const gpt = await providers.llm.generateImage({ prompt, size: '1024x1024' });
      const gptFinal = await factoryCaptionBar(gpt, wrapped.lines, wrapped.fontSize);
      await providers.storage.uploadPng(resolved.drive.factoryGptFolder, name, gptFinal);

      // Gemini variant
      const gem = await providers.llm.generateImageGemini({ prompt });
      const gemFinal = await factoryCaptionBar(gem, wrapped.lines, wrapped.fontSize);
      await providers.storage.uploadPng(resolved.drive.factoryGeminiFolder, name, gemFinal);

      // Mark Done.
      const statusCol = colLetter(col('status'));
      const doneCol = colLetter(col('done_at'));
      if (statusCol) await providers.sheets.updateCells(resolved.sheets.factory, `${SHEET_TAB}!${statusCol}${rowNumber}`, [['Done']]);
      if (doneCol) await providers.sheets.updateCells(resolved.sheets.factory, `${SHEET_TAB}!${doneCol}${rowNumber}`, [[new Date().toISOString()]]);
      processed += 1;
      log.info({ id }, 'factory row processed');
    } catch (err) {
      log.warn({ id, err: err.message }, 'factory row failed (continuing)');
    }
  }
  log.info({ processed }, 'image factory run complete');
  return { processed };
}

function colLetter(index0) {
  if (index0 < 0) return null;
  let n = index0;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export default { run };
