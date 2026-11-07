import { describe, it, expect, vi } from 'vitest';
import { createClaudeProvider, claudeSystem, DEFAULT_CLAUDE_MODEL } from '../src/providers/claudeProvider.js';
import { COPY_SCHEMA, DEFAULT_COPY_PROMPT, copySystemPrompt, copyUserPrompt, normalizeCopy } from '../src/utils/aiCopySpec.js';
import { thumbImagePrompt, THUMB_LAYOUT_ONLY, DEFAULT_THUMB_RULES } from '../src/utils/thumbSpec.js';
import { costClaude } from '../src/utils/pricing.js';

/** A stand-in for the SDK client; records what it was sent. */
function fakeClient(reply) {
  const stream = vi.fn(() => ({ finalMessage: async () => reply }));
  return { beta: { messages: { stream } }, stream };
}
const good = (o = {}) => ({
  model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ title: 'T', thumbPrompt: 'A prompt' }) }],
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }, ...o,
});

describe('claudeProvider', () => {
  it('sends the model, schema, background and transcript, and reads the text block', async () => {
    const c = fakeClient(good());
    const p = createClaudeProvider({ apiKey: 'k', model: 'claude-opus-5', context: 'I sell to founders.', globalSystem: 'House rules.' }, null, c);
    const out = await p.generateJsonDetailed({ system: 'Write copy.', user: 'Transcript: hi', schema: COPY_SCHEMA });
    const req = c.stream.mock.calls[0][0];
    expect(req.model).toBe('claude-opus-5');
    expect(req.fallbacks).toBe('default');
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: COPY_SCHEMA } });
    expect(req.messages).toEqual([{ role: 'user', content: 'Transcript: hi' }]);
    expect(req.system[0].text).toContain('I sell to founders.');
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.system[1].text).toBe('Write copy.');
    expect(out.data).toEqual({ title: 'T', thumbPrompt: 'A prompt' });
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 10 });
  });
  it('defaults to Opus 5, the model the owner named', async () => {
    const c = fakeClient(good());
    await createClaudeProvider({ apiKey: 'k' }, null, c).generateJsonDetailed({ system: 's', user: 'u' });
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5');
    expect(c.stream.mock.calls[0][0].model).toBe('claude-opus-5');
  });
  it('reports the model that really answered, for the cost', async () => {
    const c = fakeClient(good({ model: 'claude-opus-5-5' }));
    const out = await createClaudeProvider({ apiKey: 'k' }, null, c).generateJsonDetailed({ system: 's', user: 'u' });
    expect(out.model).toBe('claude-opus-5-5');
  });
  it('stops with a clear error on a refusal, a cut-off answer or bad JSON', async () => {
    const run = (reply) => createClaudeProvider({ apiKey: 'k' }, null, fakeClient(reply)).generateJsonDetailed({ system: 's', user: 'u' });
    await expect(run(good({ stop_reason: 'refusal', stop_details: { explanation: 'no' } }))).rejects.toThrow(/declined this video: no/);
    await expect(run(good({ stop_reason: 'max_tokens' }))).rejects.toThrow(/ran out of room/);
    await expect(run(good({ content: [{ type: 'text', text: 'not json' }] }))).rejects.toThrow(/invalid JSON/);
  });
  it('a failed call says it was Claude', async () => {
    const client = { beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('overloaded'); } }) } } };
    await expect(createClaudeProvider({ apiKey: 'k' }, null, client).generateJsonDetailed({ system: 's', user: 'u' })).rejects.toThrow('Claude: overloaded');
  });
  it('no background and no house rules: only the call\'s own instructions, nothing cached', () => {
    const blocks = claudeSystem({ system: 'Write copy.' });
    expect(blocks).toEqual([{ type: 'text', text: 'Write copy.' }]);
  });
});

describe('the image prompt is Claude\'s own', () => {
  it('drops the fixed literal-chart recipe from the copy prompt', () => {
    const free = copySystemPrompt({ freePrompt: true });
    expect(free).not.toMatch(/retention line chart/);
    expect(free).not.toMatch(/one literal visual/);
    expect(free).toMatch(/the owner asked you directly/);
    expect(free).toMatch(/same one point/);
    expect(free).toContain('"thumbTag"');
  });
  it('OpenAI keeps the old instructions, word for word', () => {
    const old = copySystemPrompt({});
    expect(old).toMatch(/retention line chart/);
    expect(old).toMatch(/one literal visual/);
    expect(old).not.toMatch(/the owner asked you directly/);
  });
  it('a default prompt saved in Settings counts as the default; one you changed stays', () => {
    expect(copySystemPrompt({ freePrompt: true, base: DEFAULT_COPY_PROMPT })).toMatch(/the owner asked you directly/);
    const mine = copySystemPrompt({ freePrompt: true, base: 'My own rules.' });
    expect(mine).toContain('My own rules.');
    expect(mine).not.toMatch(/the owner asked you directly/);
  });
  it('reaches the image model as written, with only the layout note', () => {
    const out = thumbImagePrompt('A worn compass on a map, warm morning light', '', 'Find your way', { asWritten: true });
    expect(out).toBe(`A worn compass on a map, warm morning light\n\n${THUMB_LAYOUT_ONLY}`);
    expect(thumbImagePrompt('X', DEFAULT_THUMB_RULES, 'H', { asWritten: true })).toBe(`X\n\n${THUMB_LAYOUT_ONLY}`);
  });
  it('rules you changed yourself still apply', () => {
    expect(thumbImagePrompt('X', 'Always blue.', 'H', { asWritten: true })).toBe('X\n\nAlways blue.');
  });
  it('the old path is unchanged without asWritten', () => {
    const out = thumbImagePrompt('X', '', 'Hook');
    expect(out).toContain('The headline going over this image is "Hook"');
    expect(out).toContain(DEFAULT_THUMB_RULES);
  });
  it('a long prompt survives whole', () => {
    const long = 'word '.repeat(700).trim(); // 3499 characters
    expect(normalizeCopy({ thumbPrompt: long }).thumbPrompt).toBe(long);
    expect(thumbImagePrompt(long, '', '', { asWritten: true })).toContain(long);
  });
});

describe('the rest of the call', () => {
  it('the schema covers every key normalizeCopy reads, all required', () => {
    expect(COPY_SCHEMA.required.sort()).toEqual(Object.keys(normalizeCopy({})).sort());
    expect(COPY_SCHEMA.additionalProperties).toBe(false);
  });
  it('a long transcript goes whole when asked; the default cut stays', () => {
    const t = 'a'.repeat(30000);
    expect(copyUserPrompt({ transcript: t, fileName: 'a.mp4', limit: 200000 })).toContain(t);
    expect(copyUserPrompt({ transcript: t, fileName: 'a.mp4' })).not.toContain(t);
  });
  it('costs tokens at the real prices, cache apart', () => {
    const c = costClaude({ inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 1000000, model: 'claude-opus-5' });
    expect(c.costUsd).toBe(36.75); // 5 + 25 + 0.5 + 6.25
    expect(c.provider).toBe('anthropic');
    expect(costClaude({ inputTokens: 1000000, model: 'claude-opus-5-5' }).costUsd).toBe(4);
    expect(costClaude({ inputTokens: 1000000, model: 'unknown' }).costUsd).toBe(5);
  });
});
