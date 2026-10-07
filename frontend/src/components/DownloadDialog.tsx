import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useDownloadStore, type DownloadItem, type DownloadOptions } from "../store/download";
import {
  convertImage,
  fetchBlob,
  formatLabel,
  formulaName,
  productSlug,
  buildSku,
  padSeq,
  splitSku,
  SEO_SUFFIX,
  humanBytes,
  readImageInfo,
  saveBlob,
  stemOf,
  type ExportFormat,
  type ImageInfo,
  type NamingFormula,
} from "../lib/imageExport";
import { patchCornerMark } from "../lib/cornerPatch";
import { removeCornerMark } from "../lib/markRemove";
import { makeZip, uniqueNames } from "../lib/zip";
import { ChipSelect } from "./ChipSelect";
import { altTextFromFileName, tagImageMetadata } from "../lib/aiMetadata";
import { useBoardStore } from "../store/board";
import { mediaUrl } from "../api/client";
import "./DownloadDialog.css";

/**
 * Asked before every image download: shows what the image is, lets the user
 * rename it (formula or original name) and pick an output format / size,
 * then converts in the browser and saves.
 */

type PresetId = "original" | "jpeg" | "webp" | "custom";

interface Custom {
  maxWidth: string;
  maxHeight: string;
  format: ExportFormat;
  quality: string;
  maxKB: string;
}

interface Saved {
  /** Cover the ✦ corner mark with the base photo wired into the node. */
  patchMark: boolean;
  /** formula = one name + running number; groups = a name per group. */
  mode: "formula" | "groups" | "original";
  formula: NamingFormula;
  preset: PresetId;
  custom: Custom;
}

const PRESETS: Array<{ id: PresetId; title: string; hint: string }> = [
  { id: "original", title: "Giữ nguyên", hint: "Ảnh gốc, không chuyển đổi" },
  { id: "jpeg", title: "JPEG", hint: "Tối đa 2048px · chất lượng 90" },
  { id: "webp", title: "WEBP", hint: "Tối đa 2048px · chất lượng 85, nhẹ cho web" },
  { id: "custom", title: "Tuỳ chỉnh…", hint: "Tự đặt kích thước, định dạng, chất lượng" },
];

const DEFAULTS: Saved = {
  patchMark: true,
  mode: "formula",
  formula: { designer: "", collection: "", seq: "", product: "" },
  // WEBP every time the dialog opens — the light format for the web shop.
  preset: "webp",
  custom: { maxWidth: "2048", maxHeight: "2048", format: "jpeg", quality: "85", maxKB: "" },
};

const STORAGE_KEY = "flowboard.download.v2";

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Saved>;
    return {
      patchMark: p.patchMark !== false,
      mode: p.mode === "original" ? "original" : p.mode === "groups" ? "groups" : "formula",
      formula: (() => {
        const f = (p.formula ?? {}) as Partial<NamingFormula> & { sku?: string };
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        // Earlier builds stored the SKU as one string — split it once.
        const old = typeof f.sku === "string" ? splitSku(f.sku) : null;
        return {
          designer: str(f.designer) || old?.designer || "",
          collection: str(f.collection) || old?.collection || "",
          seq: str(f.seq) || old?.seq || "",
          product: str(f.product),
        };
      })(),
      // The format is not remembered on purpose: it always starts on WEBP.
      preset: DEFAULTS.preset,
      custom: { ...DEFAULTS.custom, ...(p.custom ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

function persist(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage blocked — settings just won't stick */
  }
}

function num(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface Resolved {
  format: ExportFormat | null;
  maxWidth: number | null;
  maxHeight: number | null;
  quality: number;
  maxKB: number | null;
}

function resolveOptions(preset: PresetId, c: Custom): Resolved {
  switch (preset) {
    case "original":
      return { format: null, maxWidth: null, maxHeight: null, quality: 100, maxKB: null };
    case "jpeg":
      return { format: "jpeg", maxWidth: 2048, maxHeight: 2048, quality: 90, maxKB: null };
    case "webp":
      return { format: "webp", maxWidth: 2048, maxHeight: 2048, quality: 85, maxKB: null };
    default:
      return {
        format: c.format,
        maxWidth: num(c.maxWidth),
        maxHeight: num(c.maxHeight),
        quality: Math.min(100, Math.max(1, num(c.quality) ?? 85)),
        maxKB: num(c.maxKB),
      };
  }
}

function outExt(format: ExportFormat | null, info: ImageInfo | undefined, item: DownloadItem): string {
  if (format === "jpeg") return "jpg";
  if (format) return format;
  if (info) return formatLabel(info.mime).toLowerCase().replace("jpeg", "jpg");
  const m = item.name.match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : "png";
}

interface BaseRef {
  url: string;
  shortId: string;
}

/** Images wired into a node — the photos a generated image was based on. */
function baseRefsFor(nodeId: string | undefined): BaseRef[] {
  if (!nodeId) return [];
  const { nodes, edges } = useBoardStore.getState();
  const out: BaseRef[] = [];
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const n = nodes.find((x) => x.id === e.source);
    if (!n) continue;
    const d = n.data as Record<string, unknown>;
    const mid =
      (typeof d.mediaId === "string" && d.mediaId) ||
      (Array.isArray(d.mediaIds)
        ? (d.mediaIds as unknown[]).find((m): m is string => typeof m === "string" && !!m)
        : undefined);
    if (mid && !out.some((o) => o.url === mediaUrl(mid))) {
      out.push({ url: mediaUrl(mid), shortId: String(d.shortId ?? n.id) });
    }
  }
  return out;
}

interface Cleaned {
  blob: Blob;
  before: string;
  after: string;
}

type PatchState =
  | { status: "pending" }
  | { status: "nomark" }
  | { status: "ok"; result: Cleaned; how: "alpha" | "base"; base?: string };

const MIME_FORMAT: Record<string, ExportFormat> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

function fitDims(info: ImageInfo | undefined, o: Resolved): string {
  if (!info) return "";
  let s = 1;
  if (o.maxWidth && info.width > o.maxWidth) s = Math.min(s, o.maxWidth / info.width);
  if (o.maxHeight && info.height > o.maxHeight) s = Math.min(s, o.maxHeight / info.height);
  return `${Math.round(info.width * s)}×${Math.round(info.height * s)}`;
}

const EMPTY_FORMULA: NamingFormula = { designer: "", collection: "", seq: "", product: "" };

/** SKU (3 boxes) + product name + fixed SEO tail — one naming formula. */
function FormulaFields({
  formula,
  onChange,
  autoFocus,
}: {
  formula: NamingFormula;
  onChange(patch: Partial<NamingFormula>): void;
  autoFocus?: boolean;
}) {
  const sku = buildSku(formula);
  const skuParts = [formula.designer, formula.collection, formula.seq].filter((x) => x.trim()).length;
  const skuPartial = skuParts > 0 && skuParts < 3;

  function focusNext(el: HTMLInputElement, steps: number) {
    const all = Array.from(el.closest(".dl-formula")?.querySelectorAll("input") ?? []) as HTMLInputElement[];
    const next = all[all.indexOf(el) + steps];
    if (next) requestAnimationFrame(() => next.focus());
  }

  // Typing "_" (or pasting a whole SKU) in any SKU box fills the parts and
  // jumps to the next box, so a SKU can be entered without touching the mouse.
  function onSkuInput(field: "designer" | "collection" | "seq", value: string, el: HTMLInputElement) {
    const whole = splitSku(value);
    if (whole) {
      onChange(whole);
      focusNext(el, 3 - ["designer", "collection", "seq"].indexOf(field));
      return;
    }
    if (/[_\s]$/.test(value) && field !== "seq") {
      onChange({ [field]: value.replace(/[_\s]+$/, "") } as Partial<NamingFormula>);
      focusNext(el, 1);
      return;
    }
    const v = field === "seq" ? value.replace(/\D+/g, "") : value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
    onChange({ [field]: v } as Partial<NamingFormula>);
  }

  return (
    <div className="dl-box dl-formula">
      <div className="dl-field">
        <span>Mã SKU</span>
        <div>
          <div className="dl-sku">
            <label className="dl-sku__part">
              <input
                autoFocus={autoFocus}
                value={formula.designer}
                placeholder="PA"
                spellCheck={false}
                aria-label="Người lên ý tưởng"
                onChange={(e) => onSkuInput("designer", e.target.value, e.currentTarget)}
              />
              <em>Người lên ý tưởng</em>
            </label>
            <span className="dl-sku__sep" aria-hidden="true">_</span>
            <label className="dl-sku__part dl-sku__part--wide">
              <input
                value={formula.collection}
                placeholder="HLW26"
                spellCheck={false}
                aria-label="Collection"
                onChange={(e) => onSkuInput("collection", e.target.value, e.currentTarget)}
              />
              <em>Collection</em>
            </label>
            <span className="dl-sku__sep" aria-hidden="true">_</span>
            <label className="dl-sku__part">
              <input
                value={formula.seq}
                placeholder="01"
                inputMode="numeric"
                aria-label="Số thứ tự"
                onChange={(e) => onSkuInput("seq", e.target.value, e.currentTarget)}
                onBlur={() => onChange({ seq: padSeq(formula.seq) })}
                onKeyDown={(e) => {
                  const n = parseInt(formula.seq || "0", 10) || 0;
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    onChange({ seq: padSeq(String(n + 1)) });
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    onChange({ seq: padSeq(String(Math.max(1, n - 1))) });
                  }
                }}
              />
              <em>Số thứ tự</em>
            </label>
            <div className={`dl-sku__result${skuPartial ? " dl-sku__result--warn" : ""}`}>{sku || "—"}</div>
          </div>
          {skuPartial ? (
            <small className="dl-help dl-help--warn">Thiếu phần nào thì mã SKU sẽ bỏ qua phần đó</small>
          ) : null}
        </div>
      </div>
      <label className="dl-field">
        <span>Tên sản phẩm</span>
        <div>
          <input
            value={formula.product}
            placeholder="Midnight Mesh"
            onChange={(e) => onChange({ product: e.target.value })}
          />
          <small className="dl-help">
            {productSlug(formula.product) ? (
              <>
                Trong tên file: <code>{productSlug(formula.product)}</code>
              </>
            ) : (
              "Viết thường, nối bằng dấu - để tối ưu SEO"
            )}
          </small>
        </div>
      </label>
      <div className="dl-field">
        <span>Đuôi SEO</span>
        <div className="dl-fixed" title={`Từ khoá SEO cố định cho press-on nails của Handora:\n${SEO_SUFFIX}`}>
          {SEO_SUFFIX}
        </div>
      </div>
    </div>
  );
}

const formulaEmpty = (f: NamingFormula) => !buildSku(f) && !productSlug(f.product);
const formulaTyped = (f: NamingFormula) => [f.designer, f.collection, f.seq, f.product].some((x) => x.trim() !== "");

/** Default archive name: SKU / product when typed, else the date. */
function defaultZipName(f: NamingFormula, n: number): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const head = [buildSku(f), productSlug(f.product)].filter(Boolean).join("-");
  return head || `handora-${n}-anh-${date}`;
}

const GROUP_COLORS = ["#f2558f", "#60a5fa", "#4ade80", "#fbbf24", "#c084fc", "#2dd4bf", "#fb923c", "#f87171"];

export function DownloadDialog() {
  const open = useDownloadStore((s) => s.open);
  const items = useDownloadStore((s) => s.items);
  const options = useDownloadStore((s) => s.options);
  const close = useDownloadStore((s) => s.close);
  if (!open || items.length === 0) return null;
  return createPortal(<DialogBody items={items} options={options} onClose={close} />, document.body);
}

function DialogBody({
  items,
  options,
  onClose,
}: {
  items: DownloadItem[];
  options: DownloadOptions;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<Saved>(() => {
    const s = loadSaved();
    // Groups only make sense with several images.
    return items.length < 2 && s.mode === "groups" ? { ...s, mode: "formula" } : s;
  });
  const [groups, setGroups] = useState<NamingFormula[]>(() => [loadSaved().formula]);
  const [assign, setAssign] = useState<number[]>(() => items.map(() => 0));
  const [packZip, setPackZip] = useState<boolean>(() => !!options.zip && items.length > 1);
  const [zipName, setZipName] = useState<string>(() => options.zipName ?? "");
  const [blobs, setBlobs] = useState<Array<Blob | null>>(() => items.map((i) => i.blob ?? null));
  const [infos, setInfos] = useState<Array<ImageInfo | undefined>>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [patches, setPatches] = useState<PatchState[]>([]);
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<Saved>) => setSaved((s) => ({ ...s, ...patch }));
  const updateFormula = (patch: Partial<NamingFormula>) =>
    setSaved((s) => ({ ...s, formula: { ...s.formula, ...patch } }));
  const updateCustom = (patch: Partial<Custom>) => setSaved((s) => ({ ...s, custom: { ...s.custom, ...patch } }));

  // Load bytes + read real width/height/size for every image.
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    (async () => {
      const bs = await Promise.all(
        items.map(async (it) => {
          try {
            return it.blob ?? (it.url ? await fetchBlob(it.url) : null);
          } catch {
            return null;
          }
        }),
      );
      const ifs = await Promise.all(
        bs.map(async (b) => {
          try {
            return b ? await readImageInfo(b) : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      if (!alive) return;
      const th = bs.map((b, i) => {
        if (!b) return items[i].url ?? "";
        const u = URL.createObjectURL(b);
        urls.push(u);
        return u;
      });
      setBlobs(bs);
      setInfos(ifs);
      setThumbs(th);
    })();
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [items]);

  // Work out the corner patch for every image once its bytes are loaded.
  const bytesReady = blobs.some((b) => b !== null);
  useEffect(() => {
    if (!saved.patchMark || !bytesReady) return;
    let alive = true;
    setPatches(items.map(() => ({ status: "pending" })));
    (async () => {
      for (let i = 0; i < items.length; i++) {
        let st: PatchState = { status: "nomark" };
        const src = blobs[i];
        if (src) {
          try {
            // 1) Undo the white overlay — recovers the image's own pixels.
            const un = await removeCornerMark(src);
            if (un) {
              st = { status: "ok", result: un, how: "alpha" };
            } else {
              // 2) Fallback: copy the spot from a base photo wired in.
              const refs = baseRefsFor(items[i].nodeId);
              if (refs.length > 0) {
                const bases = (
                  await Promise.all(refs.map((r) => fetchBlob(r.url).catch(() => null)))
                ).filter((b): b is Blob => b !== null);
                const res = await patchCornerMark(src, bases);
                if (res && res.box.detected) {
                  st = { status: "ok", result: res, how: "base", base: refs[res.baseIndex]?.shortId ?? "" };
                }
              }
            }
          } catch (e) {
            console.error("[download] corner mark removal failed:", e);
          }
        }
        if (!alive) return;
        setPatches((ps) => {
          const next = ps.slice();
          next[i] = st;
          return next;
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [items, blobs, bytesReady, saved.patchMark]);

  // Esc closes (unless converting).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const opts = useMemo(() => resolveOptions(saved.preset, saved.custom), [saved.preset, saved.custom]);

  const names = useMemo(() => {
    const raw = items.map((it, i) => {
      const ext = outExt(opts.format, infos[i], it);
      let stem: string;
      if (saved.mode === "original") stem = stemOf(it.name);
      else if (saved.mode === "groups") {
        const g = assign[i] ?? 0;
        const members = assign.map((a, k) => (a === g ? k : -1)).filter((k) => k >= 0);
        stem = formulaName(groups[g] ?? EMPTY_FORMULA, members.indexOf(i), members.length);
      } else stem = formulaName(saved.formula, i, items.length);
      return `${stem}.${ext}`;
    });
    // Never two files with the same name in one download / archive.
    return uniqueNames(raw);
  }, [items, infos, opts.format, saved.mode, saved.formula, groups, assign]);

  function updateGroup(gi: number, patch: Partial<NamingFormula>) {
    setGroups((gs) => gs.map((g, k) => (k === gi ? { ...g, ...patch } : g)));
  }
  function addGroup() {
    setGroups((gs) => [...gs, { ...EMPTY_FORMULA, designer: gs[gs.length - 1]?.designer ?? "", collection: gs[gs.length - 1]?.collection ?? "" }]);
  }
  function removeGroup(gi: number) {
    setGroups((gs) => gs.filter((_, k) => k !== gi));
    setAssign((as) => as.map((a) => (a === gi ? 0 : a > gi ? a - 1 : a)));
  }

  const loading = infos.length === 0;
  const usedGroups = groups.map((_, gi) => assign.includes(gi));
  const nameMissing =
    saved.mode === "formula"
      ? formulaEmpty(saved.formula)
      : saved.mode === "groups"
        ? groups.some((g, gi) => usedGroups[gi] && formulaEmpty(g))
        : false;
  const hasTyped = formulaTyped(saved.formula);
  const zipBase = (zipName.trim() || defaultZipName(saved.mode === "groups" ? groups[0] : saved.formula, items.length))
    .replace(/\.zip$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-");

  async function run() {
    setError(null);
    persist({ ...saved, formula: saved.mode === "groups" ? groups[0] ?? saved.formula : saved.formula });
    let failed = 0;
    const zipped: { name: string; data: Uint8Array }[] = [];
    for (let i = 0; i < items.length; i++) {
      setBusy(`Đang chuyển đổi ${i + 1}/${items.length}…`);
      try {
        const original = blobs[i] ?? (items[i].url ? await fetchBlob(items[i].url!) : null);
        if (!original) throw new Error("không có dữ liệu ảnh");
        const p = saved.patchMark ? patches[i] : undefined;
        const patched = p && p.status === "ok" ? p.result.blob : null;
        // A patched image is a fresh PNG; "keep original" then means keep
        // the original FORMAT, so re-encode it to that.
        const o = patched && opts.format === null
          ? { ...opts, format: MIME_FORMAT[infos[i]?.mime ?? ""] ?? "png", quality: 95 }
          : opts;
        const out = await convertImage(patched ?? original, o);
        // Alt text = the readable file name, always. When the corner mark was
        // covered, also record in the file itself that it's AI-made.
        const blob = await tagImageMetadata(out.blob, out.width, out.height, {
          altText: altTextFromFileName(names[i]),
          aiGenerated: !!patched,
        });
        if (packZip) {
          zipped.push({ name: names[i], data: new Uint8Array(await blob.arrayBuffer()) });
          continue;
        }
        saveBlob(blob, names[i]);
      } catch (e) {
        failed++;
        console.error("[download] convert failed:", e);
      }
      // Chrome drops back-to-back downloads without a small gap.
      await new Promise((r) => setTimeout(r, 250));
    }
    if (packZip && zipped.length > 0) {
      setBusy("Đang đóng gói ZIP…");
      saveBlob(makeZip(zipped), `${zipBase}.zip`);
    }
    setBusy(null);
    if (failed > 0) {
      setError(`${failed}/${items.length} ảnh không chuyển đổi được — xem console để biết chi tiết.`);
      return;
    }
    onClose();
  }

  const n = items.length;
  const patchPending = saved.patchMark && patches.some((p) => p?.status === "pending");
  const markDone = patches.filter((p) => p?.status === "ok").length;
  const markNone = patches.filter((p) => p?.status === "nomark").length;
  const markPendingCount = saved.patchMark ? n - markDone - markNone : 0;

  return (
    <div className="dl-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dl-dialog" role="dialog" aria-modal="true" aria-labelledby="dl-title">
        <header className="dl-head">
          <div>
            <h2 id="dl-title">Tải ảnh về</h2>
            <p>
              {n} ảnh · chọn tên và định dạng, app sẽ chuyển đổi rồi mới tải về.
            </p>
          </div>
          <button className="dl-x" onClick={onClose} disabled={!!busy} aria-label="Đóng">
            ✕
          </button>
        </header>

        <div className={`dl-body${n === 1 ? " dl-body--single" : ""}`}>
          {/* ── Left: the images ───────────────────────────────────── */}
          <div className="dl-col dl-col--files">
            <div className="dl-col__head">
              <h3>Ảnh</h3>
              <div className="dl-stats">
                <span className="dl-stat">{n} ảnh</span>
                {saved.patchMark && markDone > 0 && <span className="dl-stat dl-stat--ok">✦ đã xoá {markDone}</span>}
                {saved.patchMark && markPendingCount > 0 && <span className="dl-stat">đang dò {markPendingCount}</span>}
                {saved.patchMark && markNone > 0 && <span className="dl-stat dl-stat--muted">không có dấu {markNone}</span>}
                {saved.mode === "groups" && <span className="dl-stat">{groups.length} nhóm</span>}
              </div>
            </div>
            <ul className="dl-files">
              {items.map((it, i) => {
                const info = infos[i];
                return (
                  <li
                    key={i}
                    className="dl-file"
                    style={saved.mode === "groups" ? { ["--grp" as string]: GROUP_COLORS[(assign[i] ?? 0) % GROUP_COLORS.length] } : undefined}
                  >
                    <span className="dl-file__no">{i + 1}</span>
                    <div className="dl-thumb">{thumbs[i] && <img src={thumbs[i]} alt="" />}</div>
                    <div className="dl-file__meta">
                      <div className="dl-file__src" title={it.name}>
                        {it.label ? <span className="dl-file__label">{it.label}</span> : null}
                        {it.name}
                      </div>
                      <div className="dl-file__info">
                        {loading ? (
                          "Đang đọc thông tin ảnh…"
                        ) : info ? (
                          <>
                            <span>{info.width}×{info.height}</span>
                            <span>{formatLabel(info.mime)}</span>
                            <span>{humanBytes(info.bytes)}</span>
                          </>
                        ) : (
                          <span className="dl-warn">Không đọc được ảnh này</span>
                        )}
                      </div>
                      {saved.mode === "groups" && (
                        <div className="dl-file__group">
                          <ChipSelect<number>
                            value={assign[i] ?? 0}
                            heading="Thuộc nhóm"
                            options={groups.map((_, gi) => ({
                              value: gi,
                              label: (
                                <>
                                  <span className="dl-group__dot" style={{ ["--grp" as string]: GROUP_COLORS[gi % GROUP_COLORS.length] }} />
                                  Nhóm {gi + 1}
                                </>
                              ),
                            }))}
                            onChange={(g) => setAssign((as) => as.map((a, k) => (k === i ? g : a)))}
                            ariaLabel="Nhóm"
                          />
                        </div>
                      )}
                      <div className="dl-file__out" title={names[i]}>
                        <span className="dl-arrow" aria-hidden="true">→</span>
                        <span className="dl-file__outname">{names[i]}</span>
                        {info && opts.format !== null ? <span className="dl-file__dims">{fitDims(info, opts)}</span> : null}
                      </div>
                    </div>
                    {saved.patchMark && (
                      <div className="dl-file__mark">
                        {patches[i]?.status === "ok" ? (
                          <>
                            <div className="dl-file__markpair">
                              <img src={(patches[i] as { result: Cleaned }).result.before} alt="Trước" title="Góc ảnh trước" />
                              <span aria-hidden="true">→</span>
                              <img src={(patches[i] as { result: Cleaned }).result.after} alt="Sau" title="Góc ảnh sau" />
                            </div>
                            <span className="dl-badge dl-badge--ok">
                              {(patches[i] as { how: string }).how === "alpha" ? "Đã xoá dấu" : "Lấy từ ảnh gốc"}
                            </span>
                          </>
                        ) : !patches[i] || patches[i].status === "pending" ? (
                          <span className="dl-badge">Đang dò…</span>
                        ) : (
                          <span className="dl-badge dl-badge--muted">Không có dấu</span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ── Right: settings ────────────────────────────────────── */}
          <div className="dl-col dl-col--opts">
          <section className="dl-section dl-section--inline">
            <h3><span className="dl-step">1</span>Xoá dấu ✦ ở góc</h3>
            <label className="dl-switch" title="Tự xoá dấu mờ ở góc, không cần ảnh gốc. Ảnh đã xoá được ghi “AI-generated” trong metadata.">
              <input
                type="checkbox"
                checked={saved.patchMark}
                onChange={(e) => update({ patchMark: e.target.checked })}
              />
              <span className="dl-switch__track" aria-hidden="true">
                <span className="dl-switch__knob" />
              </span>
              <span className="dl-switch__state">{saved.patchMark ? "Bật" : "Tắt"}</span>
            </label>
          </section>

          {/* ── Naming ─────────────────────────────────────────────── */}
          <section className="dl-section">
            <h3><span className="dl-step">2</span>Tên file</h3>
            <div className="dl-radio-row">
              <label className="dl-radio">
                <input
                  type="radio"
                  checked={saved.mode === "formula"}
                  onChange={() => update({ mode: "formula" })}
                />
                <span>{n > 1 ? "Một tên chung, thêm số ở cuối" : "Đặt tên theo công thức"}</span>
              </label>
              {saved.mode === "formula" && (
                <button
                  type="button"
                  className="dl-clear"
                  disabled={!hasTyped}
                  title="Xoá mã SKU và tên sản phẩm"
                  onClick={(e) => {
                    updateFormula({ designer: "", collection: "", seq: "", product: "" });
                    const first = e.currentTarget
                      .closest(".dl-section")
                      ?.querySelector<HTMLInputElement>(".dl-formula input");
                    first?.focus();
                  }}
                >
                  ✕ Xoá hết
                </button>
              )}
            </div>
            {saved.mode === "formula" && (
              <FormulaFields formula={saved.formula} onChange={updateFormula} autoFocus />
            )}
            {n > 1 && (
              <label className="dl-radio">
                <input type="radio" checked={saved.mode === "groups"} onChange={() => update({ mode: "groups" })} />
                <span>Mỗi nhóm một tên</span>
                <small className="dl-radio__hint">chia ảnh thành nhóm, đặt tên riêng từng nhóm</small>
              </label>
            )}
            {saved.mode === "groups" && (
              <div className="dl-groups">
                {groups.map((g, gi) => {
                  const count = assign.filter((a) => a === gi).length;
                  return (
                    <div key={gi} className="dl-group" style={{ ["--grp" as string]: GROUP_COLORS[gi % GROUP_COLORS.length] }}>
                      <div className="dl-group__head">
                        <span className="dl-group__dot" />
                        <strong>Nhóm {gi + 1}</strong>
                        <span className="dl-group__count">{count} ảnh</span>
                        <span className="dl-group__thumbs">
                          {assign.map((a, i) =>
                            a === gi && thumbs[i] ? <img key={i} src={thumbs[i]} alt="" /> : null,
                          )}
                        </span>
                        {groups.length > 1 && (
                          <button type="button" className="dl-clear" onClick={() => removeGroup(gi)} title="Xoá nhóm này">
                            ✕ Xoá nhóm
                          </button>
                        )}
                      </div>
                      <FormulaFields formula={g} onChange={(p) => updateGroup(gi, p)} />
                    </div>
                  );
                })}
                <button type="button" className="dl-add-group" onClick={addGroup}>
                  + Thêm nhóm
                </button>
                <p className="dl-note">Chọn nhóm cho từng ảnh ở danh sách “Ảnh” phía trên; số thứ tự chạy riêng trong mỗi nhóm.</p>
              </div>
            )}
            <label className="dl-radio">
              <input
                type="radio"
                checked={saved.mode === "original"}
                onChange={() => update({ mode: "original" })}
              />
              <span>Giữ nguyên tên file gốc</span>
            </label>
          </section>

          {/* ── Format ─────────────────────────────────────────────── */}
          <section className="dl-section">
            <h3><span className="dl-step">3</span>Định dạng và kích thước</h3>
            <div className="dl-presets" role="radiogroup">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={saved.preset === p.id}
                  className={`dl-preset${saved.preset === p.id ? " dl-preset--on" : ""}`}
                  onClick={() => update({ preset: p.id })}
                >
                  <strong>{p.title}</strong>
                  <span>{p.hint}</span>
                </button>
              ))}
            </div>
            {saved.preset === "custom" && (
              <div className="dl-box dl-custom">
                <label className="dl-field">
                  <span>Rộng tối đa</span>
                  <div className="dl-unit">
                    <input
                      inputMode="numeric"
                      value={saved.custom.maxWidth}
                      placeholder="không giới hạn"
                      onChange={(e) => updateCustom({ maxWidth: e.target.value.replace(/\D/g, "") })}
                    />
                    <em>px</em>
                  </div>
                </label>
                <label className="dl-field">
                  <span>Cao tối đa</span>
                  <div className="dl-unit">
                    <input
                      inputMode="numeric"
                      value={saved.custom.maxHeight}
                      placeholder="không giới hạn"
                      onChange={(e) => updateCustom({ maxHeight: e.target.value.replace(/\D/g, "") })}
                    />
                    <em>px</em>
                  </div>
                </label>
                <label className="dl-field">
                  <span>Định dạng</span>
                  <select
                    value={saved.custom.format}
                    onChange={(e) => updateCustom({ format: e.target.value as ExportFormat })}
                  >
                    <option value="jpeg">JPEG</option>
                    <option value="webp">WEBP</option>
                    <option value="png">PNG</option>
                  </select>
                </label>
                <label className="dl-field">
                  <span>Chất lượng</span>
                  <div className="dl-unit">
                    <input
                      inputMode="numeric"
                      value={saved.custom.quality}
                      disabled={saved.custom.format === "png"}
                      onChange={(e) => updateCustom({ quality: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                    />
                    <em>/ 100</em>
                  </div>
                </label>
                <label className="dl-field">
                  <span>Dung lượng tối đa</span>
                  <div className="dl-unit">
                    <input
                      inputMode="numeric"
                      value={saved.custom.maxKB}
                      placeholder="không giới hạn"
                      onChange={(e) => updateCustom({ maxKB: e.target.value.replace(/\D/g, "") })}
                    />
                    <em>KB</em>
                  </div>
                </label>
                {saved.custom.format === "png" && (
                  <p className="dl-note">PNG không nén mất dữ liệu nên bỏ qua chất lượng; muốn nhẹ hơn hãy giảm kích thước.</p>
                )}
              </div>
            )}
          </section>
          </div>
        </div>

        {n > 1 && (
          <section className="dl-zipbar">
            <label className="dl-switch">
              <input type="checkbox" checked={packZip} onChange={(e) => setPackZip(e.target.checked)} />
              <span className="dl-switch__track" aria-hidden="true">
                <span className="dl-switch__knob" />
              </span>
              <span>Gộp thành 1 file ZIP</span>
            </label>
            {packZip && (
              <div className="dl-zipname">
                <input
                  value={zipName}
                  placeholder={defaultZipName(saved.mode === "groups" ? groups[0] : saved.formula, n)}
                  spellCheck={false}
                  aria-label="Tên file ZIP"
                  onChange={(e) => setZipName(e.target.value)}
                />
                <em>.zip</em>
              </div>
            )}
          </section>
        )}

        <footer className="dl-foot">
          <div className="dl-status">
            {error ? (
              <span className="dl-warn">{error}</span>
            ) : busy ? (
              <span>{busy}</span>
            ) : nameMissing ? (
              <span className="dl-help--warn">
                {saved.mode === "groups" ? "Mỗi nhóm cần mã SKU hoặc tên sản phẩm" : "Nhập mã SKU hoặc tên sản phẩm để đặt tên file"}
              </span>
            ) : (
              <>
                <span className="dl-status__label">{packZip ? "File ZIP" : "Tên file kết quả"}</span>
                <span className="dl-status__name" title={names.join("\n")}>
                  {packZip ? `${zipBase}.zip · ${n} ảnh` : names[0]}
                  {!packZip && n > 1 ? ` … và ${n - 1} ảnh khác` : ""}
                </span>
              </>
            )}
          </div>
          <button type="button" className="dl-btn" onClick={onClose} disabled={!!busy}>
            Huỷ
          </button>
          <button
            type="button"
            className="dl-btn dl-btn--primary"
            onClick={() => void run()}
            disabled={!!busy || loading || nameMissing || patchPending}
            title={nameMissing ? "Nhập mã SKU hoặc tên sản phẩm" : undefined}
          >
            {busy ? "Đang xử lý…" : packZip ? `Tải ZIP · ${n} ảnh` : `Tải về ${n} ảnh`}
          </button>
        </footer>
      </div>
    </div>
  );
}
