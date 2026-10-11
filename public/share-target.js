/*
 * Service worker add-on (loaded with importScripts by the generated worker).
 *
 * Android's share sheet POSTs shared photos to `<scope>share-target` as
 * multipart/form-data (see `share_target` in the manifest). There is no server
 * to receive them, so the worker does: it keeps the images in Cache Storage
 * and redirects to the app, which picks them up on start
 * (src/lib/shareTarget.ts). Keep the names in step with that file.
 */
(() => {
  const CACHE = 'shared-files';
  const ACTION = 'share-target';

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'POST') return;
    const scope = self.registration.scope;
    if (request.url.split('?')[0] !== scope + ACTION) return;
    event.respondWith(receive(request, scope));
  });

  async function receive(request, scope) {
    let count = 0;
    try {
      const form = await request.formData();
      const cache = await caches.open(CACHE);
      const batch = Date.now();
      for (const file of form.getAll('files')) {
        if (typeof file === 'string' || !file.type.startsWith('image/')) continue;
        const key = `${scope}${CACHE}/${batch}-${String(count).padStart(3, '0')}`;
        await cache.put(
          key,
          new Response(file, {
            headers: {
              'Content-Type': file.type,
              'X-File-Name': encodeURIComponent(file.name || 'shared'),
            },
          }),
        );
        count++;
      }
    } catch {
      // Nothing usable was shared; the app opens as usual.
    }
    return Response.redirect(`${scope}?shared=${count}`, 303);
  }
})();
