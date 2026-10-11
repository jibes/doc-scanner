# Doc Scanner

A phone-camera document scanner that runs entirely in the browser and files
multi-page PDFs into a self-hosted
[Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) instance.

Point your phone at a page. A neural network finds its edges live on the camera
preview; hold steady and it captures by itself. Every page is cropped to its
real edges, straightened, and its proportions corrected for the camera angle.
Then it gets a filter that makes the paper literal `#FFFFFF` and the text
literal `#000000` without blurring it, while logos, stamps and signatures keep
their colour. Collect as many pages as you like, then save one searchable PDF
(text recognised on the phone) or upload it to Paperless, which runs its own
OCR.

No backend. The app is static files; your phone talks straight to your own
Paperless server, and it keeps working offline after the first visit.

## How it works

| Stage      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detect     | [DocAligner](https://github.com/DocsaidLab/DocAligner) LC100 (4.8 MB ONNX, heatmap regression) runs on the live preview via ONNX Runtime Web. About 0.99 Jaccard on SmartDoc 2015. On the captured photo its quad is checked against the photo itself: every side must be a colour edge along its whole length. A line search over the photo (Hough transform on colour gradients) finds the quads that pass, and the largest one wins, so a page that fills the frame, one whose model quad stops at a photo or a coloured band inside it, or a coloured or gradient page is cropped to its real edges. When no straight quad passes (a sheet pinned to a board bows and sags, pins cover its corners, it overlaps another white sheet), a relaxed search snaps candidate quads onto the edges near each corner and accepts sides that run within about 1 % of a straight line, with the paper on their inside, one of them only partly visible. A side must be a step (paper inside, something else outside), not a thin dark line with paper on both sides: a form's table rules are long straight edges too, and would otherwise crop a ruled sheet to a strip of its rows. An unverified model quad is used only when the model is sure of it, it has the shape of a photographed rectangle and none of its sides is such a printed line. Failing all that, a page that fills the frame is taken (a flat scan, a sheet photographed close up): each side is the paper's edge near a border, or the border itself where the paper reaches it all along. Otherwise no page is reported and you place the corners; an imported image then keeps all of it rather than a guessed inset. A page running off the photo is cut to the part in view, undistorted, and the app says so. |
| Capture    | Full-sensor still via ImageCapture where available (Android Chrome), else the video frame. Auto-capture fires after ~1 s of a steady, confident detection. "Hold still…" shows while the photo is taken; the flash and buzz mean it is done. Blurred captures are flagged for a retake: edge strength against a slightly blurred copy catches focus blur, and the width of the strongest edges in each direction catches a shake, which smears edges one way only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Refine     | The model's corners (from a 256 px thumbnail) are snapped to the real paper edges at 1600 px: gradient search along each side's normal, sub-pixel peak, robust line fit, intersection. Typically 11 px → 1 px of error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Proportion | Edge lengths in a photo are foreshortened, so pages shot at an angle would rectify too short. The camera's focal length is recovered from the quad's vanishing points (Zhang & He, 2007) to get the true aspect ratio; a tilted A4 comes out at 1 : 1.414.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Rectify    | Perspective warp with Catmull-Rom bicubic sampling (no softening when enlarging) and a box prefilter when shrinking (no aliasing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Flatten    | A paper-colour surface from a morphological closing (which wipes out ink but keeps the paper's own shading) follows wrinkles, creases and hand shadows; crisp edges separate photos, colour panels and bands from the paper, and the surface under them is filled in from the paper around them. Dividing by it removes shadows and colour casts with no grey halos around text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Filter     | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Export     | One PDF. The paper size comes from the page's shape, since a photo has no scale: A4 / Letter / Legal, an ID-1 card (85.6 × 54 mm), an 80 mm till receipt for long narrow strips, anything else fitted to A4. A crop that is a guess or cut off by the photo's edge claims no format. Clean pages are stored losslessly (Flate), photographic ones as JPEG.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Read       | Optional, for saved PDFs: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 text detection (4.7 MB) and Latin recognition (7.8 MB) in a worker. Words go into an invisible text layer positioned over the image, so the PDF is searchable and copyable. The recogniser reads the flattened greyscale page rather than the thresholded Document or B&W image: on faint or low-resolution print, thresholding loses umlaut dots and the shapes that tell letters apart. A page photographed sideways or upside down is turned upright: tall text regions mean sideways, and the longest lines read both ways up tell up from down; only clear evidence turns a page, and never one you rotated yourself. Runs in the background while you review the pages (the page turns in the app too); "Save without text" skips the wait.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Upload     | `POST /api/documents/post_document/` with title, tags, type and correspondent, then the ingest task is polled until OCR finishes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

- **Paper, shadows and printed areas told apart.** The paper surface comes
  from a morphological closing of a ~1200 px copy, which wipes out ink but
  keeps the paper's own shading. Crisp edges in it (a printed area ends as
  sharply as the lens draws it; shading changes gradually) cut it into
  regions. The paper is the large, bright, nearly neutral region; regions
  with the paper's colour where they are (paper beyond a band, white
  lettering) and hard-edged shadows (the paper's colour, evenly darker,
  smooth) count as paper too. Everything else (photos, colour panels,
  header bands, tints) is content: the surface under it is filled in from
  the paper around it, so dividing by the surface removes shadows and casts
  from the paper but leaves those areas as printed, not whitened into
  patches. At a hard shadow edge the surface steps on the lit side, where an
  error only clips paper to white, never on the shadowed side, where it
  would draw a dark line.
- **Contour smoothing before the threshold.** A sub-pixel Gaussian, scaled to
  the camera's pixel size, removes the wobble that sensor noise and JPEG
  blocks put into glyph outlines. The ramp re-sharpens every edge.
- **Upsampled thresholding.** Pages are rendered at about 300 dpi even when
  that means enlarging the photo (bicubic, at most 2×), which gives smoother
  letter shapes than thresholding at camera resolution.
- **Solid shapes stay solid, tints go white.** Anything clearly dark is ink,
  so filled logos are not hollowed out; a light tint fills its own
  surroundings, so it does not turn into a black block.
- **Faded print is strengthened, not dropped.** When even the darkest print
  on the page (the ink level over a few lines' area) is light grey, the
  page's contrast is stretched (up to 4×) until it is dark grey, so a washed
  out copy comes out legible instead of blank. A crease or a speck covers too
  little area to count as print.
- **Whole-component cleanup.** Every non-white blob (a glyph plus its
  anti-aliased fringe) is kept or dropped as a unit:
  - dark blobs are kept down to the size of an umlaut dot;
  - faint blobs are kept next to dark text, and elsewhere if they are made
    of strokes (stroke width, from area and outline, stays narrow), crisp for
    their contrast (a lighter print has gentler edges) and not a short lone
    streak: fold, crease and wrinkle shading is broad, soft or a single
    short line, while a grey word's letters each add their own outline;
  - lines of faint print (a thermal receipt, a grey footer) vouch for the
    softer, smaller marks among them (punctuation, an l or a 1), as dark text
    does;
  - slivers along the border are removed only if they touch it or are long
    thin lines, so text close to the edge of a tight crop survives.
- **Grey stays grey** in the Document filter: a thin grey rule is not turned
  into a heavy black line.
- **B&W is strictly black and white** (two levels, no anti-aliasing): that is
  what the mode is for, it compresses best, and at 300 dpi the edge is
  still where the threshold puts it. Photos and colour areas get one fixed
  threshold on their tone (smoothed on smooth tones, sharp on lettering), so
  they come out as a clean two-tone picture with legible lettering instead
  of a hollow outline or noise.
- **Colour layer.** Photos, colour areas and dark bands found by the paper
  analysis, and saturated blobs larger than a speck (logos, stamps,
  signatures, highlighter), are composited from the colour page, so a photo
  stays photographic and white lettering on a coloured band stays white
  without a black rim. Pale neutral tints go white with the paper.
- **Coloured print stays coloured.** A kept glyph or line whose core is
  clearly coloured (a link, a coloured heading, a thin coloured table rule)
  is drawn as crisp ink in its own colour. Thin lines mix with the paper in
  the photo; the test is the colour's purity (chroma over distance from
  white), which that mixing does not change, and the colour is extended to
  the blob's darkest point.
- **Pen marks stay coloured too.** Ballpoint is dark and only faintly blue
  or violet for its darkness, and a cross over a printed answer circle or a
  table rule joins them into one blob that is mostly grey print. So colour
  is also judged per pixel against its own darkness, with the page's print
  colour cast taken out: connected coloured ink that has an inside (a pen
  stroke, not the one- or two-pixel fringe a lens or JPEG leaves along black
  print), one hue throughout, and clearly more colour than a cast keeps its
  colour, while the print it touches stays black. Warm hues need much more
  colour, since warm light leaves the darkest print a little brown. A page
  with real colour is stored in three channels, which costs about 1.7× the
  size of a grey page.

| Filter   | Result                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| Document | Black text on white, colour content, photos and coloured print kept (default)                    |
| B&W      | Strictly black and white; photos and colour areas as two-tone pictures                           |
| Grey     | Flattened greyscale with clean white paper; photos as grey photos                                |
| Colour   | Flattened colour: paper in its own colour (white paper white), shadows and casts removed, levels |
| Original | Perspective correction only                                                                      |

**Coloured paper.** Document, B&W and Grey turn any paper white: they are for
reading and archiving text, and a tinted ground only costs contrast and file
size. Colour keeps the paper's own colour, minus shadows and the light's
cast. Only the page is seen, and a lamp's cast and a coloured sheet look
alike, so the rule goes by what light can do: phones white-balance, and what
is left of a lamp's or the sun's colour lies on the warm (orange to yellow)
axis and stays moderate. A warm tint therefore counts as the paper's colour
only when strong (saturation above about 0.22, as yellow paper is), a tint of
any other hue (blue, green, pink paper) already when mild (above about
0.05). In between it fades in, so no threshold flips a page abruptly.

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
npm test             # vitest: imaging, detection, refinement, orientation, PDF, camera choice
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
gzipped) are precached by the service worker on the first visit. The OCR models
(12.7 MB) are downloaded the first time a searchable PDF is made and cached from
then on; turn "Make saved PDFs searchable" off in the settings to never fetch
them. A new version takes over once every tab of the app is closed (for the
installed app: swiped away), never under a running one.

## Using it

- **Camera:** the outline follows the page; hints say when to move closer or
  that it is too dark (with a flash shortcut). Each capture confirms with
  "Page N added", and **Done · N pages** next to the shutter leads to the
  document. The lens is chosen under Settings → Camera. A few tips show the
  first time the camera opens.
- **Crop:** drag a corner or edge; it moves with the finger from where it
  was, never jumping to it. Rest the finger for a moment and the corner moves
  at half speed for the last pixels (the magnifier's ring turns blue); the
  small shift a finger makes as it lifts off the glass is undone.
- **Importing:** the gallery button beside the shutter adds photos. On
  Android, the installed app also appears in the share sheet: share photos
  from the gallery or another app and they are added as pages.
- **Installing:** where the browser supports it (Chrome, Edge, Brave on
  Android and desktop) the document screen offers "Install"; on iOS it shows
  once how to use Share → Add to Home Screen.
- **Document:** press and hold a page to drag it to a new position. A filter
  chip above the grid applies to every page.
- **Page:** swipe left or right (or use the arrow keys) to move between pages.
  "Apply … to all pages" copies this page's filter and adjustments. Deleting a
  page can be undone from the message that appears.
- **History:** every saved PDF and upload is listed; the last 15 PDFs are kept
  on the device to share or upload again.
- Follows the system light or dark theme; the camera and crop screens stay
  dark. Reduced-motion settings turn off the animations.

## Connecting to Paperless-ngx

Open the gear icon and enter the server URL and an API token (Paperless: your
profile → _API Auth Token_). Both values stay in this browser's `localStorage`
and are only ever sent to that server. **Test connection** checks, step by step,
that the address is valid, the server answers (and, if it does not, whether it
is down or only refusing this app's origin under CORS), the token is accepted,
the user may add documents, view tasks and read tags, and shows the Paperless
version when the server reports it.

Default tags, document type and correspondent are picked by name from the lists
on your server (searchable, with the tags' colours) and can be changed before
each upload. The lists are cached on the device for ten minutes and used
offline beyond that; names are looked up again just before sending, so a tag
renamed or deleted in Paperless is simply left out. Tag IDs from older versions
of the app are turned into names the first time the lists load.

If an upload cannot reach the server (offline, server down, or a gateway error
from the proxy in front of it), the PDF and its tags are kept on the device and
the History entry shows it as waiting. The app retries when the device comes
back online, when it is opened or brought to the foreground, and on a timer
while it is open (15 s, doubling up to 10 minutes). An error from Paperless
itself (a rejected file or token) is reported instead of retried. Retries run
in the app, not in the service worker: Background Sync is Chromium-only and
would replay the upload where the app cannot learn its result.

**Paperless must be served over https.** The app itself is on https, and
browsers block requests from an https page to a plain `http://` server (mixed
content); some also block pages on the internet from reaching addresses on your
local network. Plain http is accepted only for `localhost` / `127.0.0.1`.
Put Paperless behind a reverse proxy with a certificate (Caddy, Traefik,
Tailscale's `tailscale serve`, …).

The browser calls Paperless from another origin, so Paperless must allow it.
In `docker-compose.env`, list the app's origin (scheme and host only, no path):

```bash
PAPERLESS_CORS_ALLOWED_HOSTS=https://yourname.github.io
```

Restart Paperless after changing it. Add `http://localhost:5173` too if you run
the dev server.

The token's user needs permission to add documents and to view tasks; without
the latter the app cannot tell whether an upload was filed.

### Where the token lives

The token is stored in `localStorage`, which belongs to the site's _origin_
(scheme + host), not to its path. On `https://<user>.github.io/doc-scanner/`
that origin is `https://<user>.github.io`, shared by **every** GitHub Pages
project site of that user: script from any of them can read the token. If you
publish other Pages sites (or might later), serve this app from its own origin
instead, e.g. a custom subdomain such as `scan.example.com` (Settings → Pages →
Custom domain, then build with `VITE_BASE=/`). Use a dedicated Paperless user
with only the permissions above, so a leaked token can do little.

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
    detect/quadSearch.ts        page edges by line search: checks and extends the model's quad
    ocr/paddle.ts               PP-OCRv5 pre/post-processing (DB boxes, CTC decoding)
    ocr/orientation.ts          sideways / upside-down pages from the text
    pdf/                        PDF writer, PNG predictors, paper size
    worker/                     detector, OCR (ONNX) and processor workers + clients
    camera/camera.ts            lens selection, torch, full-resolution stills
    importPhotos.ts             photo → page (camera, file picker and share sheet)
    dragFilter.ts               crop handle dragging: fine mode, lift jitter
    shareTarget.ts              photos shared from other apps (with public/share-target.js)
    onboarding.svelte.ts        install prompt and first-run tips
    store/                      session state, IndexedDB persistence
    paperless.ts export.ts      upload and PDF assembly
    history.ts                  past exports and uploads
public/models/                  DocAligner and PaddleOCR models + licences
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

- **Punch holes stay visible.** Automatic removal was tried and taken out: an
  isolated letter at the margin can match every geometric test a hole
  matches, and a deleted letter is far worse than a visible hole.
- **Sharp creases can leave a dark line.** Broad wrinkle shading is removed,
  but a crease narrower than a thick pen stroke is indistinguishable from ink.
- **Curled pages are not dewarped.** Book spines and folded receipts are
  straightened as planes. A bowed sheet is cropped at its corners, so its
  bulging sides are cut by up to the bow.
- **A page among other papers** (a pin board, a cluttered desk) is found from
  its own edges; an edge of a neighbouring card or sheet that runs exactly
  parallel to the page a few millimetres away can still be taken for the
  page's own, and the crop then needs a corner dragged.
- **Paper size is a guess from the shape.** A photo carries no scale, so:
  A-series pages are assumed to be A4 (A5 shares its aspect ratio); till
  receipts are assumed to be on 80 mm rolls, so a 57/58 mm card-terminal slip
  comes out about 1.4× too large; an ID-1 card and a Legal page differ by
  4% in shape, so a strongly tilted shot of one can be taken for the other;
  other shapes are fitted to A4.
- **A page running off the photo** keeps only the part in view, so its PDF
  page is smaller than the paper.
- **Light colour fills in B&W mode** go white (with their text black): B&W
  is two-tone. The Document filter keeps them in colour.
- **A flat, neutral grey print with a crisp edge** looks exactly like a hard
  shadow, and is flattened white like one. Printed full-page gradients look
  like uneven light and are flattened too.
- **Sharing into the app needs Android and the installed app.** The share
  target is declared in the manifest and handled by the service worker
  (`public/share-target.js`), so it appears only after installing, and only
  where Web Share Target is supported (Chrome-based browsers on Android, not
  iOS). PDFs cannot be shared in; images only.
- **iOS Safari has no ImageCapture**, so stills there come from the video
  stream (up to 4K), not the full sensor.
- **Threads are off.** GitHub Pages cannot send the cross-origin isolation
  headers that WebAssembly threads need, so the model runs single-threaded.

- **OCR reads Latin script only** (English, German, French, Spanish, …), and
  the text layer uses the standard Helvetica encoding, so characters outside
  Windows-1252 are written as `?`. It takes a few seconds per page on a phone.
- **Curly apostrophes and ellipses come out as `'` and `...`** in the text
  layer: the recogniser was trained on normalised text. They are left that
  way on purpose. Which quote a straight `'` stands for (’ in "don’t", ‘ or ’
  around a quotation, a foot mark, a typewriter page) cannot be told from the
  text, and searches are typed with the plain characters anyway, so a guessed
  conversion would mostly make words harder to find.

## Privacy

Static files only: no analytics, no telemetry, no server of its own. The only
network requests are loading the app itself (including the OCR models, from
the same site) and the uploads to the Paperless URL you configure. Text
recognition happens on the device. A Content Security Policy in `index.html`
allows only the app's own scripts and network requests to https servers (plus
`localhost`).

## Licence

See `THIRD_PARTY_NOTICES.md` for bundled components. The DocAligner and PaddleOCR
models are Apache-2.0. No licence has been chosen for this project's own code yet.
