/**
 * Settings layer.
 *
 * Purpose:      The single place environment variables are read, validated, and
 *               exposed. Nothing outside this module reads `process.env`.
 * Responsibility:
 *               - Validate the environment once at import time (fail fast).
 *               - Expose configuration as namespaced, relevantly-named groups.
 *               - Provide the environment defaults the tenant-aware resolver
 *                 overlays per tenant (see core/tenantSettings.js).
 * Dependencies: zod.
 */
import { z } from 'zod';

const SERVICE_NAME = 'content-engine';

const boolFromEnv = (def) =>
  z.string().optional().transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const intFromEnv = (def) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? def : Number(v))).pipe(z.number().int());

function parseJsonEnv(raw, fallback, label) {
  if (raw === undefined || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${err.message}`);
  }
}

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: intFromEnv(8080),
  TZ: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  APP_SECRET: z.string().optional().default('dev-secret-change-me'),
  PUBLIC_BASE_URL: z.string().optional().default(''),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),

  OPENAI_API_KEY: z.string().optional().default(''),
  IMAGE_MODEL: z.string().optional().default('gpt-image-2'),
  TEXT_MODEL: z.string().optional().default('gpt-5-mini'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_IMAGE_MODEL: z.string().optional().default('models/gemini-3.1-flash-image'),

  POSTFORME_API_KEY: z.string().optional().default(''),
  PFM_GITA_ACCOUNTS: z.string().optional().default('[]'),
  PFM_VIDAPULSE_ACCOUNTS: z.string().optional().default('[]'),
  PFM_GITA_VIDEO_ACCOUNTS: z.string().optional().default('[]'),
  PFM_ACCOUNT_MAP: z.string().optional().default('{}'),

  GITA_SHEET_ID: z.string().optional().default(''),
  VIDAPULSE_SHEET_ID: z.string().optional().default(''),
  VIDEO_SHEET_ID: z.string().optional().default(''),
  FACTORY_SHEET_ID: z.string().optional().default(''),
  GITA_DRIVE_FOLDER_ID: z.string().optional().default(''),
  STRIP_FILE_ID: z.string().optional().default(''),
  VOICEOVER_FOLDER_ID: z.string().optional().default(''),
  REELS_FOLDER_ID: z.string().optional().default(''),
  FACTORY_GPT_FOLDER_ID: z.string().optional().default(''),
  FACTORY_GEMINI_FOLDER_ID: z.string().optional().default(''),

  JSON2VIDEO_API_KEY: z.string().optional().default(''),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: intFromEnv(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),
  APPROVAL_EMAIL_GITA: z.string().optional().default(''),
  APPROVAL_EMAIL_VIDAPULSE: z.string().optional().default(''),
  REPORT_EMAIL: z.string().optional().default(''),

  IG_AUTOMATION_URL: z.string().optional().default(''),
  IG_CONTACT_EMAIL: z.string().optional().default(''),
  IG_COMMENT_WEBHOOK_URL: z.string().optional().default(''),

  WA_GATEWAY_URL: z.string().optional().default(''),
  INTERNAL_API_KEY: z.string().optional().default(''),
  ADMIN_KEY: z.string().optional().default(''),

  GITA_ASSESSMENT_LINK: z.string().optional().default('https://applygita.com/assessment'),
  GITA_SIMPLE_ASSESSMENT_LINK: z
    .string()
    .optional()
    .default('https://assess.applygitawisdom.com/a/executive-emotional-stability-assessment'),

  MODULE_GITA_IMAGE_ENABLED: boolFromEnv(true),
  MODULE_VIDAPULSE_IMAGE_ENABLED: boolFromEnv(true),
  MODULE_VIDAPULSE_REFILL_ENABLED: boolFromEnv(true),
  MODULE_DELIVERY_ENABLED: boolFromEnv(true),
  MODULE_VIDEO_PIPELINE_ENABLED: boolFromEnv(false),
  MODULE_IMAGE_FACTORY_ENABLED: boolFromEnv(true),
  MODULE_DASHBOARD_ENABLED: boolFromEnv(true),
  MODULE_ADMIN_ENABLED: boolFromEnv(true),

  // Scheduler: 'internal' runs an in-process 1-minute cron (always-on host);
  // 'external' turns it off so the host can sleep and an external scheduler
  // pings POST /api/v1/jobs/run-due ~10 min before each funnel's time.
  SCHEDULER_MODE: z.string().optional().default('internal'),
});

function build(rawEnv) {
  const parsed = schema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment for ${SERVICE_NAME}:\n${issues}`);
  }
  const e = parsed.data;

  return Object.freeze({
    service: SERVICE_NAME,
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    tz: e.TZ,
    logLevel: e.LOG_LEVEL,

    database: Object.freeze({ url: e.DATABASE_URL }),

    app: Object.freeze({ secret: e.APP_SECRET, publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, '') }),

    google: Object.freeze({
      serviceAccount: e.GOOGLE_SERVICE_ACCOUNT_JSON
        ? parseJsonEnv(e.GOOGLE_SERVICE_ACCOUNT_JSON, null, 'GOOGLE_SERVICE_ACCOUNT_JSON')
        : null,
    }),

    openai: Object.freeze({ apiKey: e.OPENAI_API_KEY, imageModel: e.IMAGE_MODEL, textModel: e.TEXT_MODEL }),
    gemini: Object.freeze({ apiKey: e.GEMINI_API_KEY, imageModel: e.GEMINI_IMAGE_MODEL }),

    postforme: Object.freeze({
      apiKey: e.POSTFORME_API_KEY,
      gitaAccounts: parseJsonEnv(e.PFM_GITA_ACCOUNTS, [], 'PFM_GITA_ACCOUNTS'),
      vidapulseAccounts: parseJsonEnv(e.PFM_VIDAPULSE_ACCOUNTS, [], 'PFM_VIDAPULSE_ACCOUNTS'),
      gitaVideoAccounts: parseJsonEnv(e.PFM_GITA_VIDEO_ACCOUNTS, [], 'PFM_GITA_VIDEO_ACCOUNTS'),
      accountMap: parseJsonEnv(e.PFM_ACCOUNT_MAP, {}, 'PFM_ACCOUNT_MAP'),
    }),

    sheets: Object.freeze({
      gita: e.GITA_SHEET_ID,
      vidapulse: e.VIDAPULSE_SHEET_ID,
      video: e.VIDEO_SHEET_ID,
      factory: e.FACTORY_SHEET_ID,
    }),

    drive: Object.freeze({
      gitaFolder: e.GITA_DRIVE_FOLDER_ID,
      stripFile: e.STRIP_FILE_ID,
      voiceoverFolder: e.VOICEOVER_FOLDER_ID,
      reelsFolder: e.REELS_FOLDER_ID,
      factoryGptFolder: e.FACTORY_GPT_FOLDER_ID,
      factoryGeminiFolder: e.FACTORY_GEMINI_FOLDER_ID,
    }),

    video: Object.freeze({ json2videoApiKey: e.JSON2VIDEO_API_KEY }),

    smtp: Object.freeze({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.SMTP_FROM || e.SMTP_USER,
    }),

    emails: Object.freeze({
      approvalGita: e.APPROVAL_EMAIL_GITA,
      approvalVidapulse: e.APPROVAL_EMAIL_VIDAPULSE,
      report: e.REPORT_EMAIL,
    }),

    instagram: Object.freeze({
      automationUrl: e.IG_AUTOMATION_URL,
      contactEmail: e.IG_CONTACT_EMAIL,
      commentWebhookUrl: e.IG_COMMENT_WEBHOOK_URL,
    }),

    waGateway: Object.freeze({ url: e.WA_GATEWAY_URL.replace(/\/+$/, ''), internalKey: e.INTERNAL_API_KEY }),

    links: Object.freeze({ gitaAssessment: e.GITA_ASSESSMENT_LINK, gitaSimpleAssessment: e.GITA_SIMPLE_ASSESSMENT_LINK }),

    auth: Object.freeze({ internalApiKey: e.INTERNAL_API_KEY, adminKey: e.ADMIN_KEY }),

    schedulerInternal: e.SCHEDULER_MODE.toLowerCase() !== 'external',

    modules: Object.freeze({
      gitaImage: e.MODULE_GITA_IMAGE_ENABLED,
      vidapulseImage: e.MODULE_VIDAPULSE_IMAGE_ENABLED,
      vidapulseRefill: e.MODULE_VIDAPULSE_REFILL_ENABLED,
      delivery: e.MODULE_DELIVERY_ENABLED,
      videoPipeline: e.MODULE_VIDEO_PIPELINE_ENABLED,
      imageFactory: e.MODULE_IMAGE_FACTORY_ENABLED,
      dashboard: e.MODULE_DASHBOARD_ENABLED,
      admin: e.MODULE_ADMIN_ENABLED,
    }),
  });
}

export const settings = build(process.env);
export const buildSettings = build;
export default settings;
