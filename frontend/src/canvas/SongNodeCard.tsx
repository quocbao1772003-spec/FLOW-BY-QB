import { Handle, Position, type NodeProps } from "@xyflow/react";
import { type FlowNode } from "../store/board";

interface SongTake {
  clip_id?: string;
  title?: string;
  duration_s?: number;
  lyrics?: string;
  image_url?: string;
  files?: Record<string, string>;
}

// "song" node: results of a Flow Music request (see routes/music.py). The
// worker writes takes / creditsUsed / musicAccount onto the node when done.
export function SongNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const takes = (Array.isArray(data.takes) ? data.takes : []) as SongTake[];
  const credits = typeof data.creditsUsed === "number" ? data.creditsUsed : null;
  const running = data.status === "queued" || data.status === "running";
  const error = typeof data.error === "string" ? data.error : null;
  return (
    <div className={`node-shell${selected ? " node-shell--selected" : ""}`}>
      <div className="node-card" style={{ width: 300, padding: 12 }}>
        <Handle type="target" position={Position.Left} className="node-handle" />
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          {data.title || "Song"}
          {running && <span style={{ marginLeft: 8, opacity: 0.7 }}>generating…</span>}
        </div>
        {data.prompt && (
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>{String(data.prompt)}</div>
        )}
        {error && <div className="node-error">{error}</div>}
        {takes.map((t, i) => {
          const src = t.files?.mp3 || t.files?.m4a || t.files?.wav;
          return (
            <div key={t.clip_id ?? i} className="nodrag" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                {t.title || `Take ${i + 1}`}
                {typeof t.duration_s === "number" && ` · ${Math.round(t.duration_s)}s`}
              </div>
              {src && <audio controls preload="none" src={src} style={{ width: "100%" }} />}
              {t.lyrics && (
                <details style={{ fontSize: 12, marginTop: 4 }}>
                  <summary>Lyrics</summary>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{t.lyrics}</pre>
                </details>
              )}
              <div style={{ fontSize: 11, marginTop: 2 }}>
                {Object.entries(t.files ?? {}).map(([fmt, url]) => (
                  <a key={fmt} href={url} download style={{ marginRight: 8 }}>
                    {fmt}
                  </a>
                ))}
              </div>
            </div>
          );
        })}
        {credits !== null && <div style={{ fontSize: 11, opacity: 0.6 }}>{credits} credits</div>}
        <Handle type="source" position={Position.Right} className="node-handle" />
      </div>
    </div>
  );
}
