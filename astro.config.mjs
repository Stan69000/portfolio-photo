import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://stan-bouchet.eu',
  // En production, Caddy sert la page privée et l'API sur la même origine.
  // En développement, ce proxy reproduit ce montage vers le serveur d'administration.
  vite: {
    server: {
      proxy: {
        '/api/galerie': {
          target: process.env.GALLERY_API_ORIGIN ?? 'http://localhost:3000',
          changeOrigin: false,
        },
      },
    },
  },
});
