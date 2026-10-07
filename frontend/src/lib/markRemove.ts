// Remove Flow's ✦ corner mark WITHOUT a base photo, by undoing the blend.
//
// The mark is pure white laid over the image at a constant opacity, so
//     shown = a·255 + (1 − a)·true   →   true = (shown − a·255) / (1 − a)
// where a(x, y) is the mark's opacity at that pixel. The shape and opacity
// were measured from real Flow renders against their source photos (6 pairs,
// residual 1.4/255): a 4-point star |x|^0.65 + |y|^0.65 ≤ r^0.65 with
// r = 26.75 px, opacity 0.304, centred 102 px in from the right and bottom
// edges of a 1024 px image (everything scales with the short side). The edge
// is softened like the JPEG-blurred original, the exact spot/size is refined
// by looking for the cleanest result, and a 3 px band along the outline is
// filled from both sides so no ring is left.

export interface MarkBox {
  cx: number;
  cy: number;
  r: number;
}

export interface MarkRemoveResult {
  blob: Blob; // PNG
  box: MarkBox;
  before: string;
  after: string;
}

const OFFSET = 102; // px from right/bottom edge to centre, at 1024 px
const RADIUS = 26.75;
const POWER = 0.65;
const OPACITY = 0.304;
const EDGE_SIGMA = 0.7;

interface Patch {
  x0: number;
  y0: number;
  w: number;
  h: number;
  a: Float32Array;
}

function gaussBlur(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const rad = Math.ceil(sigma * 3);
  const k: number[] = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += a[y * w + xx] * k[i + rad];
      }
      tmp[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += tmp[yy * w + x] * k[i + rad];
      }
      out[y * w + x] = s;
    }
  return out;
}

/** Opacity of the mark per pixel around (cx, cy), supersampled. */
function markPatch(box: MarkBox, W: number, H: number, ss: number): Patch {
  const { cx, cy, r } = box;
  const x0 = Math.max(0, Math.floor(cx - r - 3));
  const y0 = Math.max(0, Math.floor(cy - r - 3));
  const x1 = Math.min(W, Math.ceil(cx + r + 3));
  const y1 = Math.min(H, Math.ceil(cy + r + 3));
  const w = x1 - x0;
  const h = y1 - y0;
  const a = new Float32Array(w * h);
  const rp = Math.pow(r, POWER);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        const v = Math.pow(Math.abs(y0 + y + (sy + 0.5) / ss - cy), POWER);
        for (let sx = 0; sx < ss; sx++) {
          const u = Math.pow(Math.abs(x0 + x + (sx + 0.5) / ss - cx), POWER);
          if (u + v <= rp) hit++;
        }
      }
      a[y * w + x] = (OPACITY * hit) / (ss * ss);
    }
  }
  return { x0, y0, w, h, a: gaussBlur(a, w, h, EDGE_SIGMA) };
}

/** Un-blend the mark inside the patch; returns the corrected RGB window. */
function unblend(img: ImageData, p: Patch): Float32Array {
  const W = img.width;
  const out = new Float32Array(p.w * p.h * 3);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const a = p.a[y * p.w + x];
      const i = ((p.y0 + y) * W + (p.x0 + x)) * 4;
      const o = (y * p.w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = (img.data[i + c] - a * 255) / (1 - a);
        out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

function edgeBand(p: Patch): Uint8Array {
  const band = new Uint8Array(p.w * p.h);
  for (let i = 0; i < band.length; i++) {
    const a = p.a[i];
    if (a > 0.02 * OPACITY && a < 0.95 * OPACITY) band[i] = 1;
  }
  // dilate by one pixel
  const out = band.slice();
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      if (!band[y * p.w + x]) continue;
      if (x > 0) out[y * p.w + x - 1] = 1;
      if (x < p.w - 1) out[y * p.w + x + 1] = 1;
      if (y > 0) out[(y - 1) * p.w + x] = 1;
      if (y < p.h - 1) out[(y + 1) * p.w + x] = 1;
    }
  return out;
}

/** Total variation of brightness across the outline — low when the mark
 *  is removed cleanly, high when its edge is still there. */
function outlineTV(win: Float32Array, p: Patch, band: Uint8Array): number {
  const L = (i: number) => 0.299 * win[i * 3] + 0.587 * win[i * 3 + 1] + 0.114 * win[i * 3 + 2];
  let tv = 0;
  for (let y = 0; y < p.h - 1; y++)
    for (let x = 0; x < p.w - 1; x++) {
      const i = y * p.w + x;
      if (!band[i]) continue;
      tv += Math.abs(L(i + 1) - L(i)) + Math.abs(L(i + p.w) - L(i));
    }
  return tv;
}

/** Is the mark really there? Sample pairs of pixels just inside and just
 *  outside the star's curved edges and compare the brightness step with the
 *  one a 30 % white overlay produces there. Local pairs, so a background
 *  that changes across the corner (skin → white) doesn't fool it. */
function markPresent(img: ImageData, box: MarkBox): boolean {
  const W = img.width;
  const H = img.height;
  const lumAt = (x: number, y: number) => {
    const xi = Math.min(W - 1, Math.max(0, Math.floor(x)));
    const yi = Math.min(H - 1, Math.max(0, Math.floor(y)));
    const i = (yi * W + xi) * 4;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  };
  const k = box.r / RADIUS;
  const dIn = 3.5 * k;
  const dOut = 3.5 * k;
  let obs = 0;
  let exp = 0;
  let agree = 0;
  let n = 0;
  for (let q = 0; q < 4; q++) {
    for (let deg = 15; deg <= 75; deg += 3) {
      const th = ((q * 90 + deg) * Math.PI) / 180;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / POWER) * box.r;
      const ey = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / POWER) * box.r;
      // outward normal = gradient of |x|^p + |y|^p
      let nx = Math.sign(ex) * Math.pow(Math.abs(ex) + 1e-6, POWER - 1);
      let ny = Math.sign(ey) * Math.pow(Math.abs(ey) + 1e-6, POWER - 1);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      const lin = lumAt(box.cx + ex - nx * dIn, box.cy + ey - ny * dIn);
      const lout = lumAt(box.cx + ex + nx * dOut, box.cy + ey + ny * dOut);
      const e = OPACITY * (255 - lout);
      const o = lin - lout;
      obs += o;
      exp += e;
      if (e > 1 && o > 0.4 * e && o < 1.8 * e) agree++;
      n++;
    }
  }
  if (!n || exp / n < 3) return false; // near-white corner: a mark would be invisible anyway
  const ratio = obs / exp;
  return ratio > 0.6 && ratio < 1.5 && agree / n > 0.6;
}

function locate(img: ImageData): MarkBox | null {
  const W = img.width;
  const H = img.height;
  const k = Math.min(W, H) / 1024;
  const def: MarkBox = { cx: W - OFFSET * k, cy: H - OFFSET * k, r: RADIUS * k };
  const score = (b: MarkBox) => {
    const p = markPatch(b, W, H, 2);
    return outlineTV(unblend(img, p), p, edgeBand(p));
  };
  const tDef = score(def);
  let best = { t: tDef, box: def };
  for (const s of [0.94, 0.97, 1, 1.03, 1.06]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (s === 1 && dx === 0 && dy === 0) continue;
        const b = { cx: def.cx + dx * k, cy: def.cy + dy * k, r: def.r * s };
        const t = score(b);
        if (t < best.t) best = { t, box: b };
      }
    }
  }
  // Stay on the measured placement unless something else is clearly better.
  const box = best.t < 0.85 * tDef ? best.box : def;
  return markPresent(img, box) ? box : null;
}

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  return [c, ctx];
}

function crop(src: HTMLCanvasElement, box: MarkBox): string {
  const side = Math.round(box.r * 4.6);
  const [c, ctx] = canvasOf(160, 160);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, Math.round(box.cx - side / 2), Math.round(box.cy - side / 2), side, side, 0, 0, 160, 160);
  return c.toDataURL("image/png");
}

/** Remove the corner mark by un-blending it. Null when no mark is found. */
export async function removeCornerMark(blob: Blob): Promise<MarkRemoveResult | null> {
  const bmp = await createImageBitmap(blob);
  const W = bmp.width;
  const H = bmp.height;
  const [srcCanvas, srcCtx] = canvasOf(W, H);
  srcCtx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = srcCtx.getImageData(0, 0, W, H);

  const box = locate(img);
  if (!box) return null;

  const p = markPatch(box, W, H, 4);
  const win = unblend(img, p);
  // Fill the thin outline band from its neighbours (Jacobi relaxation):
  // the JPEG-softened edge never matches a model exactly.
  const band = edgeBand(p);
  const idx: number[] = [];
  for (let y = 1; y < p.h - 1; y++)
    for (let x = 1; x < p.w - 1; x++) if (band[y * p.w + x]) idx.push(y * p.w + x);
  const next = new Float32Array(idx.length * 3);
  for (let it = 0; it < 300; it++) {
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      for (let c = 0; c < 3; c++) {
        next[k * 3 + c] =
          (win[(i - 1) * 3 + c] + win[(i + 1) * 3 + c] + win[(i - p.w) * 3 + c] + win[(i + p.w) * 3 + c]) / 4;
      }
    }
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      win[i * 3] = next[k * 3];
      win[i * 3 + 1] = next[k * 3 + 1];
      win[i * 3 + 2] = next[k * 3 + 2];
    }
  }

  const before = crop(srcCanvas, box);
  const out = new ImageData(new Uint8ClampedArray(img.data), W, H);
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const i = ((p.y0 + y) * W + (p.x0 + x)) * 4;
      const o = (y * p.w + x) * 3;
      out.data[i] = Math.round(win[o]);
      out.data[i + 1] = Math.round(win[o + 1]);
      out.data[i + 2] = Math.round(win[o + 2]);
    }
  const [resCanvas, resCtx] = canvasOf(W, H);
  resCtx.putImageData(out, 0, 0);
  const after = crop(resCanvas, box);
  const png: Blob = await new Promise((resolve, reject) =>
    resCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"),
  );
  return { blob: png, box, before, after };
}
