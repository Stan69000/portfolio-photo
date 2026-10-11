import test from 'node:test';
import assert from 'node:assert/strict';
import { visitChoice } from '../src/lib/visit-choice.js';
import { guidedSelection, matchesEmotion, emotions } from '../src/lib/discovery.js';
const photo = (slug, series, tags = []) => ({data: {slug, series, tags, emotions: []}});
test('a visit retains its choice, replaces deleted photos and separates revisions', () => {
  const saved = new Map();
  const storage = {getItem: key => saved.get(key), setItem: (key,value) => saved.set(key,value)};
  const items = [{slug:'a'}, {slug:'b'}];
  const first = visitChoice(items,'home:0',storage);
  assert.equal(visitChoice(items,'home:0',storage),first);
  assert.equal(visitChoice([{slug:'c'}],'home:0',storage).slug,'c');
  visitChoice(items,'home:1',storage);
  assert.equal(saved.size,2);
  assert.equal(visitChoice([],'empty',storage),undefined);
});
test('blocked storage still permits a choice', () => {
  const blocked = {getItem(){throw Error('blocked');}, setItem(){throw Error('blocked');}};
  assert.equal(visitChoice([{slug:'a'}],'home',blocked).slug,'a');
});
test('tour balances series, stays unique and honors valid curated order', () => {
  const photos = Array.from({length:20},(_,i) => photo(`a${i}`,'a')).concat([photo('b','b'),photo('c','c')]);
  const tour = guidedSelection(photos);
  assert.equal(tour.length,12);
  assert.equal(new Set(tour.map(p=>p.data.slug)).size,12);
  assert.deepEqual(tour.slice(0,3).map(p=>p.data.series),['a','b','c']);
  assert.deepEqual(guidedSelection(photos,['c','invalid','c','b']).map(p=>p.data.slug),['c','b']);
  assert.equal(guidedSelection([],[]).length,0);
});
test('explicit emotions override tag suggestions and parent tags are inherited', () => {
  const calm = emotions.find(e=>e.slug==='ralentir');
  const p = photo('a','s',['paysage']);
  assert.equal(matchesEmotion(p,calm),true);
  p.data.emotions = ['vibrer'];
  assert.equal(matchesEmotion(p,calm),false);
  assert.equal(matchesEmotion(photo('b','s'),calm,[{data:{slug:'s',tags:['Nature']}}]),true);
});
test('diptychs retain original lightbox indices, stay unique and cross chapter limits together', async () => {
  const {narrativeChapters} = await import('../src/lib/discovery.js');
  const images = Array.from({length:18},(_,i)=>({slug:`image-${i}`, diptych_with:''}));
  images[12].diptych_with = 'image-16';
  const chapters = narrativeChapters(images);
  const flattened = chapters.flat();
  assert.equal(flattened.length,17);
  assert.equal(new Set(flattened.map(p=>p.slug)).size,17);
  assert.deepEqual(chapters[0].slice(-2).map(p=>p.slug),['image-12','image-16']);
  assert.equal(flattened.find(p=>p.slug==='image-16').index,16);
  images[12].diptych_with = '';
  images[16].diptych_with = 'image-12';
  assert.deepEqual(narrativeChapters(images)[0].slice(-2).map(p=>p.slug),['image-12','image-16']);
  assert.deepEqual(narrativeChapters([]),[]);
  assert.deepEqual(narrativeChapters([{slug:'only'}]),[]);
});
