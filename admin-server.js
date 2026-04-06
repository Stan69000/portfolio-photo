import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { readFileSync } from "fs";
// charge .env manuellement (pas de dep dotenv)
try { const envLines = readFileSync(new URL(".env", import.meta.url)).toString().split("\n"); for (const l of envLines) { const [k,...v]=l.split("="); if(k&&v.length) process.env[k.trim()]=v.join("=").trim(); } } catch {}
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
  domain:      'http://photos.bost7423.odns.fr',  // URL temporaire O2Switch
  ftp: {
    host:       'ftp.bost7423.odns.fr',
    port:       21,
    username:   'photo@stan-bouchet.eu',
    password:   process.env.FTP_PASSWORD || '',  // défini dans .env
    remotePath: '/',                    // racine du compte FTP photo@stan-bouchet.eu
    secure:     false,                           // passer à true si TLS disponible
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

function autoGitPush(msg) {
  try {
    execSync('git add -A src/content/', { cwd: __dirname, stdio: 'pipe' });
    // vérifie qu'il y a quelque chose à commiter
    const diff = execSync('git diff --cached --name-only', { cwd: __dirname }).toString().trim();
    if (!diff) return 'nothing';
    execSync(`git commit -m "${msg.replace(/"/g, "'")}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push origin main', { cwd: __dirname, stdio: 'pipe' });
    return 'ok';
  } catch(e) {
    console.error('autoGitPush error:', e.message);
    return 'error';
  }
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
    const pending = [];
    fs.mkdirSync(CFG.tmpDir, { recursive: true });
    bb.on('field', (k,v) => { fields[k]=v; });
    bb.on('file', (name, stream, info) => {
      const tmp = path.join(CFG.tmpDir, `${Date.now()}-${info.filename}`);
      const ws = fs.createWriteStream(tmp);
      stream.pipe(ws);
      const done = new Promise((res, rej) => {
        ws.on('finish', () => { files.push({ path: tmp, filename: info.filename, mime: info.mimeType }); res(); });
        ws.on('error', rej);
      });
      pending.push(done);
    });
    bb.on('close', () => Promise.all(pending).then(() => resolve({ fields, files })).catch(reject));
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
    await sharp(src).rotate().resize({ width: cfg.width, withoutEnlargement: true }).webp({ quality: cfg.quality }).toFile(out);
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

// ─── FTP ──────────────────────────────────────────────────────────────────────
async function getFtp() {
  const { Client } = await import('basic-ftp');
  const client = new Client();
  await client.access({
    host:     CFG.ftp.host,
    port:     CFG.ftp.port,
    user:     CFG.ftp.username,
    password: CFG.ftp.password,
    secure:   CFG.ftp.secure,
  });
  return client;
}

async function uploadViaFTP(versions, seriesSlug, photoSlug) {
  if (!CFG.ftp.password) return { ok: false, error: 'Mot de passe FTP non configuré' };
  try {
    const ftp = await getFtp();
    for (const [name, lp] of Object.entries(versions)) {
      const remoteDir = `${CFG.ftp.remotePath}/${seriesSlug}/${name}`;
      await ftp.ensureDir(remoteDir);
      await ftp.uploadFrom(lp, `${remoteDir}/${photoSlug}.webp`);
    }
    ftp.close();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

async function deleteViaFTP(seriesSlug, photoSlug) {
  if (!CFG.ftp.password) return { ok: false };
  try {
    const ftp = await getFtp();
    for (const name of ['thumb','web','zoom']) {
      const rp = `${CFG.ftp.remotePath}/${seriesSlug}/${name}/${photoSlug}.webp`;
      await ftp.remove(rp).catch(()=>{});
    }
    ftp.close();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function buildUrls(seriesSlug, photoSlug) {
  const domain = (readSettings().images_domain || CFG.domain).replace(/\/$/, '');
  return {
    url_thumb: `${domain}/${seriesSlug}/thumb/${photoSlug}.webp`,
    url_web:   `${domain}/${seriesSlug}/web/${photoSlug}.webp`,
    url_zoom:  `${domain}/${seriesSlug}/zoom/${photoSlug}.webp`,
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
.upload-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,120px));gap:.75rem;margin-top:1rem;max-width:640px}
.upload-thumb{width:120px;height:120px;object-fit:cover;border-radius:.5rem;border:1px solid #243a65;display:block}
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
.stat-card{background:#0f1f3d;border:1px solid #243a65;border-radius:.8rem;padding:1.25rem;text-align:center;transition:border-color .2s,background .2s}
.stat-card.clickable{cursor:pointer}
.stat-card.clickable:hover{border-color:#748fff55;background:#142240}
.stat-card.active{border-color:#748fff;background:#1a2e52}
.stat-num{font-size:2rem;font-weight:700;color:#748fff}
.stat-label{font-size:.78rem;color:#9fb2d4;margin-top:.25rem}
.lb-overlay{display:none;position:fixed;inset:0;background:rgba(5,11,26,.93);z-index:300;align-items:center;justify-content:center;cursor:zoom-out}
.lb-overlay.open{display:flex}
.lb-overlay img{max-width:92vw;max-height:92vh;border-radius:.5rem;object-fit:contain;box-shadow:0 0 60px rgba(0,0,0,.8)}
.table{width:100%;border-collapse:collapse;font-size:.85rem}
.table th{text-align:left;padding:.5rem .75rem;color:#9fb2d4;border-bottom:1px solid #243a65;font-weight:500}
.table td{padding:.5rem .75rem;border-bottom:1px solid #1a2e52}
.table tr:hover td{background:#0f1f3d}
.batch-preview{font-family:monospace;font-size:.8rem;background:#0a1628;border:1px solid #243a65;border-radius:.5rem;padding:1rem;max-height:300px;overflow-y:auto;margin-top:1rem}
.batch-row{display:grid;grid-template-columns:1fr auto 1fr;gap:1rem;padding:.3rem 0;border-bottom:1px solid #1a2e52}
.tag-row{display:flex;align-items:center;gap:.75rem;padding:.5rem 0;border-bottom:1px solid #1a2e52}
.tag-count{font-size:.75rem;color:#9fb2d4;min-width:2rem;text-align:right}
.ti-wrap{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;padding:.4rem .6rem;cursor:text;min-height:2.4rem}
.ti-wrap:focus-within{border-color:#748fff}
.ti-chip{display:inline-flex;align-items:center;gap:.3rem;background:#748fff22;border:1px solid #748fff44;border-radius:999px;padding:.15rem .55rem;font-size:.78rem;color:#9fb2ff;white-space:nowrap}
.ti-chip button{background:none;border:none;color:#748fff;cursor:pointer;font-size:.9rem;line-height:1;padding:0;display:flex;align-items:center}
.ti-chip button:hover{color:#ff7a7a}
.ti-input{background:none;border:none;outline:none;color:#edf4ff;font-size:.85rem;font-family:inherit;min-width:80px;flex:1}
`;

// ─── TAG INPUT WIDGET ─────────────────────────────────────────────────────────
// Génère un widget chips pour saisir plusieurs tags
// inputName : nom du champ hidden soumis avec le formulaire
// currentTags : tableau de strings
// allTags : suggestions (datalist)
// id : identifiant unique (pour avoir plusieurs widgets par page)
function tagInputWidget(inputName, currentTags, allTags, id='ti') {
  const tagsJson = JSON.stringify(currentTags);
  const dlId = id + '-dl';
  const suggestions = allTags.map(t => '<option value="' + t.replace(/"/g,'&quot;') + '">').join('');
  return `
<div class="ti-wrap" id="${id}-wrap" onclick="document.getElementById('${id}-input').focus()">
  <div id="${id}-chips" style="display:contents"></div>
  <input class="ti-input" id="${id}-input" list="${dlId}" placeholder="Ajouter un tag…" autocomplete="off">
  <datalist id="${dlId}">${suggestions}</datalist>
</div>
<input type="hidden" name="${inputName}" id="${id}-hidden">
<script>
(function(){
  const id='${id}';
  let tags=${tagsJson};
  const hidden=document.getElementById(id+'-hidden');
  const input=document.getElementById(id+'-input');
  function render(){
    document.getElementById(id+'-chips').innerHTML=tags.map((t,i)=>
      '<span class="ti-chip">'+t.replace(/</g,'&lt;')+'<button type="button" onclick="window[\\'tiRemove_'+id+'\\']('+(i)+')">×</button></span>'
    ).join('');
    hidden.value=tags.join(',');
  }
  window['tiRemove_'+id]=function(i){tags.splice(i,1);render();};
  function addTag(v){
    const t=v.trim();
    if(t&&!tags.includes(t)){tags.push(t);}
    input.value='';
    render();
  }
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===','){e.preventDefault();addTag(input.value);}
    if(e.key==='Backspace'&&input.value===''&&tags.length){tags.pop();render();}
  });
  input.addEventListener('blur',()=>{if(input.value.trim())addTag(input.value);});
  input.addEventListener('input',()=>{if(input.value.endsWith(','))addTag(input.value.slice(0,-1));});
  render();
})();
</script>`;
}

// ─── LAYOUT ───────────────────────────────────────────────────────────────────
function layout(title, content, active = '') {
  const nav = [
    ['https://stan-bouchet.eu/', 'home', '🏠 Accueil', true],
    ['/', 'adminhome', '⬅ Admin', false],
    ['/', 'photos', '📷 Photos', false],
    ['/series', 'series', '📁 Séries', false],
    ['/upload', 'upload', '⬆️ Upload', false],
    ['/tags', 'tags', '🏷 Tags', false],
    ['/stats', 'stats', '📊 Stats', false],
    ['/settings', 'settings', '⚙️ Réglages', false],
  ];
  const navLinks = nav.map(([href,id,label,ext]) => '<a href="' + href + '"' + (ext?' target="_blank"':'') + ' class="' + (active===id?'active':'') + '">' + label + '</a>').join('');
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
  ${filter==='trash' ? '<button type="button" class="btn btn-sm btn-danger" onclick="batchDelete()">🗑 Supprimer définitivement</button>' : ''}
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
function batchDelete(){
  const sel=getSelected();
  if(!sel.length){alert('Sélectionne au moins une photo.');return;}
  openModal('Suppression définitive',sel.length+' photo(s) et leurs fichiers O2Switch seront supprimés. Irréversible.',()=>{
    fetch('/batch/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:sel})})
    .then(()=>location.reload());
  });
}
</script>`, 'photos');
}

// ─── EDIT PAGE ────────────────────────────────────────────────────────────────
function editPage(photo, file, saved=false) {
  const currentTags = Array.isArray(photo.tags) ? photo.tags : (photo.tags ? [photo.tags] : []);
  const series = readSeries();
  const allTags = [...new Set(readPhotos().flatMap(p=>p.tags||[]))].sort();
  const savedHtml = saved ? '<div class="alert alert-success">✓ Sauvegardé.</div>' : '';
  const thumbUrl = photo.url_thumb||photo.url_web;
  const thumbHtml = thumbUrl ? '<img src="' + thumbUrl + '" style="max-width:360px;border-radius:.5rem;margin-bottom:1.5rem;display:block">' : '';
  const seriesOptsHtml = series.map(s=>'<option value="' + s.slug + '"' + (photo.series===s.slug?' selected':'') + '>' + s.name + '</option>').join('');
  const tagsWidget = tagInputWidget('tags', currentTags, allTags, 'ti-photo');
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
    <label>Tags</label>
    ${tagsWidget}
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
  <div id="upload-summary" style="display:none;margin-top:.75rem;display:none;gap:.5rem;flex-wrap:wrap;align-items:center"></div>
  <div id="upload-log" style="font-size:.8rem;color:#9fb2d4;margin-top:.5rem"></div>
  <div style="margin-top:1.5rem">
    <button type="button" class="btn btn-primary" id="upload-btn" onclick="doUpload()">Importer et traiter</button>
  </div>
</form>
<div class="lb-overlay" id="lb-overlay" onclick="this.classList.remove('open')">
  <img id="lb-img" src="" alt="">
</div>
<script>
const drop=document.getElementById('drop-zone'),input=document.getElementById('file-input'),preview=document.getElementById('preview');
input.addEventListener('change',showPreviews);
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover')});
drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');const dt=e.dataTransfer;if(dt.files.length){const fil=dt.files;input.files=fil;showPreviews();}});
function openLb(src){document.getElementById('lb-img').src=src;document.getElementById('lb-overlay').classList.add('open');}
function showPreviews(){
  preview.innerHTML='';
  for(const f of input.files){
    const src=URL.createObjectURL(f);
    const wrap=document.createElement('div');
    wrap.style.cssText='position:relative;width:120px;height:120px;flex-shrink:0;cursor:zoom-in';
    wrap.title='Cliquer pour agrandir — '+f.name;
    const img=document.createElement('img');
    img.style.cssText='width:120px;height:120px;object-fit:cover;border-radius:.5rem;border:1px solid #243a65;display:block;transition:opacity .15s';
    img.src=src;
    img.onmouseenter=()=>{img.style.opacity='.75';};
    img.onmouseleave=()=>{img.style.opacity='1';};
    wrap.onclick=()=>openLb(src);
    wrap.appendChild(img);
    preview.appendChild(wrap);
  }
}
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
    const ok=r.results.filter(x=>x.ok).length;
    const fail=r.results.filter(x=>!x.ok).length;
    const sum=document.getElementById('upload-summary');
    sum.style.display='flex';
    sum.innerHTML=
      (ok ? '<span style="background:#1a3d1a;border:1px solid #2d6b2d;color:#7aff7a;border-radius:.5rem;padding:.35rem .85rem;font-size:.88rem;font-weight:600">✓ '+ok+' réussi'+(ok>1?'s':'')+'</span>' : '')+
      (fail ? '<span style="background:#3d0a0a;border:1px solid #6b1a1a;color:#ff7a7a;border-radius:.5rem;padding:.35rem .85rem;font-size:.88rem;font-weight:600">✗ '+fail+' échec'+(fail>1?'s':'')+'</span>' : '')+
      (r.gitStatus==='deploy' ? '<span style="background:#0f1f3d;border:1px solid #243a65;color:#748fff;border-radius:.5rem;padding:.35rem .85rem;font-size:.88rem">🚀 Déploiement en cours (~2 min)</span>' : '')+
      (r.gitStatus==='git-error' ? '<span style="background:#3d2a00;border:1px solid #6b4a00;color:#ffb347;border-radius:.5rem;padding:.35rem .85rem;font-size:.88rem">⚠️ Git push échoué</span>' : '');
    const lines=r.results.map(x=>'<span style="color:'+(x.ok?'#9fb2d4':'#ff7a7a')+'">'+(x.ok?'✓':'✗')+' '+x.slug+(x.ok&&x.sftp===false?' <em style="color:#ffb347">(FTP: échec)</em>':'')+'</span>').join('<br>');
    document.getElementById('upload-log').innerHTML=lines;
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
  const currentTags = Array.isArray(serie.tags) ? serie.tags : (serie.tags ? [serie.tags] : []);
  const allPhotoTags = [...new Set(readPhotos().flatMap(p=>p.tags||[]))].sort();
  const tagsWidget = tagInputWidget('tags', currentTags, allPhotoTags, 'ti-serie');
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
  <div class="field full">
    <label>Tags</label>
    ${tagsWidget}
  </div>
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
  const allSeries = readSeries();

  // photo data payload for JS (non-trash)
  const photoData = photos.filter(p=>p.status!=='trash').map(p=>({
    file:p.file, title:p.title, series:p.series||'',
    tags:p.tags||[], thumb:p.url_thumb||p.url_web||''
  }));

  // global tag stats
  const tagMap = {};
  photoData.forEach(p=>p.tags.forEach(t=>{const k=t.trim();if(k)tagMap[k]=(tagMap[k]||0)+1;}));
  const sorted = Object.entries(tagMap).sort((a,b)=>b[1]-a[1]);
  const dupes = sorted.filter(([t])=>sorted.some(([t2])=>t2!==t&&t2.toLowerCase()===t.toLowerCase()));

  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  const dupesHtml = dupes.length ? '<div class="alert alert-info">⚠️ ' + dupes.length + ' tag(s) potentiellement en doublon (casse différente).</div>' : '';
  const seriesOptsHtml = allSeries.map(s=>'<option value="' + s.slug + '">' + s.name + '</option>').join('');
  const tagsDatalistHtml = sorted.map(([t])=>'<option value="' + t + '">').join('');
  const photoDataJson = JSON.stringify(photoData);

  return layout('Tags', `
<h1>Gestion des tags</h1>
${msgHtml}
${dupesHtml}
<div style="display:flex;gap:.75rem;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap">
  <label style="font-size:.82rem;color:#9fb2d4">Filtrer :</label>
  <select id="filter-series" onchange="filterTags()" style="background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;color:#edf4ff;padding:.35rem .75rem;font-size:.82rem">
    <option value="">— Toutes les séries —</option>
    ${seriesOptsHtml}
  </select>
  <input type="search" id="filter-photo" placeholder="Titre ou tag…" oninput="filterTags()"
    style="background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;color:#edf4ff;padding:.35rem .75rem;font-size:.82rem;width:200px">
  <span id="filter-badge" style="font-size:.78rem;color:#748fff"></span>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;max-width:960px">
  <div>
    <h2>Tags — <span id="tags-count" style="font-weight:400;font-size:.85rem;color:#9fb2d4"></span></h2>
    <div style="max-height:520px;overflow-y:auto" id="tag-list"></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:2rem">
    <div>
      <h2>Renommer / Fusionner</h2>
      <form method="POST" action="/tags/rename" style="display:flex;flex-direction:column;gap:1rem">
        <div class="field"><label>Tag source</label><input name="from" id="tag-from" placeholder="ancien-tag" list="tags-dl"></div>
        <div class="field"><label>Nouveau nom</label><input name="to" placeholder="nouveau-tag"></div>
        <datalist id="tags-dl">${tagsDatalistHtml}</datalist>
        <div class="hint">Si le tag cible existe déjà, les deux seront fusionnés.</div>
        <button type="submit" class="btn btn-primary">Appliquer sur toutes les photos</button>
      </form>
    </div>
    <div id="photo-tag-editor" style="display:none;background:#0f1f3d;border:1px solid #243a65;border-radius:.8rem;padding:1rem">
      <h2 style="margin-bottom:.5rem">Éditer les tags</h2>
      <div id="photo-tag-info" style="font-size:.82rem;color:#9fb2d4;margin-bottom:.75rem"></div>
      <div class="field" style="margin-bottom:.75rem">
        <label>Tags <span class="hint">séparés par virgule</span></label>
        <input id="photo-tags-input" placeholder="tag1, tag2" list="tags-dl">
      </div>
      <div style="display:flex;gap:.5rem">
        <button type="button" class="btn btn-primary btn-sm" onclick="savePhotoTags()">Sauvegarder</button>
        <button type="button" class="btn btn-sm" onclick="closePhotoEditor()">Fermer</button>
      </div>
      <div id="photo-tag-msg" style="font-size:.78rem;margin-top:.5rem"></div>
    </div>
  </div>
</div>
<script>
const photoData=${photoDataJson};
let editingFile=null;
function getFiltered(){
  const serie=document.getElementById('filter-series').value;
  const q=document.getElementById('filter-photo').value.toLowerCase();
  return photoData.filter(p=>{
    if(serie&&p.series!==serie)return false;
    if(q&&!p.title.toLowerCase().includes(q)&&!p.tags.some(t=>t.toLowerCase().includes(q)))return false;
    return true;
  });
}
function filterTags(){
  const filtered=getFiltered();
  const tm={};
  filtered.forEach(p=>p.tags.forEach(t=>{const k=t.trim();if(k)tm[k]=(tm[k]||0)+1;}));
  const s=Object.entries(tm).sort((a,b)=>b[1]-a[1]);
  const serie=document.getElementById('filter-series').value;
  const q=document.getElementById('filter-photo').value;
  document.getElementById('filter-badge').textContent=(serie||q)?'('+filtered.length+' photo'+(filtered.length>1?'s':'')+')':'';
  document.getElementById('tags-count').textContent=s.length+' tag'+(s.length>1?'s':'');
  document.getElementById('tag-list').innerHTML=s.map(([t,c])=>{
    const safe=t.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
    return '<div class="tag-row">'+
      '<span class="tag" onclick="fillRename(\''+safe+'\')" title="Clic pour préremplir renommage">'+t+'</span>'+
      '<span class="tag-count">'+c+' photo'+(c>1?'s':'')+'</span>'+
      '<button class="btn btn-sm" onclick="fillRename(\''+safe+'\')">Renommer</button>'+
      '</div>';
  }).join('')||'<div style="color:#6b7fa8;padding:1rem 0;font-size:.85rem">Aucun tag pour cette sélection.</div>';
  if(filtered.length===1)showPhotoEditor(filtered[0]);
  else if(!filtered.some(p=>p.file===editingFile)){document.getElementById('photo-tag-editor').style.display='none';editingFile=null;}
}
function showPhotoEditor(p){
  editingFile=p.file;
  document.getElementById('photo-tag-info').textContent=p.title+(p.series?' · '+p.series:'');
  document.getElementById('photo-tags-input').value=p.tags.join(', ');
  document.getElementById('photo-tag-editor').style.display='block';
  document.getElementById('photo-tag-msg').textContent='';
}
function closePhotoEditor(){document.getElementById('photo-tag-editor').style.display='none';editingFile=null;}
function fillRename(t){document.getElementById('tag-from').value=t;}
function savePhotoTags(){
  const tags=document.getElementById('photo-tags-input').value.split(',').map(t=>t.trim()).filter(Boolean);
  fetch('/tags/photo-save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:editingFile,tags})})
  .then(r=>r.json()).then(r=>{
    if(r.ok){
      const p=photoData.find(x=>x.file===editingFile);
      if(p)p.tags=tags;
      document.getElementById('photo-tag-msg').textContent='✓ Sauvegardé';
      document.getElementById('photo-tag-msg').style.color='#7aff7a';
      filterTags();
    }
  });
}
filterTags();
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

  const bySeriesRowsHtml = bySeries.map(s=>{
    const safeName=s.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<tr style="cursor:pointer" onclick="showPhotos({series:\''+s.slug+'\'},\''+safeName+'\')">'+
      '<td><span style="color:#748fff">'+s.name+'</span></td><td>'+s.count+'</td>'+
      '<td><span class="status-badge status-'+(s.status||'published')+'">'+(s.status==='draft'?'Brouillon':'En ligne')+'</span></td></tr>';
  }).join('');
  const topRatedRowsHtml = topRated.map(p=>'<tr><td><a href="/edit/'+p.file+'" style="color:#748fff">'+p.title+'</a></td><td>⭐ '+p.rating+'</td></tr>').join('')
    || '<tr><td colspan="2" style="color:#6b7fa8">Aucune note renseignée</td></tr>';
  const topViewedRowsHtml = topViewed.map(p=>'<tr><td><a href="/edit/'+p.file+'" style="color:#748fff">'+p.title+'</a></td><td>'+views[p.slug]+'</td><td>'+(p.series||'—')+'</td></tr>').join('');
  const topViewedHtml = topViewed.length
    ? '<div style="grid-column:1/-1"><h2>Photos les plus vues</h2><table class="table"><tr><th>Photo</th><th>Vues</th><th>Série</th></tr>'+topViewedRowsHtml+'</table></div>'
    : '';

  const photoDataJson = JSON.stringify(photos.map(p=>({
    file:p.file, title:p.title, slug:p.slug||'', series:p.series||'',
    status:p.status||'published', thumb:p.url_thumb||p.url_web||'',
    tags:p.tags||[], rating:p.rating||0
  })));
  const viewsJson = JSON.stringify(views);
  const totalNonTrash = photos.filter(p=>p.status!=='trash').length;

  return layout('Statistiques', `
<h1>Statistiques</h1>
<div class="stat-grid">
  <div class="stat-card clickable" onclick="showPhotos({status:'all'},'Toutes les photos')">
    <div class="stat-num">${totalNonTrash}</div><div class="stat-label">Photos totales ↗</div>
  </div>
  <div class="stat-card clickable" onclick="showPhotos({status:'published'},'En ligne')">
    <div class="stat-num" style="color:#7aff7a">${pub}</div><div class="stat-label">En ligne ↗</div>
  </div>
  <div class="stat-card clickable" onclick="showPhotos({status:'draft'},'Brouillons')">
    <div class="stat-num" style="color:#ffb347">${draft}</div><div class="stat-label">Brouillons ↗</div>
  </div>
  <div class="stat-card clickable" onclick="showPhotos({status:'trash'},'Corbeille')">
    <div class="stat-num" style="color:#ff7a7a">${trash}</div><div class="stat-label">Corbeille ↗</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${series.length}</div><div class="stat-label">Séries</div>
  </div>
  <div class="stat-card clickable" onclick="window.location='/tags'">
    <div class="stat-num">${allTags.length}</div><div class="stat-label">Tags uniques ↗</div>
  </div>
  <div class="stat-card clickable" onclick="showPhotos({topViewed:true},'Plus vues')">
    <div class="stat-num">${totalViews.toLocaleString()}</div><div class="stat-label">Vues totales ↗</div>
  </div>
</div>

<div id="filter-view" style="display:none;background:#0a1628;border:1px solid #243a65;border-radius:.8rem;padding:1.25rem;margin-bottom:2rem">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
    <h2 style="margin:0" id="filter-title"></h2>
    <div style="display:flex;gap:.5rem;align-items:center">
      <input type="search" id="filter-search" placeholder="Filtrer…" oninput="renderGrid()"
        style="background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;color:#edf4ff;padding:.3rem .65rem;font-size:.8rem;width:180px">
      <button class="btn btn-sm" onclick="closeFilter()">✕ Fermer</button>
    </div>
  </div>
  <div id="filter-grid"></div>
  <div id="filter-footer" style="font-size:.78rem;color:#6b7fa8;margin-top:.75rem;text-align:right"></div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem">
  <div>
    <h2>Par série <span style="font-weight:400;font-size:.78rem;color:#6b7fa8">cliquer pour filtrer</span></h2>
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
</div>
<script>
const allPhotos=${photoDataJson};
const views=${viewsJson};
let activeKey=null,currentFilter=null;
function closeFilter(){
  document.getElementById('filter-view').style.display='none';
  document.querySelectorAll('.stat-card').forEach(c=>c.classList.remove('active'));
  activeKey=null;
}
function showPhotos(filter,label){
  const key=JSON.stringify(filter);
  if(activeKey===key){closeFilter();return;}
  activeKey=key;currentFilter=filter;
  document.querySelectorAll('.stat-card').forEach(c=>c.classList.remove('active'));
  document.getElementById('filter-title').textContent=label;
  document.getElementById('filter-search').value='';
  document.getElementById('filter-view').style.display='block';
  renderGrid();
  document.getElementById('filter-view').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function getFilteredList(){
  const f=currentFilter;
  const q=document.getElementById('filter-search').value.toLowerCase();
  let list=allPhotos.slice();
  if(f.status==='all')list=list.filter(p=>p.status!=='trash');
  else if(f.status)list=list.filter(p=>p.status===f.status);
  else if(f.series)list=list.filter(p=>p.series===f.series);
  else if(f.topViewed)list=list.filter(p=>views[p.slug]).sort((a,b)=>(views[b.slug]||0)-(views[a.slug]||0)).slice(0,20);
  if(q)list=list.filter(p=>p.title.toLowerCase().includes(q)||p.series.toLowerCase().includes(q)||(p.tags||[]).some(t=>t.toLowerCase().includes(q)));
  return list;
}
function renderGrid(){
  const list=getFilteredList();
  document.getElementById('filter-footer').textContent=list.length+' photo'+(list.length>1?'s':'');
  document.getElementById('filter-grid').innerHTML=list.map(p=>{
    const img=p.thumb
      ?'<img src="'+p.thumb+'" style="width:72px;height:54px;object-fit:cover;border-radius:.35rem;flex-shrink:0">'
      :'<div style="width:72px;height:54px;background:#0f1f3d;border-radius:.35rem;flex-shrink:0"></div>';
    const sc=p.status==='published'?'#7aff7a':p.status==='draft'?'#ffb347':'#ff7a7a';
    const stLbl=p.status==='published'?'En ligne':p.status==='draft'?'Brouillon':'Corbeille';
    const tags=(p.tags||[]).slice(0,3).map(t=>'<span class="tag">'+t+'</span>').join('');
    return '<div style="display:flex;gap:.75rem;align-items:center;padding:.5rem 0;border-bottom:1px solid #1a2e52">'+
      img+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+p.title+'</div>'+
        '<div style="font-size:.72rem;color:#9fb2d4;margin:.15rem 0">📁 '+p.series+'</div>'+
        '<div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.2rem">'+tags+'</div>'+
      '</div>'+
      '<div style="display:flex;flex-direction:column;gap:.35rem;align-items:flex-end;flex-shrink:0">'+
        '<span style="font-size:.7rem;font-weight:600;color:'+sc+'">● '+stLbl+'</span>'+
        '<a href="/edit/'+p.file+'" class="btn btn-sm">Modifier</a>'+
      '</div>'+
    '</div>';
  }).join('')||'<div style="color:#6b7fa8;padding:1rem 0">Aucune photo dans cette catégorie.</div>';
}
</script>`, 'stats');
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function settingsPage(settings, photos, allSeries, msg='') {
  // Photo du jour — build grouped select
  const published = photos.filter(p => p.status !== 'trash');
  const seriesNames = {};
  allSeries.forEach(s => { seriesNames[s.slug] = s.name; });
  const grouped = {};
  published.forEach(p => {
    const key = p.series || '_';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(p);
  });
  const current = settings.featured_photo_slug || '';
  const optgroupsHtml = Object.entries(grouped).map(([slug, list]) => {
    const label = seriesNames[slug] || slug;
    const opts = list.map(p => {
      const thumb = p.url_thumb || p.url_web || '';
      const sel = p.slug === current ? ' selected' : '';
      return '<option value="' + p.slug + '" data-thumb="' + thumb + '"' + sel + '>' + p.title + '</option>';
    }).join('');
    return '<optgroup label="' + label + '">' + opts + '</optgroup>';
  }).join('');

  // Current preview
  const currentPhoto = published.find(p => p.slug === current);
  const previewThumb = currentPhoto?.url_thumb || currentPhoto?.url_web || '';
  const previewHtml = previewThumb
    ? '<img id="featured-img" src="' + previewThumb + '" style="width:100%;max-height:200px;object-fit:cover;border-radius:.5rem;border:1px solid #243a65;display:block">'
    : '<div id="featured-img" style="width:100%;height:120px;border-radius:.5rem;border:1px dashed #243a65;display:flex;align-items:center;justify-content:center;color:#6b7fa8;font-size:.8rem">Aucune sélection</div>';

  const msgHtml = msg ? '<div class="alert alert-success">✓ ' + msg + '</div>' : '';
  return layout('Réglages', `
<h1>Réglages du site</h1>
${msgHtml}
<form method="POST" action="/settings/save" style="max-width:640px">
<div class="form-grid">
  <div class="field full"><label>Titre du site</label><input name="site_title" value="${settings.site_title||''}"></div>
  <div class="field full"><label>Nom watermark</label><input name="watermark_name" value="${settings.watermark_name||''}"></div>
  <div class="field full"><label>Titre hero (grande phrase d'accueil)</label><input name="hero_title" value="${settings.hero_title||''}"></div>
  <div class="field full">
    <label>Texte d'introduction (paragraphe sous le titre)</label>
    <textarea name="about_text" style="min-height:120px">${settings.about_text||''}</textarea>
  </div>
  <div class="field full"><label>Domaine images O2Switch <span class="hint">Sans slash final</span></label><input name="images_domain" value="${settings.images_domain||CFG.domain}" placeholder="https://photos.mondomaine.fr"></div>
</div>

<h2 style="margin-top:2rem;margin-bottom:1rem">📷 Photo du jour</h2>
<div style="display:grid;grid-template-columns:1fr 200px;gap:1rem;align-items:start;max-width:640px">
  <div style="display:flex;flex-direction:column;gap:.75rem">
    <div class="field">
      <label>Photo à mettre en avant <span class="hint">affichée en hero sur l'accueil</span></label>
      <select name="featured_photo_slug" id="featured-sel" onchange="updatePreview()" style="width:100%">
        <option value="">— Dernière photo publiée (auto) —</option>
        ${optgroupsHtml}
      </select>
    </div>
    <button type="button" class="btn btn-sm" onclick="document.getElementById('featured-sel').value='';updatePreview()">✕ Remettre en automatique</button>
  </div>
  <div id="featured-preview">${previewHtml}</div>
</div>

<h2 style="margin-top:2rem;margin-bottom:1rem">Section Séries (page d'accueil)</h2>
<div class="form-grid">
  <div class="field full"><label>Titre de la section</label><input name="series_title" value="${settings.series_title||'Séries'}" placeholder="Séries"></div>
  <div class="field full"><label>Sous-titre de la section</label><input name="series_subtitle" value="${settings.series_subtitle||''}" placeholder="Des ensembles d'images pensés comme des mini-récits visuels."></div>
</div>
<div style="margin-top:1.5rem"><button type="submit" class="btn btn-primary">Sauvegarder</button></div>
</form>
<script>
function updatePreview(){
  const sel=document.getElementById('featured-sel');
  const opt=sel.options[sel.selectedIndex];
  const thumb=opt?opt.dataset.thumb:'';
  const box=document.getElementById('featured-preview');
  if(thumb){
    box.innerHTML='<img id="featured-img" src="'+thumb+'" style="width:100%;max-height:200px;object-fit:cover;border-radius:.5rem;border:1px solid #243a65;display:block">';
  } else {
    box.innerHTML='<div id="featured-img" style="width:100%;height:120px;border-radius:.5rem;border:1px dashed #243a65;display:flex;align-items:center;justify-content:center;color:#6b7fa8;font-size:.8rem">Automatique</div>';
  }
}
</script>`, 'settings');
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
    autoGitPush(`edit: ${body.title||file}`);
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
    autoGitPush(`${action}: ${file}`);
    json({ok:true});

  // ── Batch status
  } else if (req.method==='POST' && p==='/batch/status') {
    const body=await new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(JSON.parse(b)));});
    for(const file of body.files){
      const fp=path.join(CFG.photosDir,file);
      if(fs.existsSync(fp)) savePhoto(file,{status:body.status});
    }
    autoGitPush(`batch: statut → ${body.status} (${body.files.length} photo(s))`);
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
    autoGitPush(`batch: renommage slug (${body.renames.length} photo(s))`);
    json({ok:true});

  // ── Batch delete (suppression définitive)
  } else if (req.method==='POST' && p==='/batch/delete') {
    const body=await new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(JSON.parse(b)));});
    for(const file of body.files) {
      const fp=path.join(CFG.photosDir,path.basename(file));
      if(!fs.existsSync(fp)) continue;
      const photo=readYaml(fp);
      fs.unlinkSync(fp);
      if(photo.slug&&photo.series) deleteViaFTP(photo.series,photo.slug).catch(()=>{});
    }
    autoGitPush(`batch: suppression définitive (${body.files.length} photo(s))`);
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
      // Auto git push — déclenche le rebuild du site sur O2Switch
      const pushed = results.filter(r=>r.ok);
      let gitStatus = '';
      if (pushed.length) {
        const slugs = pushed.map(r=>r.slug).join(', ');
        const res2 = autoGitPush(`photos: ajout ${slugs}`);
        gitStatus = res2 === 'ok' ? 'deploy' : res2 === 'nothing' ? '' : 'git-error';
      }
      json({ok:true,results,gitStatus});
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
    const seriesTags=body.tags?body.tags.split(',').map(t=>t.trim()).filter(Boolean):[];
    const data={name:body.name,slug,description:body.description||'',cover_url:body.cover_url||'',status:body.status||'published',published:body.status!=='draft',tags:seriesTags};
    const outFile=isNew?`${slug}.yaml`:file;
    writeYaml(path.join(CFG.seriesDir,outFile),data);
    autoGitPush(`serie: ${isNew?'création':'modification'} ${slug}`);
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
    autoGitPush(`serie: suppression ${serie.slug}`);
    json({ok:true});

  // ── Tags page
  } else if (req.method==='GET' && p==='/tags') {
    html(tagsPage(url.searchParams.get('saved')||''));

  // ── Save tags for a single photo (inline editor)
  } else if (req.method==='POST' && p==='/tags/photo-save') {
    const body=await new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(JSON.parse(b)));});
    const fp=path.join(CFG.photosDir,path.basename(body.file||''));
    if(!fs.existsSync(fp)){json({ok:false,error:'Not found'},404);return;}
    savePhoto(path.basename(body.file),{tags:Array.isArray(body.tags)?body.tags:[]});
    autoGitPush(`tags: mise à jour ${path.basename(body.file)}`);
    json({ok:true});

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
    autoGitPush(`tags: renommage "${from}" → "${to}"`);
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
    html(settingsPage(readSettings(), readPhotos(), readSeries(), url.searchParams.get('saved')||''));

  } else if (req.method==='POST' && p==='/settings/save') {
    const body=await parseBody(req);
    const current=readSettings();
    writeYaml(CFG.settingsFile,{
      ...current,
      site_title: body.site_title,
      watermark_name: body.watermark_name,
      hero_title: body.hero_title,
      about_text: body.about_text,
      images_domain: body.images_domain,
      series_title: body.series_title||undefined,
      series_subtitle: body.series_subtitle||undefined,
      featured_photo_slug: body.featured_photo_slug||undefined,
    });
    autoGitPush('settings: mise à jour');
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
