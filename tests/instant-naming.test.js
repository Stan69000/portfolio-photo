import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInstantTitle, instantPhotoTitle } from '../scripts/instant-naming.js';

test('personal title takes priority over place and date', () => {
  assert.equal(instantPhotoTitle({ title: '  Reflets   après la pluie ', place: 'Lyon', date: '2026-10-11' }), 'Reflets après la pluie');
});
test('fallback uses supplied place and French capture date', () => {
  assert.equal(instantPhotoTitle({ title: ' ', place: 'Lyon', date: '2026-09-28' }), 'Lyon — 28 septembre 2026');
});
test('without a place uses date only, never a filename or coordinates', () => {
  assert.equal(instantPhotoTitle({ date: '2026-09-28' }), 'Instant du 28 septembre 2026');
});
test('disambiguates fallback titles across batches without changing older titles', () => {
  const used = new Set(['Lyon — 28 septembre 2026', 'Lyon — 28 septembre 2026 — 02']);
  assert.equal(instantPhotoTitle({ place: 'Lyon', date: '2026-09-28' }, used), 'Lyon — 28 septembre 2026 — 03');
  assert.equal(used.size, 2);
});
test('personal titles can repeat intentionally', () => {
  assert.equal(instantPhotoTitle({ title: 'Le Rhône' }, new Set(['Le Rhône'])), 'Le Rhône');
});
test('rejects invalid dates and limits title length', () => {
  assert.throws(() => instantPhotoTitle({ date: 'not-a-date' }));
  assert.equal(cleanInstantTitle('a'.repeat(200)).length, 140);
  assert.equal(cleanInstantTitle({}), '');
});

test('upload keeps each title associated with its file when writes finish out of order', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { EventEmitter } = await import('node:events');
  const source = fs.readFileSync(new URL('../admin-server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function parseUpload(req)');
  const end = source.indexOf('// ─── SHARP + EXIF', start);
  const parser = new EventEmitter();
  const writes = [];
  const parse = vm.runInNewContext(source.slice(start, end) + '\nparseUpload', {
    Busboy: () => parser,
    fs: { mkdirSync() {}, createWriteStream() { const write = new EventEmitter(); writes.push(write); return write; } },
    path, crypto, CFG: { tmpDir: '/tmp' }, ALLOWED_UPLOAD_MIME: new Set(['image/jpeg']), decodeUploadFilename: name => name,
  });
  const pending = parse({ headers: {}, pipe() {
    parser.emit('field', 'titles', '["Première","Ignorée","Troisième"]');
    for (const [filename, mimeType] of [['one.jpg', 'image/jpeg'], ['skip.gif', 'image/gif'], ['three.jpg', 'image/jpeg']]) {
      parser.emit('file', 'photos', { pipe() {}, resume() {} }, { filename, mimeType });
    }
    writes[1].emit('finish');
    writes[0].emit('finish');
    parser.emit('close');
  } });
  const { fields, files } = await pending;
  const titles = JSON.parse(fields.titles);
  assert.deepEqual(Array.from(files, file => [file.filename, titles[file.uploadIndex]]), [['one.jpg', 'Première'], ['three.jpg', 'Troisième']]);
});
