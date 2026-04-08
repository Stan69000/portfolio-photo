import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const seriesEntries = await getCollection('series');
  const seriesBySlug = new Map(seriesEntries.map((s) => [s.data.slug, s.data.name]));

  const allPhotos = (await getCollection('photos')).filter(
    (p) => p.data.status === 'published' && p.data.date
  );

  const allSeries = (await getCollection('series')).filter(
    (s) => (s.data.status === 'published' || s.data.published) && s.data.date
  );

  const photoItems = allPhotos.map((p) => ({
    title: p.data.title,
    pubDate: new Date(p.data.date as string),
    description: [
      `<strong>Série :</strong> ${seriesBySlug.get(p.data.series) || p.data.series}`,
      p.data.description || p.data.title
    ].join('<br/>'),
    link: `/photo/${p.data.slug}/`,
    categories: p.data.tags ?? [],
    ...(p.data.url_web
      ? { enclosure: { url: p.data.url_web, length: 0, type: 'image/webp' } }
      : {}),
  }));

  const seriesItems = allSeries.map((s) => ({
    title: `Série : ${s.data.name}`,
    pubDate: new Date(s.data.date as string),
    description: s.data.description || s.data.name,
    link: `/series/${s.data.slug}/`,
    categories: s.data.tags ?? [],
    ...(s.data.cover_url
      ? { enclosure: { url: s.data.cover_url, length: 0, type: 'image/webp' } }
      : {}),
  }));

  const items = [...photoItems, ...seriesItems]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
    .slice(0, 50);

  return rss({
    title: 'Stan Bouchet — Photographie',
    description: 'Nouvelles photos et séries publiées sur le portfolio de Stan Bouchet.',
    site: context.site ?? 'https://stan-bouchet.eu',
    items,
    customData: '<language>fr-fr</language>',
  });
}
