import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CREDITS_PER_SONG,
  MUSIC_MODELS,
  cancelMusic,
  generateMusic,
  listMusic,
  musicAccounts,
  musicErrorText,
  splitStems,
  type MusicAccount,
  type MusicRequest,
  type MusicTake,
} from "../../api/music";
import { createNode } from "../../api/client";
import { useBoardStore } from "../../store/board";
import { useViewStore } from "../../store/view";
import { ChipSelect } from "../ChipSelect";
import {
  IconAlert,
  IconBoard,
  IconClose,
  IconDownload,
  IconGridLayout,
  IconList,
  IconMic,
  IconMusic,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSpinner,
  IconSplit,
  IconUser,
} from "../../canvas/icons";
import { Waveform } from "./Waveform";
import "./music.css";

// "Flow Music" tab — compose a song on the left (same layout as Image Gen),
// queue + personal library on the right, sticky player at the bottom.
// Everything goes through /api/music/* (scoped per user server-side).

const SECTION_TAGS = ["[Intro]", "[Verse]", "[Pre-Chorus]", "[Chorus]", "[Bridge]", "[Outro]"];
const LS_DRAFT = "flowboard:musicDraft";

interface Draft {
  title: string;
  style: string;
  lyrics: string;
  instrumental: boolean;
  model: string;
  takes: number;
  wav: boolean;
  stems: boolean;
  seed: string;
  account: string;
}

const EMPTY: Draft = {
  title: "",
  style: "",
  lyrics: "",
  instrumental: false,
  model: "Lyria 3.5",
  takes: 2,
  wav: false,
  stems: false,
  seed: "",
  account: "auto",
};

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

const fmtDur = (s?: number | null) => {
  if (!s && s !== 0) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
};

function fmtWhen(iso: string | null): { t: string; d: string } {
  if (!iso) return { t: "—", d: "" };
  const d = new Date(iso);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  return {
    t: d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false }),
    d: same ? "hôm nay" : d.toDateString() === y.toDateString() ? "hôm qua" : d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }),
  };
}

const shortAcc = (e?: string | null) => (e ? e.split("@")[0] : "—");
const audioOf = (t: MusicTake) => t.files?.mp3 || t.files?.m4a || t.files?.wav;
/** Library label: the title, plus "· bản N" when one request made several takes. */
const takeName = (r: MusicRequest, t: MusicTake, i: number) =>
  `${t.title || r.title}${r.takes.length > 1 ? ` · bản ${i + 1}` : ""}`;
const lyricLines = (l: string) => l.split("\n").filter((x) => x.trim() && !/^\s*\[.*\]\s*$/.test(x)).length;
const sections = (l: string) => l.split("\n").filter((x) => /^\s*\[.*\]\s*$/.test(x)).length;
const live = (r: MusicRequest) => r.status === "queued" || r.status === "running";

/** Gradient fallback cover, stable per clip. */
const COVERS = [
  "linear-gradient(135deg,#f2558f,#6b3bd6)",
  "linear-gradient(135deg,#ffb36b,#e0427c)",
  "linear-gradient(135deg,#3bb5d6,#3b4bd6)",
  "linear-gradient(135deg,#5fd9a3,#2a7c8f)",
  "linear-gradient(135deg,#c79cff,#4b2a8f)",
  "linear-gradient(135deg,#ffd36b,#d6703b)",
];
function coverBg(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COVERS[h % COVERS.length];
}

function Cover({ take, k, size }: { take?: MusicTake; k: string; size?: number }) {
  const [bad, setBad] = useState(false);
  const style = size ? { width: size, height: size } : undefined;
  if (take?.image_url && !bad) {
    return (
      <span className="music-cover" style={style}>
        <img src={take.image_url} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} />
      </span>
    );
  }
  return (
    <span className="music-cover music-cover--grad" style={{ ...style, background: coverBg(k) }}>
      <IconMusic size={size && size < 44 ? 14 : 18} />
    </span>
  );
}

interface Playing {
  key: string;
  url: string;
  title: string;
  sub: string;
  take: MusicTake;
}

export function FlowMusicPage() {
  const setView = useViewStore((s) => s.setView);
  const boardId = useBoardStore((s) => s.boardId);
  const boards = useBoardStore((s) => s.boards);

  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [accounts, setAccounts] = useState<MusicAccount[] | null>(null);
  const [items, setItems] = useState<MusicRequest[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"compose" | "queue" | "lib">(() =>
    window.matchMedia?.("(max-width: 767px)").matches ? "compose" : "queue",
  );
  const [libView, setLibView] = useState<"grid" | "table">("grid");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "vocal" | "inst" | "stems">("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);

  // ── persistence of the draft (survives tab switches / reloads) ──────
  useEffect(() => {
    try {
      localStorage.setItem(LS_DRAFT, JSON.stringify(draft));
    } catch {
      // non-fatal
    }
  }, [draft]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // ── data: accounts + first page of requests, polled ─────────────────
  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await musicAccounts());
    } catch {
      setAccounts((a) => a ?? []);
    }
  }, []);

  const loadFirst = useCallback(async () => {
    try {
      const r = await listMusic({ limit: 40, type: "gen_music" });
      setItems((prev) => {
        // keep older pages that were loaded with "Xem thêm"
        if (!prev || prev.length <= r.items.length) {
          setNextBefore(r.next_before);
          return r.items;
        }
        const ids = new Set(r.items.map((x) => x.request_id));
        return [...r.items, ...prev.filter((x) => !ids.has(x.request_id) && Number(x.request_id) < Number(r.items[r.items.length - 1]?.request_id ?? 0))];
      });
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

  async function loadMore() {
    if (!nextBefore) return;
    try {
      const r = await listMusic({ limit: 40, before: nextBefore, type: "gen_music" });
      setItems((p) => [...(p ?? []), ...r.items]);
      setNextBefore(r.next_before);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }

  // ── derived ─────────────────────────────────────────────────────────
  const ready = (accounts ?? []).filter((a) => a.session_ok !== false);
  const noAccount = accounts !== null && ready.length === 0;
  const pool =
    draft.account === "auto" ? ready : ready.filter((a) => a.email === draft.account);
  const creditsLeft = pool.reduce((s, a) => s + (a.credits_remaining ?? 0), 0);
  const creditsKnown = pool.some((a) => a.credits_remaining !== null);
  const cost = draft.takes * CREDITS_PER_SONG;
  const queue = items ?? [];
  const liveCount = queue.filter(live).length;
  const library = useMemo(() => {
    const out: Array<{ req: MusicRequest; take: MusicTake; idx: number; key: string }> = [];
    for (const r of queue) {
      if (r.status !== "done") continue;
      r.takes.forEach((t, i) => out.push({ req: r, take: t, idx: i, key: `${r.request_id}-${i}` }));
    }
    const q = query.trim().toLowerCase();
    return out.filter(({ req, take }) => {
      if (filter === "vocal" && req.instrumental) return false;
      if (filter === "inst" && !req.instrumental) return false;
      if (filter === "stems" && !take.stems) return false;
      if (!q) return true;
      return [take.title, req.title, req.sound_prompt, req.lyrics, take.lyrics].some((x) => x?.toLowerCase().includes(q));
    });
  }, [queue, query, filter]);
  const libAll = queue.filter((r) => r.status === "done").reduce((s, r) => s + r.takes.length, 0);

  // ── player ──────────────────────────────────────────────────────────
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [paused, setPaused] = useState(true);
  const [pos, setPos] = useState({ t: 0, d: 0 });
  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    audio.current = a;
    const tick = () => setPos({ t: a.currentTime, d: a.duration || 0 });
    a.addEventListener("timeupdate", tick);
    a.addEventListener("loadedmetadata", tick);
    a.addEventListener("play", () => setPaused(false));
    a.addEventListener("pause", () => setPaused(true));
    a.addEventListener("ended", () => setPaused(true));
    return () => {
      a.pause();
      a.src = "";
    };
  }, []);
  function play(p: Playing) {
    const a = audio.current;
    if (!a) return;
    if (playing?.key === p.key) {
      if (a.paused) void a.play();
      else a.pause();
      return;
    }
    a.src = p.url;
    setPlaying(p);
    setPos({ t: 0, d: p.take.duration_s ?? 0 });
    void a.play();
  }
  const isOn = (key: string) => playing?.key === key && !paused;
  const progOf = (key: string) => (playing?.key === key && pos.d ? pos.t / pos.d : 0);
  const seek = (key: string, f: number) => {
    const a = audio.current;
    if (a && playing?.key === key && a.duration) a.currentTime = f * a.duration;
  };

  // ── actions ─────────────────────────────────────────────────────────
  async function submit(over?: Partial<Draft>) {
    const d = { ...draft, ...over };
    if (!d.style.trim() || busy) return;
    setBusy(true);
    setSubmitErr(null);
    try {
      const seed = d.seed.trim() ? Number(d.seed) : null;
      await generateMusic({
        sound_prompt: d.style.trim(),
        lyrics: d.instrumental ? null : d.lyrics.trim() || null,
        instrumental: d.instrumental,
        title: d.title.trim() || "Untitled",
        model: d.model,
        seed: Number.isFinite(seed) ? seed : null,
        takes: d.takes,
        formats: d.wav ? ["mp3", "wav"] : ["mp3"],
        stems: d.stems,
        account: d.account === "auto" ? null : d.account,
      });
      setTab((t) => (t === "compose" ? "queue" : t === "lib" ? "queue" : t));
      await loadFirst();
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function regenerate(r: MusicRequest) {
    const d: Draft = {
      ...draft,
      title: r.title === "Untitled" ? "" : r.title,
      style: r.sound_prompt ?? "",
      lyrics: r.lyrics ?? "",
      instrumental: r.instrumental,
      model: r.model ?? draft.model,
      takes: r.takes_wanted || 1,
      wav: r.formats.includes("wav"),
      stems: r.stems_wanted,
      seed: "",
    };
    setDraft(d);
    void submit(d);
  }

  function reuse(r: MusicRequest) {
    setDraft((d) => ({
      ...d,
      title: r.title === "Untitled" ? "" : r.title,
      style: r.sound_prompt ?? "",
      lyrics: r.lyrics ?? "",
      instrumental: r.instrumental,
      model: r.model ?? d.model,
    }));
    setTab("compose");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function cancel(r: MusicRequest) {
    try {
      await cancelMusic(r.request_id);
    } catch {
      // already finished — the next poll shows the real state
    }
    void loadFirst();
  }

  async function stems(r: MusicRequest, t: MusicTake) {
    if (!t.clip_id) return;
    try {
      await splitStems(t.clip_id, r.account);
      flash("Đang tách stems — file sẽ hiện trên board khi xong");
    } catch (e) {
      flash(`Không tách được stems: ${e instanceof Error ? e.message : e}`);
    }
  }

  const boardName = boards.find((b) => b.id === boardId)?.name;
  async function toBoard(list: Array<{ req: MusicRequest; take?: MusicTake }>) {
    if (boardId === null) {
      flash("Mở một board trước (mục Flows) rồi thử lại");
      return;
    }
    try {
      let i = 0;
      for (const { req, take } of list) {
        const takes = take ? [take] : req.takes;
        await createNode({
          board_id: boardId,
          type: "song",
          x: 80 + (i % 4) * 340,
          y: 80 + Math.floor(i / 4) * 360,
          data: {
            title: take?.title || req.title,
            prompt: req.sound_prompt,
            lyrics: req.lyrics,
            instrumental: req.instrumental,
            model: req.model,
            takes,
            creditsUsed: req.credits_used,
            musicAccount: req.account,
          },
        });
        i += 1;
      }
      flash(`Đã đưa ${list.length} bài lên board “${boardName ?? "hiện tại"}”`);
    } catch (e) {
      flash(`Không đưa lên board được: ${e instanceof Error ? e.message : e}`);
    }
  }

  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  function flash(msg: string) {
    setNotice(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setNotice(null), 3500);
  }

  function insertTag(tag: string) {
    const el = lyricsRef.current;
    const v = draft.lyrics;
    const at = el ? el.selectionStart : v.length;
    const before = v.slice(0, at);
    const pre = before && !before.endsWith("\n") ? "\n" : "";
    const next = `${before}${pre}${tag}\n${v.slice(at)}`;
    set("lyrics", next);
    requestAnimationFrame(() => {
      if (!el) return;
      const p = before.length + pre.length + tag.length + 1;
      el.focus();
      el.setSelectionRange(p, p);
    });
  }

  function download(urls: string[]) {
    for (const u of urls) {
      const a = document.createElement("a");
      a.href = u;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  // ── render pieces ───────────────────────────────────────────────────
  const composer = (
    <section className="imagegen-form music-form">
      <h2 className="imagegen-form__title">
        <IconMusic size={15} /> Soạn bài mới
        <span className="music-form__hint">~1–2 phút/bài</span>
      </h2>

      {noAccount && (
        <div className="music-alert music-alert--warn">
          <IconAlert size={16} />
          <div>
            <b>Chưa có tài khoản Flow Music</b>
            <span>Đăng nhập flowmusic.app trong Chrome đã cài extension Flowboard.</span>
            <button type="button" className="accounts-btn" onClick={() => setView("accounts")}>
              Kết nối ngay
            </button>
          </div>
        </div>
      )}

      <span className="imagegen-form__label">TIÊU ĐỀ</span>
      <input
        className="music-input"
        value={draft.title}
        maxLength={80}
        placeholder="Không bắt buộc"
        onChange={(e) => set("title", e.target.value)}
      />

      <span className="imagegen-form__label">
        PHONG CÁCH <span className="music-form__sub">sound prompt</span>
      </span>
      <textarea
        className="imagegen-form__prompt"
        rows={3}
        value={draft.style}
        placeholder="vd: lofi hip hop, mellow piano, vinyl crackle, 80 BPM"
        onChange={(e) => set("style", e.target.value)}
      />

      <span className="imagegen-form__label">
        LỜI BÀI HÁT
        <span className="music-form__sub">
          {draft.instrumental ? "Không lời" : `${lyricLines(draft.lyrics)} dòng · ${sections(draft.lyrics)} đoạn`}
        </span>
      </span>
      <label className="accounts-switch music-switch">
        <input type="checkbox" checked={draft.instrumental} onChange={(e) => set("instrumental", e.target.checked)} />
        <span className="accounts-switch__track" aria-hidden="true">
          <span className="accounts-switch__knob" />
        </span>
        <span>Không lời (instrumental)</span>
      </label>
      {!draft.instrumental && (
        <>
          <textarea
            ref={lyricsRef}
            className="imagegen-form__prompt music-lyrics"
            rows={8}
            value={draft.lyrics}
            placeholder={"[Verse]\nLời đoạn 1…\n[Chorus]\nĐiệp khúc…\n\nĐể trống: Flow Music tự viết lời"}
            onChange={(e) => set("lyrics", e.target.value)}
          />
          <div className="music-tags">
            {SECTION_TAGS.map((t) => (
              <button key={t} type="button" className="music-tag" onClick={() => insertTag(t)}>
                {t}
              </button>
            ))}
          </div>
        </>
      )}

      <span className="imagegen-form__label">MODEL</span>
      <ChipSelect<string>
        variant="field"
        value={draft.model}
        heading="Model nhạc"
        options={MUSIC_MODELS}
        onChange={(v) => set("model", v)}
        ariaLabel="Model nhạc"
      />

      <div className="music-row2">
        <div>
          <span className="imagegen-form__label">SỐ BẢN</span>
          <div className="music-seg">
            {[1, 2, 3, 4].map((n) => (
              <button key={n} type="button" className={draft.takes === n ? "on" : ""} onClick={() => set("takes", n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="imagegen-form__label">ĐỊNH DẠNG</span>
          <div className="music-seg">
            <button type="button" className={!draft.wav ? "on" : ""} onClick={() => set("wav", false)}>
              MP3
            </button>
            <button type="button" className={draft.wav ? "on" : ""} onClick={() => set("wav", true)} title="Tải cả MP3 và WAV">
              + WAV
            </button>
          </div>
        </div>
      </div>

      <span className="imagegen-form__label">TÀI KHOẢN</span>
      <ChipSelect<string>
        variant="field"
        value={draft.account}
        heading="Chạy bằng tài khoản"
        options={[
          { value: "auto", label: "Tự động", hint: "Tài khoản rảnh, còn credit" },
          ...ready.map((a) => ({
            value: a.email,
            label: shortAcc(a.email),
            hint: `${a.credits_remaining ?? "?"} credit${a.busy ? " · đang bận" : ""}`,
          })),
        ]}
        onChange={(v) => set("account", v)}
        ariaLabel="Tài khoản Flow Music"
      />

      <details className="music-adv">
        <summary>Nâng cao</summary>
        <label className="accounts-switch music-switch">
          <input type="checkbox" checked={draft.stems} onChange={(e) => set("stems", e.target.checked)} />
          <span className="accounts-switch__track" aria-hidden="true">
            <span className="accounts-switch__knob" />
          </span>
          <span>Tách stems (vocal, nhạc cụ)</span>
        </label>
        <span className="imagegen-form__label">
          SEED <span className="music-form__sub">trống = ngẫu nhiên</span>
        </span>
        <input
          className="music-input music-input--mono"
          inputMode="numeric"
          value={draft.seed}
          placeholder="vd 81"
          onChange={(e) => set("seed", e.target.value.replace(/[^\d]/g, ""))}
        />
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
        disabled={busy || !draft.style.trim() || noAccount}
        onClick={() => void submit()}
        title={!draft.style.trim() ? "Nhập phong cách trước" : undefined}
      >
        {busy ? <IconSpinner size={14} /> : <IconMusic size={14} />} Tạo {draft.takes} bản
      </button>
      </div>
    </section>
  );

  function statusBadge(r: MusicRequest) {
    const m: Record<string, [string, string]> = {
      running: ["run", "Đang tạo"],
      queued: ["info", "Chờ"],
      done: ["ok", "Xong"],
      failed: ["err", "Lỗi"],
      cancelled: ["off", "Đã huỷ"],
    };
    const [tone, label] = m[r.status] ?? ["off", r.status];
    return <span className={`music-badge music-badge--${tone}`}>{label}</span>;
  }

  function phase(r: MusicRequest) {
    const n = r.takes.length;
    if (r.status === "queued") return "Chờ tài khoản rảnh";
    if (r.status === "running") return n ? `Đang tạo · bản ${n + 1}/${r.takes_wanted}` : `Đang tạo · ${r.takes_wanted} bản`;
    if (r.status === "done") {
      const f = [...new Set(r.takes.flatMap((t) => Object.keys(t.files ?? {})))].join(", ");
      return `${n} bản · ${f || "mp3"}${r.takes.some((t) => t.stems) ? " · stems" : ""}`;
    }
    if (r.status === "cancelled") return "Đã huỷ";
    return "Không tạo được";
  }

  function progress(r: MusicRequest) {
    if (r.status === "running") {
      const pct = Math.max(8, Math.round((r.takes.length / Math.max(1, r.takes_wanted)) * 100));
      return <span className="music-prog"><i style={{ width: `${pct}%` }} className="music-prog__pulse" /></span>;
    }
    if (r.status === "queued") return <span className="music-prog music-prog--ind"><i /></span>;
    const cls = r.status === "done" ? " music-prog--ok" : r.status === "failed" ? " music-prog--err" : "";
    return <span className={`music-prog${cls}`}><i style={{ width: r.status === "cancelled" ? 0 : "100%" }} /></span>;
  }

  function takeRow(r: MusicRequest, t: MusicTake, i: number) {
    const key = `${r.request_id}-${i}`;
    const url = audioOf(t);
    const p: Playing | null = url
      ? { key, url, title: t.title || r.title, sub: `Bản ${i + 1} · ${r.sound_prompt ?? ""}`, take: t }
      : null;
    return (
      <div key={key} className="music-take">
        <span className="music-take__n">Bản {i + 1}</span>
        <button type="button" className={`music-play${isOn(key) ? " on" : ""}`} disabled={!p} onClick={() => p && play(p)} aria-label={isOn(key) ? "Tạm dừng" : "Phát"}>
          {isOn(key) ? <IconPause size={14} /> : <IconPlay size={14} />}
        </button>
        <Waveform url={url} progress={progOf(key)} onSeek={(f) => (playing?.key === key ? seek(key, f) : p && play(p))} />
        <span className="music-take__d">{fmtDur(t.duration_s)}</span>
        <span className="music-take__act">
          {Object.entries(t.files ?? {}).map(([fmt, u]) => (
            <a key={fmt} className="accounts-btn" href={u} download title={`Tải ${fmt.toUpperCase()}`}>
              <IconDownload size={13} /> <span className="music-hide-sm">{fmt.toUpperCase()}</span>
            </a>
          ))}
          {t.stems ? (
            <button type="button" className="accounts-btn music-md" title="Tải stems" onClick={() => download(Object.values(t.stems ?? {}))}>
              <IconSplit size={13} /> <span className="music-hide-md">Stems</span>
            </button>
          ) : (
            <button type="button" className="accounts-btn music-md" title={t.stems_error ? `Tách stems lỗi: ${t.stems_error}` : "Tách stems"} onClick={() => void stems(r, t)} disabled={!t.clip_id}>
              <IconSplit size={13} /> <span className="music-hide-md">Tách stems</span>
            </button>
          )}
          <button type="button" className="accounts-btn music-md" title="Đưa lên board" onClick={() => void toBoard([{ req: r, take: t }])}>
            <IconBoard size={13} /> <span className="music-hide-md">Lên board</span>
          </button>
        </span>
      </div>
    );
  }

  function queueItem(r: MusicRequest) {
    const when = fmtWhen(r.created_at);
    const expanded = open.has(r.request_id) || (r.status === "done" && queue.find((x) => x.status === "done")?.request_id === r.request_id && !open.has(`-${r.request_id}`));
    const toggle = () =>
      setOpen((s) => {
        const n = new Set(s);
        if (expanded) {
          n.delete(r.request_id);
          n.add(`-${r.request_id}`);
        } else {
          n.add(r.request_id);
          n.delete(`-${r.request_id}`);
        }
        return n;
      });
    const lyr = r.takes.find((t) => t.lyrics)?.lyrics || r.lyrics;
    return (
      <div key={r.request_id} className={`music-qitem${r.status === "running" ? " music-qitem--run" : ""}`}>
        <div className={`music-qrow${r.status === "done" ? " music-qrow--click" : ""}`} onClick={r.status === "done" ? toggle : undefined}>
          {r.status === "done" ? (
            <Cover take={r.takes[0]} k={r.request_id} />
          ) : (
            <span className="music-cover music-cover--empty">{live(r) ? <IconSpinner size={16} /> : <IconMusic size={16} />}</span>
          )}
          <div className="music-qtitle">
            <div className="music-h" title={r.title}>{r.takes[0]?.title || r.title}</div>
            <div className="music-c" title={r.sound_prompt ?? ""}>{r.sound_prompt}</div>
          </div>
          <div className="music-col-st">{statusBadge(r)}</div>
          <div className="music-phase">
            <span className="music-c">{phase(r)}</span>
            {progress(r)}
          </div>
          <div className="music-cell music-col-xl" title={r.account ?? r.account_wanted ?? ""}>
            {r.account ? shortAcc(r.account) : r.account_wanted ? shortAcc(r.account_wanted) : "Tự động"}
            <small>{r.account ? "tài khoản" : "chưa giao"}</small>
          </div>
          <div className="music-cell music-cell--r music-col-xl">
            {r.credits_used ?? (r.status === "done" ? "?" : "—")}
            <small>credit</small>
          </div>
          <div className="music-cell music-cell--r music-col-t">
            {when.t}
            <small>{when.d}</small>
          </div>
          <div className="music-qact" onClick={(e) => e.stopPropagation()}>
            {live(r) ? (
              <button type="button" className="footer-btn" title="Huỷ" aria-label="Huỷ" onClick={() => void cancel(r)}>
                <IconClose size={13} />
              </button>
            ) : (
              <>
                {r.status === "done" && (
                  <button type="button" className="footer-btn music-hide-sm" title="Đưa cả bài lên board" aria-label="Đưa lên board" onClick={() => void toBoard([{ req: r }])}>
                    <IconBoard size={13} />
                  </button>
                )}
                <button type="button" className="footer-btn music-hide-sm" title="Dùng lại thiết lập để sửa" aria-label="Dùng lại" onClick={() => reuse(r)}>
                  <IconPlus size={13} />
                </button>
                <button type="button" className="footer-btn" title="Tạo lại với cùng thiết lập" aria-label="Tạo lại" onClick={() => regenerate(r)} disabled={busy || noAccount}>
                  <IconRefresh size={13} />
                </button>
              </>
            )}
          </div>
        </div>
        {r.status === "failed" && (
          <div className="music-errline">
            <IconAlert size={14} />
            <span title={r.error_detail || r.error || ""}>{musicErrorText(r)}</span>
            {/no_session|extension_offline|credits/.test(r.error ?? "") && (
              <button type="button" className="accounts-btn" onClick={() => setView("accounts")}>Kiểm tra</button>
            )}
          </div>
        )}
        {r.status !== "failed" && r.takes.length > 0 && (expanded || r.status === "running") && (
          <div className="music-takes">
            {r.takes.map((t, i) => takeRow(r, t, i))}
            {lyr && (
              <details className="music-lyr">
                <summary><IconMic size={13} /> Lời bài hát · {lyricLines(lyr)} dòng</summary>
                <pre>{lyr}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    );
  }

  function emptyBox(icon: JSX.Element, title: string, text: string, cta?: JSX.Element) {
    return (
      <div className="music-empty">
        <span className="music-empty__ic">{icon}</span>
        <h3>{title}</h3>
        <p>{text}</p>
        {cta}
      </div>
    );
  }

  const queuePane = () => {
    if (items === null && !loadErr) {
      return (
        <div className="music-qlist">
          {[0, 1, 2].map((i) => (
            <div key={i} className="music-qitem"><div className="music-qrow"><span className="music-sk" style={{ width: 48, height: 48 }} /><div><div className="music-sk" style={{ height: 12, width: "50%" }} /><div className="music-sk" style={{ height: 10, width: "80%", marginTop: 8 }} /></div></div></div>
          ))}
        </div>
      );
    }
    if (noAccount && queue.length === 0) {
      return emptyBox(<IconUser size={22} />, "Chưa kết nối Flow Music", "Cần ít nhất 1 tài khoản Google đã đăng nhập flowmusic.app trong Chrome có extension Flowboard", (
        <button type="button" className="page__cta" onClick={() => setView("accounts")}>Kết nối ngay</button>
      ));
    }
    if (queue.length === 0) {
      return emptyBox(<IconMusic size={22} />, "Chưa có bài nào", `Viết phong cách + lời rồi bấm Tạo. Mỗi bản ~${CREDITS_PER_SONG} credit, xong sau 1–2 phút`);
    }
    return (
      <>
        <div className="music-qhead">
          <span /><span>Bài</span><span className="music-col-st">Trạng thái</span><span>Tiến độ</span>
          <span className="music-col-xl">Tài khoản</span><span className="music-cell--r music-col-xl">Credit</span>
          <span className="music-cell--r music-col-t">Lúc</span><span />
        </div>
        <div className="music-qlist">{queue.map(queueItem)}</div>
        {nextBefore && (
          <button type="button" className="accounts-btn music-more" onClick={() => void loadMore()}>Xem thêm</button>
        )}
      </>
    );
  };

  const libPane = () => {
    if (libAll === 0) {
      return emptyBox(<IconGridLayout size={22} />, "Thư viện trống", "Bài tạo xong sẽ tự vào đây để nghe lại, tải về hoặc đưa lên board");
    }
    const chips: Array<[typeof filter, string]> = [
      ["all", `Tất cả · ${libAll}`],
      ["vocal", "Có lời"],
      ["inst", "Không lời"],
      ["stems", "Có stems"],
    ];
    const toggleSel = (k: string) =>
      setSel((s) => {
        const n = new Set(s);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      });
    return (
      <>
        <div className="music-filters">
          <label className="music-search">
            <IconSearch size={14} />
            <input className="music-input" placeholder="Tìm tên, phong cách, lời…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {chips.map(([k, l]) => (
            <button key={k} type="button" className={`music-chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        {library.length === 0 && <p className="page__empty">Không có bài khớp bộ lọc.</p>}
        {libView === "grid" ? (
          <div className={`music-lgrid${sel.size ? " music-lgrid--sel" : ""}`}>
            {library.map(({ req, take, idx, key }) => {
              const url = audioOf(take);
              const p: Playing | null = url ? { key, url, title: takeName(req, take, idx), sub: req.sound_prompt ?? "", take } : null;
              const when = fmtWhen(req.created_at);
              return (
                <div key={key} className={`music-song${sel.has(key) ? " sel" : ""}`}>
                  <div className="music-song__art">
                    <Cover take={take} k={req.request_id + idx} />
                    <button type="button" className={`music-play music-song__play${isOn(key) ? " on" : ""}`} disabled={!p} onClick={() => p && play(p)} aria-label="Nghe thử">
                      {isOn(key) ? <IconPause size={14} /> : <IconPlay size={14} />}
                    </button>
                  </div>
                  <button type="button" className="music-song__chk" onClick={() => toggleSel(key)} aria-label="Chọn" aria-pressed={sel.has(key)}>
                    {sel.has(key) ? "✓" : ""}
                  </button>
                  <div className="music-song__meta">
                    <div className="music-h" title={takeName(req, take, idx)}>{takeName(req, take, idx)}</div>
                    <div className="music-c" title={req.sound_prompt ?? ""}>{req.sound_prompt}</div>
                    <div className="music-song__foot">
                      <span>{fmtDur(take.duration_s)}{take.stems ? " · stems" : ""}</span>
                      <span>{when.d === "hôm nay" ? when.t : when.d}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="music-ltable">
            {library.map(({ req, take, idx, key }) => {
              const url = audioOf(take);
              const p: Playing | null = url ? { key, url, title: takeName(req, take, idx), sub: req.sound_prompt ?? "", take } : null;
              const when = fmtWhen(req.created_at);
              return (
                <div key={key} className={`music-lrow${sel.has(key) ? " sel" : ""}`}>
                  <button type="button" className={`music-ck${sel.has(key) ? " on" : ""}`} onClick={() => toggleSel(key)} aria-label="Chọn">{sel.has(key) ? "✓" : ""}</button>
                  <button type="button" className={`music-play${isOn(key) ? " on" : ""}`} disabled={!p} onClick={() => p && play(p)} aria-label="Nghe thử">
                    {isOn(key) ? <IconPause size={13} /> : <IconPlay size={13} />}
                  </button>
                  <Cover take={take} k={req.request_id + idx} size={36} />
                  <span className="music-h" title={takeName(req, take, idx)}>{takeName(req, take, idx)}</span>
                  <span className="music-c music-hide-sm" title={req.sound_prompt ?? ""}>{req.sound_prompt}</span>
                  <span className="music-c music-cell--r">{fmtDur(take.duration_s)}</span>
                  <span className="music-c music-cell--r music-hide-sm">{when.d === "hôm nay" ? when.t : when.d}</span>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  };

  // Pinned bars start where the app sidebar ends (200px, 56px collapsed).
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const side = document.querySelector(".app-sidebar");
    const el = pageRef.current;
    if (!side || !el) return;
    const apply = () => el.style.setProperty("--music-left", `${Math.round(side.getBoundingClientRect().right)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(side);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  const selected = library.filter((x) => sel.has(x.key));
  const total = playing ? pos.d || playing.take.duration_s || 0 : 0;

  return (
    <div ref={pageRef} className={`page music-page${playing ? " music-page--player" : ""}`} data-tab={tab}>
      <div className="page__header music-header">
        <div>
          <h1 className="page__title">Flow Music</h1>
          <p className="page__subtitle">Tạo nhạc bằng Google Flow Music (Lyria) với tài khoản của bạn</p>
        </div>
        <div className="accounts-page__head-actions">
          <span className="music-credit" title="Credit Flow Music còn lại (mọi tài khoản)">
            {ready.some((a) => a.credits_remaining !== null)
              ? `${ready.reduce((s, a) => s + (a.credits_remaining ?? 0), 0).toLocaleString("vi-VN")} credit`
              : "— credit"}
          </span>
          <button type="button" className="accounts-btn music-hide-sm" onClick={() => setView("accounts")}>
            Tài khoản
          </button>
        </div>
      </div>

      <div className="music-mtabs">
        {([["compose", "Soạn bài"], ["queue", "Hàng đợi"], ["lib", "Thư viện"]] as const).map(([k, l]) => (
          <button key={k} type="button" className={`music-tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      <div className="music-layout">
        {composer}
        <section className="music-main">
          <div className="music-tabs">
            <button type="button" className={`music-tab${tab !== "lib" ? " on" : ""}`} onClick={() => setTab("queue")}>
              Hàng đợi <span className="music-tab__n">{liveCount}</span>
            </button>
            <button type="button" className={`music-tab${tab === "lib" ? " on" : ""}`} onClick={() => setTab("lib")}>
              Thư viện của tôi <span className="music-tab__n">{libAll}</span>
            </button>
            {tab === "lib" && (
              <span className="music-tabs__tools">
                <button type="button" className={`footer-btn${libView === "grid" ? " footer-btn--active" : ""}`} onClick={() => setLibView("grid")} title="Dạng lưới" aria-label="Dạng lưới">
                  <IconGridLayout size={13} />
                </button>
                <button type="button" className={`footer-btn${libView === "table" ? " footer-btn--active" : ""}`} onClick={() => setLibView("table")} title="Dạng bảng" aria-label="Dạng bảng">
                  <IconList size={13} />
                </button>
              </span>
            )}
          </div>
          {loadErr && (
            <div className="music-alert music-alert--err">
              <IconAlert size={14} />
              <span>Không tải được danh sách ({loadErr}). Tự thử lại sau vài giây.</span>
            </div>
          )}
          {tab === "lib" ? libPane() : queuePane()}
        </section>
      </div>

      {tab === "lib" && selected.length > 0 && (
        <div className="music-actionbar">
          <span className="music-actionbar__n">Đã chọn {selected.length} bài</span>
          <button type="button" className="accounts-btn" onClick={() => download(selected.map((x) => audioOf(x.take)).filter((u): u is string => !!u))}>
            <IconDownload size={13} /> <span className="music-hide-sm">Tải về</span>
          </button>
          <button type="button" className="accounts-btn" onClick={() => void toBoard(selected.map((x) => ({ req: x.req, take: x.take })))}>
            <IconBoard size={13} /> <span className="music-hide-sm">Lên board</span>
          </button>
          <button type="button" className="footer-btn" onClick={() => setSel(new Set())} title="Bỏ chọn" aria-label="Bỏ chọn">
            <IconClose size={13} />
          </button>
        </div>
      )}

      {notice && <div className="music-notice" role="status">{notice}</div>}

      {playing && (
        <div className="music-player">
          <div className="music-player__who">
            <Cover take={playing.take} k={playing.key} size={40} />
            <div>
              <div className="music-h">{playing.title}</div>
              <div className="music-c">{playing.sub}</div>
            </div>
          </div>
          <div className="music-player__mid">
            <button type="button" className="music-play on" onClick={() => play(playing)} aria-label={paused ? "Phát" : "Tạm dừng"}>
              {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
            </button>
            <Waveform url={playing.url} progress={total ? pos.t / total : 0} onSeek={(f) => seek(playing.key, f)} />
            <span className="music-player__t">{fmtDur(pos.t)} / {fmtDur(total)}</span>
          </div>
          <div className="music-player__right">
            <a className="footer-btn" href={playing.url} download title="Tải về" aria-label="Tải về">
              <IconDownload size={13} />
            </a>
            <button
              type="button"
              className="footer-btn"
              title="Đóng"
              aria-label="Đóng"
              onClick={() => {
                audio.current?.pause();
                setPlaying(null);
              }}
            >
              <IconClose size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
