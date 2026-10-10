"""Turn a photo into a short Y4M clip for Chromium's fake camera
(--use-file-for-fake-video-capture), so the live preview detection and
auto-capture can be driven with a known page.

usage: python3 y4m.py photo.jpg out.y4m [width height frames]
"""

import sys

import numpy as np
from PIL import Image


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 960
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 1280
    frames = int(sys.argv[5]) if len(sys.argv) > 5 else 30
    img = Image.open(src).convert("RGB").resize((width, height), Image.LANCZOS)
    ycc = np.asarray(img.convert("YCbCr"), dtype=np.uint8)
    y = ycc[:, :, 0]
    # 4:2:0 chroma: average 2x2 blocks.
    cb = ycc[:, :, 1].reshape(height // 2, 2, width // 2, 2).mean(axis=(1, 3)).round().astype(np.uint8)
    cr = ycc[:, :, 2].reshape(height // 2, 2, width // 2, 2).mean(axis=(1, 3)).round().astype(np.uint8)
    frame = b"FRAME\n" + y.tobytes() + cb.tobytes() + cr.tobytes()
    with open(dst, "wb") as f:
        f.write(f"YUV4MPEG2 W{width} H{height} F30:1 Ip A1:1 C420jpeg\n".encode())
        for _ in range(frames):
            f.write(frame)


if __name__ == "__main__":
    main()
