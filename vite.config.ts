import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * GitHub Pages serves project sites from https://<user>.github.io/<repo>/, so
 * every asset has to be requested from that sub-path. Override VITE_BASE when
 * deploying to a user/org site (VITE_BASE=/) or a custom domain.
 */
const base = process.env.VITE_BASE ?? '/doc-scanner/';

/** Workbox wants an absolute path for the navigation fallback. */
const navigateFallback = base.startsWith('/') ? `${base}index.html` : 'index.html';

export default defineConfig({
  base,
  plugins: [
    svelte(),
    VitePWA({
      // An update waits until every tab of the app is closed. Taking over a
      // running tab would delete the old precache under it, and the workers
      // it has yet to start (export, OCR) would then 404.
      registerType: 'prompt',
      manifest: {
        name: 'Doc Scanner',
        short_name: 'Scanner',
        description:
          'Scan multi-page documents with automatic edge detection and send clean PDFs to Paperless-ngx.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The model and the ONNX runtime are what make the app work offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest,wasm,onnx}'],
        // The OCR models (~13 MB) are only fetched, then cached, when a PDF is
        // first made; the page detector is needed immediately and precached.
        globIgnores: ['**/models/ppocrv5-*'],
        runtimeCaching: [
          {
            urlPattern: /\/models\/ppocrv5-/,
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-models' },
          },
        ],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
