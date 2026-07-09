import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the app under /Lightroute/, local dev under /.
  base: command === 'build' ? '/Lightroute/' : '/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Lightroute',
        short_name: 'Lightroute',
        description: 'Gratis routeplanner voor wielrennen',
        theme_color: '#d1342f',
        background_color: '#ffffff',
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
