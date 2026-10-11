import fs from 'node:fs/promises';
import path from 'node:path';

export function kdriveConfig(env = process.env) {
  const config = { token: env.KDRIVE_TOKEN, driveId: String(env.KDRIVE_ID || ''), rootId: String(env.KDRIVE_ROOT_ID || '') };
  if (!config.token || !/^\d+$/.test(config.driveId) || !/^\d+$/.test(config.rootId)) {
    throw new Error('kDrive non configuré : renseigner KDRIVE_TOKEN, KDRIVE_ID et KDRIVE_ROOT_ID dans le fichier .env local.');
  }
  if (env.KDRIVE_CATEGORY_NAME) config.categoryName = env.KDRIVE_CATEGORY_NAME;
  return config;
}

export function kdriveFolderName(name, date) {
  const label = String(name || 'Instants').replace(/[\x00-\x1f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Date du dossier kDrive invalide.');
  return `${label || 'Instants'} — ${day}`;
}

export function kdriveUrls(origin, slug, relayPath = '/media-kdrive.php') {
  const base = new URL(relayPath, origin);
  return Object.fromEntries(['thumb', 'web', 'zoom'].map(version => {
    const url = new URL(base);
    url.searchParams.set('slug', slug);
    url.searchParams.set('version', version);
    return [`url_${version}`, url.toString()];
  }));
}

export class KdriveStorage {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetch = fetcher;
    this.folders = new Map();
    this.taggedFolders = new Map();
  }
  async request(endpoint, options = {}, binary = false) {
    let response;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
      response = await this.fetch(`https://api.infomaniak.com${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.config.token}`, ...options.headers },
      redirect: binary ? 'follow' : 'error',
      signal: AbortSignal.timeout(binary ? 120000 : 30000),
    });
      } catch (error) {
        if ((options.method && options.method !== 'GET') || attempt===4) throw error;
        await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
        continue;
      }
      const retryable = response.status === 429 || ((!options.method || options.method === 'GET') && [500,502,503,504].includes(response.status));
      if (!retryable || attempt === 4) break;
      await response.body?.cancel();
      const retry = Number(response.headers?.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(1000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 2000 * 2 ** attempt))));
    }
    if (!response.ok) throw new Error(`kDrive : requête refusée (HTTP ${response.status}).`);
    if (binary) return response;
    const result = await response.json();
    if (result.result && result.result !== 'success') throw new Error('kDrive : opération refusée. Vérifier les droits du jeton.');
    return result;
  }
  async folder(name) {
    if (!name) return this.config.rootId;
    if (this.folders.has(name)) return this.folders.get(name);
    const pending = this.ensureFolder(name).then(async id => { await this.tagFolder(id); return id; });
    this.folders.set(name, pending);
    try { return await pending; } catch (error) { this.folders.delete(name); throw error; }
  }
  async tagFolder(id) {
    if (!this.config.categoryName || String(id) === this.config.rootId) return;
    if (!/^\d+$/.test(String(id))) throw new Error('Identifiant du dossier invalide.');
    if (this.taggedFolders.has(String(id))) return this.taggedFolders.get(String(id));
    const pending = this.applyFolderCategory(String(id));
    this.taggedFolders.set(String(id), pending);
    try { return await pending; } catch (error) { this.taggedFolders.delete(String(id)); throw error; }
  }
  async applyFolderCategory(id) {
    this.categoryPromise ||= this.request(`/2/drive/${this.config.driveId}/categories`).then(result => {
      const category = result.data?.find(item => item.name === this.config.categoryName);
      if (!category || !/^\d+$/.test(String(category.id))) throw new Error('Catégorie kDrive introuvable : ' + this.config.categoryName);
      return String(category.id);
    });
    const categoryId = await this.categoryPromise;
    const file = await this.request(`/3/drive/${this.config.driveId}/files/${id}?with=categories`);
    if (file.data?.type !== 'dir') throw new Error('La catégorie doit être attribuée à un dossier.');
    if (!Array.isArray(file.data.categories)) throw new Error('Catégories du dossier kDrive indisponibles.');
    if (file.data.categories.some(item => String(item.category_id ?? item.category?.id ?? item.id) === categoryId)) return;
    await this.request(`/2/drive/${this.config.driveId}/files/${id}/categories/${categoryId}`, { method: 'POST' });
  }
  async ensureFolder(name) {
    let cursor = '';
    const seen = new Set();
    do {
      const query = new URLSearchParams({ 'type[]': 'dir' });
      if (cursor) query.set('cursor', cursor);
      const result = await this.request(`/3/drive/${this.config.driveId}/files/${this.config.rootId}/files?${query}`);
      if (!Array.isArray(result.data)) throw new Error('kDrive : liste de dossiers inattendue.');
      const match = result.data.find(file => file.name === name && /^\d+$/.test(String(file.id)));
      if (match) return String(match.id);
      const next = result.cursor || result.pagination?.cursor || '';
      if (!next) {
        if (result.has_more || result.pagination?.has_more) throw new Error('kDrive : pagination incomplète.');
        break;
      }
      if (seen.has(next)) throw new Error('kDrive : pagination répétée.');
      seen.add(next); cursor = next;
    } while (cursor);
    const result = await this.request(`/3/drive/${this.config.driveId}/files/${this.config.rootId}/directory`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const id = String(result.data?.id || '');
    if (!/^\d+$/.test(id)) throw new Error('kDrive : identifiant du nouveau dossier manquant.');
    return id;
  }
  async upload(buffer, filename, directoryId) {
    const query = new URLSearchParams({ directory_id: String(directoryId), file_name: filename, total_size: String(buffer.length) });
    const result = await this.request(`/3/drive/${this.config.driveId}/upload?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer,
    });
    const id = String(result.data?.id || '');
    if (!/^\d+$/.test(id)) throw new Error('kDrive : identifiant du fichier envoyé manquant.');
    return id;
  }
  async save({ versions, original, slug, folderName }) {
    const directoryId = await this.folder(folderName);
    const files = {};
    for (const version of ['thumb', 'web', 'zoom']) {
      if (!versions[version]) throw new Error(`Version ${version} manquante.`);
      files[version] = await this.upload(await fs.readFile(versions[version]), `${slug}-${version}.webp`, directoryId);
    }
    if (original) {
      const extension = path.extname(original).toLowerCase();
      files.original = await this.upload(await fs.readFile(original), `${slug}-original${extension}`, directoryId);
    }
    return { drive_id: this.config.driveId, directory_id: directoryId, files };
  }
  async download(fileId) {
    if (!/^\d+$/.test(String(fileId))) throw new Error('Identifiant du fichier invalide.');
    return this.request(`/2/drive/${this.config.driveId}/files/${fileId}/download`, {}, true);
  }
}
