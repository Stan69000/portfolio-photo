import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KdriveStorage, kdriveConfig, kdriveFolderName, kdriveUrls } from '../scripts/kdrive-storage.js';
const config = { token: 'private-test-token', driveId: '620855', rootId: '426358' };
const ok = data => new Response(JSON.stringify({ result: 'success', data }), { headers: { 'Content-Type': 'application/json' } });

test('requires a token and numeric IDs; folder name retains accents and removes separators', () => {
  assert.throws(() => kdriveConfig({}));
  assert.throws(() => kdriveConfig({ KDRIVE_TOKEN: 'x', KDRIVE_ID: '../2', KDRIVE_ROOT_ID: '1' }));
  assert.equal(kdriveFolderName('Été / Lyon', '2026-10-11'), 'Été Lyon — 2026-10-11');
  assert.throws(() => kdriveFolderName('Lyon', 'not-a-date'));
});
test('media URLs use the public site, never an API token or an original', () => {
  const urls = kdriveUrls('https://stan-bouchet.eu', 'lyon-001');
  assert.deepEqual(Object.keys(urls), ['url_thumb', 'url_web', 'url_zoom']);
  const url = new URL(urls.url_zoom);
  assert.equal(url.pathname, '/media-kdrive.php');
  assert.equal(url.searchParams.get('slug'), 'lyon-001');
  assert.equal(url.searchParams.get('version'), 'zoom');
  assert.ok(!JSON.stringify(urls).includes(config.token));
});
test('reuses a matching directory on the second page and caches it', async () => {
  let calls = 0;
  const client = new KdriveStorage(config, async (input, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
    if (calls === 1) return new Response(JSON.stringify({ data: [], has_more: true, cursor: 'next-page' }));
    assert.equal(new URL(input).searchParams.get('cursor'), 'next-page');
    return ok([{ id: 88, name: 'Lyon — 2026-10-11' }]);
  });
  assert.equal(await client.folder('Lyon — 2026-10-11'), '88');
  assert.equal(await client.folder('Lyon — 2026-10-11'), '88');
  assert.equal(calls, 2);
});
test('flat imports use the configured parent without creating a directory', async () => {
  const client = new KdriveStorage(config, async () => { throw Error('Unexpected request'); });
  assert.equal(await client.folder(null), '426358');
});
test('creates the requested named directory under the configured parent', async () => {
  const calls = [];
  const client = new KdriveStorage(config, async (input, options) => {
    calls.push({ input, options });
    return calls.length === 1 ? ok([]) : ok({ id: 99 });
  });
  assert.equal(await client.folder('Lyon — 2026-10-11'), '99');
  assert.ok(calls[1].input.endsWith('/files/426358/directory'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Lyon — 2026-10-11' });
});
test('uploads each version and the unchanged original with no public share request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kdrive-test-'));
  try {
    const versions = {};
    for (const name of ['thumb', 'web', 'zoom']) {
      versions[name] = path.join(directory, name + '.webp');
      await fs.writeFile(versions[name], Buffer.from(name));
    }
    const original = path.join(directory, 'original.JPG');
    const originalBytes = Buffer.from([0xff, 0xd8, 0, 1, 2, 3]);
    await fs.writeFile(original, originalBytes);
    const calls = [];
    const client = new KdriveStorage(config, async (input, options) => {
      const url = new URL(input);
      assert.ok(url.pathname.endsWith('/upload'));
      assert.equal(url.searchParams.get('directory_id'), config.rootId);
      assert.equal(url.searchParams.get('total_size'), String(options.body.length));
      calls.push({ url, body: options.body });
      return ok({ id: calls.length + 100 });
    });
    const metadata = await client.save({ versions, original, slug: 'lyon-001' });
    assert.deepEqual(metadata.files, { thumb: '101', web: '102', zoom: '103', original: '104' });
    assert.equal(metadata.directory_id, config.rootId);
    assert.equal(calls[3].url.searchParams.get('file_name'), 'lyon-001-original.jpg');
    assert.deepEqual(calls[3].body, originalBytes);
    assert.deepEqual(await fs.readFile(original), originalBytes);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('HTTP and API failures stay failures and never disclose the token', async () => {
  for (const response of [new Response(config.token, { status: 403 }), new Response(JSON.stringify({ result: 'error', error: config.token }))]) {
    const client = new KdriveStorage(config, async () => response);
    await assert.rejects(client.request('/3/drive/620855/files/426358'), error => !error.message.includes(config.token));
  }
});
test('does not create a directory when pagination is incomplete', async () => {
  const client = new KdriveStorage(config, async () => new Response(JSON.stringify({ data: [], has_more: true })));
  await assert.rejects(client.folder('Lyon'), /pagination/);
});

test('public manifest excludes originals, drafts, trash and credentials', async () => {
  const { publicKdriveManifest } = await import('../scripts/kdrive-media.js');
  const kdrive = { drive_id: config.driveId, directory_id: '123', files: { thumb: '1', web: '2', zoom: '3', original: '4' }, token: config.token };
  const result = publicKdriveManifest([
    { slug: 'published', status: 'published', kdrive },
    { slug: 'draft', status: 'draft', kdrive },
    { slug: 'trash', status: 'trash', kdrive },
    { slug: 'old', status: 'published' },
  ]);
  assert.deepEqual(result, { published: { drive_id: config.driveId, files: { thumb: '1', web: '2', zoom: '3' } } });
  assert.ok(!JSON.stringify(result).includes(config.token));
});
