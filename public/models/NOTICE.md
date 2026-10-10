# docaligner-lc100.onnx

Document corner detector from **DocAligner** by DocsaidLab
(<https://github.com/DocsaidLab/DocAligner>), heatmap-regression model with an
LCNet-100 backbone and BiFPN neck, 256x256 input. Distributed unmodified, as
published by the authors for their `docaligner-docsaid` Python package
(model file `lcnet100_h_e_bifpn_256_fp32.onnx`).

Licensed under the Apache License, Version 2.0; see `LICENSE-Apache-2.0.txt`
in this directory. Copyright DocsaidLab.

# ppocrv5-det.onnx, ppocrv5-latin-rec.onnx, ppocrv5-latin-dict.txt

Text detection and Latin-script text recognition models from **PaddleOCR**
(PP-OCRv5 mobile; <https://github.com/PaddlePaddle/PaddleOCR>), Copyright
PaddlePaddle Authors, licensed under the Apache License, Version 2.0 (see
`LICENSE-Apache-2.0.txt` in this directory). Distributed unmodified in the
ONNX conversions published at
<https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx> (`ppocrv5_det.onnx`) and
<https://huggingface.co/monkt/paddleocr-onnx> (`languages/latin/rec.onnx`,
`languages/latin/dict.txt`), both Apache-2.0.
