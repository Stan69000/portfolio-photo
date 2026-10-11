#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { KdriveStorage, kdriveConfig, kdriveFolderName, kdriveUrls } from './kdrive-storage.js';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
} catch {}
const args = process.argv.slice(2);
for (let index=0;index<args.length;index++) {
  if(['--limit','--concurrency'].includes(args[index])){index++;continue;}
  if(!['--apply','--flat'].includes(args[index]))throw new Error('Option inconnue : '+args[index]);
}
const apply = args.includes('--apply');
const limitArg = args.indexOf('--limit');
const limit = limitArg < 0 ? Infinity : Number(args[limitArg + 1]);
if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) throw new Error('Limite invalide.');
const concurrencyArg = args.indexOf('--concurrency');
const concurrency = concurrencyArg < 0 ? 2 : Number(args[concurrencyArg + 1]);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Parallélisme invalide (1 à 4).');
const read = dir => fs.readdirSync(dir).filter(file => file.endsWith('.yaml')).sort()
  .map(file => ({ file, data: yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')) }));
const photosDir = path.join(root, 'src/content/photos');
const seriesDir = path.join(root, 'src/content/series');
const photos = read(photosDir);
const series = new Map(read(seriesDir).map(({ data }) => [data.slug, data]));
const pending = photos.filter(({ data }) => !data.kdrive).slice(0, limit);
console.log(`${pending.length} photos à transférer ; ${photos.filter(({ data }) => data.kdrive).length} déjà sur kDrive.`);
console.log('Versions transférées : miniature, web, zoom. Les originaux historiques ne sont pas disponibles dans les métadonnées.');
if (!apply) {
  console.log('Simulation : aucune requête distante, aucun fichier modifié. Ajouter --apply pour transférer ; --limit 1 pour un premier essai.');
  process.exit(0);
}
const config = kdriveConfig();
const client = new KdriveStorage(config);
const origin = process.env.KDRIVE_RELAY_ORIGIN || process.env.PUBLIC_SITE_ORIGIN || 'https://stan-bouchet.eu';
const relayPath = process.env.KDRIVE_RELAY_PATH || '/media-kdrive.php';
const destination = await client.request(`/3/drive/${config.driveId}/files/${config.rootId}`);
if (destination.data?.type !== 'dir') throw new Error('Dossier kDrive inaccessible.');
const journalDir = path.join(root, '.processed/kdrive-migration');
fs.mkdirSync(journalDir, { recursive: true });
const replacements = new Map();
let completed = 0;
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const saveYaml = (target, data) => {
  const temp = target + '.migrating';
  fs.writeFileSync(temp, yaml.dump(data, { lineWidth: -1 }));
  fs.renameSync(temp, target);
};
async function transferOne({ file, data: photo }) {
    if (!/^[a-z0-9][a-z0-9-]{0,240}$/.test(photo.slug)) throw new Error('Slug invalide.');
    const serie = series.get(photo.series);
    const folderName = args.includes('--flat') ? null : kdriveFolderName(serie?.name || 'Instants', serie?.date || photo.date);
    const directoryId = await client.folder(folderName);
    const journalPath = path.join(journalDir, photo.slug + '.json');
    let journal = { drive_id: config.driveId, directory_id: directoryId, files: {} };
    if (fs.existsSync(journalPath)) journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (journal.drive_id !== config.driveId || journal.directory_id !== directoryId) throw new Error('Destination différente du précédent essai.');
    const urls = kdriveUrls(origin, photo.slug, relayPath);
    for (const version of ['thumb', 'web', 'zoom']) {
      const oldUrl = photo[`url_${version}`] || photo.url;
      const url = new URL(oldUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !['stan-bouchet.eu', 'www.stan-bouchet.eu', 'photos.bost7423.odns.fr'].includes(url.hostname)) {
        throw new Error('Source image non autorisée.');
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Source indisponible (HTTP ${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('La source ne contient pas une image WebP.');
      if (!journal.files[version]) {
        journal.files[version] = await client.upload(bytes, `${photo.slug}-${version}.webp`, directoryId);
        const temp = journalPath + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(journal));fs.renameSync(temp, journalPath);
      }
      const downloaded = await client.download(journal.files[version]);
      if (hash(Buffer.from(await downloaded.arrayBuffer())) !== hash(bytes)) throw new Error('Vérification du fichier transféré échouée.');
    }
    // Change local links only after all three uploaded files have been verified.
    for (const version of ['thumb', 'web', 'zoom']) {
      if (photo[`url_${version}`]) replacements.set(photo[`url_${version}`], urls[`url_${version}`]);
    }
    replacements.set(photo.url, urls.url_web);
    const current=yaml.load(fs.readFileSync(path.join(photosDir,file),'utf8'));
    if(['url','url_thumb','url_web','url_zoom'].some(key=>current[key]!==photo[key]))throw new Error('La source a changé pendant le transfert.');
    saveYaml(path.join(photosDir, file), { ...current, kdrive: journal, url: urls.url_web, ...urls });
    completed++;
    console.log(`Vérifiée : ${photo.slug} (${completed}/${pending.length})`);
}
try {
  let next = 0, failure;
  const worker = async () => {
    while (!failure && next < pending.length) {
      const photo = pending[next++];
      try { await transferOne(photo); } catch (error) { failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  if (failure) throw failure;
} finally {
  // Keep explicit album covers and other exact URL references in sync, even after a partial run.
  const replace = value => typeof value === 'string' ? (replacements.get(value) || value)
    : Array.isArray(value) ? value.map(replace)
    : value && typeof value === 'object' && !(value instanceof Date) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
  for (const dir of [seriesDir, path.join(root, 'src/content/settings')]) {
    for (const { file, data } of read(dir)) {
      const updated = replace(data);
      if (JSON.stringify(updated) !== JSON.stringify(data)) saveYaml(path.join(dir, file), updated);
    }
  }
}
console.log(`${completed} photos migrées localement. Générer, vérifier et publier le site pour activer les nouvelles adresses.`);
console.log('Aucun fichier supprimé sur O2Switch.');
