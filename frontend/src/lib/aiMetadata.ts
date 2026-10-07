// Write an XMP record into an exported image:
//   - alt text (IPTC "Alt Text (Accessibility)" + dc:title/description) —
//     the readable file name, so platforms that read embedded metadata get
//     an alt text without anyone typing it;
//   - optionally "AI-generated" (IPTC DigitalSourceType =
//     trainedAlgorithmicMedia), used when the visible corner mark was
//     covered so the file itself still says how it was made.
//
// JPEG → APP1 "http://ns.adobe.com/xap/1.0/" segment
// PNG  → iTXt "XML:com.adobe.xmp" chunk
// WEBP → "XMP " chunk (converting a simple VP8/VP8L file to the VP8X layout)
// Any XMP block already in the file is replaced, not duplicated.

export interface ImageMeta {
  altText?: string;
  aiGenerated?: boolean;
}

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const langAlt = (t: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${esc(t)}</rdf:li></rdf:Alt>`;

function buildXmp(meta: ImageMeta): string {
  const alt = meta.altText?.trim();
  const aiNote = "AI-generated image (Google Flow)";
  const desc = alt ? (meta.aiGenerated ? `${alt} — ${aiNote}` : alt) : meta.aiGenerated ? aiNote : "";
  return (
    `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" ` +
    `xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">` +
    (meta.aiGenerated
      ? `<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>`
      : "") +
    (alt ? `<Iptc4xmpCore:AltTextAccessibility>${langAlt(alt)}</Iptc4xmpCore:AltTextAccessibility>` : "") +
    (alt ? `<dc:title>${langAlt(alt)}</dc:title>` : "") +
    (desc ? `<dc:description>${langAlt(desc)}</dc:description>` : "") +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

/** "pa_hlw26_01-midnight-mesh-handmade-…" → "PA_HLW26_01 midnight mesh handmade …" */
export function altTextFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  return stem
    .split("-")
    .map((w) => (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(w) ? w.toUpperCase() : w))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const XMP_NS = "http://ns.adobe.com/xap/1.0/\0";

/** Remove existing XMP APP1 segments (they sit before the first SOS). */
function stripJpegXmp(src: Uint8Array): Uint8Array {
  const keep: Uint8Array[] = [src.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= src.length && src[i] === 0xff) {
    const marker = src[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI: image data follows
    const len = (src[i + 2] << 8) | src[i + 3];
    const seg = src.subarray(i, i + 2 + len);
    const isXmp =
      marker === 0xe1 &&
      new TextDecoder().decode(src.subarray(i + 4, i + 4 + XMP_NS.length)) === XMP_NS;
    if (!isXmp) keep.push(seg);
    i += 2 + len;
  }
  keep.push(src.subarray(i));
  return concat(keep);
}

function tagJpeg(input: Uint8Array, xmp: Uint8Array): Uint8Array | null {
  if (input[0] !== 0xff || input[1] !== 0xd8) return null;
  const src = stripJpegXmp(input);
  const ns = enc.encode(XMP_NS);
  const len = 2 + ns.length + xmp.length;
  if (len > 0xffff) return null;
  const seg = concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), ns, xmp]);
  // After SOI and a JFIF APP0 if there is one.
  let at = 2;
  if (src[2] === 0xff && src[3] === 0xe0) at = 4 + ((src[4] << 8) | src[5]);
  return concat([src.subarray(0, at), seg, src.subarray(at)]);
}

function stripPngXmp(src: Uint8Array): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset);
  const keep: Uint8Array[] = [src.subarray(0, 8)];
  let i = 8;
  const key = enc.encode("XML:com.adobe.xmp\0");
  while (i + 12 <= src.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
    const chunk = src.subarray(i, i + 12 + len);
    const isXmp = type === "iTXt" && key.every((b, k) => src[i + 8 + k] === b);
    if (!isXmp) keep.push(chunk);
    i += 12 + len;
  }
  return concat(keep);
}

function tagPng(input: Uint8Array, xmp: Uint8Array): Uint8Array | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => input[i] === b)) return null;
  const src = stripPngXmp(input);
  const ihdrLen = new DataView(src.buffer, src.byteOffset).getUint32(8);
  const at = 8 + 12 + ihdrLen; // after IHDR
  const body = concat([enc.encode("XML:com.adobe.xmp"), new Uint8Array([0, 0, 0, 0, 0]), xmp]);
  const type = enc.encode("iTXt");
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, body.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat([type, body])));
  return concat([src.subarray(0, at), head, type, body, crc, src.subarray(at)]);
}

function tagWebp(src: Uint8Array, xmp: Uint8Array, width: number, height: number): Uint8Array | null {
  const ascii = (o: number) => String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3]);
  if (ascii(0) !== "RIFF" || ascii(8) !== "WEBP") return null;
  const dv = new DataView(src.buffer, src.byteOffset);
  const first = ascii(12);
  const pad = xmp.length & 1 ? new Uint8Array([0]) : new Uint8Array(0);
  const xmpHead = concat([enc.encode("XMP "), new Uint8Array(4)]);
  new DataView(xmpHead.buffer).setUint32(4, xmp.length, true);
  const xmpChunk = concat([xmpHead, xmp, pad]);

  let chunks: Uint8Array;
  if (first === "VP8X") {
    const parts: Uint8Array[] = [];
    let i = 12;
    const end = Math.min(src.length, 8 + dv.getUint32(4, true));
    while (i + 8 <= end) {
      const size = dv.getUint32(i + 4, true);
      const total = 8 + size + (size & 1);
      if (ascii(i) !== "XMP ") parts.push(src.slice(i, i + total));
      i += total;
    }
    parts[0][8] |= 0x04; // XMP flag on the VP8X chunk
    chunks = concat([...parts, xmpChunk]);
  } else if (first === "VP8 " || first === "VP8L") {
    let alpha = 0;
    if (first === "VP8L") {
      const bits = dv.getUint32(21, true); // after 0x2f signature
      alpha = (bits >>> 28) & 1 ? 0x10 : 0;
    }
    const vp8x = new Uint8Array(18);
    vp8x.set(enc.encode("VP8X"), 0);
    const v = new DataView(vp8x.buffer);
    v.setUint32(4, 10, true);
    vp8x[8] = 0x04 | alpha;
    const w1 = width - 1;
    const h1 = height - 1;
    vp8x[12] = w1 & 0xff;
    vp8x[13] = (w1 >> 8) & 0xff;
    vp8x[14] = (w1 >> 16) & 0xff;
    vp8x[15] = h1 & 0xff;
    vp8x[16] = (h1 >> 8) & 0xff;
    vp8x[17] = (h1 >> 16) & 0xff;
    chunks = concat([vp8x, src.subarray(12), xmpChunk]);
  } else {
    return null;
  }
  const head = new Uint8Array(12);
  head.set(enc.encode("RIFF"), 0);
  new DataView(head.buffer).setUint32(4, 4 + chunks.length, true);
  head.set(enc.encode("WEBP"), 8);
  return concat([head, chunks]);
}

/** Returns `blob` with the XMP record written in (unchanged if the format
 *  isn't recognised or nothing to write). */
export async function tagImageMetadata(
  blob: Blob,
  width: number,
  height: number,
  meta: ImageMeta,
): Promise<Blob> {
  if (!meta.altText?.trim() && !meta.aiGenerated) return blob;
  const src = new Uint8Array(await blob.arrayBuffer());
  const xmp = enc.encode(buildXmp(meta));
  const type = blob.type;
  let out: Uint8Array | null = null;
  try {
    if (type === "image/jpeg") out = tagJpeg(src, xmp);
    else if (type === "image/png") out = tagPng(src, xmp);
    else if (type === "image/webp") out = tagWebp(src, xmp, width, height);
  } catch {
    out = null;
  }
  return out ? new Blob([out as Uint8Array<ArrayBuffer>], { type }) : blob;
}
