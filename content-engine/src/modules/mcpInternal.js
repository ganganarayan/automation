/**
 * Module: the internal MCP endpoint.
 *
 * Purpose:      Streamable HTTP MCP at POST /mcp-internal for the gateway only.
 *               Not public: X-Service-Secret must equal env GATEWAY_SERVICE_SECRET,
 *               and X-User-Email must belong to an account here ("no_account"
 *               otherwise). Every tool then works inside that account's workspace.
 * Responsibility: HTTP + MCP wiring and the tool catalogue (names, descriptions,
 *               input schemas, readOnlyHint / destructiveHint). The tool bodies
 *               live in services/mcpToolsService.js.
 * Dependencies: @modelcontextprotocol/sdk, zod, middleware/serviceSecret,
 *               services/mcpToolsService, core/jobRunner.
 *
 * Stateless: a fresh server and transport per request (no MCP session ids), JSON
 * responses (no SSE stream), so it survives Railway sleeping between calls.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { requireServiceSecret, resolveAccount, rpcError } from '../middleware/serviceSecret.js';
import * as tools from '../services/mcpToolsService.js';
import * as jobRunner from '../core/jobRunner.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'mcpInternal' });
export const PATH = '/mcp-internal';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const platform = z.enum(tools.PLATFORMS);
const postId = z.string().min(1).describe('post_id from list_queue or schedule_post');
const confirm = z.boolean().optional().describe('true to act; omitted or false returns a preview only');
const time = z.string().optional().describe('ISO-8601 with offset, e.g. 2026-11-20T18:30:00+05:30, or "now"');

/** The catalogue: [name, description, annotations, input shape, handler]. */
export const TOOLS = [
  ['get_entitlement', 'Is this workspace\'s plan active, and which plan it is. Returns {active, plan, reason?, expires_ist}.', READ, {}, tools.getEntitlement],
  ['connection_status', 'Which social platforms are connected (with account names), which are not, and the workspace\'s funnels (funnel_id is needed by create_video, generate_thumbnail and sheet-row posts).', READ, {}, tools.connectionStatus],
  ['get_connect_link', 'A URL the user opens to connect one platform. They sign in on the platform; tokens stay on the server.', { ...READ, openWorldHint: true }, { platform }, tools.getConnectLink],
  ['list_queue', 'Posts waiting or in progress (scheduled, in review, running, draft, failed), newest first. Optional status filter, limit up to 50.', READ,
    { status: z.string().optional().describe('one status, e.g. scheduled, posted, failed'), limit: z.number().int().min(1).max(50).optional() }, tools.listQueue],
  ['get_post', 'One post: status, caption, media, channels and times.', READ, { post_id: postId }, tools.getPost],
  ['schedule_post', 'Schedule a post. Give media_url + caption + platforms, or sheet_row (a row of a funnel\'s content sheet; caption and channels then come from the funnel). Without confirm=true it only returns a preview of what would be scheduled.', WRITE, {
    media_url: z.string().url().optional().describe('public https URL of the image or video'),
    sheet_row: z.object({ funnel_id: z.string(), row_key: z.string().optional().describe('the row\'s key; omit for the next Ready row') }).optional(),
    caption: z.string().max(5000).optional(),
    platforms: z.array(platform).optional().describe('connected platforms to post to (media_url only)'),
    time,
    confirm,
  }, tools.schedulePost],
  ['edit_post', 'Change the caption and/or time of a scheduled post (not one already published). Without confirm=true it only returns a preview of the change.', DESTRUCTIVE,
    { post_id: postId, caption: z.string().max(5000).optional(), time, confirm }, tools.editPost],
  ['cancel_post', 'Cancel a scheduled post: removed from the publishing queue, kept as a draft in the app. Without confirm=true it only returns a preview.', DESTRUCTIVE,
    { post_id: postId, confirm }, tools.cancelPost],
  ['generate_thumbnail', 'Start making thumbnails for a ready video in a funnel\'s Drive folder (one per platform size). Returns job_id; poll get_job_status.', WRITE, {
    funnel_id: z.string(), drive_id: z.string().describe('Drive file id of the video'),
    headline: z.string().max(80).optional(), subhead: z.string().max(120).optional(), audience: z.string().max(40).optional(), image_prompt: z.string().max(1000).optional(),
  }, tools.generateThumbnail],
  ['create_video', 'Start an AI video for a funnel from a topic prompt. model picks the animation provider tried first. The script then waits for approval in the app. Returns job_id; poll get_job_status.', WRITE, {
    funnel_id: z.string(), prompt: z.string().min(3).max(300), model: z.enum(tools.VIDEO_MODELS).optional(), time,
  }, tools.createVideo],
  ['get_job_status', 'Status of a generate_thumbnail, create_video or sheet-row schedule_post job: pending, running, done or failed, with its result.', READ,
    { job_id: z.string() }, tools.getJobStatus],
  ['get_post_results', 'Per platform: published or failed, the live link, and reach, views, likes, comments and shares (null where the platform does not report one).', { ...READ, openWorldHint: true },
    { post_id: postId }, tools.getPostResults],
];

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

/** One MCP server bound to one caller's workspace. */
export function buildServer(account) {
  const server = new McpServer({ name: 'content-engine-internal', version: '1.0.0' });
  for (const [name, description, annotations, inputSchema, fn] of TOOLS) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        return text(await fn(account, args || {}));
      } catch (err) {
        const code = err instanceof tools.ToolError ? err.code : 'failed';
        if (code === 'failed') log.warn({ tool: name, tenant: account.tenantId, err: err.message }, 'mcp tool failed');
        return { ...text({ error: code, message: String(err.message || err).slice(0, 300) }), isError: true };
      }
    });
  }
  return server;
}

export async function handle(req, res, next) {
  const server = buildServer(req.mcpAccount);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) return res.status(500).json(rpcError(req, -32603, 'internal error'));
    next(err);
  }
}

/** Mount on the app root (outside /api/v1). Options are for tests. */
export function mount(app, { getSecret, findByEmail } = {}) {
  const guard = [requireServiceSecret(getSecret), resolveAccount(findByEmail)];
  app.post(PATH, ...guard, handle);
  // Stateless: no SSE stream to open and no session to end.
  app.all(PATH, requireServiceSecret(getSecret), (req, res) => res.status(405).set('Allow', 'POST').json(rpcError(req, -32000, 'method not allowed')));
  jobRunner.registerHandler(tools.JOB_TYPES.thumbnail, tools.runThumbnailJob, { maxAttempts: 1 });
  jobRunner.registerHandler(tools.JOB_TYPES.video, tools.runVideoJob, { maxAttempts: 1 });
  jobRunner.registerHandler(tools.JOB_TYPES.sheetPost, tools.runSheetPostJob, { maxAttempts: 1 });
}

export default { mount, buildServer, TOOLS, PATH };
