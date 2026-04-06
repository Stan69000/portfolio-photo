import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Busboy from 'busboy';

const require = createRequire(import.meta.url);
const yaml  = require('js-yaml');
const sharp = require('sharp');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  port: 3333,
  photosDir:   path.join(__dirname, 'src/content/photos'),
  seriesDir:   path.join(__dirname, 'src/content/series'),
  settingsFile:path.join(__dirname, 'src/content/settings/site.yaml'),
  viewsFile:   path.join(__dirname, 'src/content/stats/views.json'),
  tmpDir:      path.join(__dirname, '.tmp-upload'),
  processDir:  path.join(__dirname, '.processed'),
  domain:      'https://photos.mondomaine.fr',   // ← à remplacer au go-live
  sftp: {
    host:           'ftp.mondomaine.fr',          // ← à remplacer
    port:           22,
    username:       'stanbouchet',               // ← à remplacer
    privateKeyPath: '/Users/stanbouchet/.ssh/id_ed25519_github_stan',
    remotePath:     '/home/stanbouchet/www/photos',
  },
  sharp: {
    thumb: { width: 500,  quality: 80 },
    web:   { width: 1200, quality: 85 },
    zoom:  { width: 2500, quality: 90 },
  }
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
const slugify = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

const readYaml  = f => yaml.load(fs.readFileSync(f, 'utf8'));
const writeYaml = (f, d) => fs.writeFileSync(f, yaml.dump(d, { lineWidth: -1 }));

function readPhotos() {
  return fs.readdirSync(CFG.photosDir).filter(f => f.endsWith('.yaml'))
    .map(file => { try { return { file, ...readYaml(path.join(CFG.photosDir, file)) }; } catch { return null; } })
    .filter(Boolean)
    .sort((a,b) => (b.date||'').toString().localeCompare((a.date||'').toString()));
}

function readSeries() {
  return fs.readdirSync(CFG.seriesDir).filter(f => f.endsWith('.yaml'))
    .map(file => { try { return { file, ...readYaml(path.join(CFG.seriesDir, file)) }; } catch { return null; } })
    .filter(Boolean);
}

function readSettings() {
  try { return readYaml(CFG.settingsFile); } catch { return {}; }
}

function readViews() {
  try {
    fs.mkdirSync(path.dirname(CFG.viewsFile), { recursive: true });
    return JSON.parse(fs.readFileSync(CFG.viewsFile, 'utf8'));
  } catch { return {}; }
}

function saveViews(v) {
  fs.mkdirSync(path.dirname(CFG.viewsFile), { recursive: true });
  fs.writeFileSync(CFG.viewsFile, JSON.stringify(v, null, 2));
}

function savePhoto(file, updates) {
  const fp = path.join(CFG.photosDir, file);
  const data = { ...readYaml(fp), ...updates };
  if (data.exif && !Object.values(data.exif).some(Boolean)) delete data.exif;
  writeYaml(fp, data);
}

function parseBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { const p = new URLSearchParams(b); const o = {}; for(const[k,v] of p) o[k]=v; r(o); });
  });
}

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 300*1024*1024 } });
    const fields = {}, files = [];
    fs.mkdirSync(CFG.tmpDir, { recursive: true });
    bb.on('field', (k,v) => { fields[k]=v; });
    bb.on('file', (name, stream, info) => {
      const tmp = path.join(CFG.tmpDir, `${Date.now()}-${info.filename}`);
      const ws = fs.createWriteStream(tmp);
      stream.pipe(ws);
      ws.on('finish', () => files.push({ path: tmp, filename: info.filename, mime: info.mimeType }));
    });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// ─── SHARP + EXIF ─────────────────────────────────────────────────────────────
async function processImage(src, seriesSlug, photoSlug) {
  const outDir = path.join(CFG.processDir, seriesSlug, photoSlug);
  fs.mkdirSync(outDir, { recursive: true });
  const versions = {};
  for (const [name, cfg] of Object.entries(CFG.sharp)) {
    const out = path.join(outDir, `${name}.webp`);
    await sharp(src).resize({ width: cfg.width, withoutEnlargement: true }).webp({ quality: cfg.quality }).toFile(out);
    versions[name] = out;
  }
  return versions;
}

async function readExif(filePath) {
  try {
    const { default: exifr } = await import('exifr');
    const data = await exifr.parse(filePath, { pick: ['Make','Model','LensModel','ExposureTime','FNumber','ISOSpeedRatings','DateTimeOriginal'] });
    if (!data) return {};
    const shutter = data.ExposureTime ? (data.ExposureTime < 1 ? `1/${Math.round(1/data.ExposureTime)}s` : `${data.ExposureTime}s`) : '';
    const aperture = data.FNumber ? `f/${data.FNumber}` : '';
    return {
      camera:   [data.Make, data.Model].filter(Boolean).join(' ') || '',
      lens:     data.LensModel || '',
      settings: [aperture, shutter].filter(Boolean).join(' ') || '',
      iso:      data.ISOSpeedRatings ? String(data.ISOSpeedRatings) : '',
    };
  } catch { return {}; }
}

// ─── SFTP ─────────────────────────────────────────────────────────────────────
async function getSftp() {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const sftp = new SftpClient();
  await sftp.connect({
    host: CFG.sftp.host, port: CFG.sftp.port, username: CFG.sftp.username,
    privateKey: fs.readFileSync(CFG.sftp.privateKeyPath),
  });
  return sftp;
}

async function uploadViaFTP(versions, seriesSlug, photoSlug) {
  try {
    const sftp = await getSftp();
    for (const [name, lp] of Object.entries(versions)) {
      const rp = `${CFG.sftp.remotePath}/${seriesSlug}/${name}/${photoSlug}.webp`;
      await sftp.mkdir(path.dirname(rp), true);
      await sftp.put(lp, rp);
    }
    await sftp.end();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

async function deleteViaFTP(seriesSlug, photoSlug) {
  try {
    const sftp = await getSftp();
    for (const name of ['thumb','web','zoom']) {
      const rp = `${CFG.sftp.remotePath}/${seriesSlug}/${name}/${photoSlug}.webp`;
      await sftp.delete(rp).catch(()=>{});
    }
    await sftp.end();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function buildUrls(seriesSlug, photoSlug) {
  return {
    url_thumb: `${CFG.domain}/${seriesSlug}/thumb/${photoSlug}.webp`,
    url_web:   `${CFG.domain}/${seriesSlug}/web/${photoSlug}.webp`,
    url_zoom:  `${CFG.domain}/${seriesSlug}/zoom/${photoSlug}.webp`,
  };
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#050b1a;color:#edf4ff;padding:2rem;min-height:100vh}
a{color:inherit;text-decoration:none}
h1{font-size:1.3rem;color:#748fff;margin-bottom:1.5rem}
h2{font-size:1rem;color:#748fff;margin-bottom:1rem}
.nav{display:flex;gap:.5rem;margin-bottom:2rem;flex-wrap:wrap}
.nav a{padding:.35rem 1rem;border-radius:999px;border:1px solid #243a65;font-size:.82rem;color:#9fb2d4}
.nav a.active,.nav a:hover{background:#748fff22;border-color:#748fff55;color:#748fff}
.filters{display:flex;gap:.5rem;margin-bottom:1.5rem;flex-wrap:wrap;align-items:center}
.filter-btn{padding:.3rem .85rem;border-radius:999px;border:1px solid #243a65;background:none;color:#9fb2d4;font-size:.78rem;cursor:pointer}
.filter-btn.active,.filter-btn:hover{background:#748fff22;border-color:#748fff55;color:#748fff}
.search{background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;color:#edf4ff;padding:.35rem .75rem;font-size:.82rem;width:220px}
.search:focus{outline:none;border-color:#748fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.card{background:#0f1f3d;border:1px solid #243a65;border-radius:.8rem;overflow:hidden;transition:border-color .2s;position:relative}
.card:hover{border-color:#748fff44}
.card-check{position:absolute;top:.6rem;left:.6rem;z-index:2;width:1.2rem;height:1.2rem;cursor:pointer;accent-color:#748fff}
.card-img{width:100%;aspect-ratio:3/2;object-fit:cover;display:block;background:#0a1628}
.card-body{padding:.85rem}
.card-title{font-size:.88rem;font-weight:600;margin-bottom:.4rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-meta{font-size:.75rem;color:#9fb2d4;margin-bottom:.65rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.tag{background:#748fff18;border:1px solid #748fff33;border-radius:999px;padding:.1rem .5rem;font-size:.7rem;color:#748fff;cursor:pointer}
.tag:hover{background:#748fff33}
.status-badge{border-radius:999px;padding:.1rem .55rem;font-size:.7rem;font-weight:600}
.status-published{background:#1a3d1a;color:#7aff7a}
.status-draft{background:#3d2a00;color:#ffb347}
.status-trash{background:#3d0a0a;color:#ff7a7a}
.card-actions{display:flex;gap:.5rem;flex-wrap:wrap}
.btn{padding:.3rem .8rem;border-radius:999px;border:1px solid #243a65;background:none;color:#9fb2d4;font-size:.75rem;cursor:pointer;display:inline-block}
.btn:hover{border-color:#748fff55;color:#748fff}
.btn-danger:hover{border-color:#ff4a4a55;color:#ff4a4a}
.btn-primary{background:#748fff;border-color:#748fff;color:#050b1a;font-weight:600}
.btn-primary:hover{background:#9fb2ff;color:#050b1a}
.btn-sm{padding:.2rem .6rem;font-size:.72rem}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;max-width:860px}
@media(max-width:640px){.form-grid{grid-template-columns:1fr}}
.field{display:flex;flex-direction:column;gap:.3rem}
.field.full{grid-column:1/-1}
label{font-size:.78rem;color:#9fb2d4}
input,textarea,select{background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;color:#edf4ff;padding:.5rem .75rem;font-size:.88rem;font-family:inherit;width:100%}
textarea{min-height:90px;resize:vertical}
input:focus,textarea:focus,select:focus{outline:none;border-color:#748fff}
.hint{font-size:.7rem;color:#6b7fa8}
.drop-zone{border:2px dashed #243a65;border-radius:.8rem;padding:3rem 2rem;text-align:center;cursor:pointer;transition:all .2s;color:#9fb2d4}
.drop-zone.dragover,.drop-zone:hover{border-color:#748fff;color:#748fff;background:#748fff08}
.drop-zone input[type=file]{display:none}
.upload-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:.75rem;margin-top:1rem}
.upload-thumb{aspect-ratio:1;object-fit:cover;border-radius:.5rem;border:1px solid #243a65}
.progress{height:4px;background:#243a65;border-radius:999px;margin-top:.75rem;overflow:hidden}
.progress-bar{height:100%;background:#748fff;width:0%;transition:width .3s}
.alert{border-radius:.5rem;padding:.75rem 1rem;margin-bottom:1.5rem;font-size:.85rem}
.alert-success{background:#1a3d1a;border:1px solid #2d6b2d;color:#7aff7a}
.alert-error{background:#3d0a0a;border:1px solid #6b1a1a;color:#ff7a7a}
.alert-info{background:#0f1f3d;border:1px solid #243a65;color:#9fb2d4}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(5,11,26,.85);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#0f1f3d;border:1px solid #243a65;border-radius:1rem;padding:2rem;max-width:480px;width:90%}
.modal h3{margin-bottom:.75rem;color:#edf4ff}
.modal p{color:#9fb2d4;font-size:.88rem;margin-bottom:1.5rem}
.modal-actions{display:flex;gap:.75rem;justify-content:flex-end}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1rem;margin-bottom:2rem}
.stat-card{background:#0f1f3d;border:1px solid #243a65;border-radius:.8rem;padding:1.25rem;text-align:center}
.stat-num{font-size:2rem;font-weight:700;color:#748fff}
.stat-label{font-size:.78rem;color:#9fb2d4;margin-top:.25rem}
.table{width:100%;border-collapse:collapse;font-size:.85rem}
.table th{text-align:left;padding:.5rem .75rem;color:#9fb2d4;border-bottom:1px solid #243a65;font-weight:500}
.table td{padding:.5rem .75rem;border-bottom:1px solid #1a2e52}
.table tr:hover td{background:#0f1f3d}
.batch-preview{font-family:monospace;font-size:.8rem;background:#0a1628;border:1px solid #243a65;border-radius:.5rem;padding:1rem;max-height:300px;overflow-y:auto;margin-top:1rem}
.batch-row{display:grid;grid-template-columns:1fr auto 1fr;gap:1rem;padding:.3rem 0;border-bottom:1px solid #1a2e52}
.tag-row{display:flex;align-items:center;gap:.75rem;padding:.5rem 0;border-bottom:1px solid #1a2e52}
.tag-count{font-size:.75rem;color:#9fb2d4;min-width:2rem;text-align:right}
`;

// ─── LAYOUT ───────────────────────────────────────────────────────────────────
function layout(title, content, active = '') {
  const nav = [
    ['/', 'photos', '📷 Photos'],
    ['/series', 'series', '📁 Séries'],
    ['/upload', 'upload', '⬆️ Upload'],
    ['/tags', 'tags', '🏷 Tags'],
    ['/stats', 'stats', '📊 Stats'],
    ['/settings', 'settings', '⚙️ Réglages'],
  ];
  const navLinks = nav.map(([href,id,label]) => '<a href="' + href + '" class="' + (active===id?'active':'') + '">' + label + '</a>').join('');
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><title>${title} — Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style></head><body>
<nav class="nav">${navLinks}</nav>
${content}
<div class="modal-overlay" id="modal"><div class="modal">
  <h3 id="modal-title"></h3><p id="modal-msg"></p>
  <div class="modal-actions">
    <button class="btn" onclick="closeModal()">Annuler</button>
    <button class="btn btn-danger" id="modal-confirm">Confirmer</button>
  </div>
</div></div>
<script>
function closeModal(){document.getElementById('modal').classList.remove('open')}
function openModal(t,m,fn){
  document.getElementById('modal-title').textContent=t;
  document.getElementById('modal-msg').textContent=m;
  document.getElementById('modal-confirm').onclick=fn;
  document.getElementById('modal').classList.add('open');
}
</script></body></html>`;
}

// ─── PHOTOS PAGE ──────────────────────────────────────────────────────────────
function photosPage(photos, filter='all', search='', msg='') {
  const counts = {
    all: photos.filter(p=>p.status!=='trash').length,
    published: photos.filter(p=>p.status==='published').length,
    draft: photos.filter(p=>p.status==='draft').length,
    trash: photos.filter(p=>p.status==='trash').length,
  };
  let list = filter==='trash' ? photos.filter(p=>p.status==='trash')
    : filter!=='all' ? photos.filter(p=>p.status===filter)
    : photos.filter(p=>p.status!=='trash');
  if (search) {
    const q=search.toLowerCase();
    list=list.filter(p=>p.title?.toLowerCase().includes(q)||p.tags?.some(t=>t.toLowerCase().includes(q))||p.series?.toLowerCase().includes(q));
  }
  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  const cardsHtml = list.map(p=>{
    const img=p.url_thumb||p.url_web||p.url||'';
    const st=p.status||'published';
    const imgHtml = img ? '<img class="card-img" src="' + img + '" alt="' + p.title + '" loading="lazy">' : '<div class="card-img"></div>';
    const stLabel = st==='published'?'En ligne':st==='draft'?'Brouillon':'Corbeille';
    const seriesHtml = p.series ? '<span>📁 ' + p.series + '</span>' : '';
    const tagsHtml = (p.tags||[]).slice(0,2).map(t=>'<span class="tag" onclick="window.location=\'/?filter=' + filter + '&search=' + encodeURIComponent(t) + '\'">' + t + '</span>').join('');
    const safeTitle = p.title.replace(/'/g,"\\'");
    const actionsHtml = st!=='trash'
      ? '<button type="button" class="btn btn-sm btn-danger" onclick="moveToTrash(\'' + p.file + '\',\'' + safeTitle + '\')">Corbeille</button>'
      : '<button type="button" class="btn btn-sm" onclick="restore(\'' + p.file + '\')">Restaurer</button>\n          <button type="button" class="btn btn-sm btn-danger" onclick="hardDelete(\'' + p.file + '\',\'' + safeTitle + '\')">Supprimer</button>';
    return `<div class="card">
  <input type="checkbox" class="card-check" name="sel" value="${p.file}">
  ${imgHtml}
  <div class="card-body">
    <div class="card-title" title="${p.title}">${p.title}</div>
    <div class="card-meta">
      <span class="status-badge status-${st}">${stLabel}</span>
      ${seriesHtml}
      ${tagsHtml}
    </div>
    <div class="card-actions">
      <a href="/edit/${p.file}" class="btn btn-sm">Modifier</a>
      ${actionsHtml}
    </div>
  </div></div>`;
  }).join('');
  return layout('Photos', `
<h1>Photos <span style="color:#9fb2d4;font-size:.85rem;font-weight:400">${list.length} / ${photos.length}</span></h1>
${msgHtml}
<div class="filters">
  <a href="/?filter=all" class="filter-btn ${filter==='all'?'active':''}">Tous (${counts.all})</a>
  <a href="/?filter=published" class="filter-btn ${filter==='published'?'active':''}">En ligne (${counts.published})</a>
  <a href="/?filter=draft" class="filter-btn ${filter==='draft'?'active':''}">Brouillons (${counts.draft})</a>
  <a href="/?filter=trash" class="filter-btn ${filter==='trash'?'active':''}">Corbeille (${counts.trash})</a>
  <form method="GET" style="margin-left:auto">
    <input type="hidden" name="filter" value="${filter}">
    <input class="search" type="search" name="search" placeholder="Rechercher…" value="${search}" oninput="this.form.submit()">
  </form>
</div>
<form id="batch-form">
<div style="display:flex;gap:.5rem;margin-bottom:1rem;flex-wrap:wrap">
  <button type="button" class="btn btn-sm" onclick="selectAll()">Tout sélectionner</button>
  <button type="button" class="btn btn-sm" onclick="selectNone()">Désélectionner</button>
  <button type="button" class="btn btn-sm" onclick="batchAction('publish')">→ En ligne</button>
  <button type="button" class="btn btn-sm" onclick="batchAction('draft')">→ Brouillon</button>
  <button type="button" class="btn btn-sm btn-danger" onclick="batchAction('trash')">→ Corbeille</button>
  <a href="/batch" class="btn btn-sm">Renommer par lot</a>
</div>
<div class="grid">
${cardsHtml}
</div></form>
<script>
function selectAll(){document.querySelectorAll('.card-check').forEach(c=>c.checked=true)}
function selectNone(){document.querySelectorAll('.card-check').forEach(c=>c.checked=false)}
function getSelected(){return[...document.querySelectorAll('.card-check:checked')].map(c=>c.value)}
function batchAction(action){
  const sel=getSelected();
  if(!sel.length){alert('Sélectionne au moins une photo.');return;}
  const labels={publish:'passer en ligne',draft:'mettre en brouillon',trash:'mettre à la corbeille'};
  openModal('Action par lot',sel.length+' photo(s) vont '+labels[action]+'.',()=>{
    fetch('/batch/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:sel,status:action==='publish'?'published':action})})
    .then(()=>location.reload());
  });
}
function moveToTrash(f,t){openModal('Corbeille','"'+t+'" sera masquée du site.',()=>{fetch('/action/trash/'+f,{method:'POST'}).then(()=>location.reload())})}
function restore(f){fetch('/action/restore/'+f,{method:'POST'}).then(()=>location.reload())}
function hardDelete(f,t){openModal('Suppression définitive','"'+t+'" et ses fichiers O2Switch seront supprimés.',()=>{fetch('/action/delete/'+f,{method:'POST'}).then(()=>location.reload())})}
</script>`, 'photos');
}

// ─── EDIT PAGE ────────────────────────────────────────────────────────────────
function editPage(photo, file, saved=false) {
  const tags = Array.isArray(photo.tags)?photo.tags.join(', '):(photo.tags||'');
  const series = readSeries();
  const allTags = [...new Set(readPhotos().flatMap(p=>p.tags||[]))].sort();
  const savedHtml = saved ? '<div class="alert alert-success">✓ Sauvegardé.</div>' : '';
  const thumbUrl = photo.url_thumb||photo.url_web;
  const thumbHtml = thumbUrl ? '<img src="' + thumbUrl + '" style="max-width:360px;border-radius:.5rem;margin-bottom:1.5rem;display:block">' : '';
  const seriesOptsHtml = series.map(s=>'<option value="' + s.slug + '"' + (photo.series===s.slug?' selected':'') + '>' + s.name + '</option>').join('');
  const tagsDatalistHtml = allTags.map(t=>'<option value="' + t + '">').join('');
  return layout('Modifier — ' + photo.title, `
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap">
  <a href="/" class="btn">← Retour</a>
  <h1 style="margin:0">${photo.title}</h1>
  <span class="status-badge status-${photo.status||'published'}">${photo.status==='draft'?'Brouillon':'En ligne'}</span>
</div>
${savedHtml}
${thumbHtml}
<form method="POST" action="/save/${file}">
<div class="form-grid">
  <div class="field"><label>Titre</label><input name="title" value="${photo.title||''}"></div>
  <div class="field"><label>Slug</label><input name="slug" value="${photo.slug||''}"></div>
  <div class="field"><label>Série</label><select name="series">${seriesOptsHtml}</select></div>
  <div class="field"><label>Statut</label><select name="status">
    <option value="published"${(photo.status||'published')==='published'?' selected':''}>En ligne</option>
    <option value="draft"${photo.status==='draft'?' selected':''}>Brouillon</option>
  </select></div>
  <div class="field full"><label>Description</label><textarea name="description">${photo.description||''}</textarea></div>
  <div class="field full">
    <label>Tags <span class="hint">séparés par des virgules</span></label>
    <input name="tags" value="${tags}" placeholder="lyon, sport, portrait" list="tags-dl">
    <datalist id="tags-dl">${tagsDatalistHtml}</datalist>
  </div>
  <div class="field"><label>Appareil</label><input name="exif_camera" value="${photo.exif?.camera||''}"></div>
  <div class="field"><label>Objectif</label><input name="exif_lens" value="${photo.exif?.lens||''}"></div>
  <div class="field"><label>Réglages (ex: f/2.8 1/500s)</label><input name="exif_settings" value="${photo.exif?.settings||''}"></div>
  <div class="field"><label>ISO</label><input name="exif_iso" value="${photo.exif?.iso||''}"></div>
  <div class="field"><label>Note (0–5)</label><input name="rating" type="number" min="0" max="5" step="0.1" value="${photo.rating||''}"></div>
  <div class="field"><label>Prix (€)</label><input name="price" type="number" step="0.01" value="${photo.price||''}"></div>
  <div class="field" style="justify-content:flex-end;padding-top:1.4rem">
    <label style="display:flex;gap:.5rem;align-items:center;cursor:pointer">
      <input type="checkbox" name="for_sale" value="true"${photo.for_sale?' checked':''}> À vendre
    </label>
  </div>
</div>
<div style="margin-top:1.5rem;display:flex;gap:.75rem">
  <button type="submit" class="btn btn-primary">Sauvegarder</button>
  <a href="/" class="btn">Annuler</a>
</div>
</form>`, 'photos');
}

// ─── UPLOAD PAGE ──────────────────────────────────────────────────────────────
function uploadPage(msg='', err='') {
  const series = readSeries();
  const msgHtml = msg ? '<div class="alert alert-success">' + msg + '</div>' : '';
  const errHtml = err ? '<div class="alert alert-error">' + err + '</div>' : '';
  const seriesOptsHtml = series.map(s=>'<option value="' + s.slug + '">' + s.name + '</option>').join('');
  return layout('Upload', `
<h1>Importer des photos</h1>
${msgHtml}
${errHtml}
<div class="alert alert-info">Sharp génère 3 versions WebP (thumb 500px · web 1200px · zoom 2500px). Les EXIF sont lus automatiquement.</div>
<form id="upload-form" style="max-width:640px">
  <div style="margin-bottom:1.5rem">
    <label style="display:block;margin-bottom:.5rem">Série</label>
    <select name="series" id="series-sel" required style="width:100%">
      <option value="">— Choisir une série —</option>
      ${seriesOptsHtml}
    </select>
  </div>
  <div style="margin-bottom:1.5rem">
    <label style="display:block;margin-bottom:.5rem">Statut initial</label>
    <select name="status" id="status-sel" style="width:100%">
      <option value="draft">Brouillon</option>
      <option value="published">En ligne</option>
    </select>
  </div>
  <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()">
    <input type="file" id="file-input" multiple accept="image/jpeg,image/png,image/tiff,image/webp">
    <div style="font-size:2rem;margin-bottom:.5rem">📷</div>
    <div style="font-weight:600;margin-bottom:.25rem">Glisser les photos ici</div>
    <div style="font-size:.8rem">ou cliquer — JPEG, PNG, TIFF, WebP</div>
  </div>
  <div class="upload-preview" id="preview"></div>
  <div class="progress" id="prog-wrap" style="display:none"><div class="progress-bar" id="prog-bar"></div></div>
  <div id="upload-log" style="font-size:.8rem;color:#9fb2d4;margin-top:.75rem"></div>
  <div style="margin-top:1.5rem">
    <button type="button" class="btn btn-primary" id="upload-btn" onclick="doUpload()">Importer et traiter</button>
  </div>
</form>
<script>
const drop=document.getElementById('drop-zone'),input=document.getElementById('file-input'),preview=document.getElementById('preview');
input.addEventListener('change',showPreviews);
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover')});
drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');const dt=e.dataTransfer;if(dt.files.length){const fil=dt.files;input.files=fil;showPreviews();}});
function showPreviews(){preview.innerHTML='';for(const f of input.files){const img=document.createElement('img');img.className='upload-thumb';img.src=URL.createObjectURL(f);preview.appendChild(img);}}
function doUpload(){
  const ser=document.getElementById('series-sel').value;
  const stat=document.getElementById('status-sel').value;
  if(!ser){alert('Choisis une série.');return;}
  if(!input.files.length){alert('Sélectionne des photos.');return;}
  const fd=new FormData();
  fd.append('series',ser);fd.append('status',stat);
  for(const f of input.files)fd.append('photos',f);
  const xhr=new XMLHttpRequest();xhr.open('POST','/upload');
  document.getElementById('prog-wrap').style.display='block';
  xhr.upload.onprogress=e=>{if(e.lengthComputable)document.getElementById('prog-bar').style.width=(e.loaded/e.total*100)+'%';};
  xhr.onload=()=>{
    const r=JSON.parse(xhr.responseText);
    document.getElementById('upload-log').innerHTML=r.results.map(x=>(x.ok?'✓':'✗')+' '+x.slug+(x.sftp===false?' (SFTP: config à renseigner)':'')).join('<br>');
    if(r.ok)document.getElementById('prog-bar').style.background='#7aff7a';
  };
  xhr.send(fd);
}
</script>`, 'upload');
}

// ─── SERIES PAGES ─────────────────────────────────────────────────────────────
function seriesListPage(series, msg='') {
  const photos = readPhotos();
  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  const cardsHtml = series.map(s=>{
    const count = photos.filter(p=>p.series===s.slug&&p.status!=='trash').length;
    const coverHtml = s.cover_url ? '<img class="card-img" src="' + s.cover_url + '" alt="' + s.name + '" loading="lazy">' : '<div class="card-img"></div>';
    const safeName = s.name.replace(/'/g,"\\'");
    return `<div class="card">
  ${coverHtml}
  <div class="card-body">
    <div class="card-title">${s.name}</div>
    <div class="card-meta">
      <span class="status-badge ${s.status==='draft'?'status-draft':'status-published'}">${s.status==='draft'?'Brouillon':'En ligne'}</span>
      <span>${count} photo${count>1?'s':''}</span>
    </div>
    <div class="card-actions">
      <a href="/series/edit/${s.file}" class="btn btn-sm">Modifier</a>
      <button type="button" class="btn btn-sm btn-danger" onclick="deleteSeries('${s.file}','${safeName}')">Supprimer</button>
    </div>
  </div></div>`;
  }).join('');
  return layout('Séries', `
<h1>Séries</h1>
${msgHtml}
<div style="margin-bottom:1.5rem"><a href="/series/new" class="btn btn-primary">+ Nouvelle série</a></div>
<div class="grid">
${cardsHtml}
</div>
<script>
function deleteSeries(f,n){
  openModal('Supprimer la série "'+n+'"','Que faire des photos associées ?',()=>{
    const action=document.getElementById('delete-photos-opt').checked?'delete':'detach';
    fetch('/series/delete/'+f,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}).then(()=>location.reload());
  });
  document.getElementById('modal-msg').innerHTML='<div style="margin-bottom:.75rem">Que faire des photos associées ?</div><label style="display:flex;gap:.5rem;align-items:center;cursor:pointer"><input type="checkbox" id="delete-photos-opt"> Supprimer aussi les photos</label>';
}
</script>`, 'series');
}

function seriesEditPage(serie={}, file='', msg='') {
  const isNew = !file;
  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  const pageTitle = isNew ? 'Nouvelle série' : 'Modifier — ' + serie.name;
  return layout(pageTitle, `
<div style="display:flex;gap:1rem;align-items:center;margin-bottom:1.5rem">
  <a href="/series" class="btn">← Retour</a>
  <h1 style="margin:0">${isNew?'Nouvelle série':serie.name}</h1>
</div>
${msgHtml}
<form method="POST" action="/series/save/${file}" style="max-width:640px">
<div class="form-grid">
  <div class="field"><label>Nom</label><input name="name" value="${serie.name||''}" required oninput="autoSlug(this.value)"></div>
  <div class="field"><label>Slug</label><input name="slug" id="slug-field" value="${serie.slug||''}"></div>
  <div class="field full"><label>Description</label><textarea name="description">${serie.description||''}</textarea></div>
  <div class="field full"><label>URL de la photo de couverture</label><input name="cover_url" value="${serie.cover_url||''}" placeholder="https://photos.mondomaine.fr/serie/web/photo.webp"></div>
  <div class="field"><label>Statut</label><select name="status">
    <option value="published"${(serie.status||'published')==='published'?' selected':''}>En ligne</option>
    <option value="draft"${serie.status==='draft'?' selected':''}>Brouillon</option>
  </select></div>
</div>
<div style="margin-top:1.5rem;display:flex;gap:.75rem">
  <button type="submit" class="btn btn-primary">${isNew?'Créer':'Sauvegarder'}</button>
  <a href="/series" class="btn">Annuler</a>
</div>
</form>
<script>
function autoSlug(v){
  if(document.getElementById('slug-field').dataset.manual)return;
  document.getElementById('slug-field').value=v.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
document.getElementById('slug-field').addEventListener('input',()=>document.getElementById('slug-field').dataset.manual='1');
</script>`, 'series');
}

// ─── TAGS PAGE ────────────────────────────────────────────────────────────────
function tagsPage(msg='') {
  const photos = readPhotos();
  const tagMap = {};
  photos.filter(p=>p.status!=='trash').forEach(p=>(p.tags||[]).forEach(t=>{tagMap[t]=(tagMap[t]||0)+1;}));
  const sorted = Object.entries(tagMap).sort((a,b)=>b[1]-a[1]);
  const dupes = sorted.filter(([t])=>sorted.some(([t2])=>t2!==t&&t2.toLowerCase()===t.toLowerCase()));
  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  const dupesHtml = dupes.length ? '<div class="alert alert-info">⚠️ ' + dupes.length + ' tag(s) potentiellement en doublon (casse différente).</div>' : '';
  const tagRowsHtml = sorted.map(([t,c])=>'\n    <div class="tag-row">\n      <span class="tag">' + t + '</span>\n      <span class="tag-count">' + c + ' photo' + (c>1?'s':'') + '</span>\n      <button class="btn btn-sm" onclick="fillRename(\'' + t + '\')">Renommer</button>\n    </div>').join('');
  const tagsDatalistHtml = sorted.map(([t])=>'<option value="' + t + '">').join('');

  return layout('Tags', `
<h1>Gestion des tags</h1>
${msgHtml}
${dupesHtml}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;max-width:900px">
  <div>
    <h2>${sorted.length} tags utilisés</h2>
    <div style="max-height:500px;overflow-y:auto">
    ${tagRowsHtml}
    </div>
  </div>
  <div>
    <h2>Renommer / Fusionner</h2>
    <form method="POST" action="/tags/rename" style="display:flex;flex-direction:column;gap:1rem">
      <div class="field"><label>Tag source (à renommer)</label><input name="from" id="tag-from" placeholder="ancien-tag" list="tags-dl"></div>
      <div class="field"><label>Nouveau nom</label><input name="to" placeholder="nouveau-tag"></div>
      <datalist id="tags-dl">${tagsDatalistHtml}</datalist>
      <div class="hint">Si le tag cible existe déjà, les deux seront fusionnés.</div>
      <button type="submit" class="btn btn-primary">Appliquer sur toutes les photos</button>
    </form>
  </div>
</div>
<script>
function fillRename(t){document.getElementById('tag-from').value=t;}
</script>`, 'tags');
}

// ─── BATCH RENAME PAGE ────────────────────────────────────────────────────────
function batchPage(photos) {
  const series = readSeries();
  const seriesOptsHtml = series.map(s=>'<option value="' + s.slug + '">' + s.name + '</option>').join('');
  return layout('Renommer par lot', `
<div style="display:flex;gap:1rem;align-items:center;margin-bottom:1.5rem">
  <a href="/" class="btn">← Retour</a>
  <h1 style="margin:0">Renommer par lot</h1>
</div>
<div style="max-width:700px">
  <div class="form-grid" style="margin-bottom:1.5rem">
    <div class="field">
      <label>Série à renommer</label>
      <select id="batch-series" onchange="updatePreview()">
        <option value="">— Toutes —</option>
        ${seriesOptsHtml}
      </select>
    </div>
    <div class="field">
      <label>Masque <span class="hint">{serie} {date} {index} {titre}</span></label>
      <input id="batch-mask" value="{serie}_{date}_{index}" oninput="updatePreview()">
    </div>
    <div class="field">
      <label>Préfixe (optionnel)</label>
      <input id="batch-prefix" placeholder="ex: stan_" oninput="updatePreview()">
    </div>
    <div class="field">
      <label>Suffixe (optionnel)</label>
      <input id="batch-suffix" placeholder="ex: _2024" oninput="updatePreview()">
    </div>
  </div>
  <div class="batch-preview" id="batch-preview"><em style="color:#6b7fa8">Sélectionne une série pour voir l'aperçu…</em></div>
  <div style="margin-top:1.5rem;display:flex;gap:.75rem">
    <button class="btn btn-primary" onclick="applyRename()">Appliquer le renommage</button>
    <a href="/" class="btn">Annuler</a>
  </div>
</div>
<script>
const photos=${JSON.stringify(photos.map(p=>({file:p.file,title:p.title,slug:p.slug,series:p.series,date:p.date})))};
function slugify(s){return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function buildSlug(p,mask,prefix,suffix,idx){
  let s=mask
    .replace('{serie}',p.series||'')
    .replace('{date}',(p.date||'').toString().slice(0,10).replace(/-/g,''))
    .replace('{index}',String(idx+1).padStart(3,'0'))
    .replace('{titre}',slugify(p.title||''));
  return slugify(prefix+s+suffix);
}
function updatePreview(){
  const serie=document.getElementById('batch-series').value;
  const mask=document.getElementById('batch-mask').value;
  const prefix=document.getElementById('batch-prefix').value;
  const suffix=document.getElementById('batch-suffix').value;
  const list=serie?photos.filter(p=>p.series===serie):photos;
  document.getElementById('batch-preview').innerHTML=list.slice(0,20).map((p,i)=>{
    const newSlug=buildSlug(p,mask,prefix,suffix,i);
    return '<div class="batch-row"><span style="color:#9fb2d4">'+p.slug+'</span><span>→</span><span style="color:#748fff">'+newSlug+'</span></div>';
  }).join('')+(list.length>20?'<div style="color:#6b7fa8;padding:.5rem 0">…et '+(list.length-20)+' de plus</div>':'');
}
function applyRename(){
  const serie=document.getElementById('batch-series').value;
  const mask=document.getElementById('batch-mask').value;
  const prefix=document.getElementById('batch-prefix').value;
  const suffix=document.getElementById('batch-suffix').value;
  const list=serie?photos.filter(p=>p.series===serie):photos;
  const renames=list.map((p,i)=>({file:p.file,newSlug:buildSlug(p,mask,prefix,suffix,i)}));
  openModal('Renommer '+renames.length+' photo(s)','Cette action modifie les slugs et noms de fichiers YAML.',()=>{
    fetch('/batch/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({renames})})
    .then(()=>window.location.href='/?saved=Renommage+appliqué');
  });
}
</script>`, 'photos');
}

// ─── STATS PAGE ───────────────────────────────────────────────────────────────
function statsPage(photos, series, views) {
  const pub=photos.filter(p=>p.status==='published').length;
  const draft=photos.filter(p=>p.status==='draft').length;
  const trash=photos.filter(p=>p.status==='trash').length;
  const totalViews=Object.values(views).reduce((a,b)=>a+b,0);
  const topViewed=photos.filter(p=>views[p.slug]).sort((a,b)=>(views[b.slug]||0)-(views[a.slug]||0)).slice(0,10);
  const topRated=photos.filter(p=>p.rating).sort((a,b)=>b.rating-a.rating).slice(0,10);
  const bySeries=series.map(s=>({...s,count:photos.filter(p=>p.series===s.slug&&p.status!=='trash').length})).sort((a,b)=>b.count-a.count);
  const allTags=[...new Set(photos.flatMap(p=>p.tags||[]))];

  const bySeriesRowsHtml = bySeries.map(s=>'<tr><td>' + s.name + '</td><td>' + s.count + '</td><td><span class="status-badge status-' + (s.status||'published') + '">' + (s.status==='draft'?'Brouillon':'En ligne') + '</span></td></tr>').join('');
  const topRatedRowsHtml = topRated.map(p=>'<tr><td><a href="/edit/' + p.file + '" style="color:#748fff">' + p.title + '</a></td><td>⭐ ' + p.rating + '</td></tr>').join('') || '<tr><td colspan="2" style="color:#6b7fa8">Aucune note renseignée</td></tr>';
  const topViewedRowsHtml = topViewed.map(p=>'<tr><td><a href="/edit/' + p.file + '" style="color:#748fff">' + p.title + '</a></td><td>' + views[p.slug] + '</td><td>' + (p.series||'—') + '</td></tr>').join('');
  const topViewedHtml = topViewed.length ? '<div style="grid-column:1/-1">\n    <h2>Photos les plus vues</h2>\n    <table class="table">\n      <tr><th>Photo</th><th>Vues</th><th>Série</th></tr>\n      ' + topViewedRowsHtml + '\n    </table>\n  </div>' : '';
  return layout('Statistiques', `
<h1>Statistiques</h1>
<div class="stat-grid">
  <div class="stat-card"><div class="stat-num">${photos.filter(p=>p.status!=='trash').length}</div><div class="stat-label">Photos totales</div></div>
  <div class="stat-card"><div class="stat-num" style="color:#7aff7a">${pub}</div><div class="stat-label">En ligne</div></div>
  <div class="stat-card"><div class="stat-num" style="color:#ffb347">${draft}</div><div class="stat-label">Brouillons</div></div>
  <div class="stat-card"><div class="stat-num">${series.length}</div><div class="stat-label">Séries</div></div>
  <div class="stat-card"><div class="stat-num">${allTags.length}</div><div class="stat-label">Tags uniques</div></div>
  <div class="stat-card"><div class="stat-num">${totalViews.toLocaleString()}</div><div class="stat-label">Vues totales</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;flex-wrap:wrap">
  <div>
    <h2>Par série</h2>
    <table class="table">
      <tr><th>Série</th><th>Photos</th><th>Statut</th></tr>
      ${bySeriesRowsHtml}
    </table>
  </div>
  <div>
    <h2>Meilleures notes</h2>
    <table class="table">
      <tr><th>Photo</th><th>Note</th></tr>
      ${topRatedRowsHtml}
    </table>
  </div>
  ${topViewedHtml}
</div>`, 'stats');
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function settingsPage(settings, msg='') {
  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  return layout('Réglages', `
<h1>Réglages du site</h1>
${msgHtml}
<form method="POST" action="/settings/save" style="max-width:640px">
<div class="form-grid">
  <div class="field full"><label>Titre du site</label><input name="site_title" value="${settings.site_title||''}"></div>
  <div class="field full"><label>Nom watermark</label><input name="watermark_name" value="${settings.watermark_name||''}"></div>
  <div class="field full">
    <label>Texte d'introduction (page d'accueil) <span class="hint">Markdown supporté</span></label>
    <textarea name="about_text" style="min-height:160px">${settings.about_text||''}</textarea>
  </div>
  <div class="field full"><label>Domaine images O2Switch <span class="hint">Sans slash final</span></label><input name="images_domain" value="${settings.images_domain||CFG.domain}" placeholder="https://photos.mondomaine.fr"></div>
</div>
<div style="margin-top:1.5rem"><button type="submit" class="btn btn-primary">Sauvegarder</button></div>
</form>`, 'settings');
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CFG.port}`);
  const p = url.pathname;

  const html = (content) => { res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); res.end(content); };
  const json = (data, code=200) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const redirect = (loc) => { res.writeHead(302,{Location:loc}); res.end(); };

  // ── Photos list
  if (req.method==='GET' && p==='/') {
    html(photosPage(readPhotos(), url.searchParams.get('filter')||'all', url.searchParams.get('search')||'', url.searchParams.get('saved')||''));

  // ── Edit photo
  } else if (req.method==='GET' && p.startsWith('/edit/')) {
    const file=path.basename(p.slice(6));
    const fp=path.join(CFG.photosDir,file);
    if(!fs.existsSync(fp)){res.writeHead(404);res.end('Not found');return;}
    html(editPage(readYaml(fp), file, url.searchParams.get('saved')==='1'));

  // ── Save photo
  } else if (req.method==='POST' && p.startsWith('/save/')) {
    const file=path.basename(p.slice(6));
    const body=await parseBody(req);
    const tags=body.tags?body.tags.split(',').map(t=>t.trim()).filter(Boolean):[];
    savePhoto(file,{
      title:body.title, slug:body.slug, series:body.series,
      description:body.description||'', tags, status:body.status||'published',
      rating:body.rating?parseFloat(body.rating):undefined,
      price:body.price?parseFloat(body.price):undefined,
      for_sale:body.for_sale==='true',
      exif:{camera:body.exif_camera||undefined,lens:body.exif_lens||undefined,settings:body.exif_settings||undefined,iso:body.exif_iso||undefined}
    });
    redirect(`/edit/${file}?saved=1`);

  // ── Actions trash/restore/delete
  } else if (req.method==='POST' && p.startsWith('/action/')) {
    const parts=p.split('/');
    const action=parts[2], file=parts.slice(3).join('/');
    const fp=path.join(CFG.photosDir,file);
    if(!fs.existsSync(fp)){json({ok:false},404);return;}
    if(action==='trash') savePhoto(file,{status:'trash'});
    else if(action==='restore') savePhoto(file,{status:'draft'});
    else if(action==='delete') {
      const photo=readYaml(fp);
      fs.unlinkSync(fp);
      if(photo.slug&&photo.series) deleteViaFTP(photo.series,photo.slug).catch(()=>{});
    }
    json({ok:true});

  // ── Batch status
  } else if (req.method==='POST' && p==='/batch/status') {
    const body=await new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(JSON.parse(b)));});
    for(const file of body.files){
      const fp=path.join(CFG.photosDir,file);
      if(fs.existsSync(fp)) savePhoto(file,{status:body.status});
    }
    json({ok:true});

  // ── Batch rename
  } else if (req.method==='POST' && p==='/batch/rename') {
    const body=await new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(JSON.parse(b)));});
    for(const {file,newSlug} of body.renames) {
      const fp=path.join(CFG.photosDir,file);
      if(!fs.existsSync(fp)) continue;
      const data=readYaml(fp);
      data.slug=newSlug;
      data.title=newSlug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
      const newFile=`${newSlug}.yaml`;
      writeYaml(path.join(CFG.photosDir,newFile),data);
      if(newFile!==file) fs.unlinkSync(fp);
    }
    json({ok:true});

  // ── Upload page
  } else if (req.method==='GET' && p==='/upload') {
    html(uploadPage(url.searchParams.get('done')?'Photos importées avec succès.':''));

  // ── Upload handler
  } else if (req.method==='POST' && p==='/upload') {
    try {
      const {fields,files}=await parseUpload(req);
      const seriesSlug=fields.series, status=fields.status||'draft';
      if(!seriesSlug){res.writeHead(400);res.end('Série manquante');return;}
      const results=[];
      for(const file of files){
        const photoSlug=slugify(path.parse(file.filename).name);
        try{
          const [versions, exif]=await Promise.all([processImage(file.path,seriesSlug,photoSlug), readExif(file.path)]);
          const sftpRes=await uploadViaFTP(versions,seriesSlug,photoSlug);
          const urls=buildUrls(seriesSlug,photoSlug);
          const yamlFile=`${seriesSlug}-${photoSlug}.yaml`;
          writeYaml(path.join(CFG.photosDir,yamlFile),{
            title:photoSlug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),
            slug:photoSlug, series:seriesSlug, status,
            url:urls.url_web, url_thumb:urls.url_thumb, url_web:urls.url_web, url_zoom:urls.url_zoom,
            date:new Date().toISOString().split('T')[0],
            description:'', tags:[],
            ...(Object.values(exif).some(Boolean)?{exif}:{}),
          });
          fs.unlinkSync(file.path);
          results.push({slug:photoSlug,ok:true,sftp:sftpRes.ok});
        } catch(e){results.push({slug:photoSlug,ok:false,error:e.message});}
      }
      json({ok:true,results});
    } catch(e){json({ok:false,error:e.message},500);}

  // ── Series list
  } else if (req.method==='GET' && p==='/series') {
    html(seriesListPage(readSeries(), url.searchParams.get('saved')||''));

  // ── New series
  } else if (req.method==='GET' && p==='/series/new') {
    html(seriesEditPage());

  // ── Edit series
  } else if (req.method==='GET' && p.startsWith('/series/edit/')) {
    const file=path.basename(p.slice(13));
    const fp=path.join(CFG.seriesDir,file);
    if(!fs.existsSync(fp)){res.writeHead(404);res.end('Not found');return;}
    html(seriesEditPage(readYaml(fp),file,url.searchParams.get('saved')?'Série sauvegardée.':''));

  // ── Save series
  } else if (req.method==='POST' && p.startsWith('/series/save/')) {
    const file=path.basename(p.slice(13));
    const body=await parseBody(req);
    const isNew=!file||file==='new';
    const slug=body.slug||slugify(body.name);
    const data={name:body.name,slug,description:body.description||'',cover_url:body.cover_url||'',status:body.status||'published',published:body.status!=='draft'};
    const outFile=isNew?`${slug}.yaml`:file;
    writeYaml(path.join(CFG.seriesDir,outFile),data);
    redirect(`/series/edit/${outFile}?saved=1`);

  // ── Delete series
  } else if (req.method==='POST' && p.startsWith('/series/delete/')) {
    const file=path.basename(p.slice(15));
    const body=await new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(JSON.parse(b)));});
    const fp=path.join(CFG.seriesDir,file);
    if(!fs.existsSync(fp)){json({ok:false},404);return;}
    const serie=readYaml(fp);
    if(body.action==='delete'){
      const photos=readPhotos().filter(p=>p.series===serie.slug);
      for(const photo of photos){
        fs.unlinkSync(path.join(CFG.photosDir,photo.file));
        if(photo.slug) deleteViaFTP(serie.slug,photo.slug).catch(()=>{});
      }
    } else {
      const photos=readPhotos().filter(p=>p.series===serie.slug);
      for(const photo of photos) savePhoto(photo.file,{series:''});
    }
    fs.unlinkSync(fp);
    json({ok:true});

  // ── Tags page
  } else if (req.method==='GET' && p==='/tags') {
    html(tagsPage(url.searchParams.get('saved')||''));

  // ── Rename/merge tags
  } else if (req.method==='POST' && p==='/tags/rename') {
    const body=await parseBody(req);
    const from=(body.from||'').trim(), to=(body.to||'').trim();
    if(from&&to){
      const photos=readPhotos();
      for(const photo of photos){
        const tags=(photo.tags||[]);
        if(tags.includes(from)){
          const newTags=[...new Set(tags.map(t=>t===from?to:t))];
          savePhoto(photo.file,{tags:newTags});
        }
      }
    }
    redirect('/tags?saved=Tag+renommé+sur+toutes+les+photos');

  // ── Batch rename page
  } else if (req.method==='GET' && p==='/batch') {
    html(batchPage(readPhotos()));

  // ── Stats
  } else if (req.method==='GET' && p==='/stats') {
    html(statsPage(readPhotos(),readSeries(),readViews()));

  // ── API: increment view
  } else if (req.method==='POST' && p.startsWith('/api/view/')) {
    const slug=p.slice(10);
    const views=readViews();
    views[slug]=(views[slug]||0)+1;
    saveViews(views);
    json({ok:true,views:views[slug]});

  // ── Settings
  } else if (req.method==='GET' && p==='/settings') {
    html(settingsPage(readSettings(), url.searchParams.get('saved')||''));

  } else if (req.method==='POST' && p==='/settings/save') {
    const body=await parseBody(req);
    const current=readSettings();
    writeYaml(CFG.settingsFile,{...current,site_title:body.site_title,watermark_name:body.watermark_name,about_text:body.about_text,images_domain:body.images_domain});
    redirect('/settings?saved=1');

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

[CFG.tmpDir,CFG.processDir].forEach(d=>fs.mkdirSync(d,{recursive:true}));

server.listen(CFG.port,()=>{
  console.log(`\n  ┌──────────────────────────────────────┐`);
  console.log(`  │  Admin → http://localhost:${CFG.port}         │`);
  console.log(`  └──────────────────────────────────────┘\n`);
});
