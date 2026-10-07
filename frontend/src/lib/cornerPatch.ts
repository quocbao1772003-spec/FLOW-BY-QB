// Corner patch: cover the small ✦ mark Flow stamps in the bottom-right
// corner of a generated image with the same spot from the base photo the
// image was made from (the photo wired into the node).
//
//   1. Find the mark: normalised cross-correlation of a 4-point-star template
//      against "generated minus base" brightness in the bottom-right corner
//      (the mark is a light overlay the base doesn't have). Falls back to
//      Flow's standard placement when nothing convincing is found.
//   2. Line the base up: search a small shift that best matches the ring
//      around the mark, and pick the best of several base candidates.
//   3. Copy a round patch from the base, shifted by the ring's average colour
//      difference so it sits in the new render's grade, feathered at the edge.
//
// Runs entirely in the browser on <canvas>.

export interface PatchBox {
  cx: number;
  cy: number;
  /** Mark size (tip to tip), px. */
  size: number;
  detected: boolean;
}

export interface PatchResult {
  blob: Blob; // PNG, lossless — the format conversion happens afterwards
  box: PatchBox;
  baseIndex: number;
  /** Small before/after crops of the corner for the dialog preview. */
  before: string;
  after: string;
  /** Mean brightness difference around the mark after alignment (0–255). */
  ringError: number;
}

const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  return [c, ctx];
}

/** Draw `bmp` onto a W×H canvas: stretch when the ratio matches, else cover. */
function drawFitted(bmp: ImageBitmap, W: number, H: number): ImageData {
  const [, ctx] = canvasOf(W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const ra = bmp.width / bmp.height;
  const rb = W / H;
  if (Math.abs(ra - rb) / rb < 0.03) {
    ctx.drawImage(bmp, 0, 0, W, H);
  } else {
    const s = Math.max(W / bmp.width, H / bmp.height);
    const dw = bmp.width * s;
    const dh = bmp.height * s;
    ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return ctx.getImageData(0, 0, W, H);
}

/** Where Flow puts the mark when detection finds nothing: measured on real
 *  1024px renders — 48px star centred 102px in from the right and bottom
 *  edges — and scaled with the image. */
function defaultBox(W: number, H: number): PatchBox {
  const k = Math.min(W, H) / 1024;
  return { cx: W - 102 * k, cy: H - 102 * k, size: 48 * k, detected: false };
}

/** Soft 4-point star, 1 inside, 0 outside — side n. */
function starTemplate(n: number): Float32Array {
  const t = new Float32Array(n * n);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = Math.abs((x - c) / (n / 2));
      const v = Math.abs((y - c) / (n / 2));
      const r = Math.pow(u, 0.8) + Math.pow(v, 0.8);
      t[y * n + x] = r <= 0.85 ? 1 : r >= 1.1 ? 0 : (1.1 - r) / 0.25;
    }
  }
  // zero-mean, unit-norm → plain dot product gives the correlation
  let mean = 0;
  for (let i = 0; i < t.length; i++) mean += t[i];
  mean /= t.length;
  let norm = 0;
  for (let i = 0; i < t.length; i++) {
    t[i] -= mean;
    norm += t[i] * t[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < t.length; i++) t[i] /= norm;
  return t;
}

/** Best normalised correlation of the star template inside `field`
 *  (a downsampled g×g grid). Returns centre + size in field units. */
function matchStar(field: Float32Array, g: number, sizes: number[]) {
  let best = { score: -1, x: 0, y: 0, n: 0, mean: 0 };
  for (const n of sizes) {
    if (n < 5 || n >= g) continue;
    const t = starTemplate(n);
    for (let oy = 0; oy + n <= g; oy++) {
      for (let ox = 0; ox + n <= g; ox++) {
        let dot = 0;
        let sum = 0;
        let sq = 0;
        for (let y = 0; y < n; y++) {
          const row = (oy + y) * g + ox;
          const trow = y * n;
          for (let x = 0; x < n; x++) {
            const v = field[row + x];
            dot += v * t[trow + x];
            sum += v;
            sq += v * v;
          }
        }
        const cnt = n * n;
        const varSum = sq - (sum * sum) / cnt;
        if (varSum <= 1e-6) continue;
        const score = dot / Math.sqrt(varSum);
        if (score > best.score) best = { score, x: ox + n / 2, y: oy + n / 2, n, mean: sum / cnt };
      }
    }
  }
  return best;
}

function locateMark(out: ImageData, base: ImageData): PatchBox {
  const W = out.width;
  const H = out.height;
  const m = Math.min(W, H);
  const R = Math.round(m * 0.2); // search the bottom-right 20%
  const f = Math.max(1, Math.round(m / 512)); // work at ~512px scale
  const g = Math.floor(R / f);
  const x0 = W - g * f;
  const y0 = H - g * f;
  const diff = new Float32Array(g * g);
  const bright = new Float32Array(g * g);
  for (let gy = 0; gy < g; gy++) {
    for (let gx = 0; gx < g; gx++) {
      let a = 0;
      let b = 0;
      for (let yy = 0; yy < f; yy++) {
        for (let xx = 0; xx < f; xx++) {
          const i = ((y0 + gy * f + yy) * W + (x0 + gx * f + xx)) * 4;
          const lo = lum(out.data, i);
          a += lo - lum(base.data, i);
          b += lo;
        }
      }
      diff[gy * g + gx] = a / (f * f);
      bright[gy * g + gx] = b / (f * f);
    }
  }
  const def = defaultBox(W, H);
  const n0 = def.size / f;
  const sizes = [0.7, 0.85, 1, 1.2, 1.45].map((k) => Math.round(n0 * k));
  let hit = matchStar(diff, g, sizes);
  if (!(hit.score > 0.35 && hit.mean > -2)) {
    // No usable base signal (base very different) — try the render alone.
    const alone = matchStar(bright, g, sizes);
    if (alone.score > hit.score) hit = alone;
  }
  if (hit.score < 0.35) return def;
  return { cx: x0 + hit.x * f, cy: y0 + hit.y * f, size: hit.n * f, detected: true };
}

/** Shift (dx, dy) of `base` that best matches `out` on the ring around the mark. */
function alignOnRing(out: ImageData, base: ImageData, box: PatchBox, rIn: number, rOut: number) {
  const W = out.width;
  const H = out.height;
  const maxShift = Math.max(4, Math.round(Math.min(W, H) / 128));
  const step = rOut > 60 ? 2 : 1;
  const pts: number[] = [];
  const x1 = Math.max(0, Math.floor(box.cx - rOut));
  const x2 = Math.min(W - 1, Math.ceil(box.cx + rOut));
  const y1 = Math.max(0, Math.floor(box.cy - rOut));
  const y2 = Math.min(H - 1, Math.ceil(box.cy + rOut));
  for (let y = y1; y <= y2; y += step) {
    for (let x = x1; x <= x2; x += step) {
      const d = Math.hypot(x - box.cx, y - box.cy);
      if (d >= rIn && d <= rOut) pts.push(x, y);
    }
  }
  let best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let err = 0;
      let cnt = 0;
      for (let k = 0; k < pts.length; k += 2) {
        const x = pts[k];
        const y = pts[k + 1];
        const bx = x + dx;
        const by = y + dy;
        if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
        err += Math.abs(lum(out.data, (y * W + x) * 4) - lum(base.data, (by * W + bx) * 4));
        cnt++;
      }
      if (cnt > 0 && err / cnt < best.err) best = { dx, dy, err: err / cnt };
    }
  }
  return best;
}

function cropPreview(src: HTMLCanvasElement, box: PatchBox, side: number): string {
  const s = Math.round(side);
  const [c, ctx] = canvasOf(160, 160);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, Math.round(box.cx - s / 2), Math.round(box.cy - s / 2), s, s, 0, 0, 160, 160);
  return c.toDataURL("image/png");
}

/**
 * Cover the corner mark of `outBlob` with the matching spot from the best of
 * `baseBlobs`. Returns null when no base lines up well enough.
 */
export async function patchCornerMark(outBlob: Blob, baseBlobs: Blob[]): Promise<PatchResult | null> {
  if (baseBlobs.length === 0) return null;
  const outBmp = await createImageBitmap(outBlob);
  const W = outBmp.width;
  const H = outBmp.height;
  const [outCanvas, outCtx] = canvasOf(W, H);
  outCtx.drawImage(outBmp, 0, 0);
  outBmp.close();
  const out = outCtx.getImageData(0, 0, W, H);

  // Score every base candidate; keep the one that lines up best.
  let pick: { idx: number; data: ImageData; box: PatchBox; dx: number; dy: number; err: number } | null = null;
  for (let i = 0; i < baseBlobs.length; i++) {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(baseBlobs[i]);
    } catch {
      continue;
    }
    const data = drawFitted(bmp, W, H);
    bmp.close();
    const box = locateMark(out, data);
    const rIn = box.size * 0.62;
    const rOut = rIn * 1.9;
    const a = alignOnRing(out, data, box, rIn, rOut);
    if (!pick || a.err < pick.err) pick = { idx: i, data, box, dx: a.dx, dy: a.dy, err: a.err };
  }
  // A ring this far off means the corner was regenerated differently —
  // pasting the base there would look wrong.
  if (!pick || pick.err > 38) return null;

  const { data: base, box, dx, dy } = pick;
  const rIn = box.size * 0.62; // fully replaced (mark + its soft glow)
  const rOut = rIn * 1.7; // feathered to nothing here
  const ringOut = rIn * 2.1;

  // Grade match: average colour difference on a ring just outside the patch.
  const sum = [0, 0, 0];
  let cnt = 0;
  const x1 = Math.max(0, Math.floor(box.cx - ringOut));
  const x2 = Math.min(W - 1, Math.ceil(box.cx + ringOut));
  const y1 = Math.max(0, Math.floor(box.cy - ringOut));
  const y2 = Math.min(H - 1, Math.ceil(box.cy + ringOut));
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const d = Math.hypot(x - box.cx, y - box.cy);
      if (d < rOut || d > ringOut) continue;
      const bx = x + dx;
      const by = y + dy;
      if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
      const io = (y * W + x) * 4;
      const ib = (by * W + bx) * 4;
      for (let c = 0; c < 3; c++) sum[c] += out.data[io + c] - base.data[ib + c];
      cnt++;
    }
  }
  const delta = sum.map((s) => (cnt ? s / cnt : 0));

  const result = new ImageData(new Uint8ClampedArray(out.data), W, H);
  const px1 = Math.max(0, Math.floor(box.cx - rOut));
  const px2 = Math.min(W - 1, Math.ceil(box.cx + rOut));
  const py1 = Math.max(0, Math.floor(box.cy - rOut));
  const py2 = Math.min(H - 1, Math.ceil(box.cy + rOut));
  for (let y = py1; y <= py2; y++) {
    for (let x = px1; x <= px2; x++) {
      const d = Math.hypot(x - box.cx, y - box.cy);
      if (d >= rOut) continue;
      const bx = Math.min(W - 1, Math.max(0, x + dx));
      const by = Math.min(H - 1, Math.max(0, y + dy));
      let a = d <= rIn ? 1 : 1 - (d - rIn) / (rOut - rIn);
      a = a * a * (3 - 2 * a); // smoothstep
      const io = (y * W + x) * 4;
      const ib = (by * W + bx) * 4;
      for (let c = 0; c < 3; c++) {
        const v = base.data[ib + c] + delta[c];
        result.data[io + c] = Math.round(a * v + (1 - a) * out.data[io + c]);
      }
    }
  }

  const before = cropPreview(outCanvas, box, rOut * 2.6);
  const [resCanvas, resCtx] = canvasOf(W, H);
  resCtx.putImageData(result, 0, 0);
  const after = cropPreview(resCanvas, box, rOut * 2.6);
  const blob: Blob = await new Promise((resolve, reject) =>
    resCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"),
  );
  return { blob, box, baseIndex: pick.idx, before, after, ringError: pick.err };
}
