import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesPhotoTitle, nextSeriesPhotoNumber, planSeriesPhotoNames } from '../scripts/photo-naming.js';
const series = { slug: 'ete', name: 'Été à Lyon' };
test('keeps accents and pads numbers without truncating large series', () => {
  assert.equal(seriesPhotoTitle(series.name, 1), 'Été à Lyon — 001');
  assert.equal(seriesPhotoTitle(series.name, 1001), 'Été à Lyon — 1001');
});
test('continues after existing numbers and includes drafts and trash', () => {
  const photos = [{ series: 'ete', title: 'Été à Lyon — 009', status: 'trash' },
    { series: 'ete', title: 'Original', status: 'draft' },
    { series: 'autre', title: 'Été à Lyon — 999' }];
  assert.equal(nextSeriesPhotoNumber(photos, series), 10);
  assert.equal(nextSeriesPhotoNumber([], series), 1);
});
test('migration uses newest dates then natural filename order, preserving links', () => {
  const photos = [{ file: 'photo-10.yaml', series: 'ete', date: '2025-01-01', slug: 'old-link', url: 'old-image' },
    { file: 'photo-2.yaml', series: 'ete', date: '2025-01-01' },
    { file: 'new.yaml', series: 'ete', date: '2026-01-01' },
    { file: 'other.yaml', series: 'autre' }];
  const result = planSeriesPhotoNames(photos, series);
  assert.deepEqual(result.map(p => p.file), ['new.yaml', 'photo-2.yaml', 'photo-10.yaml']);
  assert.equal(result[2].title, 'Été à Lyon — 003');
  assert.equal(result[2].slug, 'old-link');
  assert.equal(result[2].url, 'old-image');
  assert.equal(photos[0].title, undefined);
});

test('does not count an in-flight title twice after its metadata reaches disk',()=>{const photos=[{series:'ete',title:'Été à Lyon — 001'},{series:'ete',title:'Été à Lyon — 002'}];const reserved=new Set(['Été à Lyon — 002','Été à Lyon — 003']);assert.equal(nextSeriesPhotoNumber(photos,series,reserved),4);photos.push({series:'ete',title:'Été à Lyon — 003'});assert.equal(nextSeriesPhotoNumber(photos,series,reserved),4)});
