import { describe, it, expect } from 'vitest';
import { classifyOpenAiModels, classifyGeminiModels, buildCatalog } from '../src/utils/modelCatalog.js';

describe('classifyOpenAiModels', () => {
  const ids = ['gpt-image-2', 'dall-e-3', 'gpt-5-mini', 'gpt-5', 'o3', 'text-embedding-3-small',
    'whisper-1', 'tts-1', 'omni-moderation-latest', 'gpt-4o-realtime-preview'];
  it('splits image models from text models', () => {
    const { image, text } = classifyOpenAiModels(ids);
    expect(image).toContain('gpt-image-2');
    expect(image).toContain('dall-e-3');
    expect(text).toEqual(expect.arrayContaining(['gpt-5', 'gpt-5-mini', 'o3']));
  });
  it('drops embeddings, audio and moderation from both lists', () => {
    const { image, text } = classifyOpenAiModels(ids);
    for (const junk of ['text-embedding-3-small', 'whisper-1', 'tts-1', 'omni-moderation-latest', 'gpt-4o-realtime-preview']) {
      expect(image).not.toContain(junk);
      expect(text).not.toContain(junk);
    }
  });
  it('de-dupes and tolerates junk', () => {
    expect(classifyOpenAiModels(['gpt-5', 'gpt-5']).text).toEqual(['gpt-5']);
    expect(classifyOpenAiModels(null)).toEqual({ image: [], text: [] });
  });
});

describe('classifyGeminiModels', () => {
  const models = [
    { name: 'models/gemini-3.1-flash-image' },
    { name: 'models/gemini-3.1-flash' },
    { name: 'models/gemini-3.1-pro' },
    { name: 'models/text-embedding-004' },
    { name: 'models/aqa' },
  ];
  it('keeps the full models/ prefix and splits image vs text', () => {
    const { image, text } = classifyGeminiModels(models);
    expect(image).toEqual(['models/gemini-3.1-flash-image']);
    expect(text).toEqual(expect.arrayContaining(['models/gemini-3.1-flash', 'models/gemini-3.1-pro']));
    expect(text).not.toContain('models/text-embedding-004');
    expect(text).not.toContain('models/aqa');
  });
  it('accepts plain name strings too', () => {
    expect(classifyGeminiModels(['models/gemini-3.1-flash-image']).image).toHaveLength(1);
  });
});

describe('buildCatalog', () => {
  it('only touches the provider it was given, and stamps the refresh time', () => {
    const at = new Date('2026-10-29T10:00:00Z');
    const c = buildCatalog({ openaiIds: ['gpt-5', 'gpt-image-2'] }, at);
    expect(c.openai_text).toContain('gpt-5');
    expect(c.openai_image).toContain('gpt-image-2');
    expect(c.gemini_image).toBeUndefined(); // untouched -> caller merges
    expect(c.refreshedAt).toBe(at.toISOString());
  });
});
