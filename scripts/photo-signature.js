import sharp from 'sharp';

export const SIGNATURE_TEXT = '© Stan Bouchet';
export const SIGNATURE_FONTS = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, Times New Roman, serif',
  script: 'Snell Roundhand, cursive',
};

export function normalizeSignature(fields = {}) {
  if (fields.signature !== 'true') return null;
  return {
    text: SIGNATURE_TEXT,
    color: /^#[0-9a-f]{6}$/i.test(fields.signature_color || '') ? fields.signature_color : '#ffffff',
    font: Object.hasOwn(SIGNATURE_FONTS, fields.signature_font) ? fields.signature_font : 'sans',
  };
}

export function signatureSvg(width, height, signature) {
  const shortest = Math.min(width, height);
  const margin = Math.max(1, Math.round(shortest * .025));
  const fontSize = Math.max(1, Math.min(36, Math.max(12, shortest * .028), (width - 2 * margin) / 20, (height - 2 * margin) / 2));
  const color = /^#[0-9a-f]{6}$/i.test(signature.color || '') ? signature.color : '#ffffff';
  const font = SIGNATURE_FONTS[signature.font] || SIGNATURE_FONTS.sans;
  // An opposing outline keeps both light and dark signatures readable.
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const outline = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 128 ? '#000000' : '#ffffff';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <text x="${width - margin}" y="${height - margin - fontSize * .24}" text-anchor="end"
      font-family="${font}" font-size="${fontSize}" fill="${color}" fill-opacity=".86"
      stroke="${outline}" stroke-opacity=".5" stroke-width="${fontSize * .065}" stroke-linejoin="round" paint-order="stroke fill">${SIGNATURE_TEXT}</text>
  </svg>`);
}

export async function renderPhotoVersion(source, config, signature = null) {
  const pipeline = sharp(source).rotate().resize({ width: config.width, withoutEnlargement: true });
  if (!signature) return pipeline.webp({ quality: config.quality }).toBuffer();
  // Use the actual resized dimensions after EXIF rotation. PNG avoids a second lossy encode.
  const { data, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
  return sharp(data).composite([{ input: signatureSvg(info.width, info.height, signature) }])
    .webp({ quality: config.quality }).toBuffer();
}
