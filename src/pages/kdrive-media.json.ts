import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { publicKdriveManifest } from '../../scripts/kdrive-media.js';

// Publish only identifiers needed to display published images; never originals or credentials.
export const GET: APIRoute = async () => {
  const photos = await getCollection('photos', ({ data }) => data.status === 'published' && Boolean(data.kdrive));
  const manifest = publicKdriveManifest(photos.map(({ data }) => data));
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
};
