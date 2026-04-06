import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Busboy from 'busboy';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const sharp = require('sharp');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  port: 3333,
  photosDir: path.join(__dirname, 'src/content/photos'),
  seriesDir: path.join(__dirname, 'src/content/series'),
  tmpDir: path.join(__dirname, '.tmp-upload'),
  domain: 'https://photos.mondomaine.fr',   // ← remplacer au go-live
  sftp: {
    host: 'ftp.mondomaine.fr',              // ← remplacer
    port: 22,
    username: 'stanbouchet',               // ← remplacer
    privateKeyPath: '/Users/stanbouchet/.ssh/id_ed25519_github_stan',
    remotePath: '/home/stanbouchet/www/photos',
  },
  sharp: {
    thumb: { width: 500, quality: 80 },
    web:   { width: 1200, quality: 85 },
    zoom:  { width: 2500, quality: 90 },
  }
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function readPhotos() {
  return fs.readdirSync(CONFIG.photosDir)
    .filter(f => f.endsWith('.yaml'))
    .map(file => {
      try {
        const data = yaml.load(fs.readFileSync(path.join(CONFIG.photosDir, file), 'utf8'));
        return { file, ...data };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.date || '').toString().localeCompare((a.date || '').toString()));
}

function readSeries() {
  return fs.readdirSync(CONFIG.seriesDir)
    .filter(f => f.endsWith('.yaml'))
    .map(file => {
      try {
        const data = yaml.load(fs.readFileSync(path.join(CONFIG.seriesDir, file), 'utf8'));
        return { file, ...data };
      } catch { return null; }
    })
    .filter(Boolean);
}

function savePhoto(file, updates) {
  const filePath = path.join(CONFIG.photosDir, file);
  const data = yaml.load(fs.readFileSync(filePath, 'utf8'));
  const merged = { ...data, ...updates };
  // Clean empty exif
  if (merged.exif && !Object.values(merged.exif).some(Boolean)) delete merged.exif;
  fs.writeFileSync(filePath, yaml.dump(merged, { lineWidth: -1 }));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      resolve(obj);
    });
  });
}

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 200 * 1024 * 1024 } });
    const fields = {};
    const files = [];
    if (!fs.existsSync(CONFIG.tmpDir)) fs.mkdirSync(CONFIG.tmpDir, { recursive: true });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const tmp = path.join(CONFIG.tmpDir, `${Date.now()}-${info.filename}`);
      const ws = fs.createWriteStream(tmp);
      stream.pipe(ws);
      ws.on('finish', () => files.push({ field: name, path: tmp, filename: info.filename, mime: info.mimeType }));
    });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// ─── SHARP PROCESSING ─────────────────────────────────────────────────────────
async function processImage(srcPath, seriesSlug, photoSlug) {
  const outDir = path.join(__dirname, '.processed', seriesSlug, photoSlug);
  fs.mkdirSync(outDir, { recursive: true });

  const versions = {};
  for (const [name, cfg] of Object.entries(CONFIG.sharp)) {
    const outPath = path.join(outDir, `${name}.webp`);
    await sharp(srcPath)
      .resize({ width: cfg.width, withoutEnlargement: true })
      .webp({ quality: cfg.quality })
      .toFile(outPath);
    versions[name] = outPath;
  }
  return versions;
}

// ─── SFTP UPLOAD ──────────────────────────────────────────────────────────────
async function uploadViaFTP(versions, seriesSlug, photoSlug) {
  let SftpClient;
  try {
    SftpClient = (await import('ssh2-sftp-client')).default;
  } catch {
    return { ok: false, error: 'ssh2-sftp-client non disponible' };
  }

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: CONFIG.sftp.host,
      port: CONFIG.sftp.port,
      username: CONFIG.sftp.username,
      privateKey: fs.readFileSync(CONFIG.sftp.privateKeyPath),
    });

    for (const [name, localPath] of Object.entries(versions)) {
      const remotePath = `${CONFIG.sftp.remotePath}/${seriesSlug}/${name}/${photoSlug}.webp`;
      const remoteDir = path.dirname(remotePath);
      await sftp.mkdir(remoteDir, true);
      await sftp.put(localPath, remotePath);
    }
    await sftp.end();
    return { ok: true };
  } catch (err) {
    await sftp.end().catch(() => {});
    return { ok: false, error: err.message };
  }
}

function buildUrls(seriesSlug, photoSlug) {
  return {
    url_thumb: `${CONFIG.domain}/${seriesSlug}/thumb/${photoSlug}.webp`,
    url_web:   `${CONFIG.domain}/${seriesSlug}/web/${photoSlug}.webp`,
    url_zoom:  `${CONFIG.domain}/${seriesSlug}/zoom/${photoSlug}.webp`,
  };
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, sans-serif; background: #050b1a; color: #edf4ff; padding: 2rem; min-height: 100vh; }
a { color: inherit; text-decoration: none; }
h1 { font-size: 1.3rem; color: #748fff; margin-bottom: 1.5rem; }
h2 { font-size: 1rem; color: #748fff; margin-bottom: 1rem; }

/* NAV */
.nav { display: flex; gap: 0.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
.nav a { padding: 0.35rem 1rem; border-radius: 999px; border: 1px solid #243a65; font-size: 0.82rem; color: #9fb2d4; }
.nav a.active, .nav a:hover { background: #748fff22; border-color: #748fff55; color: #748fff; }

/* FILTERS */
.filters { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; align-items: center; }
.filter-btn { padding: 0.3rem 0.85rem; border-radius: 999px; border: 1px solid #243a65; background: none; color: #9fb2d4; font-size: 0.78rem; cursor: pointer; }
.filter-btn.active, .filter-btn:hover { background: #748fff22; border-color: #748fff55; color: #748fff; }
.search { background: #0f1f3d; border: 1px solid #243a65; border-radius: 0.5rem; color: #edf4ff; padding: 0.35rem 0.75rem; font-size: 0.82rem; width: 220px; }
.search:focus { outline: none; border-color: #748fff; }

/* GRID */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.card { background: #0f1f3d; border: 1px solid #243a65; border-radius: 0.8rem; overflow: hidden; transition: border-color 0.2s; }
.card:hover { border-color: #748fff44; }
.card-img { width: 100%; aspect-ratio: 3/2; object-fit: cover; display: block; background: #0a1628; }
.card-body { padding: 0.85rem; }
.card-title { font-size: 0.88rem; font-weight: 600; margin-bottom: 0.4rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-meta { font-size: 0.75rem; color: #9fb2d4; margin-bottom: 0.65rem; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.tag { background: #748fff18; border: 1px solid #748fff33; border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.7rem; color: #748fff; }
.status-badge { border-radius: 999px; padding: 0.1rem 0.55rem; font-size: 0.7rem; font-weight: 600; }
.status-published { background: #1a3d1a; color: #7aff7a; }
.status-draft { background: #3d2a00; color: #ffb347; }
.status-trash { background: #3d0a0a; color: #ff7a7a; }
.card-actions { display: flex; gap: 0.5rem; }
.btn { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid #243a65; background: none; color: #9fb2d4; font-size: 0.75rem; cursor: pointer; }
.btn:hover { border-color: #748fff55; color: #748fff; }
.btn-danger:hover { border-color: #ff4a4a55; color: #ff4a4a; }
.btn-primary { background: #748fff; border-color: #748fff; color: #050b1a; font-weight: 600; }
.btn-primary:hover { background: #9fb2ff; }

/* FORM */
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; max-width: 860px; }
@media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } }
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field.full { grid-column: 1 / -1; }
label { font-size: 0.78rem; color: #9fb2d4; }
input, textarea, select { background: #0f1f3d; border: 1px solid #243a65; border-radius: 0.5rem; color: #edf4ff; padding: 0.5rem 0.75rem; font-size: 0.88rem; font-family: inherit; width: 100%; }
textarea { min-height: 90px; resize: vertical; }
input:focus, textarea:focus, select:focus { outline: none; border-color: #748fff; }
.hint { font-size: 0.7rem; color: #6b7fa8; }

/* UPLOAD */
.drop-zone { border: 2px dashed #243a65; border-radius: 0.8rem; padding: 3rem 2rem; text-align: center; cursor: pointer; transition: all 0.2s; color: #9fb2d4; }
.drop-zone.dragover, .drop-zone:hover { border-color: #748fff; color: #748fff; background: #748fff08; }
.drop-zone input[type=file] { display: none; }
.upload-preview { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
.upload-thumb { aspect-ratio: 1; object-fit: cover; border-radius: 0.5rem; border: 1px solid #243a65; }
.progress { height: 4px; background: #243a65; border-radius: 999px; margin-top: 0.5rem; overflow: hidden; }
.progress-bar { height: 100%; background: #748fff; width: 0%; transition: width 0.3s; }

/* ALERTS */
.alert { border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.85rem; }
.alert-success { background: #1a3d1a; border: 1px solid #2d6b2d; color: #7aff7a; }
.alert-error { background: #3d0a0a; border: 1px solid #6b1a1a; color: #ff7a7a; }
.alert-info { background: #0f1f3d; border: 1px solid #243a65; color: #9fb2d4; }

/* MODAL */
.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(5,11,26,0.85); z-index: 100; align-items: center; justify-content: center; }
.modal-overlay.open { display: flex; }
.modal { background: #0f1f3d; border: 1px solid #243a65; border-radius: 1rem; padding: 2rem; max-width: 460px; width: 90%; }
.modal h3 { margin-bottom: 0.75rem; color: #edf4ff; }
.modal p { color: #9fb2d4; font-size: 0.88rem; margin-bottom: 1.5rem; }
.modal-actions { display: flex; gap: 0.75rem; justify-content: flex-end; }
`;

// ─── HTML PAGES ───────────────────────────────────────────────────────────────
function layout(title, content, activeNav = '') {
  return `<!doctype html><html lang="fr"><head>
  <meta charset="utf-8"><title>${title} — Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${CSS}</style>
</head><body>
<nav class="nav">
  <a href="/" class="${activeNav === 'photos' ? 'active' : ''}">📷 Photos</a>
  <a href="/series" class="${activeNav === 'series' ? 'active' : ''}">📁 Séries</a>
  <a href="/upload" class="${activeNav === 'upload' ? 'active' : ''}">⬆️ Upload</a>
</nav>
${content}
</body></html>`;
}

function photosPage(photos, filter = 'all', search = '', saved = '') {
  const counts = {
    all: photos.filter(p => p.status !== 'trash').length,
    published: photos.filter(p => p.status === 'published').length,
    draft: photos.filter(p => p.status === 'draft').length,
    trash: photos.filter(p => p.status === 'trash').length,
  };

  let filtered = photos;
  if (filter === 'trash') filtered = photos.filter(p => p.status === 'trash');
  else if (filter !== 'all') filtered = photos.filter(p => p.status === filter);
  else filtered = photos.filter(p => p.status !== 'trash');

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(p =>
      p.title?.toLowerCase().includes(q) ||
      p.tags?.some(t => t.toLowerCase().includes(q)) ||
      p.series?.toLowerCase().includes(q)
    );
  }

  const allTags = [...new Set(photos.flatMap(p => p.tags || []))].sort();

  return layout('Photos', `
  <h1>Photos <span style="color:#9fb2d4;font-size:0.85rem;font-weight:400">${filtered.length} / ${photos.length}</span></h1>
  ${saved ? `<div class="alert alert-success">✓ "${saved}" sauvegardée.</div>` : ''}
  <div class="filters">
    <a href="/?filter=all" class="filter-btn ${filter === 'all' ? 'active' : ''}">Tous (${counts.all})</a>
    <a href="/?filter=published" class="filter-btn ${filter === 'published' ? 'active' : ''}">En ligne (${counts.published})</a>
    <a href="/?filter=draft" class="filter-btn ${filter === 'draft' ? 'active' : ''}">Brouillons (${counts.draft})</a>
    <a href="/?filter=trash" class="filter-btn ${filter === 'trash' ? 'active' : ''}">Corbeille (${counts.trash})</a>
    <form method="GET" style="margin-left:auto">
      <input type="hidden" name="filter" value="${filter}">
      <input class="search" type="search" name="search" placeholder="Rechercher…" value="${search}">
    </form>
  </div>
  <div class="grid">
    ${filtered.map(p => {
      const imgSrc = p.url_thumb || p.url_web || p.url || '';
      const status = p.status || 'published';
      return `
      <div class="card" data-status="${status}">
        ${imgSrc ? `<img class="card-img" src="${imgSrc}" alt="${p.title}" loading="lazy">` : `<div class="card-img" style="background:#0a1628"></div>`}
        <div class="card-body">
          <div class="card-title" title="${p.title}">${p.title}</div>
          <div class="card-meta">
            <span class="status-badge status-${status}">${status === 'published' ? 'En ligne' : status === 'draft' ? 'Brouillon' : 'Corbeille'}</span>
            ${p.series ? `<span>📁 ${p.series}</span>` : ''}
            ${(p.tags || []).slice(0, 2).map(t => `<span class="tag">${t}</span>`).join('')}
          </div>
          <div class="card-actions">
            <a href="/edit/${p.file}" class="btn">Modifier</a>
            ${status !== 'trash'
              ? `<button class="btn btn-danger" onclick="moveToTrash('${p.file}', '${p.title}')">Corbeille</button>`
              : `<button class="btn" onclick="restore('${p.file}')">Restaurer</button>
                 <button class="btn btn-danger" onclick="hardDelete('${p.file}', '${p.title}')">Supprimer</button>`
            }
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>

  <div class="modal-overlay" id="modal">
    <div class="modal">
      <h3 id="modal-title"></h3>
      <p id="modal-msg"></p>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Annuler</button>
        <button class="btn btn-danger" id="modal-confirm">Confirmer</button>
      </div>
    </div>
  </div>

  <script>
  function closeModal() { document.getElementById('modal').classList.remove('open'); }
  function openModal(title, msg, onConfirm) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-msg').textContent = msg;
    document.getElementById('modal-confirm').onclick = onConfirm;
    document.getElementById('modal').classList.add('open');
  }
  function moveToTrash(file, title) {
    openModal('Mettre à la corbeille', '"' + title + '" sera masquée du site.', () => {
      fetch('/action/trash/' + file, { method: 'POST' }).then(() => location.reload());
    });
  }
  function restore(file) {
    fetch('/action/restore/' + file, { method: 'POST' }).then(() => location.reload());
  }
  function hardDelete(file, title) {
    openModal('Suppression définitive', '"' + title + '" et ses fichiers seront supprimés. Impossible d\'annuler.', () => {
      fetch('/action/delete/' + file, { method: 'POST' }).then(() => location.reload());
    });
  }
  </script>
  `, 'photos');
}

function editPage(photo, file, saved = false) {
  const tags = Array.isArray(photo.tags) ? photo.tags.join(', ') : (photo.tags || '');
  const series = readSeries();
  const allTags = [...new Set(readPhotos().flatMap(p => p.tags || []))].sort();

  return layout(`Modifier — ${photo.title}`, `
  <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
    <a href="/" class="btn">← Retour</a>
    <h1 style="margin:0">${photo.title}</h1>
    <span class="status-badge status-${photo.status || 'published'}">${photo.status === 'draft' ? 'Brouillon' : 'En ligne'}</span>
  </div>
  ${saved ? `<div class="alert alert-success">✓ Sauvegardé.</div>` : ''}
  ${photo.url_thumb || photo.url_web ? `<img src="${photo.url_thumb || photo.url_web}" style="max-width:360px;border-radius:0.5rem;margin-bottom:1.5rem;display:block">` : ''}
  <form method="POST" action="/save/${file}">
    <div class="form-grid">
      <div class="field"><label>Titre</label><input name="title" value="${photo.title || ''}"></div>
      <div class="field">
        <label>Série</label>
        <select name="series">
          ${series.map(s => `<option value="${s.slug}" ${photo.series === s.slug ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </div>
      <div class="field full"><label>Description</label><textarea name="description">${photo.description || ''}</textarea></div>
      <div class="field full">
        <label>Tags <span class="hint">séparés par des virgules</span></label>
        <input name="tags" value="${tags}" placeholder="lyon, sport, portrait" list="tags-list">
        <datalist id="tags-list">${allTags.map(t => `<option value="${t}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label>Statut</label>
        <select name="status">
          <option value="published" ${(photo.status || 'published') === 'published' ? 'selected' : ''}>En ligne</option>
          <option value="draft" ${photo.status === 'draft' ? 'selected' : ''}>Brouillon</option>
        </select>
      </div>
      <div class="field"><label>Note (0–5)</label><input name="rating" type="number" min="0" max="5" step="0.1" value="${photo.rating || ''}"></div>
      <div class="field"><label>Appareil</label><input name="exif_camera" value="${photo.exif?.camera || ''}"></div>
      <div class="field"><label>Objectif</label><input name="exif_lens" value="${photo.exif?.lens || ''}"></div>
      <div class="field"><label>Réglages</label><input name="exif_settings" value="${photo.exif?.settings || ''}"></div>
      <div class="field"><label>ISO</label><input name="exif_iso" value="${photo.exif?.iso || ''}"></div>
      <div class="field"><label>Prix (€)</label><input name="price" type="number" step="0.01" value="${photo.price || ''}"></div>
      <div class="field" style="align-items:start;padding-top:1.4rem">
        <label style="display:flex;gap:0.5rem;align-items:center;cursor:pointer">
          <input type="checkbox" name="for_sale" value="true" ${photo.for_sale ? 'checked' : ''}> À vendre
        </label>
      </div>
    </div>
    <div style="margin-top:1.5rem;display:flex;gap:0.75rem">
      <button type="submit" class="btn btn-primary">Sauvegarder</button>
      <a href="/" class="btn">Annuler</a>
    </div>
  </form>
  `, 'photos');
}

function uploadPage(msg = '', error = '') {
  const series = readSeries();
  return layout('Upload', `
  <h1>Importer des photos</h1>
  ${msg ? `<div class="alert alert-success">${msg}</div>` : ''}
  ${error ? `<div class="alert alert-error">${error}</div>` : ''}
  <div class="alert alert-info">Les fichiers sont traités par Sharp (thumb 500px · web 1200px · zoom 2500px) puis uploadés sur O2Switch via SFTP.</div>
  <form method="POST" action="/upload" enctype="multipart/form-data" id="upload-form" style="max-width:640px">
    <div style="margin-bottom:1.5rem">
      <label style="display:block;margin-bottom:0.5rem">Série</label>
      <select name="series" required style="width:100%">
        <option value="">— Choisir une série —</option>
        ${series.map(s => `<option value="${s.slug}">${s.name}</option>`).join('')}
      </select>
    </div>
    <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()">
      <input type="file" name="photos" id="file-input" multiple accept="image/jpeg,image/png,image/tiff,image/webp">
      <div style="font-size:2rem;margin-bottom:0.5rem">📷</div>
      <div style="font-weight:600;margin-bottom:0.25rem">Glisser les photos ici</div>
      <div style="font-size:0.8rem">ou cliquer pour sélectionner — JPEG, PNG, TIFF acceptés</div>
    </div>
    <div class="upload-preview" id="preview"></div>
    <div class="progress" id="progress-wrap" style="display:none"><div class="progress-bar" id="progress-bar"></div></div>
    <div style="margin-top:1.5rem;display:flex;gap:0.75rem">
      <button type="submit" class="btn btn-primary" id="upload-btn">Importer et traiter</button>
    </div>
  </form>
  <script>
  const drop = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');
  const preview = document.getElementById('preview');

  input.addEventListener('change', showPreviews);
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('dragover');
    input.files = e.dataTransfer.files;
    showPreviews();
  });

  function showPreviews() {
    preview.innerHTML = '';
    for (const f of input.files) {
      const img = document.createElement('img');
      img.className = 'upload-thumb';
      img.src = URL.createObjectURL(f);
      preview.appendChild(img);
    }
  }

  document.getElementById('upload-form').addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    document.getElementById('progress-wrap').style.display = 'block';
    xhr.upload.onprogress = ev => {
      if (ev.lengthComputable)
        document.getElementById('progress-bar').style.width = (ev.loaded / ev.total * 100) + '%';
    };
    xhr.onload = () => { window.location.href = '/upload?done=1'; };
    xhr.send(fd);
  });
  </script>
  `, 'upload');
}

function seriesPage(series, msg = '') {
  return layout('Séries', `
  <h1>Séries</h1>
  ${msg ? `<div class="alert alert-success">${msg}</div>` : ''}
  <div style="margin-bottom:1.5rem"><a href="/series/new" class="btn btn-primary">+ Nouvelle série</a></div>
  <div class="grid">
    ${series.map(s => `
    <div class="card">
      ${s.cover_url ? `<img class="card-img" src="${s.cover_url}" alt="${s.name}" loading="lazy">` : `<div class="card-img" style="background:#0a1628"></div>`}
      <div class="card-body">
        <div class="card-title">${s.name}</div>
        <div class="card-meta">
          <span class="status-badge ${s.status === 'draft' ? 'status-draft' : 'status-published'}">${s.status === 'draft' ? 'Brouillon' : 'En ligne'}</span>
          <span style="font-size:0.75rem;color:#9fb2d4">${s.slug}</span>
        </div>
        <div class="card-actions">
          <a href="/series/edit/${s.file}" class="btn">Modifier</a>
        </div>
      </div>
    </div>`).join('')}
  </div>
  `, 'series');
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const p = url.pathname;

  // ── Photos list
  if (req.method === 'GET' && p === '/') {
    const filter = url.searchParams.get('filter') || 'all';
    const search = url.searchParams.get('search') || '';
    const saved = url.searchParams.get('saved') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(photosPage(readPhotos(), filter, search, saved));

  // ── Edit photo form
  } else if (req.method === 'GET' && p.startsWith('/edit/')) {
    const file = path.basename(p.replace('/edit/', ''));
    const filePath = path.join(CONFIG.photosDir, file);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const photo = yaml.load(fs.readFileSync(filePath, 'utf8'));
    const saved = url.searchParams.get('saved') === '1';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(editPage(photo, file, saved));

  // ── Save photo
  } else if (req.method === 'POST' && p.startsWith('/save/')) {
    const file = path.basename(p.replace('/save/', ''));
    const body = await parseBody(req);
    const tags = body.tags ? body.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    savePhoto(file, {
      title: body.title,
      series: body.series,
      description: body.description || '',
      tags,
      status: body.status || 'published',
      rating: body.rating ? parseFloat(body.rating) : undefined,
      price: body.price ? parseFloat(body.price) : undefined,
      for_sale: body.for_sale === 'true',
      exif: {
        camera: body.exif_camera || undefined,
        lens: body.exif_lens || undefined,
        settings: body.exif_settings || undefined,
        iso: body.exif_iso || undefined,
      }
    });
    res.writeHead(302, { Location: `/edit/${file}?saved=1` });
    res.end();

  // ── Actions (trash / restore / delete)
  } else if (req.method === 'POST' && p.startsWith('/action/')) {
    const [, , action, ...rest] = p.split('/');
    const file = rest.join('/');
    const filePath = path.join(CONFIG.photosDir, file);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('{}'); return; }

    if (action === 'trash') {
      savePhoto(file, { status: 'trash' });
    } else if (action === 'restore') {
      savePhoto(file, { status: 'draft' });
    } else if (action === 'delete') {
      fs.unlinkSync(filePath);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

  // ── Upload page
  } else if (req.method === 'GET' && p === '/upload') {
    const done = url.searchParams.get('done');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(uploadPage(done ? 'Photos importées avec succès.' : ''));

  // ── Upload handler
  } else if (req.method === 'POST' && p === '/upload') {
    try {
      const { fields, files } = await parseUpload(req);
      const seriesSlug = fields.series;
      if (!seriesSlug) { res.writeHead(400); res.end('Série manquante'); return; }

      const results = [];
      for (const file of files) {
        const photoSlug = slugify(path.parse(file.filename).name);
        try {
          // Sharp processing
          const versions = await processImage(file.path, seriesSlug, photoSlug);
          // SFTP upload
          const sftpResult = await uploadViaFTP(versions, seriesSlug, photoSlug);
          // Build URLs
          const urls = buildUrls(seriesSlug, photoSlug);
          // Create YAML
          const yamlFile = `${seriesSlug}-${photoSlug}.yaml`;
          const yamlData = {
            title: photoSlug,
            slug: photoSlug,
            series: seriesSlug,
            url: urls.url_web,
            url_thumb: urls.url_thumb,
            url_web: urls.url_web,
            url_zoom: urls.url_zoom,
            status: 'draft',
            date: new Date().toISOString().split('T')[0],
            description: '',
            tags: [],
          };
          fs.writeFileSync(path.join(CONFIG.photosDir, yamlFile), yaml.dump(yamlData, { lineWidth: -1 }));
          // Cleanup tmp
          fs.unlinkSync(file.path);
          results.push({ slug: photoSlug, ok: true, sftp: sftpResult.ok });
        } catch (err) {
          results.push({ slug: photoSlug, ok: false, error: err.message });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }

  // ── Series list
  } else if (req.method === 'GET' && p === '/series') {
    const msg = url.searchParams.get('saved') ? 'Série sauvegardée.' : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(seriesPage(readSeries(), msg));

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// Ensure tmp dir
if (!fs.existsSync(CONFIG.tmpDir)) fs.mkdirSync(CONFIG.tmpDir, { recursive: true });

server.listen(CONFIG.port, () => {
  console.log(`\n  ┌─────────────────────────────────────┐`);
  console.log(`  │  Admin photos → http://localhost:${CONFIG.port}  │`);
  console.log(`  └─────────────────────────────────────┘\n`);
});
