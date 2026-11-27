import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  STEP_TOTAL,
  VIDEO_CREDIT_FALLBACK,
  VIDEO_MODELS,
  VIDEO_STEPS,
  cancelVideoUi,
  generateVideoUi,
  listVideoUi,
  videoUiAccounts,
  videoUiMediaUrl,
  type VideoUiAccount,
  type VideoUiRequest,
} from "../../api/videoUi";
import { createNode } from "../../api/client";
import { useBoardStore } from "../../store/board";
import { useViewStore } from "../../store/view";
import { ChipSelect } from "../ChipSelect";
import {
  IconAlert,
  IconBoard,
  IconClose,
  IconDownload,
  IconExternal,
  IconPlay,
  IconRefresh,
  IconSpinner,
  IconUpload,
  IconVideo,
} from "../../canvas/icons";
import "../music/music.css";
import "./video.css";

// "Flow Video" tab — Veo / Omni run inside the signed-in Flow tab of the user's
// own Google account (extension drives the real UI). Same layout as Flow Music:
// composer left, queue right, detail drawer. Everything is /api/video-ui/*.

const LS_DRAFT = "flowboard:videoDraft";

interface Draft {
  prompt: string;
  model: string;
  aspect: "16:9" | "9:16";
  resolution: string;
  durationS: number;
  silent: boolean;
  account: string;
  maxCredits: string;
  quality: "1080p" | "720p";
}

const EMPTY: Draft = {
  prompt: "",
  model: "veo_lite",
  aspect: "16:9",
  resolution: "720p",
  durationS: 8,
  silent: true,
  account: "auto",
  maxCredits: "",
  quality: "1080p",
};

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

const shortAcc = (e?: string | null) => (e ? e.split("@")[0] : "—");
const live = (r: VideoUiRequest) => r.status === "queued" || r.status === "running";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const G = [
  "linear-gradient(135deg,#f2558f,#6b3bd6)",
  "linear-gradient(135deg,#ffb36b,#e0427c)",
  "linear-gradient(135deg,#3bb5d6,#3b4bd6)",
  "linear-gradient(135deg,#5fd9a3,#2a7c8f)",
  "linear-gradient(135deg,#c79cff,#4b2a8f)",
  "linear-gradient(135deg,#ffd36b,#d6703b)",
];

const modelLabel = (v: string | null) => VIDEO_MODELS.find((m) => m.value === v)?.label ?? v ?? "—";

export function FlowVideoPage() {
  const setView = useViewStore((s) => s.setView);
  const boardId = useBoardStore((s) => s.boardId);
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [accounts, setAccounts] = useState<VideoUiAccount[] | null>(null);
  const [items, setItems] = useState<VideoUiRequest[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState<"compose" | "queue">(() =>
    window.matchMedia?.("(max-width: 767px)").matches ? "compose" : "queue",
  );
  const [image, setImage] = useState<{ b64: string; name: string; preview: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_DRAFT, JSON.stringify(draft));
    } catch {
      // non-fatal
    }
  }, [draft]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await videoUiAccounts());
    } catch {
      setAccounts((a) => a ?? []);
    }
  }, []);
  const loadFirst = useCallback(async () => {
    try {
      const r = await listVideoUi({ limit: 40 });
      setItems(r.items);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadAccounts();
    void loadFirst();
  }, [loadAccounts, loadFirst]);

  const anyLive = !!items?.some(live);
  useEffect(() => {
    const t = setInterval(() => {
      void loadFirst();
      if (anyLive) void loadAccounts();
    }, anyLive ? 3000 : 15000);
    return () => clearInterval(t);
  }, [anyLive, loadFirst, loadAccounts]);

  const ready = accounts ?? [];
  const noAccount = accounts !== null && ready.length === 0;
  const isOmni = draft.model === "omni_flash";
  const deprecated = VIDEO_MODELS.find((m) => m.value === draft.model)?.deprecated;
  const cost = VIDEO_CREDIT_FALLBACK[draft.model] ?? 10;
  const creditsKnown = ready.some((a) => a.credits !== null);
  const creditsLeft = ready.reduce((s, a) => s + (a.credits ?? 0), 0);
  const leavingTags = useMemo(() => {
    const out = new Map<string, string>();
    for (const a of ready) for (const m of a.models || []) if (m.leaving) out.set(m.label, m.leaving);
    return [...out.entries()];
  }, [ready]);

  async function pickFile(f: File | undefined) {
    if (!f) return;
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
      fr.onerror = () => reject(new Error("đọc file lỗi"));
      fr.readAsDataURL(f);
    });
    setImage({ b64, name: f.name, preview: URL.createObjectURL(f) });
  }

  async function submit() {
    if (!image || !draft.prompt.trim()) return;
    setBusy(true);
    setSubmitErr(null);
    try {
      const max = draft.maxCredits.trim() ? Number(draft.maxCredits) : null;
      await generateVideoUi({
        prompt: draft.prompt.trim(),
        start_image: { b64: image.b64, name: image.name },
        model: draft.model,
        aspect: draft.aspect,
        resolution: isOmni ? (draft.resolution === "1080p" ? "720p" : draft.resolution) : draft.resolution,
        duration_s: isOmni ? draft.durationS : null,
        max_credits: Number.isFinite(max) ? max : null,
        download_quality: draft.quality,
        account: draft.account === "auto" ? null : draft.account,
        board_id: boardId,
        silent: draft.silent,
        client_ref: `ui:${Date.now()}`,
      });
      await loadFirst();
      setTab("queue");
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(r: VideoUiRequest) {
    try {
      await cancelVideoUi(r.id);
      await loadFirst();
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    }
  }

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3500);
  }

  async function toBoard(r: VideoUiRequest) {
    if (!boardId || !r.result) return flash("Chưa mở board nào");
    try {
      await createNode({
        board_id: boardId,
        type: "video",
        x: 120,
        y: 120,
        data: { title: "Video", prompt: r.prompt ?? "", videoUiUrl: videoUiMediaUrl(r.id), videoUiRequestId: r.id },
      });
      flash("Đã đưa lên board");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không thêm được node");
    }
  }

  const composer = (
    <section className="imagegen-form music-form video-form">
      <h2 className="imagegen-form__title">
        <IconVideo size={15} /> Tạo video
        <span className="music-form__hint">~3 phút/clip</span>
      </h2>

      {noAccount && (
        <div className="music-alert music-alert--warn">
          <IconAlert size={16} />
          <div>
            <b>Chưa có tài khoản Flow</b>
            <span>Cần Chrome có extension Flowboard và tab Flow đã đăng nhập.</span>
            <button type="button" className="accounts-btn" onClick={() => setView("accounts")}>Kết nối ngay</button>
          </div>
        </div>
      )}

      <span className="imagegen-form__label">ẢNH ĐẦU <span className="music-form__sub">keyframe</span></span>
      <button type="button" className={`video-kf${image ? " video-kf--set" : ""}`} onClick={() => fileRef.current?.click()}>
        {image ? <img src={image.preview} alt="" /> : <IconUpload size={20} />}
        <span className="video-kf__tag">{image ? image.name : "Tải ảnh lên"}</span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pickFile(e.target.files?.[0])} />

      <span className="imagegen-form__label">PROMPT CHUYỂN ĐỘNG <span className="music-form__sub">cử động, camera</span></span>
      <textarea
        className="imagegen-form__prompt"
        value={draft.prompt}
        maxLength={2000}
        placeholder="Cô gái nghiêng đầu nhìn ra cửa sổ mưa, camera dolly in chậm"
        onChange={(e) => set("prompt", e.target.value)}
      />

      <span className="imagegen-form__label">MODEL</span>
      <ChipSelect<string>
        variant="field"
        value={draft.model}
        heading="Model video"
        options={VIDEO_MODELS.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
        onChange={(v) => set("model", v)}
        ariaLabel="Model video"
      />
      {deprecated && (
        <div className="video-warn" role="status">
          <IconAlert size={13} /> Model này sẽ ngừng ngày 5/12 — vẫn chọn được.
        </div>
      )}

      <div className="music-row2">
        <div>
          <span className="imagegen-form__label">TỈ LỆ</span>
          <div className="music-seg">
            {(["16:9", "9:16"] as const).map((a) => (
              <button key={a} type="button" className={draft.aspect === a ? "on" : ""} onClick={() => set("aspect", a)}>{a}</button>
            ))}
          </div>
        </div>
        <div>
          <span className="imagegen-form__label">ĐỘ PHÂN GIẢI</span>
          <div className="music-seg">
            {(isOmni ? ["360p", "720p"] : ["720p", "1080p"]).map((r) => (
              <button key={r} type="button" className={draft.resolution === r ? "on" : ""} onClick={() => set("resolution", r)}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      {isOmni && (
        <>
          <span className="imagegen-form__label">THỜI LƯỢNG <span className="music-form__sub">{draft.durationS} giây</span></span>
          <input
            type="range" min={4} max={10} step={1} value={draft.durationS}
            onChange={(e) => set("durationS", Number(e.target.value))}
            aria-label="Thời lượng"
          />
        </>
      )}

      <span className="imagegen-form__label">TÀI KHOẢN</span>
      <ChipSelect<string>
        variant="field"
        value={draft.account}
        heading="Chạy bằng tài khoản"
        options={[
          { value: "auto", label: "Tự động", hint: "Tab Flow rảnh" },
          ...ready.map((a) => ({
            value: a.email,
            label: shortAcc(a.email),
            hint: `${a.credits ?? "?"} credit${a.busy ? " · đang bận" : ""}${a.tab_open === false ? " · tab đóng" : ""}`,
          })),
        ]}
        onChange={(v) => set("account", v)}
        ariaLabel="Tài khoản Flow"
      />

      <details className="music-adv">
        <summary>Nâng cao</summary>
        <label className="accounts-switch music-switch">
          <input type="checkbox" checked={draft.silent} onChange={(e) => set("silent", e.target.checked)} />
          <span className="accounts-switch__track" aria-hidden="true"><span className="accounts-switch__knob" /></span>
          <span>Video không tiếng</span>
        </label>
        <span className="imagegen-form__label">TỐI ĐA CREDIT <span className="music-form__sub">trống = không giới hạn</span></span>
        <input
          className="music-input music-input--mono"
          inputMode="numeric"
          value={draft.maxCredits}
          placeholder="vd 20"
          onChange={(e) => set("maxCredits", e.target.value.replace(/[^\d]/g, ""))}
        />
        <span className="imagegen-form__label">CHẤT LƯỢNG TẢI VỀ</span>
        <div className="music-seg">
          {(["1080p", "720p"] as const).map((q) => (
            <button key={q} type="button" className={draft.quality === q ? "on" : ""} onClick={() => set("quality", q)}>{q}</button>
          ))}
        </div>
      </details>

      <div className="music-form__foot">
        <div className="music-cost">
          <span>Sẽ tốn</span>
          <b>~{cost} credit</b>
          <span>Còn lại</span>
          <b>{creditsKnown ? creditsLeft.toLocaleString("vi-VN") : "—"}</b>
        </div>
        {submitErr && <div className="music-alert music-alert--err"><IconAlert size={14} /><span>{submitErr}</span></div>}
        <button
          type="button"
          className="imagegen-form__generate"
          disabled={busy || !image || !draft.prompt.trim() || noAccount}
          onClick={() => void submit()}
          title={!image ? "Chọn ảnh đầu trước" : undefined}
        >
          {busy ? <IconSpinner size={14} /> : <IconVideo size={14} />} Tạo video
        </button>
      </div>
    </section>
  );

  function statusBadge(r: VideoUiRequest) {
    const m: Record<string, [string, string]> = {
      running: ["run", "Đang tạo"], queued: ["info", "Chờ"], done: ["ok", "Xong"], failed: ["err", "Lỗi"], cancelled: ["off", "Đã huỷ"],
    };
    const [tone, label] = m[r.status] ?? ["off", r.status];
    return <span className={`music-badge music-badge--${tone}`}>{label}</span>;
  }

  function segs(r: VideoUiRequest) {
    return (
      <span className="video-seg" aria-hidden="true">
        {VIDEO_STEPS.map((_, i) => {
          const n = i + 1;
          let c = "";
          if (r.status === "done") c = "d";
          else if (r.status === "failed") c = n <= r.step ? "d" : n === r.step + 1 ? "f" : "";
          else c = n <= r.step ? "d" : n === r.step + 1 ? "c" : "";
          return <i key={i} className={c} />;
        })}
      </span>
    );
  }

  function stepLabel(r: VideoUiRequest) {
    if (r.status === "done") return `${STEP_TOTAL}/${STEP_TOTAL} Tải về xong`;
    if (r.status === "failed") return r.error?.message ?? "Không tạo được";
    if (r.status === "cancelled") return "Đã huỷ";
    if (r.status === "queued") return "Chờ tab Flow rảnh";
    const n = Math.min(STEP_TOTAL, r.step + 1);
    return `Qua tab Flow · ${n}/${STEP_TOTAL} ${VIDEO_STEPS[n - 1]}`;
  }

  function row(r: VideoUiRequest) {
    const g = G[r.id % G.length];
    return (
      <div key={r.id} className={`music-qitem${r.status === "running" ? " music-qitem--run" : ""}`}>
        <div className="music-qrow video-qrow">
          <span className="video-thumb" style={{ background: g }}>
            {live(r) ? <IconSpinner size={14} /> : <IconVideo size={14} />}
          </span>
          <div className="music-qtitle">
            <div className="music-h" title={r.prompt ?? ""}>{r.prompt}</div>
            <div className="music-c">
              {modelLabel(r.model)}{r.deprecated ? " · sắp ngừng" : ""} · {r.credits ?? "—"} credit
            </div>
          </div>
          <div className="music-col-st">{statusBadge(r)}</div>
          <div className="music-phase">
            <span className="music-c">{stepLabel(r)}</span>
            {segs(r)}
          </div>
          <div className="music-cell music-col-xl" title={r.account ?? ""}>{shortAcc(r.account)}</div>
          <div className="music-cell music-cell--r music-col-xl">{r.credits ?? "—"}</div>
          <div className="music-cell music-cell--r music-col-t">{fmtTime(r.created_at)}</div>
          <div className="music-qact">
            <button type="button" className="footer-btn" title="Xem" aria-label="Xem" onClick={() => setOpen(r.id)}><IconPlay size={13} /></button>
            {live(r) && <button type="button" className="footer-btn" title="Huỷ" aria-label="Huỷ" onClick={() => void cancel(r)}><IconClose size={13} /></button>}
            {r.status === "done" && (
              <>
                <a className="footer-btn" href={videoUiMediaUrl(r.id)} download title="Tải MP4" aria-label="Tải MP4"><IconDownload size={13} /></a>
                <button type="button" className="footer-btn" title="Lên board" aria-label="Lên board" onClick={() => void toBoard(r)}><IconBoard size={13} /></button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const queuePane = () => {
    if (noAccount) {
      return (
        <div className="music-empty">
          <span className="music-empty__ic"><IconVideo size={22} /></span>
          <h3>Chưa kết nối Flow</h3>
          <p>Cần ít nhất 1 tài khoản Google có tab Flow mở trong Chrome đã cài extension Flowboard</p>
          <button type="button" className="page__cta" onClick={() => setView("accounts")}>Kết nối ngay</button>
        </div>
      );
    }
    if (items && items.length === 0) {
      return (
        <div className="music-empty">
          <span className="music-empty__ic"><IconVideo size={22} /></span>
          <h3>Chưa có video nào</h3>
          <p>Chọn ảnh đầu, viết prompt chuyển động rồi bấm Tạo video. Xong sau ~3 phút</p>
        </div>
      );
    }
    return (
      <>
        <div className="music-qhead video-qrow">
          <span /><span>Prompt</span><span className="music-col-st">Trạng thái</span><span>Bước</span>
          <span className="music-col-xl">Tài khoản</span><span className="music-cell--r music-col-xl">Credit</span>
          <span className="music-cell--r music-col-t">Lúc</span><span />
        </div>
        <div className="music-qlist">{(items ?? []).map(row)}</div>
      </>
    );
  };

  const drawerReq = items?.find((x) => x.id === open) ?? null;
  const drawer = drawerReq && (
    <>
      <div className="video-drawer-back" onClick={() => setOpen(null)} />
      <aside className="video-drawer" role="dialog" aria-label="Chi tiết video">
        <div className="video-drawer__head">
          <h2>Video #{drawerReq.id} {statusBadge(drawerReq)}</h2>
          <button type="button" className="footer-btn" aria-label="Đóng" onClick={() => setOpen(null)}><IconClose size={14} /></button>
        </div>
        <div className="video-drawer__body">
          {drawerReq.status === "done" ? (
            <video className="video-player" src={videoUiMediaUrl(drawerReq.id)} controls preload="metadata" />
          ) : (
            <div className="video-player video-player--ph">
              {drawerReq.status === "failed" ? <IconAlert size={20} /> : <IconSpinner size={20} />}
              <span>{drawerReq.status === "failed" ? "Không có video" : "Đang tạo trong tab Flow"}</span>
            </div>
          )}
          <div className="video-meta">
            <div><small>Model</small><span>{modelLabel(drawerReq.model)}</span></div>
            <div><small>Tài khoản</small><span>{drawerReq.account ?? "—"}</span></div>
            <div><small>Credit</small><span>{drawerReq.credits ?? "—"}</span></div>
            <div><small>Nguồn</small><span>{drawerReq.source === "board" ? "Board" : "API"}</span></div>
          </div>
          <div className="video-sub">Prompt</div>
          <div className="video-raw">{drawerReq.prompt}</div>
          <div className="video-sub">Các bước · qua tab Flow</div>
          <ul className="video-tl">
            {drawerReq.steps.map((s, i) => {
              const cls = s.ok ? "ok" : drawerReq.status === "failed" && i === drawerReq.step ? "bad" : live(drawerReq) && i === drawerReq.step ? "cur" : "";
              return (
                <li key={s.key} className={cls}>
                  <span className="video-tl__dot">{cls === "ok" ? "✓" : cls === "bad" ? "×" : cls === "cur" ? <IconSpinner size={11} /> : ""}</span>
                  <span>{i + 1}. {s.label}</span>
                  <time>{s.at ? fmtTime(s.at) : "—"}</time>
                </li>
              );
            })}
          </ul>
          {drawerReq.status === "failed" && drawerReq.error && (
            <>
              <div className="video-sub">Lỗi</div>
              <pre className="video-raw video-raw--err">{drawerReq.error.code}: {drawerReq.error.message}{drawerReq.error.detail ? `\n${drawerReq.error.detail}` : ""}</pre>
            </>
          )}
        </div>
        <div className="video-drawer__foot">
          <a className="accounts-btn" href="https://flow.google.com/" target="_blank" rel="noreferrer"><IconExternal size={13} /> Mở tab Flow</a>
          {drawerReq.status === "done" && <a className="accounts-btn accounts-btn--on" href={videoUiMediaUrl(drawerReq.id)} download><IconDownload size={13} /> Tải MP4</a>}
          {live(drawerReq) && <button type="button" className="accounts-btn" onClick={() => void cancel(drawerReq)}><IconClose size={13} /> Huỷ</button>}
        </div>
      </aside>
    </>
  );

  return (
    <div className="page music-page" data-tab={tab}>
      <div className="page__header music-header">
        <div>
          <h1 className="page__title">Flow Video</h1>
          <p className="page__subtitle">Veo / Omni chạy trong tab Flow của tài khoản bạn · credit đọc thật từ Flow</p>
        </div>
        <div className="accounts-page__head-actions">
          <span className="music-credit" title="Credit Flow còn lại (mọi tài khoản)">
            {creditsKnown ? `${creditsLeft.toLocaleString("vi-VN")} credit` : "— credit"}
          </span>
          <button type="button" className="accounts-btn music-hide-sm" onClick={() => void loadAccounts()} title="Đọc lại tài khoản">
            <IconRefresh size={13} />
          </button>
          <button type="button" className="accounts-btn music-hide-sm" onClick={() => setView("accounts")}>Tài khoản</button>
        </div>
      </div>

      {leavingTags.length > 0 && (
        <div className="video-warn video-warn--bar" role="status">
          <IconAlert size={13} /> {leavingTags.map(([l, t]) => `${l}: ${t}`).join(" · ")}
        </div>
      )}

      <div className="music-mtabs">
        {([["compose", "Tạo video"], ["queue", "Hàng đợi"]] as const).map(([k, l]) => (
          <button key={k} type="button" className={`music-tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div className="music-layout">
        {composer}
        <section className="music-main">
          <div className="music-tabs">
            <button type="button" className="music-tab on">
              Hàng đợi <span className="music-tab__n">{items?.filter(live).length ?? 0}</span>
            </button>
          </div>
          {loadErr && (
            <div className="music-alert music-alert--err">
              <IconAlert size={14} />
              <span>Không tải được danh sách ({loadErr}). Tự thử lại sau vài giây.</span>
            </div>
          )}
          {queuePane()}
        </section>
      </div>

      {drawer}
      {notice && <div className="music-notice" role="status">{notice}</div>}
    </div>
  );
}
