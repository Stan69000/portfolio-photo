import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeSignature, signatureSvg, renderPhotoVersion } from '../scripts/photo-signature.js';
const signature = normalizeSignature({ signature: 'true' });

test('signature is opt-in and rejects untrusted font and color values', () => {
  assert.equal(normalizeSignature(), null);
  assert.equal(normalizeSignature({ signature: 'false' }), null);
  assert.deepEqual(normalizeSignature({ signature: 'true', signature_color: '<svg>', signature_font: 'constructor' }), signature);
  assert.equal(normalizeSignature({ signature: 'true', signature_color: '#1245ab', signature_font: 'serif' }).color, '#1245ab');
});

for (const [width, height] of [[1200, 800], [800, 1200], [800, 800], [1800, 300], [120, 80]]) {
  for (const font of ['sans', 'serif', 'script']) {
    test(`${font} stays inside the bottom-right corner on ${width}×${height}`, async () => {
      const { data, info } = await sharp(signatureSvg(width, height, { ...signature, font }))
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let left = width, top = height, right = 0, bottom = 0, pixels = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * info.channels + 3] < 5) continue;
        pixels++; left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      assert.ok(pixels > 0);
      assert.ok(left > width * .5 && top > height * .7, `${left}, ${top}`);
      assert.ok(right < width - 1 && bottom < height - 1);
    });
  }
}

for (const format of ['jpeg', 'png', 'webp', 'tiff']) {
  test(`renders signed ${format} and leaves source bytes intact`, async () => {
    const source = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#777777' } }).toFormat(format).toBuffer();
    const original = Buffer.from(source);
    const config = { width: 500, quality: 85 };
    const unsigned = await renderPhotoVersion(source, config);
    const signed = await renderPhotoVersion(source, config, signature);
    assert.deepEqual(source, original);
    const metadata = await sharp(signed).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 500);
    assert.equal(metadata.height, 333);
    assert.notDeepEqual(signed, unsigned);
    const expected = await sharp(source).rotate().resize({ width: 500, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    assert.deepEqual(unsigned, expected);
  });
}

test('uses actual portrait dimensions after EXIF rotation', async () => {
  const source = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#ddd' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await renderPhotoVersion(source, { width: 500, quality: 85 }, signature);
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.height, 600);
});
