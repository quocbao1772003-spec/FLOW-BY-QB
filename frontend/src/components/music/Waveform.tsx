import { useEffect, useRef, useState } from "react";

// Waveform drawn from the real audio: the file is decoded once in the
// browser (WebAudio) and reduced to N peaks, cached per URL. Decoding
// starts only when the bar scrolls into view and at most 2 run at once,
// so a long history doesn't download every song up front.

const BARS = 96;
const cache = new Map<string, number[]>();
const waiting: Array<() => void> = [];
let running = 0;

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => {
      running += 1;
      resolve(() => {
        running -= 1;
        waiting.shift()?.();
      });
    };
    if (running < 2) go();
    else waiting.push(go);
  });
}

async function peaksOf(url: string): Promise<number[]> {
  const hit = cache.get(url);
  if (hit) return hit;
  const release = await slot();
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    try {
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(ch.length / BARS));
      const out: number[] = [];
      for (let i = 0; i < BARS; i++) {
        let max = 0;
        for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 16) {
          const v = Math.abs(ch[j]);
          if (v > max) max = v;
        }
        out.push(max);
      }
      const top = Math.max(...out, 0.01);
      const norm = out.map((v) => Math.max(0.08, v / top));
      cache.set(url, norm);
      return norm;
    } finally {
      void ctx.close();
    }
  } finally {
    release();
  }
}

/** Deterministic placeholder while the real peaks load. */
function placeholder(seed: string): number[] {
  let x = 0;
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) % 233280;
  return Array.from({ length: BARS }, (_, i) => {
    x = (x * 9301 + 49297) % 233280;
    return (0.25 + (x / 233280) * 0.35) * (0.6 + 0.4 * Math.sin((Math.PI * i) / BARS));
  });
}

export function Waveform({
  url,
  progress = 0,
  onSeek,
}: {
  url: string | undefined;
  progress?: number;
  onSeek?: (fraction: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(() => (url ? cache.get(url) ?? null : null));
  const [loaded, setLoaded] = useState(!!peaks);

  useEffect(() => {
    if (!url || cache.has(url)) {
      if (url && cache.has(url)) {
        setPeaks(cache.get(url)!);
        setLoaded(true);
      }
      return;
    }
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      peaksOf(url)
        .then((p) => {
          if (alive) {
            setPeaks(p);
            setLoaded(true);
          }
        })
        .catch(() => {
          // keep the placeholder; the audio itself may still play
        });
    });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [url]);

  const bars = peaks ?? placeholder(url ?? "x");
  return (
    <div
      ref={ref}
      className={`music-wave${loaded ? "" : " music-wave--loading"}${onSeek ? " music-wave--seek" : ""}`}
      onClick={(e) => {
        if (!onSeek) return;
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      role={onSeek ? "slider" : undefined}
      aria-label={onSeek ? "Tua" : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
    >
      {bars.map((h, i) => (
        <i
          key={i}
          className={i / bars.length < progress ? "on" : undefined}
          style={{ height: `${Math.round(h * 100)}%` }}
        />
      ))}
    </div>
  );
}
