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
