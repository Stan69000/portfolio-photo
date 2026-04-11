import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const photos = defineCollection({
  loader: glob({ pattern: '**/*.{yml,yaml}', base: './src/content/photos' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    series: z.string(),
    url: z.string(),
    url_thumb: z.string().optional(),
    url_web: z.string().optional(),
    url_zoom: z.string().optional(),
    status: z.enum(['published', 'draft', 'trash']).default('published'),
    date: z.coerce.date().optional(),
    description: z.string().default(''),
    tags: z.array(z.string()).default([]),
    rating: z.number().min(0).max(5).optional(),
    views: z.number().default(0),
    exif: z
      .object({
        camera: z.string().optional(),
        lens: z.string().optional(),
        focal_length: z.string().optional(),
        settings: z.string().optional(),
        iso: z.union([z.string(), z.number()]).optional()
      })
      .optional(),
    location: z
      .object({
        input_type: z.enum(['address', 'coords']).default('coords'),
        address: z.string().optional(),
        label: z.string().optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        public_visibility: z.enum(['hidden', 'approx', 'precise']).default('hidden')
      })
      .optional(),
    price: z.number().optional(),
    for_sale: z.boolean().default(false)
  })
});

const series = defineCollection({
  loader: glob({ pattern: '**/*.{yml,yaml}', base: './src/content/series' }),
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string(),
    cover_url: z.string(),
    published: z.boolean().default(true),
    status: z.enum(['published', 'draft']).default('published'),
    tags: z.array(z.string()).default([]),
    date: z.string().optional(),
    map_input_type: z.enum(['address', 'coords']).optional(),
    map_address: z.string().optional(),
    map_label: z.string().optional(),
    map_lat: z.number().optional(),
    map_lng: z.number().optional(),
    map_zoom: z.number().default(13).optional(),
    links: z.array(z.object({
      label: z.string(),
      url: z.string(),
    })).default([]),
  })
});

const settings = defineCollection({
  loader: glob({ pattern: '**/*.{yml,yaml}', base: './src/content/settings' }),
  schema: z.object({
    site_title: z.string(),
    watermark_name: z.string(),
    hero_title: z.string().optional(),
    about_text: z.string(),
    images_domain: z.string().optional(),
    series_title: z.string().optional(),
    series_subtitle: z.string().optional(),
    featured_photo_slug: z.string().optional()
  })
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  })
});

export const collections = { photos, series, settings, pages };
