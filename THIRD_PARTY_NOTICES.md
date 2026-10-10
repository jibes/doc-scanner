# Third-party notices

| Component                                                                                                  | Use                                         | Licence                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| [DocAligner](https://github.com/DocsaidLab/DocAligner) LC100 model (`public/models/docaligner-lc100.onnx`) | Page corner detection, bundled unmodified   | Apache-2.0 — see `public/models/NOTICE.md` and `public/models/LICENSE-Apache-2.0.txt` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)                                               | Runs the model in the browser (WebAssembly) | MIT                                                                                   |
| [Svelte](https://svelte.dev)                                                                               | UI framework                                | MIT                                                                                   |
| [Workbox](https://developer.chrome.com/docs/workbox) via vite-plugin-pwa                                   | Offline caching                             | MIT                                                                                   |

The corner refinement follows the usual sub-pixel edge fitting approach; the
aspect-ratio correction implements Zhang & He, _Whiteboard scanning and image
enhancement_, Digital Signal Processing 17(2), 2007.
