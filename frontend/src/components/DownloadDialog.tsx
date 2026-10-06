import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useDownloadStore, type DownloadItem } from "../store/download";
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
  mode: "formula" | "original";
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
      mode: p.mode === "original" ? "original" : "formula",
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

function fitDims(info: ImageInfo | undefined, o: Resolved): string {
  if (!info) return "";
  let s = 1;
  if (o.maxWidth && info.width > o.maxWidth) s = Math.min(s, o.maxWidth / info.width);
  if (o.maxHeight && info.height > o.maxHeight) s = Math.min(s, o.maxHeight / info.height);
  return `${Math.round(info.width * s)}×${Math.round(info.height * s)}`;
}

export function DownloadDialog() {
  const open = useDownloadStore((s) => s.open);
  const items = useDownloadStore((s) => s.items);
  const close = useDownloadStore((s) => s.close);
  if (!open || items.length === 0) return null;
  return createPortal(<DialogBody items={items} onClose={close} />, document.body);
}

function DialogBody({ items, onClose }: { items: DownloadItem[]; onClose: () => void }) {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [blobs, setBlobs] = useState<Array<Blob | null>>(() => items.map((i) => i.blob ?? null));
  const [infos, setInfos] = useState<Array<ImageInfo | undefined>>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
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

  // Esc closes (unless converting).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const opts = useMemo(() => resolveOptions(saved.preset, saved.custom), [saved.preset, saved.custom]);

  const names = useMemo(
    () =>
      items.map((it, i) => {
        const ext = outExt(opts.format, infos[i], it);
        const stem = saved.mode === "original" ? stemOf(it.name) : formulaName(saved.formula, i, items.length);
        return `${stem}.${ext}`;
      }),
    [items, infos, opts.format, saved.mode, saved.formula],
  );

  const loading = infos.length === 0;
  const sku = buildSku(saved.formula);
  const skuParts = [saved.formula.designer, saved.formula.collection, saved.formula.seq].filter((x) => x.trim()).length;
  const skuPartial = skuParts > 0 && skuParts < 3;
  const nameMissing = saved.mode === "formula" && !sku && !productSlug(saved.formula.product);
  const hasTyped = [saved.formula.designer, saved.formula.collection, saved.formula.seq, saved.formula.product].some(
    (x) => x.trim() !== "",
  );

  // Typing "_" (or pasting a whole SKU) in any SKU box fills the parts and
  // jumps to the next box, so a SKU can be entered without touching the mouse.
  function onSkuInput(field: "designer" | "collection" | "seq", value: string, el: HTMLInputElement) {
    const whole = splitSku(value);
    if (whole) {
      updateFormula(whole);
      focusNext(el, 3 - ["designer", "collection", "seq"].indexOf(field));
      return;
    }
    if (/[_\s]$/.test(value) && field !== "seq") {
      updateFormula({ [field]: value.replace(/[_\s]+$/, "") } as Partial<NamingFormula>);
      focusNext(el, 1);
      return;
    }
    const v = field === "seq" ? value.replace(/\D+/g, "") : value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
    updateFormula({ [field]: v } as Partial<NamingFormula>);
  }

  function focusNext(el: HTMLInputElement, steps: number) {
    const all = Array.from(el.closest(".dl-formula")?.querySelectorAll("input") ?? []) as HTMLInputElement[];
    const next = all[all.indexOf(el) + steps];
    if (next) requestAnimationFrame(() => next.focus());
  }

  async function run() {
    setError(null);
    persist(saved);
    let failed = 0;
    for (let i = 0; i < items.length; i++) {
      setBusy(`Đang chuyển đổi ${i + 1}/${items.length}…`);
      try {
        const src = blobs[i] ?? (items[i].url ? await fetchBlob(items[i].url!) : null);
        if (!src) throw new Error("không có dữ liệu ảnh");
        const out = await convertImage(src, opts);
        saveBlob(out.blob, names[i]);
      } catch (e) {
        failed++;
        console.error("[download] convert failed:", e);
      }
      // Chrome drops back-to-back downloads without a small gap.
      await new Promise((r) => setTimeout(r, 250));
    }
    setBusy(null);
    if (failed > 0) {
      setError(`${failed}/${items.length} ảnh không chuyển đổi được — xem console để biết chi tiết.`);
      return;
    }
    onClose();
  }

  const n = items.length;

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

        <div className="dl-scroll">
          {/* ── Image info ─────────────────────────────────────────── */}
          <section className="dl-section">
            <h3>Ảnh</h3>
            <ul className="dl-files">
              {items.map((it, i) => {
                const info = infos[i];
                return (
                  <li key={i} className="dl-file">
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
                      <div className="dl-file__out" title={names[i]}>
                        <span className="dl-arrow" aria-hidden="true">→</span>
                        <span className="dl-file__outname">{names[i]}</span>
                        {info && opts.format !== null ? <span className="dl-file__dims">{fitDims(info, opts)}</span> : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ── Naming ─────────────────────────────────────────────── */}
          <section className="dl-section">
            <h3>Tên file</h3>
            <div className="dl-radio-row">
              <label className="dl-radio">
                <input
                  type="radio"
                  checked={saved.mode === "formula"}
                  onChange={() => update({ mode: "formula" })}
                />
                <span>Đặt tên theo công thức</span>
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
              <div className="dl-box dl-formula">
                <div className="dl-field">
                  <span>Mã SKU</span>
                  <div>
                    <div className="dl-sku">
                      <label className="dl-sku__part">
                        <input
                          autoFocus
                          value={saved.formula.designer}
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
                          value={saved.formula.collection}
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
                          value={saved.formula.seq}
                          placeholder="01"
                          inputMode="numeric"
                          aria-label="Số thứ tự"
                          onChange={(e) => onSkuInput("seq", e.target.value, e.currentTarget)}
                          onBlur={() => updateFormula({ seq: padSeq(saved.formula.seq) })}
                          onKeyDown={(e) => {
                            const n = parseInt(saved.formula.seq || "0", 10) || 0;
                            if (e.key === "ArrowUp") {
                              e.preventDefault();
                              updateFormula({ seq: padSeq(String(n + 1)) });
                            } else if (e.key === "ArrowDown") {
                              e.preventDefault();
                              updateFormula({ seq: padSeq(String(Math.max(1, n - 1))) });
                            }
                          }}
                        />
                        <em>Số thứ tự</em>
                      </label>
                      <div className={`dl-sku__result${skuPartial ? " dl-sku__result--warn" : ""}`}>
                        {sku || "—"}
                      </div>
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
                      value={saved.formula.product}
                      placeholder="Midnight Mesh"
                      onChange={(e) => updateFormula({ product: e.target.value })}
                    />
                    <small className="dl-help">
                      {productSlug(saved.formula.product)
                        ? <>Trong tên file: <code>{productSlug(saved.formula.product)}</code></>
                        : "Viết thường, nối bằng dấu - để tối ưu SEO"}
                    </small>
                  </div>
                </label>
                <div className="dl-field">
                  <span>Đuôi SEO</span>
                  <div className="dl-fixed" title="Từ khoá SEO cố định cho press-on nails của Handora">
                    {SEO_SUFFIX}
                  </div>
                </div>
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
            <h3>Định dạng và kích thước</h3>
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

        <footer className="dl-foot">
          <div className="dl-status">
            {error ? (
              <span className="dl-warn">{error}</span>
            ) : busy ? (
              <span>{busy}</span>
            ) : nameMissing ? (
              <span className="dl-help--warn">Nhập mã SKU hoặc tên sản phẩm để đặt tên file</span>
            ) : (
              <>
                <span className="dl-status__label">Tên file kết quả</span>
                <span className="dl-status__name" title={names.join("\n")}>
                  {names[0]}
                  {n > 1 ? ` … và ${n - 1} ảnh khác` : ""}
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
            disabled={!!busy || loading || nameMissing}
            title={nameMissing ? "Nhập mã SKU hoặc tên sản phẩm" : undefined}
          >
            {busy ? "Đang xử lý…" : `Tải về ${n} ảnh`}
          </button>
        </footer>
      </div>
    </div>
  );
}
