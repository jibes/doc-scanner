/**
 * 8-connected component labelling with union-find. Returns the label of every
 * set pixel (0 = background) and the pixel count of every label.
 */
export function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; areas: Int32Array } {
  const labels = new Int32Array(width * height);
  const parent: number[] = [0];

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): number => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    if (ra < rb) {
      parent[rb] = ra;
      return ra;
    }
    parent[ra] = rb;
    return rb;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      // Previously visited neighbours: W, NW, N, NE.
      let label = x > 0 ? labels[i - 1] : 0;
      if (y > 0) {
        const nw = x > 0 ? labels[i - width - 1] : 0;
        const n = labels[i - width];
        const ne = x < width - 1 ? labels[i - width + 1] : 0;
        if (nw) label = label ? union(label, nw) : nw;
        if (n) label = label ? union(label, n) : n;
        if (ne) label = label ? union(label, ne) : ne;
      }
      if (!label) {
        label = parent.length;
        parent.push(label);
      }
      labels[i] = label;
    }
  }

  const areas = new Int32Array(parent.length);
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    labels[i] = root;
    areas[root]++;
  }
  return { labels, areas };
}

/** Clear components smaller than `minArea` pixels. Mutates and returns `mask`. */
export function removeSmallComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): Uint8Array {
  if (minArea <= 1) return mask;
  const { labels, areas } = labelComponents(mask, width, height);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && areas[labels[i]] < minArea) mask[i] = 0;
  }
  return mask;
}

/** 3x3 binary dilation. */
export function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width && mask[yy * width + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * width + x] = on;
    }
  }
  return out;
}
