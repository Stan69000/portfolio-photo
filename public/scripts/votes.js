const RATINGS_KEY   = 'stan-photo-ratings-v1';
const FAVORITES_KEY = 'stan-photo-favorites-v1';

// ── Ratings ───────────────────────────────────────────────────────────────────
function readRatings() {
  try { return JSON.parse(localStorage.getItem(RATINGS_KEY) || '{}'); }
  catch { return {}; }
}

function getRating(slug) {
  return Number(readRatings()[slug] || 0);
}

function ratePhoto(slug, rating) {
  const ratings = readRatings();
  if (rating === 0) { delete ratings[slug]; }
  else { ratings[slug] = rating; }
  localStorage.setItem(RATINGS_KEY, JSON.stringify(ratings));
  document.dispatchEvent(new CustomEvent('ratings-updated', { detail: { slug } }));
  refreshStarWidgets();
}

// ── Favorites ─────────────────────────────────────────────────────────────────
function readFavorites() {
  try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'); }
  catch { return []; }
}

function isFavorite(slug) {
  return readFavorites().includes(slug);
}

function toggleFavorite(slug) {
  const favs = readFavorites();
  const idx = favs.indexOf(slug);
  if (idx >= 0) { favs.splice(idx, 1); }
  else { favs.push(slug); }
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
  document.dispatchEvent(new CustomEvent('favorites-updated', { detail: { slug } }));
  return idx < 0;
}

// ── Top photos par note ───────────────────────────────────────────────────────
function computeTop(limit) {
  const ratings = readRatings();
  return Object.entries(ratings)
    .map(([slug, rating]) => ({ slug, rating: Number(rating) }))
    .filter(x => x.rating > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit || 10);
}

// ── Labels ────────────────────────────────────────────────────────────────────
const LABELS = ['', 'Décevant', 'Moyen', 'Bien', 'Très bien', 'Excellent !'];
function labelFor(n) { return LABELS[n] || ''; }

// ── Rafraîchir tous les widgets étoiles ───────────────────────────────────────
function refreshStarWidgets() {
  document.querySelectorAll('[data-star-overlay]').forEach(wrap => {
    const slug = wrap.dataset.starOverlay;
    const current = getRating(slug);
    wrap.querySelectorAll('.star-btn').forEach(btn => {
      btn.classList.toggle('filled', Number(btn.dataset.star) <= current);
      btn.classList.remove('hovered');
    });
  });
  document.querySelectorAll('[data-star-widget]').forEach(wrap => {
    const slug = wrap.dataset.starWidget;
    const current = getRating(slug);
    wrap.querySelectorAll('.star-btn').forEach(btn => {
      btn.classList.toggle('filled', Number(btn.dataset.star) <= current);
      btn.classList.remove('hovered');
    });
    const label = wrap.closest('.star-widget-wrap')?.querySelector('.star-label');
    if (label) label.textContent = current > 0 ? LABELS[current] : '';
  });
}

// ── Clicks ────────────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.star-btn[data-star][data-star-slug]');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  ratePhoto(btn.dataset.starSlug, Number(btn.dataset.star));
});

// ── Hover ─────────────────────────────────────────────────────────────────────
document.addEventListener('mouseover', e => {
  const btn = e.target.closest('.star-btn[data-star][data-star-slug]');
  if (!btn) return;
  const n = Number(btn.dataset.star);
  const wrap = btn.closest('[data-star-overlay], [data-star-widget]');
  if (!wrap) return;
  wrap.querySelectorAll('.star-btn').forEach(b => {
    b.classList.toggle('hovered', Number(b.dataset.star) <= n);
    b.classList.remove('filled');
  });
  const label = wrap.closest('.star-widget-wrap')?.querySelector('.star-label');
  if (label) label.textContent = LABELS[n] || '';
});

document.addEventListener('mouseout', e => {
  const btn = e.target.closest('.star-btn[data-star][data-star-slug]');
  if (!btn) return;
  const wrap = btn.closest('[data-star-overlay], [data-star-widget]');
  if (!wrap) return;
  const current = getRating(btn.dataset.starSlug);
  wrap.querySelectorAll('.star-btn').forEach(b => {
    b.classList.remove('hovered');
    b.classList.toggle('filled', Number(b.dataset.star) <= current);
  });
  const label = wrap.closest('.star-widget-wrap')?.querySelector('.star-label');
  if (label) label.textContent = current > 0 ? LABELS[current] : '';
});

// ── Init ─────────────────────────────────────────────────────────────────────
window.PhotoVotes = { getRating, ratePhoto, isFavorite, toggleFavorite, computeTop, labelFor };
document.addEventListener('DOMContentLoaded', refreshStarWidgets);
document.addEventListener('astro:after-swap', refreshStarWidgets);
