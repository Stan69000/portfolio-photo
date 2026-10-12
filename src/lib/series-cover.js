// Resolves a series cover_url to a public image URL.
// The admin can store kDrive preview links (/api/sites/<site>/kdrive/preview?slug=…)
// that only exist on the admin host: they are mapped back to the photo's public URL.
const VERSION_FIELDS = { thumb: 'url_thumb', web: 'url_web', zoom: 'url_zoom' };

export function coverPhotoSlug(coverUrl) {
  if (!coverUrl || !/kdrive/.test(coverUrl)) return '';
  try {
    return new URL(coverUrl, 'https://local.invalid').searchParams.get('slug') || '';
  } catch {
    return '';
  }
}

export function resolveSeriesCover(coverUrl, photos = []) {
  if (!coverUrl) return '';
  const slug = coverPhotoSlug(coverUrl);
  if (slug) {
    const photo = photos.find(p => (p.data ?? p).slug === slug);
    if (photo) {
      const data = photo.data ?? photo;
      const version = new URL(coverUrl, 'https://local.invalid').searchParams.get('version');
      return data[VERSION_FIELDS[version] || 'url_web'] || data.url_web || data.url || '';
    }
  }
  // Relative admin-only paths are not served by the static site.
  return coverUrl.startsWith('/api/') ? '' : coverUrl;
}
