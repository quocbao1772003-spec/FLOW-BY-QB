// Image export helpers used by the download dialog: read an image's real
// properties, convert it (resize / format / quality / size cap) in the
// browser, build file names from the naming formula, and trigger downloads.
//
// Everything runs client-side on a <canvas>; the agent is not involved.

export type ExportFormat = "png" | "jpeg" | "webp";

export interface ImageInfo {
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

export interface ConvertOptions {
  /** null = keep the original bytes untouched (no re-encode). */
  format: ExportFormat | null;
  maxWidth: number | null;
  maxHeight: number | null;
  /** 1–100, ignored for PNG. */
  quality: number;
  /** Target ceiling in KB; null = no cap. Lossy formats only. */
  maxKB: number | null;
}

export interface ConvertResult {
  blob: Blob;
  width: number;
  height: number;
  ext: string;
}

const MIME: Record<ExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function extForMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

export function formatLabel(mime: string): string {
  return extForMime(mime).toUpperCase().replace("JPG", "JPEG");
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được ảnh (${res.status})`);
  return res.blob();
}

export async function readImageInfo(blob: Blob): Promise<ImageInfo> {
  const bmp = await createImageBitmap(blob);
  const info = { width: bmp.width, height: bmp.height, bytes: blob.size, mime: blob.type || "image/png" };
  bmp.close();
  return info;
}

function fitWithin(w: number, h: number, maxW: number | null, maxH: number | null): [number, number] {
  let scale = 1;
  if (maxW && w > maxW) scale = Math.min(scale, maxW / w);
  if (maxH && h > maxH) scale = Math.min(scale, maxH / h);
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

function encode(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Trình duyệt không mã hoá được ảnh"))),
      mime,
      quality,
    );
  });
}

function draw(bmp: ImageBitmap, w: number, h: number, mime: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  if (mime === "image/jpeg") {
    // JPEG has no alpha — flatten onto white instead of black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}

export async function convertImage(src: Blob, opts: ConvertOptions): Promise<ConvertResult> {
  const bmp = await createImageBitmap(src);
  try {
    const noResize =
      (!opts.maxWidth || bmp.width <= opts.maxWidth) && (!opts.maxHeight || bmp.height <= opts.maxHeight);
    if (opts.format === null && noResize) {
      return { blob: src, width: bmp.width, height: bmp.height, ext: extForMime(src.type) };
    }
    const mime = opts.format ? MIME[opts.format] : src.type || "image/png";
    let [w, h] = fitWithin(bmp.width, bmp.height, opts.maxWidth, opts.maxHeight);
    const lossy = mime === "image/jpeg" || mime === "image/webp";
    let q = Math.min(1, Math.max(0.05, opts.quality / 100));
    let blob = await encode(draw(bmp, w, h, mime), mime, q);

    const cap = opts.maxKB && opts.maxKB > 0 ? opts.maxKB * 1024 : null;
    if (cap && blob.size > cap) {
      // Step quality down first (keeps full size), then shrink dimensions.
      for (let i = 0; i < 24 && blob.size > cap; i++) {
        if (lossy && q > 0.45) {
          q = Math.max(0.45, q - 0.07);
        } else {
          w = Math.max(1, Math.round(w * 0.9));
          h = Math.max(1, Math.round(h * 0.9));
        }
        blob = await encode(draw(bmp, w, h, mime), mime, q);
      }
    }
    return { blob, width: w, height: h, ext: extForMime(mime) };
  } finally {
    bmp.close();
  }
}

// ── Naming ────────────────────────────────────────────────────────────────
//
// Handora file names: [SKU]-[product-name]-[fixed SEO keywords].ext
//   SKU      built from three parts the user types — designer (PA),
//            collection (HLW26), number (01) — joined as PA_HLW26_01
//   product  typed by the user, written lowercase-with-hyphens for SEO
//   suffix   fixed Google-SEO keywords for Handora press-on nails

export const SEO_SUFFIX =
  "handmade-press-on-nails-with-3d-nail-art-reusable-salon-quality-stick-on-fake-nails-by-handora-nails";

export interface NamingFormula {
  /** Who drew the idea, e.g. PA */
  designer: string;
  /** Collection code, e.g. HLW26 */
  collection: string;
  /** Number inside the collection, e.g. 1 → 01 */
  seq: string;
  product: string;
}

function skuPiece(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** "1" → "01"; longer numbers stay as typed. */
export function padSeq(s: string): string {
  const d = s.replace(/\D+/g, "");
  return d ? d.padStart(2, "0") : "";
}

/** designer + collection + number → PA_HLW26_01 (empty parts are skipped). */
export function buildSku(f: Pick<NamingFormula, "designer" | "collection" | "seq">): string {
  return [skuPiece(f.designer), skuPiece(f.collection), padSeq(f.seq)].filter(Boolean).join("_");
}

/** Split a pasted "PA_HLW26_01" back into its three parts. */
export function splitSku(s: string): { designer: string; collection: string; seq: string } | null {
  const m = s.trim().match(/^([A-Za-z0-9]+)[_\s-]+([A-Za-z0-9]+)[_\s-]+(\d+)$/);
  return m ? { designer: m[1].toUpperCase(), collection: m[2].toUpperCase(), seq: m[3] } : null;
}

function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** SKU as typed; spaces become underscores, unsafe characters are dropped. */
export function cleanSku(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]+/g, "");
}

/** "Midnight Mesh Đỏ" → "midnight-mesh-do" */
export function productSlug(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `total` > 1 appends -1, -2 … so several images of one product don't collide. */
export function formulaName(f: NamingFormula, index: number, total: number): string {
  const parts = [buildSku(f), productSlug(f.product), SEO_SUFFIX].filter(Boolean);
  if (total > 1) parts.push(String(index + 1));
  return parts.join("-");
}

/** Strip a file name's extension, keep the stem. */
export function stemOf(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, "");
}

// ── Download ──────────────────────────────────────────────────────────────

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function saveUrl(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
