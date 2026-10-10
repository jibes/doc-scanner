# Doc Scanner

A phone-camera document scanner that runs entirely in the browser and files the
result into a self-hosted [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx)
instance.

Point your phone at a page, drag the corners onto the paper, and the app
rectifies the perspective, flattens the lighting, turns the background into a
literal `#FFFFFF` and the text into a literal `#000000`, keeps logos and stamps
in colour, and uploads a PNG. Paperless runs OCRmyPDF and Tesseract on ingest,
so what lands in your archive is a small, searchable PDF.

There is no backend. The app is a static site; your phone talks straight to your
own Paperless server.

## What it does

| Stage     | What happens                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------- |
| Capture   | Standard 1x rear lens at full sensor resolution, or pick an image from the gallery                      |
| Rectify   | Four draggable corners, perspective warp to an axis-aligned page                                        |
| Flatten   | Divide-by-background illumination correction, per channel, so yellowed or unevenly lit paper goes white |
| Binarise  | Sauvola local thresholding (also Adaptive, Niblack, Wolf, Otsu)                                         |
| Colour    | Chroma-based mask keeps logos, stamps and signatures in their original pixels                           |
| Composite | Three normalised layers blended into the final page                                                     |
| Export    | PNG with a `pHYs` chunk so OCRmyPDF knows the intended DPI                                              |
| Upload    | `POST /api/documents/post_document/`, then poll the ingest task                                         |

### The two guarantees

The composite blends three weights that always sum to one:

```
colour = c
ink    = k * (1 - c)
paper  = (1 - c) * (1 - k)
```

So any pixel that is neither ink nor colour lands on exactly `paper` (255), and
any pixel at the core of a stroke lands on exactly `text` (0). Both masks are
feathered before blending, so edges stay anti-aliased instead of turning into
1-bit jaggies. `tests/composite.test.ts` asserts all of this.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/doc-scanner/
```

The dev server serves from the same sub-path as production, so base-path bugs
show up locally rather than after a deploy.

```bash
npm run check        # svelte-check + tsc for app, node and test configs
npm test             # vitest, 65 tests over the imaging pipeline and camera selection
npm run lint         # eslint
npm run format       # prettier
npm run build        # -> dist/
npm run preview      # serve dist/ locally
npm run icons        # regenerate the PWA icons in public/
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main`.
Enable it once under **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

The workflow asks `actions/configure-pages` for the base path and passes it to
the build as `VITE_BASE`, so forks with a different repository name work without
edits. To build for a user/org site or a custom domain:

```bash
VITE_BASE=/ npm run build
```

Camera access requires a secure context. GitHub Pages is HTTPS, so the deployed
URL works as-is. `http://localhost` also counts as secure; a plain
`http://192.168.x.x` does not.

## Connecting to Paperless-ngx

Open the gear icon and fill in:

- **Base URL** — e.g. `https://paperless.example.com`
- **API token** — from Paperless under _Settings → API Tokens_
- **Default tag IDs** — optional, comma separated

Both values are kept in this browser's `localStorage` and are only ever sent to
the server you name. Nothing goes anywhere else.

### You must allow CORS

The browser is calling your Paperless server from a different origin, so
Paperless has to permit it. In `docker-compose.env`:

```bash
PAPERLESS_CORS_ALLOWED_HOSTS=https://yourname.github.io
```

Then restart the container. Without this the upload fails with a network error
and the app will tell you so.

If you serve the scanner from a custom domain, list that origin instead. If you
run the scanner from `http://localhost:5173`, add that too.

## Settings

The four sliders most people touch:

| Control            | Effect                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Paper whiteness    | Background level. 255 is pure white; lower it for a softer look                                   |
| Text boldness      | Sauvola `k`. Higher thickens strokes, lower thins them                                            |
| Text darkness      | Ink level. 0 is pure black                                                                        |
| Despeckle          | Minimum blob area kept in the colour mask                                                         |
| Colour sensitivity | Chroma threshold for what counts as colour content                                                |
| Preserve colour    | Off folds coloured content into the ink layer, so stamps become solid black rather than vanishing |

Under **Advanced**: illumination radius, threshold window, edge feather, target
DPI, maximum long edge, binarisation method, and an invert toggle for light text
on a dark background.

### Presets

| Preset  | For                                          |
| ------- | -------------------------------------------- |
| Auto    | Balanced defaults                            |
| Text    | Pure black on pure white, no colour          |
| Receipt | Small text, tight threshold, no colour       |
| Invoice | Keeps logos and stamps, cleans the body text |
| Colour  | No binarisation, lighting flattened only     |
| Photo   | Pass-through for pages that are mostly image |

Touching any slider clears the preset selection but keeps the values.

## Camera selection

Phones expose every physical lens as its own camera device, and
`facingMode: 'environment'` is free to pick any of them. On most modern phones
that means the ultra-wide or a virtual multi-camera, which is the wrong lens for
a document: it is softer, wider, and distorts more towards the edges.

The scanner does not trust `facingMode` alone. It:

1. Opens a stream, because device labels stay hidden until permission is granted.
2. Scores every label and picks the standard 1x lens — `Back Camera` on iOS,
   `camera2 0, facing back` on Android. Ultra-wide, telephoto, macro, depth,
   LiDAR and front lenses are scored down; a virtual multi-camera loses to a
   plain single-lens entry.
3. Reopens the stream on that device when it differs from what `facingMode` chose.
4. Pins `zoom` to `1` and `focusMode` to `continuous` via `applyConstraints`, so
   a virtual multi-camera cannot sit on its 0.5x end.

The zoom and focus constraints are optional and best effort: platforms that do
not implement them ignore the request and the stream still works. The badge in
the top-left of the preview shows the selected lens and the zoom it was pinned to.

If the automatic choice is wrong, open the gear icon and pick a lens under
**Camera**. The choice is stored in `localStorage`. Device IDs are salted per
origin and can rotate between sessions, so a stale value falls back to automatic
selection rather than failing.

## Project layout

```
src/
  App.svelte                 screen state, worker orchestration, upload flow
  components/                camera, crop, result, settings dialog, slider, toast
  lib/
    imaging/                 the pipeline — pure functions, no DOM
      filters.ts             separable box filter (mirrored window)
      normalize.ts           divide-by-background illumination flattening
      binarize.ts            Sauvola / Niblack / Wolf / Adaptive / Otsu
      color.ts               chroma-based colour mask
      morphology.ts          erode, dilate, blob filter, mask feathering
      composite.ts           the three-layer blend
      warp.ts                homography + perspective warp
      png.ts                 pHYs chunk injection
      pipeline.ts            stage orchestration
    worker/                  module worker + promise client
    canvas.ts camera.ts      DOM and getUserMedia helpers
    cameraPrefs.ts           the stored camera choice
    paperless.ts             upload + task polling
    presets.ts settings.ts   defaults, presets, persistence
tests/                       vitest suites for every imaging module
scripts/generate-icons.mjs   writes the PWA icons, no binary assets in the repo
```

The imaging modules are pure functions over typed arrays with no DOM
dependency, which is why they can be unit-tested in Node and run unchanged
inside a Web Worker.

## How it stays responsive

All pixel work happens in a module Web Worker. The interactive preview runs on a
900 px copy of the page; the full-resolution render only happens when you save or
upload. Dragging a slider debounces for 80 ms and supersedes any in-flight
request, so only the newest settings are ever computed.

## Limitations

- **One page per scan.** Multi-page capture and PDF assembly are not implemented
  yet; each scan produces one PNG and one Paperless document.
- **Corners are manual.** There is no automatic edge detection. A good default
  inset plus four drag handles is more predictable than a heuristic, but it is
  more work per page.
- **No dewarping.** Curled pages and book spines are not straightened.
- **Divide-by-background leaves a small residual at the page borders**, because
  the estimation window there is mirrored rather than centred on real pixels. On
  a real photograph this is around one level; it is only visible on synthetic
  gradients steeper than any real lighting.
- **Large solid colour blocks** are not detected as ink by Sauvola, which is
  correct for text but means a big flat stamp relies on the colour mask to
  survive. With colour preservation off it is folded into the ink layer instead.
- **Lens selection depends on device labels.** Browsers only reveal them once
  camera permission has been granted, and some Android builds expose generic
  labels. When nothing scores above zero the app falls back to `facingMode`,
  which may land on the ultra-wide; the manual picker in settings is the escape
  hatch.
- **The API token lives in `localStorage`.** Fine for a personal device; do not
  use this on a shared browser.

## Privacy

The app is static files. It has no analytics, no telemetry, and no server of its
own. The only network request it makes is the upload to the Paperless URL you
configure. The service worker caches the app shell so it keeps working offline
after the first load.

## License

No license file is included. Add one before distributing.
