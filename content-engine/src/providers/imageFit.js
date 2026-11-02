/**
 * Image aspect fit.
 *
 * Purpose:      Crop a generated image (centred) to the funnel's chosen aspect,
 *               e.g. 9:16 stories and 16:9 landscape, which the image models
 *               don't make exactly (OpenAI: 1024x1536 / 1536x1024).
 * Responsibility: one sharp call; the crop math is utils/imageGateSpec.cropBox.
 * Dependencies: sharp, utils/imageGateSpec.
 */
import sharp from 'sharp';
import { imageSpec, cropBox } from '../utils/imageGateSpec.js';

/** The image cropped to the funnel image_size's aspect (unchanged when none or it fits). */
export async function fitImage(buffer, imageSize, fallback = 'portrait') {
  const { aspect } = imageSpec(imageSize, fallback);
  if (!aspect || !buffer) return buffer;
  const img = sharp(buffer);
  const { width, height } = await img.metadata();
  const box = cropBox(width, height, aspect);
  return box ? img.extract(box).png().toBuffer() : buffer;
}

export default { fitImage };
