import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * The OCR models are cached at runtime under unversioned names. Naming the
 * cache after a hash of their contents makes a new model set land in a fresh
 * cache instead of being served stale forever.
 */
interface CacheList {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

function ocrModelsCacheName(): string {
  const dir = new URL('./public/models/', import.meta.url);
  const hash = createHash('sha256');
  for (const name of readdirSync(dir)
    .filter((n) => n.startsWith('ppocrv5-'))
    .sort()) {
    hash.update(name).update(readFileSync(new URL(name, dir)));
  }
  return `ocr-models-${hash.digest('hex').slice(0, 12)}`;
}

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
        // Android: "Share" photos from the gallery or another app straight
        // into the document. public/share-target.js receives the POST.
        share_target: {
          action: 'share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'files', accept: ['image/*'] }] },
        },
        // Sharing again focuses the open app instead of stacking windows.
        launch_handler: { client_mode: ['navigate-existing', 'auto'] },
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
        // Receives photos shared from other apps (relative to the worker).
        importScripts: ['share-target.js'],
        // The model and the ONNX runtime are what make the app work offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest,wasm,onnx}'],
        // The OCR models (~13 MB) are only fetched, then cached, when a PDF is
        // first made; the page detector is needed immediately and precached.
        globIgnores: ['**/models/ppocrv5-*'],
        runtimeCaching: [
          {
            urlPattern: /\/models\/ppocrv5-/,
            handler: 'CacheFirst',
            options: {
              cacheName: ocrModelsCacheName(),
              cacheableResponse: { statuses: [200] },
              plugins: [
                {
                  // Serialised into the service worker, so it may use only its
                  // arguments. Drops the caches of earlier model sets.
                  cachedResponseWillBeUsed: async function ({
                    cacheName,
                    cachedResponse,
                  }: {
                    cacheName: string;
                    cachedResponse?: Response;
                  }) {
                    // This config is typed without the DOM library.
                    const storage = (globalThis as unknown as { caches: CacheList }).caches;
                    for (const key of await storage.keys()) {
                      if (/^ocr-models(-|$)/.test(key) && key !== cacheName) {
                        await storage.delete(key);
                      }
                    }
                    return cachedResponse;
                  },
                },
              ],
            },
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
    // The imaging tests run whole filters on page-sized images.
    testTimeout: 30_000,
  },
});
