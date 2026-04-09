import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
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
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const ALLOWED_UPLOAD_MIME = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/webp']);
const PUBLIC_SITE_ORIGIN = process.env.PUBLIC_SITE_ORIGIN || 'https://stan-bouchet.eu';
const CORS_ALLOWED_ORIGINS = new Set([
  PUBLIC_SITE_ORIGIN,
  'https://www.stan-bouchet.eu',
]);

// ─── RATINGS (fichier JSON — pas de dépendance native) ────────────────────────
const RATINGS_FILE = path.join(__dirname, 'ratings.json');

function ratingsRead() {
  try { return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function ratingsWrite(data) {
  fs.writeFileSync(RATINGS_FILE, JSON.stringify(data), 'utf8');
}
function dbRate(slug, score) {
  const data = ratingsRead();
  if (!data[slug]) data[slug] = { total: 0, count: 0 };
  data[slug].total += score;
  data[slug].count += 1;
  ratingsWrite(data);
}
function dbGetRating(slug) {
  const data = ratingsRead();
  const r = data[slug];
  if (!r || r.count === 0) return null;
  return { avg: Math.round((r.total / r.count) * 10) / 10, count: r.count };
}
function dbGetAll() {
  const data = ratingsRead();
  return Object.entries(data)
    .filter(([, r]) => r.count > 0)
    .map(([slug, r]) => ({ slug, avg: Math.round((r.total / r.count) * 10) / 10, count: r.count }))
    .sort((a, b) => b.avg - a.avg);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  port: process.env.PORT || 3333,
  photosDir:   path.join(__dirname, 'src/content/photos'),
  seriesDir:   path.join(__dirname, 'src/content/series'),
  settingsFile:path.join(__dirname, 'src/content/settings/site.yaml'),
  viewsFile:   path.join(__dirname, 'src/content/stats/views.json'),
  tmpDir:      path.join(__dirname, '.tmp-upload'),
  processDir:  path.join(__dirname, '.processed'),
  domain:      'http://photos.bost7423.odns.fr',  // URL temporaire O2Switch
  ftp: {
    host:       process.env.SFTP_HOST || '',
    port:       Number(process.env.SFTP_PORT || 22),
    username:   process.env.SFTP_USERNAME || '',
    password:   process.env.SFTP_PASSWORD || '',
    remotePath: process.env.SFTP_REMOTE_PATH || '/',
  },
  sharp: {
    thumb: { width: 500,  quality: 80 },
    web:   { width: 1200, quality: 85 },
    zoom:  { width: 2500, quality: 90 },
  }
};

// ─── AUTH CONFIG ──────────────────────────────────────────────────────────────
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID     || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_ALLOWED_USER  = process.env.GITHUB_ALLOWED_USER  || '';
const SESSION_SECRET_ENV   = process.env.SESSION_SECRET       || '';
const SESSION_SECRET       = SESSION_SECRET_ENV || crypto.randomBytes(32).toString('hex');
const ADMIN_BASE_URL       = process.env.ADMIN_BASE_URL       || `http://localhost:3333`;
const SKIP_AUTH            = process.env.SKIP_AUTH            === 'true'; // true en local si pas encore configuré

// ─── SESSION ──────────────────────────────────────────────────────────────────
const sessions    = new Map(); // id → { user, expires }
const oauthStates = new Map(); // state → expiry timestamp
const rateBuckets = new Map();

function signVal(v)  { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }

function getSessionUser(req) {
  const raw = (req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('sid='));
  if (!raw) return null;
  const signed = raw.slice(4);
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const id = signed.slice(0, dot), sig = signed.slice(dot+1);
  if (sig !== signVal(id)) return null;
  const s = sessions.get(id);
  if (!s || s.expires < Date.now()) { sessions.delete(id); return null; }
  return s.user;
}

function setSessionCookie(res, user) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { user, expires: Date.now() + 7*24*3600*1000 });
  const secure = ADMIN_BASE_URL.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${id}.${signVal(id)}; HttpOnly; SameSite=Lax; Max-Age=${7*24*3600}; Path=/${secure}`);
}

function clearSession(req, res) {
  const raw = (req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('sid='));
  if (raw) { const signed=raw.slice(4); sessions.delete(signed.slice(0, signed.lastIndexOf('.'))); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Max-Age=0; Path=/');
}

function requestIsSecure(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim().toLowerCase();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; " +
    "img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "connect-src 'self' https://admin.stan-bouchet.eu;"
  );
  if (requestIsSecure(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
}

function applyPublicApiCors(req, res) {
  const origin = (req.headers.origin || '').toString();
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isCorsOriginAllowed(req) {
  const origin = (req.headers.origin || '').toString();
  return !origin || CORS_ALLOWED_ORIGINS.has(origin);
}

function getClientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(slug);
}

function getKnownPhotoSlugs() {
  return new Set(readPhotos().map((p) => p.slug).filter((s) => typeof s === 'string' && s));
}

// ─── GITHUB OAUTH HELPERS ─────────────────────────────────────────────────────
function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json','Content-Length':Buffer.byteLength(data)}
    }, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path,
      headers:{'Authorization':`Bearer ${token}`,'User-Agent':'stan-admin','Accept':'application/json'}
    }, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} }); }).on('error', reject);
  });
}

// ─── LIMITS ───────────────────────────────────────────────────────────────────
const LIMITS = {
  photos: { max: 10000, recommended: 2000 },
  series: { max: 500,   recommended: 100  },
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

function gitCommit(msg) {
  try {
    execFileSync('git', ['add', '-A', 'src/content/'], { cwd: __dirname, stdio: 'pipe' });
    const diff = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: __dirname, stdio: 'pipe' }).toString().trim();
    if (!diff) return 'nothing';
    execFileSync('git', ['commit', '-m', msg], { cwd: __dirname, stdio: 'pipe' });
    return 'ok';
  } catch(e) {
    console.error('gitCommit error:', e.message);
    return 'error';
  }
}

function gitPush() {
  const opts = { cwd: __dirname, stdio: 'pipe' };
  try {
    // 1. Récupérer les derniers commits de GitHub (code Mac)
    execFileSync('git', ['fetch', 'origin', 'main'], opts);
    // 2. Replacer nos commits YAML sur la dernière version Mac (sans toucher au code)
    try {
      execFileSync('git', ['rebase', 'origin/main'], opts);
    } catch(rebaseErr) {
      // En cas de conflit inattendu : annuler le rebase et signaler
      try { execFileSync('git', ['rebase', '--abort'], opts); } catch(_) {}
      const msg = (rebaseErr.stderr||rebaseErr.stdout||Buffer.from('')).toString().trim()||rebaseErr.message;
      console.error('gitPush rebase error:', msg);
      return { ok: false, error: 'Conflit rebase : ' + msg };
    }
    // 3. Push normal (pas de --force : le rebase garantit qu'on est en avance)
    execFileSync('git', ['push', 'origin', 'HEAD:main'], opts);
    return { ok: true };
  } catch(e) {
    const msg = (e.stderr||e.stdout||Buffer.from('')).toString().trim()||e.message;
    console.error('gitPush error:', msg);
    return { ok: false, error: msg };
  }
}

function getPendingCount() {
  try {
    const out = execFileSync('git', ['log', 'origin/main..HEAD', '--oneline'], { cwd: __dirname, stdio: 'pipe' }).toString().trim();
    return out ? out.split('\n').length : 0;
  } catch { return 0; }
}

// Alias pour compatibilité upload handler
function autoGitPush(msg) {
  const r = gitCommit(msg);
  return r;
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
  return new Promise((resolve) => {
    let b = '';
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      b += c;
      if (Buffer.byteLength(b) > MAX_BODY_BYTES) {
        tooLarge = true;
      }
    });
    req.on('end', () => {
      if (tooLarge) { resolve({}); return; }
      const p = new URLSearchParams(b);
      const o = {};
      for (const [k, v] of p) o[k] = v;
      resolve(o);
    });
    req.on('error', () => resolve({}));
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (Buffer.byteLength(b) > MAX_BODY_BYTES) {
        reject(new Error('Payload JSON trop volumineux'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); }
      catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 300*1024*1024, files: 100, parts: 200 } });
    const fields = {}, files = [];
    const pending = [];
    fs.mkdirSync(CFG.tmpDir, { recursive: true });
    bb.on('field', (k,v) => { fields[k]=v; });
    bb.on('file', (name, stream, info) => {
      if (!ALLOWED_UPLOAD_MIME.has(info.mimeType)) {
        stream.resume();
        return;
      }
      const safeName = path.basename(info.filename || 'upload');
      const tmp = path.join(CFG.tmpDir, `${Date.now()}-${safeName}`);
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

async function readExifDate(filePath) {
  try {
    const { default: exifr } = await import('exifr');
    const data = await exifr.parse(filePath, { pick: ['DateTimeOriginal'] });
    if (data?.DateTimeOriginal) return new Date(data.DateTimeOriginal).toISOString().split('T')[0];
  } catch {}
  return null;
}

function limitBar(current, recommended, max, label) {
  const pct = Math.min(100, Math.round(current / max * 100));
  const color = current >= max ? '#ff4a4a' : current >= recommended ? '#ff9a6a' : '#4aff9a';
  return `<div style="margin-bottom:1.5rem">
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.35rem">
    <span style="font-family:monospace;font-size:.78rem;color:#9fb2d4">${label}</span>
    <span style="font-family:monospace;font-size:.78rem">
      <strong style="color:${color}">${current}</strong>
      <span style="color:#5a7090"> / ${max} max — conseillé : ${recommended}</span>
    </span>
  </div>
  <div style="background:#0a1628;border-radius:999px;height:6px;overflow:hidden;border:1px solid #1a2d52">
    <div style="background:${color};width:${pct}%;height:100%;border-radius:999px"></div>
  </div>
</div>`;
}

// ─── FTP ──────────────────────────────────────────────────────────────────────
async function getSftp() {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const sftp = new SftpClient();
  await sftp.connect({
    host: process.env.SFTP_HOST || CFG.ftp.host,
    port: Number(process.env.SFTP_PORT || 22),
    username: process.env.SFTP_USERNAME || CFG.ftp.username,
    password: process.env.SFTP_PASSWORD || CFG.ftp.password,
    readyTimeout: 20000,
  });
  return sftp;
}

async function uploadViaSFTP(versions, seriesSlug, photoSlug) {
  const password = process.env.SFTP_PASSWORD || CFG.ftp.password;
  if (!password) return { ok: false, error: 'Mot de passe SFTP non configuré' };
  try {
    const sftp = await getSftp();
    for (const [name, lp] of Object.entries(versions)) {
      const remoteDir = `${CFG.ftp.remotePath}/${seriesSlug}/${name}`.replace(/\/+/g, '/');
      await sftp.mkdir(remoteDir, true);
      await sftp.put(lp, `${remoteDir}/${photoSlug}.webp`);
    }
    await sftp.end();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

async function deleteViaSFTP(seriesSlug, photoSlug) {
  const password = process.env.SFTP_PASSWORD || CFG.ftp.password;
  if (!password) return { ok: false };
  try {
    const sftp = await getSftp();
    for (const name of ['thumb','web','zoom']) {
      const rp = `${CFG.ftp.remotePath}/${seriesSlug}/${name}/${photoSlug}.webp`;
      await sftp.delete(rp).catch(()=>{});
    }
    await sftp.end();
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
.nav{display:flex;gap:.5rem;margin-bottom:2rem;flex-wrap:wrap;align-items:center}
.nav a{padding:.35rem 1rem;border-radius:999px;border:1px solid #243a65;font-size:.82rem;color:#9fb2d4}
.nav a.active,.nav a:hover{background:#748fff22;border-color:#748fff55;color:#748fff}
.deploy-btn{margin-left:auto;display:inline-flex;align-items:center;gap:.45rem;padding:.35rem 1.1rem;border-radius:999px;border:1px solid #2a7a4f;background:#0d2b1e;color:#4dbb80;font-size:.82rem;cursor:pointer;font-family:inherit;transition:background 150ms,border-color 150ms}
.deploy-btn:hover{background:#14402a;border-color:#4dbb80}
.deploy-btn.has-pending{border-color:#4dbb80;color:#4dbb80;animation:pulse-green 2s infinite}
.deploy-btn.deploying{opacity:.6;cursor:wait}
.deploy-badge{background:#4dbb80;color:#050b1a;border-radius:999px;padding:0 .45rem;font-size:.72rem;font-weight:700;min-width:1.2rem;text-align:center}
@keyframes pulse-green{0%,100%{box-shadow:0 0 0 0 #4dbb8055}50%{box-shadow:0 0 0 4px #4dbb8022}}
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

// ─── TAG HELPERS ──────────────────────────────────────────────────────────────
// Palette de couleurs par catégorie (index cyclique)
const CAT_COLORS = ['#748fff','#7aff9a','#ffb347','#ff7aaa','#7adcff','#c07aff','#ffdf7a'];
function catColor(cat) {
  if (!cat) return '#748fff';
  let h = 0; for (const c of cat) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
  return CAT_COLORS[Math.abs(h) % CAT_COLORS.length];
}
function parseTag(t) {
  const i = t.indexOf(':');
  return i > 0 ? { cat: t.slice(0, i).trim(), val: t.slice(i + 1).trim(), full: t } : { cat: '', val: t, full: t };
}

// ─── TAG INPUT WIDGET ─────────────────────────────────────────────────────────
// Widget chips avec catégories optionnelles (syntaxe "Catégorie:valeur")
// Ex: "Lieu:Lyon", "Style:Nuit", "paysage" (sans catégorie)
function tagInputWidget(inputName, currentTags, allTags, id='ti') {
  const tagsJson = JSON.stringify(currentTags);
  // Extraire les catégories connues depuis tous les tags existants
  const cats = [...new Set(allTags.map(t => parseTag(t).cat).filter(Boolean))].sort();
  const catsJson = JSON.stringify(cats);
  const dlId = id + '-dl';
  const suggestions = allTags.map(t => '<option value="' + t.replace(/"/g,'&quot;') + '">').join('');
  const catOpts = cats.map(c => '<option value="' + c + '">' + c + '</option>').join('');
  return `
<div style="display:flex;flex-direction:column;gap:.5rem">
  <div class="ti-wrap" id="${id}-wrap" onclick="document.getElementById('${id}-input').focus()">
    <div id="${id}-chips" style="display:contents"></div>
    <input class="ti-input" id="${id}-input" list="${dlId}" placeholder="tag ou Catégorie:valeur…" autocomplete="off">
    <datalist id="${dlId}">${suggestions}</datalist>
  </div>
  <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
    <span style="font-size:.72rem;color:#6b7fa8">Catégorie rapide :</span>
    ${cats.length ? '<select id="'+id+'-catsel" style="background:#0f1f3d;border:1px solid #243a65;border-radius:.4rem;color:#edf4ff;padding:.2rem .5rem;font-size:.75rem"><option value="">libre</option>'+catOpts+'</select>' : ''}
    <span style="font-size:.7rem;color:#6b7fa8">Tape le tag puis <kbd style="background:#1a2e52;border-radius:3px;padding:.05rem .3rem;font-size:.68rem">Entrée</kbd> ou virgule</span>
  </div>
</div>
<input type="hidden" name="${inputName}" id="${id}-hidden">
<script>
(function(){
  const id='${id}';
  const catColors=${JSON.stringify(Object.fromEntries(cats.map(c=>[c,catColor(c)])))};
  let tags=${tagsJson};
  const hidden=document.getElementById(id+'-hidden');
  const input=document.getElementById(id+'-input');
  const catSel=document.getElementById(id+'-catsel');
  function chipHtml(t,i){
    const p=parseTagClient(t);
    const col=p.cat?(catColors[p.cat]||'#748fff'):'#748fff';
    const label=p.cat?('<span style="opacity:.6;font-size:.68em;margin-right:.2rem">'+p.cat+':</span>'+p.val):t;
    return '<span class="ti-chip" style="border-color:'+col+'44;color:'+col+'">'+label+'<button type="button" onclick="window[\\'tiRemove_'+id+'\\']('+(i)+')">×</button></span>';
  }
  function parseTagClient(t){const i=t.indexOf(':');return i>0?{cat:t.slice(0,i),val:t.slice(i+1)}:{cat:'',val:t};}
  function render(){
    document.getElementById(id+'-chips').innerHTML=tags.map((t,i)=>chipHtml(t,i)).join('');
    hidden.value=tags.join(',');
  }
  window['tiRemove_'+id]=function(i){tags.splice(i,1);render();};
  function addTag(v){
    let t=v.trim();
    if(!t)return;
    // Préfixer avec la catégorie sélectionnée si pas déjà préfixé
    if(catSel&&catSel.value&&!t.includes(':')){t=catSel.value+':'+t;}
    if(!tags.includes(t)){tags.push(t);}
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
    ['/about', 'about', '👤 À propos', false],
    ['/settings', 'settings', '⚙️ Réglages', false],
  ];
  const navLinks = nav.map(([href,id,label,ext]) => '<a href="' + href + '"' + (ext?' target="_blank"':'') + ' class="' + (active===id?'active':'') + '">' + label + '</a>').join('');
  const deployBtn = `<button class="deploy-btn" id="deploy-btn" onclick="triggerDeploy()" title="Publier les modifications sur le site">🚀 Déployer <span class="deploy-badge" id="deploy-badge" style="display:none">0</span></button>`;
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><title>${title} — Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style></head><body>
<nav class="nav">${navLinks}${deployBtn}<a href="/auth/logout" style="margin-left:.5rem;padding:.35rem .8rem;border-radius:999px;border:1px solid #243a65;font-size:.78rem;color:#5a7090;display:inline-flex;align-items:center;gap:.4rem" title="Déconnexion">⎋ Quitter</a></nav>
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

// ── Deploy badge ──────────────────────────────────────────────────────────────
function updateDeployBadge(){
  fetch('/deploy/status').then(r=>r.json()).then(d=>{
    const btn=document.getElementById('deploy-btn');
    const badge=document.getElementById('deploy-badge');
    if(!btn||!badge)return;
    if(d.pending>0){
      badge.textContent=d.pending;
      badge.style.display='inline-block';
      btn.classList.add('has-pending');
      btn.title='🚀 ' + d.pending + ' modification(s) à publier';
    } else {
      badge.style.display='none';
      btn.classList.remove('has-pending');
      btn.title='Aucune modification en attente';
    }
  }).catch(()=>{});
}

function triggerDeploy(){
  const btn=document.getElementById('deploy-btn');
  const badge=document.getElementById('deploy-badge');
  const n=parseInt(badge?.textContent||'0');
  if(n===0){alert('Aucune modification en attente.');return;}
  if(!confirm('Publier ' + n + ' modification(s) sur le site ?'))return;
  btn.classList.add('deploying');
  btn.textContent='⏳ Déploiement…';
  fetch('/deploy',{method:'POST'}).then(r=>r.json()).then(d=>{
    if(d.ok){
      btn.textContent='✓ Publié !';
      badge.style.display='none';
      btn.classList.remove('has-pending','deploying');
      setTimeout(()=>{btn.innerHTML='🚀 Déployer <span class="deploy-badge" id="deploy-badge" style="display:none">0</span>';updateDeployBadge();},3000);
    } else {
      btn.textContent='❌ Erreur';
      btn.classList.remove('deploying');
      alert('Erreur git push :\\n\\n' + (d.message || 'Erreur inconnue'));
      setTimeout(()=>{btn.innerHTML='🚀 Déployer <span class="deploy-badge" id="deploy-badge" style="display:none">' + n + '</span>';document.getElementById('deploy-badge').style.display='inline-block';updateDeployBadge();},3000);
    }
  }).catch(()=>{btn.classList.remove('deploying');});
}

updateDeployBadge();
setInterval(updateDeployBadge, 15000);
</script></body></html>`;
}

// ─── PHOTOS PAGE ──────────────────────────────────────────────────────────────
function photosPage(photos, filter='all', search='', msg='') {
  const counts = {
    all: photos.filter(p=>p.status!=='trash').length,
    published: photos.filter(p=>p.status==='published').length,
    draft: photos.filter(p=>p.status==='draft').length,
    trash: photos.filter(p=>p.status==='trash').length,
    notags: photos.filter(p=>p.status!=='trash'&&(!p.tags||p.tags.length===0)).length,
  };
  let list = filter==='trash' ? photos.filter(p=>p.status==='trash')
    : filter==='notags' ? photos.filter(p=>p.status!=='trash'&&(!p.tags||p.tags.length===0))
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
    const hasTags = p.tags&&p.tags.length>0;
    const noTagBadge = !hasTags&&st!=='trash' ? '<span style="background:#3d1a00;border:1px solid #ff7a4a44;border-radius:999px;padding:.1rem .45rem;font-size:.65rem;color:#ff9a6a">sans tags</span>' : '';
    const tagsHtml = (p.tags||[]).slice(0,2).map(t=>{const pTag=parseTag(t);const col=catColor(pTag.cat);return '<span class="tag" style="border-color:'+col+'33;color:'+col+'" onclick="window.location=\'/?filter='+filter+'&search='+encodeURIComponent(t)+'\'">'+t+'</span>';}).join('');
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
      ${noTagBadge}
      ${tagsHtml}
    </div>
    <div class="card-actions">
      <a href="/edit/${p.file}" class="btn btn-sm">Modifier</a>
      ${actionsHtml}
    </div>
  </div></div>`;
  }).join('');
  return layout('Photos', `
<h1>Photos <span style="color:#9fb2d4;font-size:.85rem;font-weight:400">${list.length} affiché${list.length>1?'s':''}</span></h1>
${limitBar(counts.all, LIMITS.photos.recommended, LIMITS.photos.max, 'Photos (publiées + brouillons, hors corbeille)')}
${msgHtml}
<div class="filters">
  <a href="/?filter=all" class="filter-btn ${filter==='all'?'active':''}">Tous (${counts.all})</a>
  <a href="/?filter=published" class="filter-btn ${filter==='published'?'active':''}">En ligne (${counts.published})</a>
  <a href="/?filter=draft" class="filter-btn ${filter==='draft'?'active':''}">Brouillons (${counts.draft})</a>
  <a href="/?filter=trash" class="filter-btn ${filter==='trash'?'active':''}">Corbeille (${counts.trash})</a>
  <a href="/?filter=notags" class="filter-btn ${filter==='notags'?'active':''}" style="${counts.notags>0?'border-color:#ff7a4a55;color:#ff9a6a':''}">🏷 Sans tags (${counts.notags})</a>
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
  <button type="button" class="btn btn-sm" onclick="batchTagModal()" style="border-color:#748fff55;color:#748fff">🏷 Ajouter des tags</button>
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
function batchTagModal(){
  const sel=getSelected();
  if(!sel.length){alert('Sélectionne au moins une photo.');return;}
  document.getElementById('modal-title').textContent='Ajouter des tags — '+sel.length+' photo(s)';
  document.getElementById('modal-msg').innerHTML=
    '<div style="margin-bottom:.75rem;font-size:.82rem;color:#9fb2d4">Les tags seront ajoutés sans écraser les existants.</div>'+
    '<input id="batch-tag-input" placeholder="tag1, Lieu:Lyon, Style:Nuit…" style="width:100%;background:#050b1a;border:1px solid #748fff;border-radius:.5rem;color:#edf4ff;padding:.5rem .75rem;font-size:.88rem">';
  document.getElementById('modal-confirm').onclick=()=>{
    const raw=document.getElementById('batch-tag-input').value;
    const tags=raw.split(',').map(t=>t.trim()).filter(Boolean);
    if(!tags.length){closeModal();return;}
    fetch('/batch/tags',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:sel,tags})})
    .then(()=>{closeModal();location.reload();});
  };
  document.getElementById('modal').classList.add('open');
  setTimeout(()=>document.getElementById('batch-tag-input')?.focus(),80);
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
  <div class="field"><label>Date du reportage</label><input type="date" name="shoot_date" value="${photo.date||''}"></div>
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
  <div style="margin-bottom:1.5rem">
    <label style="display:block;margin-bottom:.5rem">Tags <span style="color:#6b7fa8;font-size:.78rem">optionnel — appliqués à toutes les photos uploadées</span></label>
    <input id="upload-tags" placeholder="Lieu:Lyon, Style:Nuit, paysage…" style="width:100%;background:#0f1f3d;border:1px solid #243a65;border-radius:.5rem;color:#edf4ff;padding:.5rem .75rem;font-size:.88rem">
    <div style="font-size:.72rem;color:#6b7fa8;margin-top:.3rem">Syntaxe : <code>Catégorie:valeur</code> ou tag simple. Sépare par des virgules.</div>
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
  const uploadTags=document.getElementById('upload-tags').value;
  const fd=new FormData();
  fd.append('series',ser);fd.append('status',stat);fd.append('tags',uploadTags);
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
      (r.gitStatus==='committed' ? '<span style="background:#0d2b1e;border:1px solid #2a7a4f;color:#4dbb80;border-radius:.5rem;padding:.35rem .85rem;font-size:.88rem">✓ Sauvegardé — clique sur 🚀 Déployer quand tu es prêt</span>' : '')+
      (r.gitStatus==='git-error' ? '<span style="background:#3d2a00;border:1px solid #6b4a00;color:#ffb347;border-radius:.5rem;padding:.35rem .85rem;font-size:.88rem">⚠️ Erreur git commit</span>' : '');
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
<h1>Séries <span style="color:#9fb2d4;font-size:.85rem;font-weight:400">${series.length}</span></h1>
${limitBar(series.length, LIMITS.series.recommended, LIMITS.series.max, 'Séries')}
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
  const serieLinks = Array.isArray(serie.links) ? serie.links : [];
  const linksHtml = Array.from({length:5},(_,i)=>{
    const l=serieLinks[i]||{};
    return `<div style="display:grid;grid-template-columns:1fr 2fr;gap:.5rem;align-items:center;margin-bottom:.5rem">
  <input name="link_label_${i+1}" placeholder="Libellé (ex: AllTrails)" value="${(l.label||'').replace(/"/g,'&quot;')}" style="min-width:0">
  <input name="link_url_${i+1}" placeholder="https://..." value="${(l.url||'').replace(/"/g,'&quot;')}" style="min-width:0">
</div>`;
  }).join('');
  return layout(pageTitle, `
<div style="display:flex;gap:1rem;align-items:center;margin-bottom:1.5rem">
  <a href="/series" class="btn">← Retour</a>
  <h1 style="margin:0">${isNew?'Nouvelle série':serie.name}</h1>
</div>
${msgHtml}
<form method="POST" action="/series/save/${file}" style="max-width:700px">
<div class="form-grid">
  <div class="field"><label>Nom</label><input name="name" value="${serie.name||''}" required oninput="autoSlug(this.value)"></div>
  <div class="field"><label>Slug</label><input name="slug" id="slug-field" value="${serie.slug||''}"></div>
  <div class="field"><label>Date du reportage</label><input type="date" name="series_date" value="${serie.date||''}"></div>
  <div class="field"></div>
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

<div style="margin-top:2rem;border-top:1px solid #243a65;padding-top:1.5rem">
  <h2 style="font-size:1rem;font-weight:600;margin:0 0 1rem;color:#d2e1ff">📍 Secteur de la randonnée <span style="font-weight:400;color:#5a7090;font-size:.85rem">(optionnel)</span></h2>
  <p style="font-size:.82rem;color:#5a7090;margin:0 0 1rem">Coordonnées GPS du point de départ — <a href="https://www.google.com/maps" target="_blank" style="color:#748fff">Google Maps</a> → clic droit → "C'est ici" pour obtenir lat/lng.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr 120px;gap:.75rem">
    <div class="field"><label>Latitude</label><input name="map_lat" type="number" step="any" placeholder="45.8566" value="${serie.map_lat||''}"></div>
    <div class="field"><label>Longitude</label><input name="map_lng" type="number" step="any" placeholder="4.8357" value="${serie.map_lng||''}"></div>
    <div class="field"><label>Zoom (1–18)</label><input name="map_zoom" type="number" min="1" max="18" placeholder="13" value="${serie.map_zoom||13}"></div>
  </div>
</div>

<div style="margin-top:2rem;border-top:1px solid #243a65;padding-top:1.5rem">
  <h2 style="font-size:1rem;font-weight:600;margin:0 0 .5rem;color:#d2e1ff">🔗 Liens externes <span style="font-weight:400;color:#5a7090;font-size:.85rem">(jusqu'à 5, optionnel)</span></h2>
  <p style="font-size:.82rem;color:#5a7090;margin:0 0 1rem">Libellé + URL. Les champs vides sont ignorés.</p>
  ${linksHtml}
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
  // Lire les notes depuis ratings.json (pas depuis les YAML)
  const allRatings = dbGetAll();
  const photoBySlug = Object.fromEntries(photos.map(p => [p.slug, p]));
  const topRated = allRatings
    .filter(r => photoBySlug[r.slug])
    .slice(0, 10)
    .map(r => ({ ...photoBySlug[r.slug], _avg: r.avg, _count: r.count }));
  const bySeries=series.map(s=>({...s,count:photos.filter(p=>p.series===s.slug&&p.status!=='trash').length})).sort((a,b)=>b.count-a.count);
  const allTags=[...new Set(photos.flatMap(p=>p.tags||[]))];

  const bySeriesRowsHtml = bySeries.map(s=>{
    const safeName=s.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<tr style="cursor:pointer" onclick="showPhotos({series:\''+s.slug+'\'},\''+safeName+'\')">'+
      '<td><span style="color:#748fff">'+s.name+'</span></td><td>'+s.count+'</td>'+
      '<td><span class="status-badge status-'+(s.status||'published')+'">'+(s.status==='draft'?'Brouillon':'En ligne')+'</span></td></tr>';
  }).join('');
  const topRatedRowsHtml = topRated.map(p=>'<tr><td><a href="/edit/'+p.file+'" style="color:#748fff">'+p.title+'</a></td><td>⭐ '+p._avg+' <span style="color:#6b7fa8;font-size:.8em">('+p._count+' vote'+(p._count>1?'s':'')+')</span></td></tr>').join('')
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
    <table class="table" id="top-rated-table">
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

// Charge les meilleures notes depuis l'API (toujours à jour)
(async function loadTopRated() {
  try {
    const res = await fetch('/api/ratings');
    if (!res.ok) return;
    const ratings = await res.json();
    if (!ratings.length) return;
    const bySlug = Object.fromEntries(allPhotos.map(p => [p.slug, p]));
    const rows = ratings
      .filter(r => bySlug[r.slug])
      .slice(0, 10)
      .map(r => {
        const p = bySlug[r.slug];
        return '<tr><td><a href="/edit/'+p.file+'" style="color:#748fff">'+p.title+'</a></td>'
          +'<td>⭐ '+r.avg+' <span style="color:#6b7fa8;font-size:.8em">('+r.count+' vote'+(r.count>1?'s':'')+')</span></td></tr>';
      }).join('');
    const table = document.getElementById('top-rated-table');
    if (table && rows) table.innerHTML = '<tr><th>Photo</th><th>Note</th></tr>' + rows;
  } catch(e) {}
})();
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
  applySecurityHeaders(req, res);

  const html = (content) => { res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); res.end(content); };
  const json = (data, code=200) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const redirect = (loc) => { res.writeHead(302,{Location:loc}); res.end(); };

  // ── GitHub OAuth — redirect vers GitHub
  if (p === '/auth/github') {
    if (!GITHUB_CLIENT_ID) { res.writeHead(500); res.end('GITHUB_CLIENT_ID manquant dans .env'); return; }
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now() + 10*60*1000);
    const cb = encodeURIComponent(`${ADMIN_BASE_URL}/auth/callback`);
    redirect(`https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${cb}&scope=read:user&state=${state}`);
    return;

  // ── GitHub OAuth — callback
  } else if (p === '/auth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const exp = oauthStates.get(state);
    if (!state || !exp || exp < Date.now()) { res.writeHead(400); res.end('State OAuth invalide ou expiré. <a href="/auth/github">Réessayer</a>'); return; }
    oauthStates.delete(state);
    try {
      const tok = await httpsPost('github.com', '/login/oauth/access_token', { client_id:GITHUB_CLIENT_ID, client_secret:GITHUB_CLIENT_SECRET, code });
      if (!tok.access_token) throw new Error('Token GitHub invalide');
      const user = await httpsGet('api.github.com', '/user', tok.access_token);
      if (!user.login) throw new Error('Utilisateur GitHub introuvable');
      if (GITHUB_ALLOWED_USER && user.login.toLowerCase() !== GITHUB_ALLOWED_USER.toLowerCase()) {
        res.writeHead(403); res.end(`Accès refusé. Compte "@${user.login}" non autorisé.`); return;
      }
      setSessionCookie(res, { login: user.login, avatar: user.avatar_url, name: user.name||user.login });
      redirect('/');
    } catch(e) { res.writeHead(500); res.end('Erreur OAuth : ' + e.message); }
    return;

  // ── Logout
  } else if (p === '/auth/logout') {
    clearSession(req, res);
    res.writeHead(200, {'Content-Type':'text/html;charset=utf-8'});
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Déconnecté</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#050b1a;color:#edf4ff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.card{background:#0a1628;border:1px solid #243a65;border-radius:1rem;padding:2.5rem 3rem;max-width:360px}
h1{font-size:1.2rem;color:#9fb2d4;margin-bottom:.75rem}p{color:#5a7090;font-size:.88rem;margin-bottom:1.5rem}
a{display:inline-block;padding:.55rem 1.4rem;background:#748fff22;border:1px solid #748fff55;border-radius:999px;color:#748fff;font-size:.88rem;text-decoration:none}
a:hover{background:#748fff33}</style></head><body>
<div class="card"><h1>✓ Déconnecté</h1><p>Session fermée avec succès.</p>
<a href="/auth/github">Se reconnecter</a></div></body></html>`);
    return;

  // ── Auth check — toutes les autres routes (sauf API publique)
  } else if (!SKIP_AUTH && !p.startsWith('/api/')) {
    const user = getSessionUser(req);
    if (!user) { redirect('/auth/github'); return; }
  }

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
      date:body.shoot_date||undefined,
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
      if(photo.slug&&photo.series) deleteViaSFTP(photo.series,photo.slug).catch(()=>{});
    }
    autoGitPush(`${action}: ${file}`);
    json({ok:true});

  // ── Batch status
  } else if (req.method==='POST' && p==='/batch/status') {
    let body;
    try { body = await parseJsonBody(req); }
    catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
    for(const file of body.files){
      const fp=path.join(CFG.photosDir,file);
      if(fs.existsSync(fp)) savePhoto(file,{status:body.status});
    }
    autoGitPush(`batch: statut → ${body.status} (${body.files.length} photo(s))`);
    json({ok:true});

  // ── Batch rename
  } else if (req.method==='POST' && p==='/batch/rename') {
    let body;
    try { body = await parseJsonBody(req); }
    catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
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

  // ── Batch add tags
  } else if (req.method==='POST' && p==='/batch/tags') {
    let body;
    try { body = await parseJsonBody(req); }
    catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
    for(const file of body.files) {
      const fp=path.join(CFG.photosDir,path.basename(file));
      if(!fs.existsSync(fp)) continue;
      const photo=readYaml(fp);
      const existing=Array.isArray(photo.tags)?photo.tags:[];
      const merged=[...new Set([...existing,...(body.tags||[])])];
      savePhoto(path.basename(file),{tags:merged});
    }
    autoGitPush(`tags: ajout en masse sur ${body.files.length} photo(s)`);
    json({ok:true});

  // ── Batch delete (suppression définitive)
  } else if (req.method==='POST' && p==='/batch/delete') {
    let body;
    try { body = await parseJsonBody(req); }
    catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
    for(const file of body.files) {
      const fp=path.join(CFG.photosDir,path.basename(file));
      if(!fs.existsSync(fp)) continue;
      const photo=readYaml(fp);
      fs.unlinkSync(fp);
        if(photo.slug&&photo.series) deleteViaSFTP(photo.series,photo.slug).catch(()=>{});
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
      const uploadTags=fields.tags?fields.tags.split(',').map(t=>t.trim()).filter(Boolean):[];
      if(!seriesSlug){res.writeHead(400);res.end('Série manquante');return;}
      if(!fs.existsSync(path.join(CFG.seriesDir, `${seriesSlug}.yaml`))){res.writeHead(400);res.end('Série invalide');return;}
      const results=[];
      const seriesYamlPath=path.join(CFG.seriesDir,`${seriesSlug}.yaml`);
      const seriesDateFallback=fs.existsSync(seriesYamlPath)?(readYaml(seriesYamlPath).date||null):null;
      const usedSlugs=new Set(readPhotos().map(p=>p.slug).filter(Boolean));
      for(const file of files){
        const origTitle=path.parse(file.filename).name.replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        const exifDateStr=await readExifDate(file.path);
        const dateStr=exifDateStr||seriesDateFallback||new Date().toISOString().split('T')[0];
        let base=`${seriesSlug}-${dateStr}`;
        let photoSlug=base;
        let n=2;
        while(usedSlugs.has(photoSlug)){photoSlug=`${base}-${String(n).padStart(3,'0')}`;n++;}
        usedSlugs.add(photoSlug);
        try{
          const [versions, exif]=await Promise.all([processImage(file.path,seriesSlug,photoSlug), readExif(file.path)]);
          const sftpRes=await uploadViaSFTP(versions,seriesSlug,photoSlug);
          const urls=buildUrls(seriesSlug,photoSlug);
          const yamlFile=`${photoSlug}.yaml`;
          writeYaml(path.join(CFG.photosDir,yamlFile),{
            title:origTitle,
            slug:photoSlug, series:seriesSlug, status,
            url:urls.url_web, url_thumb:urls.url_thumb, url_web:urls.url_web, url_zoom:urls.url_zoom,
            date:dateStr,
            description:'', tags:uploadTags,
            ...(Object.values(exif).some(Boolean)?{exif}:{}),
          });
          fs.unlinkSync(file.path);
          results.push({slug:photoSlug,ok:true,sftp:sftpRes.ok});
        } catch(e){results.push({slug:photoSlug,ok:false,error:e.message});}
      }
      // Commit local — le déploiement se fait via le bouton "Déployer" dans la nav
      const pushed = results.filter(r=>r.ok);
      let gitStatus = '';
      if (pushed.length) {
        const slugs = pushed.map(r=>r.slug).join(', ');
        const res2 = gitCommit(`photos: ajout ${slugs}`);
        gitStatus = res2 === 'ok' ? 'committed' : res2 === 'nothing' ? '' : 'git-error';
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
    const mapLat=body.map_lat?parseFloat(body.map_lat):undefined;
    const mapLng=body.map_lng?parseFloat(body.map_lng):undefined;
    const mapZoom=body.map_zoom?parseInt(body.map_zoom):13;
    const links=[];
    for(let i=1;i<=5;i++){
      const label=(body[`link_label_${i}`]||'').trim();
      const url=(body[`link_url_${i}`]||'').trim();
      if(label&&url)links.push({label,url});
    }
    const seriesDate=body.series_date||undefined;
    const data={name:body.name,slug,description:body.description||'',cover_url:body.cover_url||'',status:body.status||'published',published:body.status!=='draft',tags:seriesTags,...(seriesDate?{date:seriesDate}:{}),...(mapLat&&mapLng?{map_lat:mapLat,map_lng:mapLng,map_zoom:mapZoom}:{}),links};
    const outFile=isNew?`${slug}.yaml`:file;
    writeYaml(path.join(CFG.seriesDir,outFile),data);
    autoGitPush(`serie: ${isNew?'création':'modification'} ${slug}`);
    redirect(`/series/edit/${outFile}?saved=1`);

  // ── Delete series
  } else if (req.method==='POST' && p.startsWith('/series/delete/')) {
    const file=path.basename(p.slice(15));
    let body;
    try { body = await parseJsonBody(req); }
    catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
    const fp=path.join(CFG.seriesDir,file);
    if(!fs.existsSync(fp)){json({ok:false},404);return;}
    const serie=readYaml(fp);
    if(body.action==='delete'){
      const photos=readPhotos().filter(p=>p.series===serie.slug);
      for(const photo of photos){
        fs.unlinkSync(path.join(CFG.photosDir,photo.file));
        if(photo.slug) deleteViaSFTP(serie.slug,photo.slug).catch(()=>{});
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
    let body;
    try { body = await parseJsonBody(req); }
    catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
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
    if (!isValidSlug(slug)) { json({ ok: false, error: 'slug invalide' }, 400); return; }
    if (!getKnownPhotoSlugs().has(slug)) { json({ ok: false, error: 'photo inconnue' }, 404); return; }
    const ip = getClientIp(req);
    if (!consumeRateLimit(`view:${ip}`, 180, 60_000)) { json({ ok: false, error: 'rate limit' }, 429); return; }
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

  // ── À propos — éditeur
  } else if (req.method==='GET' && p==='/about') {
    const aboutFile=path.join(__dirname,'src/content/pages/about.md');
    let raw='';
    try { raw=fs.readFileSync(aboutFile,'utf8'); } catch {}
    // Retire le frontmatter pour n'afficher que le contenu MD
    const bodyMd=raw.replace(/^---[\s\S]*?---\n?/,'').trim();
    const saved=url.searchParams.get('saved')||'';
    html(layout('À propos',`
<h1>À propos <span style="color:#9fb2d4;font-size:.85rem;font-weight:400">page publique /a-propos</span></h1>
${saved?'<div class="alert alert-success">✓ Page sauvegardée et déployée.</div>':''}
<p style="color:#9fb2d4;font-size:.85rem;margin-bottom:1.5rem">Saisie en Markdown — aperçu en direct à droite.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start">
  <div>
    <label style="display:block;font-family:monospace;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#9fb2d4;margin-bottom:.5rem">Markdown</label>
    <textarea id="md-input" style="width:100%;min-height:520px;background:#0a1628;border:1px solid #243a65;border-radius:.5rem;color:#d2e1ff;font-family:monospace;font-size:.85rem;padding:1rem;resize:vertical;line-height:1.6" oninput="updatePreview()">${bodyMd.replace(/</g,'&lt;')}</textarea>
    <form method="POST" action="/about/save" id="about-form" style="margin-top:1rem">
      <input type="hidden" id="md-hidden" name="content" value="">
      <button type="submit" class="btn btn-primary" onclick="document.getElementById('md-hidden').value=document.getElementById('md-input').value">Sauvegarder</button>
      <a href="https://stan-bouchet.eu/a-propos" target="_blank" class="btn btn-sm" style="margin-left:.5rem">Voir la page →</a>
    </form>
  </div>
  <div>
    <label style="display:block;font-family:monospace;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#9fb2d4;margin-bottom:.5rem">Aperçu</label>
    <div id="md-preview" style="background:#0a1628;border:1px solid #243a65;border-radius:.5rem;padding:1.25rem;min-height:520px;color:#d2e1ff;font-size:.93rem;line-height:1.7;overflow-y:auto"></div>
  </div>
</div>
<script>
function escapeHtml(s){
  return s
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function updatePreview(){
  const md=document.getElementById('md-input').value;
  document.getElementById('md-preview').innerHTML='<pre style="white-space:pre-wrap;font-family:inherit">'+escapeHtml(md)+'</pre>';
}
updatePreview();
</script>
<style>
#md-preview h1,#md-preview h2,#md-preview h3{font-family:serif;font-weight:400;margin:.5em 0 .25em}
#md-preview h1{font-size:1.6rem}#md-preview h2{font-size:1.2rem}
#md-preview p{margin:0 0 .75rem}
#md-preview a{color:#748fff}
#md-preview strong{color:#fff}
#md-preview ul,#md-preview ol{padding-left:1.5rem;margin:0 0 .75rem}
#md-preview blockquote{border-left:3px solid #748fff;padding-left:1rem;color:#9fb2d4;font-style:italic}
#md-preview code{background:#0f1f3d;border:1px solid #243a65;border-radius:3px;padding:.1em .35em;font-size:.85em}
#md-preview hr{border:none;border-top:1px solid #243a65;margin:1.5rem 0}
</style>
`,'settings'));

  } else if (req.method==='POST' && p==='/about/save') {
    const body=await parseBody(req);
    const content=(body.content||'').trim();
    const aboutFile=path.join(__dirname,'src/content/pages/about.md');
    // Lit le frontmatter existant
    let frontmatter='---\ntitle: À propos\ndescription: Qui je suis, pourquoi la photographie.\n---\n\n';
    try {
      const existing=fs.readFileSync(aboutFile,'utf8');
      const fm=existing.match(/^(---[\s\S]*?---\n)/);
      if(fm) frontmatter=fm[1]+'\n';
    } catch {}
    fs.writeFileSync(aboutFile, frontmatter+content+'\n');
    autoGitPush('page: mise à jour À propos');
    redirect('/about?saved=1');

  // ── Deploy status
  } else if (req.method==='GET' && p==='/deploy/status') {
    json({ pending: getPendingCount() });

  // ── Deploy (git push)
  } else if (req.method==='POST' && p==='/deploy') {
    const result = gitPush();
    if (result.ok) {
      json({ ok: true, message: '🚀 GitHub Action déclenchée — site MAJ sur O2Switch (~2 min)' });
    } else {
      json({ ok: false, message: result.error || 'Erreur lors du git push' }, 500);
    }

  // ── API ping (diagnostic version) ────────────────────────────────────────────
  } else if (p === '/api/ping') {
    applyPublicApiCors(req, res);
    if (!isCorsOriginAllowed(req)) { json({ ok: false, error: 'origin non autorisée' }, 403); return; }
    json({ version: '3.0', time: Date.now(), ratingsCount: dbGetAll().length });

  // ── API publique ratings (CORS ouvert — lecture/écriture sans auth) ─────────
  } else if (p.startsWith('/api/ratings')) {
    applyPublicApiCors(req, res);
    if (!isCorsOriginAllowed(req)) { json({ ok: false, error: 'origin non autorisée' }, 403); return; }

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    // GET /api/ratings → toutes les moyennes
    if (req.method === 'GET' && p === '/api/ratings') {
      json(dbGetAll());

    // GET /api/ratings/:slug → moyenne d'une photo
    } else if (req.method === 'GET' && p.startsWith('/api/ratings/')) {
      const slug = decodeURIComponent(p.slice('/api/ratings/'.length));
      if (!isValidSlug(slug)) { json({ ok: false, error: 'slug invalide' }, 400); return; }
      if (!getKnownPhotoSlugs().has(slug)) { json({ ok: false, error: 'photo inconnue' }, 404); return; }
      const r = dbGetRating(slug);
      json(r || { avg: 0, count: 0 });

    // POST /api/ratings/:slug  body: { score: 1-5 }
    } else if (req.method === 'POST' && p.startsWith('/api/ratings/')) {
      const slug = decodeURIComponent(p.slice('/api/ratings/'.length));
      if (!isValidSlug(slug)) { json({ ok: false, error: 'slug invalide' }, 400); return; }
      if (!getKnownPhotoSlugs().has(slug)) { json({ ok: false, error: 'photo inconnue' }, 404); return; }
      const ip = getClientIp(req);
      if (!consumeRateLimit(`rate:${ip}:${slug}`, 30, 60_000)) { json({ ok: false, error: 'rate limit' }, 429); return; }
      let payload;
      try { payload = await parseJsonBody(req); }
      catch { json({ ok: false, error: 'JSON invalide' }, 400); return; }
      const n = Number(payload.score);
      if (!slug || n < 1 || n > 5 || !Number.isInteger(n)) {
        json({ ok: false, error: 'score invalide (1-5 requis)' }, 400); return;
      }
      dbRate(slug, n);
      json({ ok: true, ...dbGetRating(slug) });
    } else {
      json({ ok: false, error: 'Route inconnue' }, 404);
    }

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

[CFG.tmpDir,CFG.processDir].forEach(d=>fs.mkdirSync(d,{recursive:true}));

function validateSecurityConfig() {
  if (SKIP_AUTH) return;
  const missing = [];
  if (!GITHUB_CLIENT_ID) missing.push('GITHUB_CLIENT_ID');
  if (!GITHUB_CLIENT_SECRET) missing.push('GITHUB_CLIENT_SECRET');
  if (!GITHUB_ALLOWED_USER) missing.push('GITHUB_ALLOWED_USER');
  if (!SESSION_SECRET_ENV) missing.push('SESSION_SECRET');
  if (missing.length) {
    throw new Error(`Configuration auth incomplète (fail-close): ${missing.join(', ')}`);
  }
  if (!ADMIN_BASE_URL.startsWith('https://')) {
    throw new Error('ADMIN_BASE_URL doit être en https quand l’auth est activée.');
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets.entries()) {
    if (v.resetAt <= now) rateBuckets.delete(k);
  }
}, 60_000).unref();

validateSecurityConfig();

server.listen(CFG.port,()=>{
  console.log(`\n  ┌──────────────────────────────────────┐`);
  console.log(`  │  Admin → http://localhost:${CFG.port}         │`);
  console.log(`  └──────────────────────────────────────┘\n`);
});
