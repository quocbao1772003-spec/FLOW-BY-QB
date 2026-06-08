import { useEffect, useState } from "react";
import { listAssets, mediaUrl, type AssetItem } from "../api/client";
import { IconDownload, IconRefresh } from "../canvas/icons";

// Library — every media the agent has generated/cached (across all
// flows + the standalone Image Gen page). Backed by GET /api/assets.

type Filter = "all" | "image" | "video";

export function LibraryPage() {
  const [items, setItems] = useState<AssetItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

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

  function download(item: AssetItem) {
    const ext = item.kind === "video" ? "mp4" : "png";
    const a = document.createElement("a");
    a.href = mediaUrl(item.media_id);
    a.download = `library-${item.media_id.slice(0, 8)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Library</h1>
          <p className="page__subtitle">
            Mọi ảnh & video đã tạo từ các flow và Image Gen.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
        </div>
      </div>

      {error && <p className="page__empty">✗ {error}</p>}
      {items !== null && items.length === 0 && !error && (
        <p className="page__empty">Thư viện trống — gen ảnh đầu tiên đi!</p>
      )}

      <div className="library-grid">
        {(items ?? []).map((item) => (
          <div key={item.id} className="library-tile">
            {item.kind === "video" ? (
              <video src={mediaUrl(item.media_id)} preload="metadata" muted />
            ) : (
              <img src={mediaUrl(item.media_id)} alt="" loading="lazy" />
            )}
            <button
              type="button"
              className="library-tile__download"
              onClick={() => download(item)}
              title="Download"
              aria-label="Download"
            >
              <IconDownload size={13} />
            </button>
            {item.kind === "video" && (
              <span className="library-tile__badge">▶</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
