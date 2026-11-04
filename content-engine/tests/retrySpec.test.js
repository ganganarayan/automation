import { describe, it, expect } from 'vitest';
import { retryAction, isStuck, RETRY_STUCK_MS } from '../src/utils/retrySpec.js';
import { parseSheetId, parseDriveFolderId, isStorageQuotaError } from '../src/utils/readyPostSpec.js';
import { isCreditError } from '../src/utils/routerSpec.js';

const script = { key: 'script', status: 'done', artifacts: { text: 'hello' } };
// 'generated' is the source type the router and the scheduler really save.
const failed = (status, extra = {}) => ({ id: 'i1', status, source_type: 'generated', ...extra });

describe('retryAction', () => {
  it('re-posts only the failed channels', () => {
    const pub = { key: 'publish', artifacts: { channels: [{ state: 'failed' }, { state: 'posted' }] } };
    expect(retryAction(failed('partial'), [pub])).toBe('channels');
    expect(retryAction(failed('failed'), [pub])).toBe('channels');
  });

  it('carries on from a failed render stage', () => {
    expect(retryAction(failed('failed'), [script, { key: 'images', status: 'failed' }])).toBe('stages');
    expect(retryAction(failed('failed'), [script, { key: 'stitch', status: 'failed' }])).toBe('stages');
  });

  it('writes the script again when there is none', () => {
    expect(retryAction(failed('failed'), [{ key: 'script', status: 'failed' }])).toBe('script');
    expect(retryAction(failed('failed'), [])).toBe('script');
  });

  it('goes back to the final review when the reel exists but posting failed', () => {
    expect(retryAction(failed('failed'), [script, { key: 'stitch', status: 'done', artifacts: { video: { driveId: 'v' } } }])).toBe('final');
  });

  it('image posts go back to approval; ready videos post from their own page', () => {
    expect(retryAction(failed('failed', { source_type: 'sheet' }), [])).toBe('image');
    expect(retryAction(failed('failed', { source_type: 'drive_folder' }), [])).toBe('open');
    expect(retryAction(failed('draft', { post_status: 'post_failed' }), [])).toBe('open');
  });

  it('covers every render stage, whichever one failed', () => {
    for (const key of ['images', 'animate', 'voiceover', 'transcript', 'stitch']) {
      expect(retryAction(failed('failed'), [script, { key, status: 'failed' }])).toBe('stages');
    }
  });

  it('offers a stuck instance once it has gone quiet, not while it works', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const old = new Date(now - RETRY_STUCK_MS - 1000).toISOString();
    const fresh = new Date(now - 60000).toISOString();
    expect(isStuck(failed('running', { updated_at: old }), now)).toBe(true);
    expect(isStuck(failed('running', { updated_at: fresh }), now)).toBe(false);
    expect(retryAction(failed('running', { updated_at: old }), [script, { key: 'animate', status: 'running' }], now)).toBe('stages');
    expect(retryAction(failed('running', { updated_at: fresh }), [script], now)).toBe('');
    expect(retryAction(failed('running', { updated_at: old, source_type: 'sheet' }), [], now)).toBe('image');
  });

  it('a manual run retries from its own page', () => {
    expect(retryAction(failed('manual'), [{ key: 'images', status: 'failed' }])).toBe('open');
    expect(retryAction(failed('manual'), [script])).toBe('');
  });

  it('offers nothing when nothing failed or it is locked', () => {
    expect(retryAction(failed('posted'), [script])).toBe('');
    expect(retryAction(failed('running'), [script])).toBe('');
    expect(retryAction(failed('failed', { locked: true }), [script])).toBe('');
    expect(retryAction(null, null)).toBe('');
  });
});

describe('pasted links', () => {
  it('reads the id out of the links seen on the funnels', () => {
    expect(parseDriveFolderId('https://drive.google.com/drive/folders/1VapkCrkdaSRXxDN4Ekp8hNk__WQTtEMS?usp=drive_link')).toBe('1VapkCrkdaSRXxDN4Ekp8hNk__WQTtEMS');
    expect(parseSheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp_qr-st/edit?gid=0#gid=0')).toBe('1AbCdEfGhIjKlMnOp_qr-st');
    expect(parseSheetId(' 1AbCdEfGhIjKlMnOp_qr-st ')).toBe('1AbCdEfGhIjKlMnOp_qr-st');
  });
});

describe('Drive storage refusal', () => {
  const msg = 'Service Accounts do not have storage quota. Leverage shared drives';
  it('is seen as storage, not as provider credit', () => {
    expect(isStorageQuotaError(msg)).toBe(true);
    expect(isCreditError(msg)).toBe(false);
    expect(isCreditError('images: This Drive folder is in a personal My Drive')).toBe(false);
    expect(isCreditError('insufficient_quota')).toBe(true);
  });
});
