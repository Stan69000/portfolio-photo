import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPhotos} from '../src/lib/photo-search.js';
const photos=[
 {slug:'a',title:'Lumière sur la mer',series:'voyage',seriesName:'Évasion',tags:['Lumière du soir','nature'],year:2025,date:2,emotions:['ralentir']},
 {slug:'b',title:'Concert',series:'concert',seriesName:'Musique',tags:['Daniel Pastor'],year:2026,date:3,emotions:['vibrer']},
 {slug:'c',title:'Sans date',series:'',seriesName:'',tags:[],year:'',date:0,emotions:[]},
];
test('year, series and emotion combine without retaining unrelated images',()=>{
 assert.deepEqual(searchPhotos(photos,{year:'2025',series:'voyage',emotion:'ralentir'}).map(p=>p.slug),['a']);
 assert.equal(searchPhotos(photos,{year:'2026',emotion:'ralentir'}).length,0);
});
test('text ignores accents and supports several words and year',()=>{
 assert.deepEqual(searchPhotos(photos,{q:'evasion lumiere 2025'}).map(p=>p.slug),['a']);
});
test('multiword tags match as complete tags',()=>{
 assert.deepEqual(searchPhotos(photos,{tag:'lumiere du soir'}).map(p=>p.slug),['a']);
 assert.equal(searchPhotos(photos,{tag:'Pastor'}).length,0);
 assert.deepEqual(searchPhotos(photos,{tag:'daniel pastor'}).map(p=>p.slug),['b']);
});
test('sorts both date directions, keeps undated photos and does not mutate input',()=>{
 assert.deepEqual(searchPhotos(photos).map(p=>p.slug),['b','a','c']);
 assert.deepEqual(searchPhotos(photos,{sort:'oldest'}).map(p=>p.slug),['c','a','b']);
 assert.deepEqual(photos.map(p=>p.slug),['a','b','c']);
 assert.deepEqual(searchPhotos(photos,{sort:'title'}).map(p=>p.slug),['b','a','c']);
});
