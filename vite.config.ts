import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the app under /Lightroute/, local dev under /.
  // This path follows the GitHub repo name, so it stays 'Lightroute' until the
  // repo itself is renamed; the user-facing branding is 'Lightmile'.
  base: command === 'build' ? '/Lightroute/' : '/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // Registered explicitly in main.ts instead (onNeedRefresh reloads the
      // page), so an already-open tab/installed app actually picks up a new
      // deploy instead of silently activating it in the background only.
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      workbox: {
        // Map tiles are immutable once published and are by far the most
        // useful thing to have offline: without them the style never finishes
        // loading, map.on('load') never fires, and the app shows a blank grey
        // rectangle with no explanation. Routing itself still needs a
        // connection; that is reported in the UI instead.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap-vector',
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 14 },
              // Tile CDNs answer cross-origin requests opaquely (status 0).
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/[a-c]?\.?tile\.(opentopomap\.org|thunderforest\.com)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap-raster',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Lightmile',
        short_name: 'Lightmile',
        description: 'Free route planner for cycling',
        theme_color: '#2424e8',
        background_color: '#f6f3ec',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
}));
