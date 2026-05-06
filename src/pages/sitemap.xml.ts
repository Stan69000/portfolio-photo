import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('https://stan-bouchet.eu');

  const staticPaths = ['/', '/photos/', '/series/', '/recherche/', '/stats/', '/a-propos/'];
  const staticUrls = staticPaths.map((path) => ({
    loc: new URL(path, base).toString(),
    lastmod: undefined as string | undefined,
  }));

  const photos = (await getCollection('photos')).filter((p) => p.data.status === 'published');
  const series = (await getCollection('series')).filter((s) => s.data.published && s.data.status === 'published');

  const photoUrls = photos.map((p) => ({
    loc: new URL(`/photo/${p.data.slug}/`, base).toString(),
    lastmod: p.data.date ? new Date(p.data.date).toISOString() : undefined,
  }));

  const seriesUrls = series.map((s) => ({
    loc: new URL(`/series/${s.data.slug}/`, base).toString(),
    lastmod: s.data.date ? new Date(s.data.date).toISOString() : undefined,
  }));

  const urls = [...staticUrls, ...photoUrls, ...seriesUrls];

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((entry) => {
      const lines = [`  <url>`, `    <loc>${escapeXml(entry.loc)}</loc>`];
      if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
      lines.push(`  </url>`);
      return lines.join('\n');
    }).join('\n') +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
};
