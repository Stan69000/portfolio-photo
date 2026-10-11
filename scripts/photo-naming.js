// Shared naming rules for existing photos and future imports.
export function seriesPhotoTitle(name, number) {
  return `${String(name).trim()} — ${String(number).padStart(3, '0')}`;
}

export function nextSeriesPhotoNumber(photos, series, reservedTitles = []) {
  const prefix = `${String(series.name).trim()} — `;
  const stored = photos.filter(photo => photo.series === series.slug);
  const existing = new Set(stored.map(photo => photo.title));
  const pending = [...reservedTitles].filter(title => title.startsWith(prefix) && !existing.has(title));
  const members = [...stored, ...pending.map(title => ({ series: series.slug, title }))];
  return members.reduce((max, photo) => {
    const suffix = String(photo.title || '').startsWith(prefix)
      ? String(photo.title).slice(prefix.length) : '';
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
  }, members.length) + 1;
}

export function planSeriesPhotoNames(photos, series) {
  return photos.filter(photo => photo.series === series.slug)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
      || String(a.file).localeCompare(String(b.file), 'fr', { numeric: true }))
    .map((photo, index) => ({ ...photo, title: seriesPhotoTitle(series.name, index + 1) }));
}
