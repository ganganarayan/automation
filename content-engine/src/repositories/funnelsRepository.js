/**
 * funnels + funnel_config data access.
 *
 * Purpose:      Manage a tenant's funnels (brand/campaign scopes) and their
 *               per-funnel configuration, and resolve a funnel into the shape
 *               the poster needs.
 * Responsibility: The only place funnels / funnel_config SQL runs.
 * Dependencies: core/db.
 *
 * A funnel is fully self-contained: it owns its content source, publishing
 * accounts, style, and schedule. There is no env fallback at funnel level —
 * everything is set in the app.
 */
import { query } from '../core/db.js';

/**
 * The config fields a funnel form edits — the ONE template every funnel shares.
 * No image compositing/overlay: the generated image is used as-is (layout is
 * handled in the image prompt).
 */
export const FUNNEL_FIELDS = [
  { key: 'sheet_id', label: 'Content sheet ID' },
  { key: 'drive_folder_id', label: 'Drive folder ID (image uploads)' },
  { key: 'postforme_api_key', label: 'Post for Me API key', type: 'secret' },
  { key: 'postforme_accounts', label: 'Post for Me account IDs (JSON array)', type: 'json' },
  { key: 'account_map', label: 'Account map (JSON id → {platform,account_name})', type: 'json' },
  { key: 'approval_email', label: 'Approval email' },
  { key: 'cta_link', label: 'CTA / assessment link' },
  { key: 'audience_prefix', label: 'Audience prefix (caption line, optional)' },
  { key: 'generate_time', label: 'Generate/approval time (HH:mm IST)', placeholder: '22:00' },
  { key: 'generate_days', label: 'Days to run (1-7 Mon-Sun, comma-sep; blank = daily)', placeholder: 'e.g. 1,2,3' },
  { key: 'publish_time', label: 'Publish time (HH:mm IST)', placeholder: '08:02' },
  { key: 'image_size', label: 'Image size (square | portrait)', placeholder: 'square' },
  { key: 'ig_webhook_url', label: 'IG-comment webhook URL (optional)' },
];

export async function listByTenant(tenantId = 'default') {
  const { rows } = await query(
    'SELECT id, tenant_id, name, style, active, created_at FROM funnels WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return rows;
}

/** All active funnels across tenants (for the daily cron). */
export async function listActive() {
  const { rows } = await query(
    'SELECT id, tenant_id, name, style, active FROM funnels WHERE active = true ORDER BY tenant_id, name',
  );
  return rows;
}

export async function get(id) {
  const { rows } = await query('SELECT * FROM funnels WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function findByName(tenantId, name) {
  const { rows } = await query('SELECT * FROM funnels WHERE tenant_id = $1 AND name = $2', [tenantId, name]);
  return rows[0] || null;
}

export async function create({ tenantId = 'default', name }) {
  const { rows } = await query(
    `INSERT INTO funnels (tenant_id, name) VALUES ($1, $2)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING *`,
    [tenantId, name],
  );
  return rows[0] || findByName(tenantId, name);
}

export async function setActive(id, active) {
  await query('UPDATE funnels SET active = $2 WHERE id = $1', [id, !!active]);
}

export async function remove(id) {
  await query('DELETE FROM funnels WHERE id = $1', [id]);
}

export async function getConfig(id) {
  const { rows } = await query('SELECT key, value FROM funnel_config WHERE funnel_id = $1', [id]);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setConfig(id, key, value) {
  await query(
    `INSERT INTO funnel_config (funnel_id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (funnel_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [id, key, value],
  );
}

export async function delConfig(id, key) {
  await query('DELETE FROM funnel_config WHERE funnel_id = $1 AND key = $2', [id, key]);
}

/** Resolve a funnel + its config into the shape the poster consumes. */
export async function resolve(funnel) {
  const c = await getConfig(funnel.id);
  const json = (v, f) => {
    if (!v) return f;
    try {
      return JSON.parse(v);
    } catch {
      return f;
    }
  };
  return {
    id: funnel.id,
    tenantId: funnel.tenant_id,
    name: funnel.name,
    active: funnel.active,
    sheetId: c.sheet_id || '',
    driveFolder: c.drive_folder_id || '',
    postformeKey: c.postforme_api_key || '',
    accounts: json(c.postforme_accounts, []),
    accountMap: json(c.account_map, {}),
    approvalEmail: c.approval_email || '',
    ctaLink: c.cta_link || '',
    audiencePrefix: c.audience_prefix || '',
    generateTime: c.generate_time || '22:00',
    generateDays: c.generate_days || '', // '' = daily
    publishTime: c.publish_time || '08:02',
    imageSize: (c.image_size || 'square').toLowerCase() === 'portrait' ? '1024x1536' : '1024x1024',
    igWebhookUrl: c.ig_webhook_url || '',
  };
}

export default {
  FUNNEL_FIELDS,
  listByTenant, listActive, get, findByName, create, setActive, remove,
  getConfig, setConfig, delConfig, resolve,
};
