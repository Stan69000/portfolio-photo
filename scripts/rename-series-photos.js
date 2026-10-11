#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { planSeriesPhotoNames } from './photo-naming.js';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = new URL('../src/content/', import.meta.url);
const photosDir = new URL('photos/', root);
const read = dir => fs.readdirSync(dir).filter(file => file.endsWith('.yaml'))
  .map(file => ({ ...yaml.load(fs.readFileSync(new URL(file, dir), 'utf8')), file }));
const photos = read(photosDir);
const apply = process.argv.includes('--apply');
let changed = 0;
for (const series of read(new URL('series/', root))) {
  for (const photo of planSeriesPhotoNames(photos, series)) {
    const target = new URL(photo.file, photosDir);
    const source = fs.readFileSync(target, 'utf8');
    const old = yaml.load(source);
    if (old.title === photo.title) continue;
    // Only replace the title; leave all other metadata and formatting intact.
    const titleLine = yaml.dump({ title: photo.title }, { lineWidth: -1 }).trimEnd();
    if (!/^title:.*$/m.test(source)) throw new Error(`Titre introuvable : ${path.basename(target.pathname)}`);
    if (apply) fs.writeFileSync(target, source.replace(/^title:.*$/m, () => titleLine));
    changed++;
  }
}
console.log(`${changed} titres ${apply ? 'renommés' : 'à renommer (ajouter --apply)'}.`);
