import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // Base path per target:
  //  - GitHub Pages serves under /Lightroute/ (repo-name subpath).
  //  - Cloudflare Pages (and any root-domain host) serve under /. Cloudflare
  //    sets CF_PAGES=1 during its build, so this switches automatically with no
  //    dashboard config. Set BASE_PATH explicitly to override (e.g. a subpath).
  //  - Local dev serves under /.
  base:
    process.env.BASE_PATH ??
    (process.env.CF_PAGES ? '/' : command === 'build' ? '/Lightroute/' : '/'),
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // Registered explicitly in main.ts instead (onNeedRefresh reloads the
      // page), so an already-open tab/installed app actually picks up a new
      // deploy instead of silently activating it in the background only.
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
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
