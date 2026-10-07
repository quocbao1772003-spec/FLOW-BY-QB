import { useEffect, useMemo, useState } from "react";
import { listAssets, mediaUrl, type AssetItem } from "../api/client";
import { IconDownload, IconRefresh } from "../canvas/icons";
import { requestDownload, type DownloadItem } from "../store/download";

// Library — every media the agent has generated/cached (across all
// flows + the standalone Image Gen page). Backed by GET /api/assets.
//
// "Chọn ảnh" switches to select mode: click tiles (Shift+click for a
// range), then "Tải ZIP" opens the download dialog in ZIP mode — same
// naming / format / corner-mark options as a single download.

type Filter = "all" | "image" | "video";

function toDownload(item: AssetItem): DownloadItem {
  const ext = item.kind === "video" ? "mp4" : "png";
  return {
    kind: item.kind === "video" ? "video" : "image",
    url: mediaUrl(item.media_id),
    name: `library-${item.media_id.slice(0, 8)}.${ext}`,
    nodeId: item.node_id != null ? String(item.node_id) : undefined,
  };
}

export function LibraryPage() {
  const [items, setItems] = useState<AssetItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  async function load() {
    setError(null);
    try {
      const data = await listAssets(filter === "all" ? undefined : filter);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Esc leaves select mode.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitSelect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  const list = items ?? [];
  const images = useMemo(() => list.filter((i) => i.kind === "image"), [list]);
  const selectedItems = images.filter((i) => selected.has(i.id));

  function exitSelect() {
    setSelecting(false);
    setSelected(new Set());
    setAnchor(null);
  }

  function toggle(item: AssetItem, idx: number, shift: boolean) {
    if (item.kind !== "image") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor !== null) {
        const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
        for (let k = a; k <= b; k++) if (list[k]?.kind === "image") next.add(list[k].id);
      } else if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    setAnchor(idx);
  }

  function selectAll() {
    setSelected(selectedItems.length === images.length ? new Set() : new Set(images.map((i) => i.id)));
  }

  function downloadZip() {
    if (selectedItems.length === 0) return;
    requestDownload(selectedItems.map(toDownload), { zip: true });
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Library</h1>
          <p className="page__subtitle">
            {selecting
              ? `Đã chọn ${selectedItems.length}/${images.length} ảnh · bấm để chọn, Shift+bấm để chọn cả dải`
              : "Mọi ảnh & video đã tạo từ các flow và Image Gen."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {selecting ? (
            <>
              <button type="button" className="footer-tab" onClick={selectAll}>
                {selectedItems.length === images.length && images.length > 0 ? "Bỏ chọn hết" : "Chọn tất cả"}
              </button>
              <button type="button" className="footer-tab" onClick={exitSelect}>
                Xong
              </button>
              <button
                type="button"
                className="library-zip-btn"
                onClick={downloadZip}
                disabled={selectedItems.length === 0}
              >
                <IconDownload size={13} /> Tải ZIP{selectedItems.length ? ` (${selectedItems.length})` : ""}
              </button>
            </>
          ) : (
            <>
              {(["all", "image", "video"] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`footer-tab${filter === f ? " footer-tab--active" : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : f === "image" ? "Images" : "Videos"}
                </button>
              ))}
              <button
                type="button"
                className="footer-btn"
                onClick={() => void load()}
                title="Refresh"
                aria-label="Refresh"
              >
                <IconRefresh size={13} />
              </button>
              <button
                type="button"
                className="library-zip-btn library-zip-btn--ghost"
                onClick={() => setSelecting(true)}
                disabled={images.length === 0}
                title="Chọn nhiều ảnh để tải về 1 file ZIP"
              >
                Chọn ảnh
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="page__empty">✗ {error}</p>}
      {items !== null && items.length === 0 && !error && (
        <p className="page__empty">Thư viện trống — gen ảnh đầu tiên đi!</p>
      )}

      <div className={`library-grid${selecting ? " library-grid--selecting" : ""}`}>
        {list.map((item, idx) => {
          const isSel = selected.has(item.id);
          const disabled = selecting && item.kind !== "image";
          return (
            <div
              key={item.id}
              className={`library-tile${isSel ? " library-tile--selected" : ""}${disabled ? " library-tile--disabled" : ""}`}
              onClick={(e) => selecting && toggle(item, idx, e.shiftKey)}
              role={selecting ? "checkbox" : undefined}
              aria-checked={selecting ? isSel : undefined}
            >
              {item.kind === "video" ? (
                <video src={mediaUrl(item.media_id)} preload="metadata" muted />
              ) : (
                <img src={mediaUrl(item.media_id)} alt="" loading="lazy" draggable={false} />
              )}
              {selecting ? (
                item.kind === "image" && (
                  <span className="library-tile__check" aria-hidden="true">
                    {isSel && (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                )
              ) : (
                <button
                  type="button"
                  className="library-tile__download"
                  onClick={() => requestDownload([toDownload(item)])}
                  title="Download"
                  aria-label="Download"
                >
                  <IconDownload size={13} />
                </button>
              )}
              {item.kind === "video" && <span className="library-tile__badge">▶</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
