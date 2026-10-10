# Doc Scanner

A phone-camera document scanner that runs entirely in the browser and files
multi-page PDFs into a self-hosted
[Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) instance.

Point your phone at a page. A neural network finds its edges live on the camera
preview; hold steady and it captures by itself. Every page is cropped to its
real edges, straightened, and its proportions corrected for the camera angle.
Then it gets a filter that makes the paper literal `#FFFFFF` and the text
literal `#000000` without blurring it, while logos, stamps and signatures keep
their colour. Collect as many pages as you like, then save one PDF or upload it
to Paperless, which adds the OCR text layer.

No backend. The app is static files; your phone talks straight to your own
Paperless server, and it keeps working offline after the first visit.

## How it works

| Stage      | What happens                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detect     | [DocAligner](https://github.com/DocsaidLab/DocAligner) LC100 (4.8 MB ONNX, heatmap regression) runs on the live preview via ONNX Runtime Web. About 0.99 Jaccard on SmartDoc 2015.                                                                                                                     |
| Capture    | Full-sensor still via ImageCapture where available (Android Chrome), else the video frame. Auto-capture fires after ~1 s of a steady, confident detection.                                                                                                                                             |
| Refine     | The model's corners (from a 256 px thumbnail) are snapped to the real paper edges at 1600 px: gradient search along each side's normal, sub-pixel peak, robust line fit, intersection. Typically 11 px → 1 px of error.                                                                                |
| Proportion | Edge lengths in a photo are foreshortened, so pages shot at an angle would rectify too short. The camera's focal length is recovered from the quad's vanishing points (Zhang & He, 2007) to get the true aspect ratio; a tilted A4 comes out at 1 : 1.414.                                             |
| Rectify    | Perspective warp with Catmull-Rom bicubic sampling (no softening when enlarging) and a box prefilter when shrinking (no aliasing).                                                                                                                                                                     |
| Flatten    | A paper-colour surface from a morphological closing (which wipes out ink but keeps the paper's own shading) follows wrinkles, creases and hand shadows; a coarse per-block estimate guards against large dark content. Dividing by it removes shadows and colour casts with no grey halos around text. |
| Filter     | See below.                                                                                                                                                                                                                                                                                             |
| Export     | One PDF, page size inferred from the shape (A4 / Letter / Legal, else 300 dpi). Clean pages are stored losslessly (Flate), photographic ones as JPEG.                                                                                                                                                  |
| Upload     | `POST /api/documents/post_document/` with title and tags, then the ingest task is polled until OCR finishes.                                                                                                                                                                                           |

### Filters that do not blur or fatten

Cheap scanners threshold the page to pure black and white, then blur the mask
to hide the jaggies, which is why their text looks soft. Most adaptive
thresholds (Sauvola and friends) also cut the camera's edge blur near the paper
end, so every stroke comes out bolder than it was printed.

Here each pixel's threshold sits halfway between the local ink level and the
paper. The ink level is the typical darkness of nearby strokes (the mean of
the darker pixels' darker half), not the single darkest pixel: phone cameras
sharpen and compress, which sprinkles near-black specks over soft grey text,
and a minimum-based threshold would cut such text in half. A lens blurs every edge into a ramp from ink to paper, and cutting that
ramp at its midpoint lands exactly on the true edge, so regular type stays
regular. Each pixel then goes through a narrow linear ramp around its
threshold: clearly ink becomes exactly black, clearly paper exactly white, and
only the one or two pixels that straddle an edge keep a proportional grey.

Around that:

- **Contour smoothing before the threshold.** A sub-pixel Gaussian, scaled to
  the camera's pixel size, removes the wobble that sensor noise and JPEG
  blocks put into glyph outlines. The ramp re-sharpens every edge.
- **Upsampled thresholding.** Pages are rendered at about 300 dpi even when
  that means enlarging the photo (bicubic, at most 2×), which gives smoother
  letter shapes than thresholding at camera resolution.
- **Solid shapes stay solid, tints go white.** Anything clearly dark is ink,
  so filled logos are not hollowed out; a light tint fills its own
  surroundings, so it does not turn into a black block.
- **Whole-component cleanup.** Every non-white blob (a glyph plus its
  anti-aliased fringe) is kept or dropped as a unit:
  - dark blobs are kept down to the size of an umlaut dot;
  - faint blobs are kept only if they are crisp, reasonably dark and thin
    (grey rules, grey small print). Fold, crease and wrinkle shading is light,
    soft and broad, so it goes;
  - slivers of table or page edge along the border are removed;
  - punch holes are removed when a pair matches ISO 838 geometry (about 6 mm,
    12 mm from the edge, 80 mm apart) and each other, and stands clear of any
    text line. A word at the margin is never taken for a hole.
- **Grey stays grey** in the Document filter: a thin grey rule is not turned
  into a heavy black line. B&W is strictly black and white.
- **Colour layer.** Saturated, non-paper blobs larger than a speck (logos,
  stamps, signatures, highlighter) are composited back in colour; chromatic
  fringes on black text are too small to qualify.

| Filter   | Result                                                     |
| -------- | ---------------------------------------------------------- |
| Document | Black text on white, colour content kept (default)         |
| B&W      | Black text on white, everything else too                   |
| Grey     | Flattened greyscale with clean white paper                 |
| Colour   | Flattened colour with clean white paper and a levels curve |
| Original | Perspective correction only                                |

Per page you can adjust whiteness, ink depth, text weight (0 keeps the printed
weight) and sharpening, rotate,
re-crop with a magnifier loupe, retake, reorder and delete. Hold the eye button
to compare with the unfiltered page.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/doc-scanner/
```

```bash
npm run check        # svelte-check + tsc
npm test             # vitest: imaging, detection decoding, refinement, PDF, camera choice
npm run lint
npm run build        # -> dist/
npm run preview
```

`tests/browser/synth.ts` generates synthetic phone photos (a printed page on a
wood-grain table with lighting gradient, shadow, noise and lens blur) for
checking detection and filters end to end in the dev server:

```js
const { synthPhoto } = await import('/doc-scanner/tests/browser/synth.ts');
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main`.
Enable it once under **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The base path comes from `actions/configure-pages`; for a user/org
site or custom domain build with `VITE_BASE=/ npm run build`.

Camera access needs a secure context: GitHub Pages (HTTPS) and `localhost` work,
a plain `http://192.168.x.x` does not.

The model (4.8 MB) and the ONNX Runtime WebAssembly binary (14 MB, 3.7 MB
gzipped) are precached by the service worker on the first visit.

## Connecting to Paperless-ngx

Open the gear icon and enter the server URL and an API token (Paperless: your
profile → _API Auth Token_). Optional default tag IDs are attached to every
upload. Both values stay in this browser's `localStorage` and are only ever sent
to that server.

The browser calls Paperless from another origin, so Paperless must allow it.
In `docker-compose.env`:

```bash
PAPERLESS_CORS_ALLOWED_HOSTS=https://yourname.github.io
```

Restart Paperless after changing it. Add `http://localhost:5173` too if you run
the dev server.

## Project layout

```
src/
  App.svelte                    screen routing
  components/                   camera, document grid, page editor, crop editor, settings
  lib/
    imaging/                    pure functions over typed arrays, no DOM
      quad.ts                   homography, corner ordering, perspective-correct aspect
      resample.ts               bicubic perspective warp with anti-alias prefilter
      background.ts             paper estimation and flattening
      filters.ts                document / B&W / grey / colour filters
      refine.ts                 sub-pixel edge snapping
      box.ts components.ts      box/Gaussian filters, connected components
    detect/heatmap.ts           DocAligner heatmaps → corners
    pdf/                        PDF writer, PNG predictors, paper size
    worker/                     detector (ONNX) and processor workers + clients
    camera/camera.ts            lens selection, torch, full-resolution stills
    store/                      session state, IndexedDB persistence
    paperless.ts export.ts      upload and PDF assembly
public/models/                  DocAligner model + licence
tests/                          vitest suites, synthetic photo generator
```

Detection and image processing run in Web Workers, so the camera preview and
the UI never stall. The session (photos, crops, filters, title) is saved to
IndexedDB, so a reload or a tab killed by the OS loses nothing.

### Speed

- Previews and thumbnails decode the photo at 1/2 or 1/4 size (natively, via
  `createImageBitmap`) when that is all the requested size needs.
- Finished renders are cached on the main thread, so going back to the grid
  or the camera redraws instantly; leaving a screen cancels its queued
  renders.
- While you review the document, a second worker prepares every page at
  export resolution, so PDF and Upload usually only assemble the file. It
  pauses while the camera is open.
- With camera permission granted, the standard lens is opened directly
  instead of opening one camera and switching.

After a deploy the app keeps running the cached version until it is reloaded
once.

## Limitations

- **Curled pages are not dewarped.** Book spines and folded receipts are
  straightened as planes.
- **A-series pages are assumed to be A4** in the PDF page size: A5 and A4 share
  an aspect ratio.
- **Light colour fills in B&W mode** come out as an outline or a grey texture.
  The Document filter keeps them in colour instead.
- **iOS Safari has no ImageCapture**, so stills there come from the video
  stream (up to 4K), not the full sensor.
- **Threads are off.** GitHub Pages cannot send the cross-origin isolation
  headers that WebAssembly threads need, so the model runs single-threaded.

## Privacy

Static files only: no analytics, no telemetry, no server of its own. The only
network requests are loading the app itself and the uploads to the Paperless
URL you configure.

## Licence

See `THIRD_PARTY_NOTICES.md` for bundled components. The DocAligner model is
Apache-2.0. No licence has been chosen for this project's own code yet.
