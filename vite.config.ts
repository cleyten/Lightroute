import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // Base path per target:
  //  - GitHub Pages serves under /Lightroute/ (repo-name subpath).
  //  - Cloudflare serves under /. Cloudflare Pages sets CF_PAGES and Cloudflare
  //    Workers Builds sets WORKERS_CI, so this switches automatically for both.
  //  - Any other root host: set BASE_PATH=/ (or override to a subpath).
  //  - Local dev serves under /.
  base:
    process.env.BASE_PATH ??
    (process.env.CF_PAGES || process.env.WORKERS_CI
      ? '/'
      : command === 'build'
        ? '/Lightroute/'
        : '/'),
  build: {
    // maplibre-gl is ~1.1 MB on its own and is essentially the whole initial
    // payload; it cannot be lazy-loaded because the map paints on first render.
    // Splitting it into its own vendor chunk does not shrink the total, but it
    // rarely changes, so a returning visitor re-downloads only the small app
    // chunk after a deploy while maplibre stays served from cache.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          return undefined;
        },
      },
    },
    // The maplibre vendor chunk is legitimately large; raise the warning above
    // it so a real regression in the (much smaller) app chunk still shows up.
    chunkSizeWarningLimit: 1200,
  },
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
        theme_color: '#f5f5f7',
        background_color: '#f5f5f7',
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
