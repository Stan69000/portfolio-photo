import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSeriesCover} from '../src/lib/series-cover.js';
const photos=[{data:{slug:'matour-2026-09-26-008',url_web:'https://admin.stan-bouchet.fr/api/public/kdrive?slug=matour-2026-09-26-008&version=web&rev=1',url_thumb:'https://admin.stan-bouchet.fr/api/public/kdrive?slug=matour-2026-09-26-008&version=thumb&rev=1'}}];
test('admin preview links map to the public photo URL',()=>{
 assert.equal(resolveSeriesCover('/api/sites/portfolio-photo/kdrive/preview?slug=matour-2026-09-26-008&version=web',photos),photos[0].data.url_web);
 assert.equal(resolveSeriesCover('/api/sites/portfolio-photo/kdrive/preview?slug=matour-2026-09-26-008&version=thumb',photos),photos[0].data.url_thumb);
});
test('unknown admin-only paths fall back to empty, other URLs are kept',()=>{
 assert.equal(resolveSeriesCover('/api/sites/portfolio-photo/kdrive/preview?slug=missing&version=web',photos),'');
 assert.equal(resolveSeriesCover('https://example.com/a.webp',photos),'https://example.com/a.webp');
 assert.equal(resolveSeriesCover('',photos),'');
});
