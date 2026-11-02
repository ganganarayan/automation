import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { imageSpec, mapImageSize, cropBox } from '../src/utils/imageGateSpec.js';
import { fitImage } from '../src/providers/imageFit.js';
import { WIZARD_STEPS } from '../src/services/videoWizardManifest.js';

describe('image size choices', () => {
  it('maps each choice to an OpenAI size and a crop aspect', () => {
    expect(imageSpec('story')).toEqual({ size: '1024x1536', aspect: '9:16' });
    expect(imageSpec('landscape')).toEqual({ size: '1536x1024', aspect: '16:9' });
    expect(imageSpec('square')).toEqual({ size: '1024x1024', aspect: null });
    expect(imageSpec('')).toEqual({ size: '1024x1536', aspect: null });
    expect(imageSpec('', 'square').size).toBe('1024x1024');
    expect(mapImageSize('landscape')).toBe('1536x1024');
  });

  it('offers 9:16 and 16:9 on the Lane 3 page', () => {
    const f = WIZARD_STEPS.find((s) => s.id === 'image').fields.find((x) => x.key === 'image_size');
    expect(f.options.map((o) => o.value)).toEqual(['portrait', 'story', 'square', 'landscape']);
  });
});

describe('cropBox', () => {
  it('crops 1024x1536 to 9:16 and 1536x1024 to 16:9, centred', () => {
    expect(cropBox(1024, 1536, '9:16')).toEqual({ left: 80, top: 0, width: 864, height: 1536 });
    expect(cropBox(1536, 1024, '16:9')).toEqual({ left: 0, top: 80, width: 1536, height: 864 });
  });
  it('leaves an image that already fits, or no aspect', () => {
    expect(cropBox(1080, 1920, '9:16')).toBeNull();
    expect(cropBox(1024, 1024, null)).toBeNull();
  });
});

describe('fitImage', () => {
  it('crops a generated image to 9:16', async () => {
    const png = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#336699' } }).png().toBuffer();
    const out = await fitImage(png, 'story');
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([864, 1536]);
    expect(await fitImage(png, 'portrait')).toBe(png);
  });
});
