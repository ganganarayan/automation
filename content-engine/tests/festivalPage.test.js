import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/festivalService.js', () => ({
  MAX_BYTES: 15 * 1024 * 1024,
  MAX_COPY: 2000,
  start: vi.fn(async () => ({ batchId: 'b', started: ['Gita'], skipped: [] })),
  voiceList: vi.fn(async () => [{ voice_id: 'v1abcdefgh', name: 'Ann', category: 'cloned', preview_url: 'https://x/p.mp3' }]),
  musicList: vi.fn(async () => [{ url: 'https://drive.google.com/uc?export=download&id=abc', credit: 'Diya by Asha, CC BY', name: 'diya.mp3' }, { url: 'https://drive.google.com/uc?export=download&id=def', credit: 't', name: 'Om Chant.mp3' }]),
  funnelReadiness: vi.fn(async () => [
    { id: 1, name: 'HNI Parents', active: true, problem: '' },
    { id: 2, name: 'No Voice', active: true, problem: 'no voice chosen for this funnel', voiceOnly: true },
    { id: 3, name: 'No Accounts', active: true, problem: 'no Post for Me accounts ticked on this funnel' },
  ]),
  batches: vi.fn(async () => [{
    batchId: 'b1', title: 'Happy Diwali', copy: 'Light & joy', thumbUrl: '', createdAt: '2026-11-08T02:30:00Z',
    rows: [{ id: 'i1', funnelName: 'HNI Parents', status: 'image_review', approvalId: 'a1', autoPost: false, videoUrl: 'https://x/v' }],
  }]),
}));
vi.mock('../src/services/accessService.js', () => ({ keyOk: vi.fn(async () => true), currentSession: vi.fn(async () => null) }));
vi.mock('../src/utils/time.js', () => ({
  formatIst: (v) => String(v),
  nowIst: () => ({ plus: () => ({ toFormat: () => '2026-11-08T08:00' }) }),
}));
vi.mock('../src/utils/retrySpec.js', () => ({ parseRetryDate: vi.fn() }));

const { register } = await import('../src/modules/festival.js');

async function renderPage() {
  const routes = {};
  const router = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  register({ router, log: { info: vi.fn(), warn: vi.fn() } });
  let html = '';
  const res = { set: () => res, type: () => res, send: (h) => { html = h; }, redirect: vi.fn() };
  await routes['GET /admin/festival']({ tenantId: 'default', originalUrl: '/x' }, res, (e) => { throw e; });
  return { html, routes };
}

describe('festival page', () => {
  it('registers its routes, the photo compose included', async () => {
    const { routes } = await renderPage();
    expect(Object.keys(routes)).toEqual(expect.arrayContaining(['POST /admin/festival/upload', 'POST /admin/festival/compose', 'POST /admin/festival', 'POST /admin/festival/approve-all']));
  });
  it('renders the form, the funnels with their state, and a waiting batch', async () => {
    const { html } = await renderPage();
    expect(html).toContain('Your photo on it');
    expect(html).toContain('🟢 HNI Parents');
    expect(html).toContain('🟡 No Voice');
    expect(html).toContain('data-voiceonly="1"');
    expect(html).toContain('🔴 No Accounts');
    expect(html).toContain("Each funnel's own voice");
    expect(html).toContain('Ann (cloned)');
    expect(html).toContain('Approve all 1 waiting');
    expect(html).toContain('Light &amp; joy');
    expect(html).toContain('🔇 None: voice only');
    expect(html).toContain('🎵 diya<');
    expect(html).toContain('🎵 Om Chant<');
  });
  it('ships a browser script that parses', async () => {
    const { html } = await renderPage();
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('starting a festival post', () => {
  it('passes the music and voice choices through to the service', async () => {
    const svc = await import('../src/services/festivalService.js');
    const { routes } = await renderPage();
    let out = null;
    const res = { status: () => res, json: (j) => { out = j; } };
    await routes['POST /admin/festival']({ tenantId: 'default', body: {
      title: 'Happy Diwali', copy: 'Hi', imageUrl: 'https://x/a.png', funnelIds: ['1'], autoPost: false,
      music: 'none', musicCredit: '', voiceId: 'v1abcdefgh',
    } }, res);
    expect(out.ok).toBe(true);
    expect(svc.start).toHaveBeenCalledWith(expect.objectContaining({ music: 'none', voiceId: 'v1abcdefgh', autoPost: false }));
  });
});
