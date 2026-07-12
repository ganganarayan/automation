/**
 * Image composer (sharp).
 *
 * Purpose:      Composite brand overlays and real text onto generated images so
 *               spelling is always perfect (text is drawn, not model-rendered).
 * Responsibility:
 *               - gitaBand(image, label): dark top band + centered gold label.
 *               - vidapulseStrip(image, stripPng): composite the brand strip.
 *               - factoryCaptionBar(image, lines, fontSize): bottom caption bar.
 * Dependencies: sharp, wrap util.
 */
import sharp from 'sharp';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Draw a dark band across the top and a centered gold uppercase label.
 * @param {Buffer} imageBuffer - 1024x1024 PNG
 * @param {string} label - e.g. "FOR FOUNDERS"
 */
export async function gitaBand(imageBuffer, label) {
  const width = 1024;
  const bandHeight = 128;
  const text = esc(String(label || '').toUpperCase());
  const fontSize = text.length > 26 ? 34 : text.length > 18 ? 40 : 44;
  const svg = `<svg width="${width}" height="${bandHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${bandHeight}" fill="#0B0B12" fill-opacity="0.76"/>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
      font-family="Georgia, 'Times New Roman', serif" font-weight="700"
      font-size="${fontSize}" letter-spacing="2" fill="#E7C879">${text}</text>
  </svg>`;
  return sharp(imageBuffer)
    .resize(width, width, { fit: 'cover' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Composite the VidaPulse brand strip (a PNG) at (0,0) over the generated image.
 * Validates PNG magic bytes on the strip before compositing.
 * @param {Buffer} imageBuffer
 * @param {Buffer} stripPng
 */
export async function vidapulseStrip(imageBuffer, stripPng) {
  if (!isPng(stripPng)) throw new Error('brand strip is not a valid PNG');
  return sharp(imageBuffer)
    .resize(1024, 1024, { fit: 'cover' })
    .composite([{ input: stripPng, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Draw a dark caption bar across the bottom third with real wrapped text.
 * @param {Buffer} imageBuffer - resized to 1080x1080 internally
 * @param {string[]} lines
 * @param {number} fontSize
 */
export async function factoryCaptionBar(imageBuffer, lines, fontSize) {
  const size = 1080;
  const barHeight = Math.round(size / 3);
  const barTop = size - barHeight;
  const lineHeight = Math.round(fontSize * 1.25);
  const totalTextHeight = lines.length * lineHeight;
  const firstBaseline = barTop + Math.round((barHeight - totalTextHeight) / 2) + fontSize;

  const texts = lines
    .map((line, i) => `<text x="60" y="${firstBaseline + i * lineHeight}"
      font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700"
      font-size="${fontSize}" fill="#FFFFFF">${esc(line)}</text>`)
    .join('');

  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${barTop}" width="${size}" height="${barHeight}" fill="#0B0B12" fill-opacity="0.9"/>
    ${texts}
  </svg>`;

  return sharp(imageBuffer)
    .resize(size, size, { fit: 'cover' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function isPng(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  );
}

export { isPng };
export default { gitaBand, vidapulseStrip, factoryCaptionBar, isPng };
