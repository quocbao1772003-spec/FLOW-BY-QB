/**
 * GitHub release lookup for the in-app "new version available" badge.
 *
 * Direct browser → api.github.com fetch — read-only public endpoint,
 * no auth needed. Rate limit is generous (60 req/hr unauthenticated)
 * and we cache the result in sessionStorage so a page refresh re-uses
 * what we already learned instead of burning quota.
 */

// Richard's fork — updates for this app ship here, not upstream.
const REPO = "quocbao1772003-spec/FLOW-BY-QB";
export const REPO_URL = `https://github.com/${REPO}`;
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const HEAD_URL = `https://api.github.com/repos/${REPO}/commits/main`;
const HEAD_CACHE_KEY = "flowboard.github.mainHead.v1";
const CACHE_KEY = "flowboard.github.latestRelease.v1";
// 1 hour — long enough that idle tabs don't hammer the API, short
// enough that a freshly-cut release shows up the same session.
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface LatestRelease {
  tagName: string;     // e.g. "v1.0.3"
  htmlUrl: string;     // GitHub release page
  publishedAt: string; // ISO timestamp
}

interface CachedShape {
  fetchedAt: number;
  release: LatestRelease | null; // null = previous fetch found no release
}

function readCache(): CachedShape | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.fetchedAt !== "number") return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed as CachedShape;
  } catch {
    return null;
  }
}

function writeCache(shape: CachedShape): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(shape));
  } catch {
    // sessionStorage disabled / quota exceeded — non-fatal.
  }
}

export async function getLatestRelease(): Promise<LatestRelease | null> {
  const cached = readCache();
  if (cached) return cached.release;
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      // 404 = no published release yet. Cache as null so we don't
      // re-spam the endpoint for the next hour.
      writeCache({ fetchedAt: Date.now(), release: null });
      return null;
    }
    const body = await res.json();
    const release: LatestRelease = {
      tagName: typeof body.tag_name === "string" ? body.tag_name : "",
      htmlUrl: typeof body.html_url === "string" ? body.html_url : "",
      publishedAt: typeof body.published_at === "string" ? body.published_at : "",
    };
    writeCache({ fetchedAt: Date.now(), release });
    return release;
  } catch {
    return null;
  }
}

/** Return true when `latest` is strictly newer than `current`. Both
 *  may be prefixed with "v" (e.g. "v1.2.3"); we strip + parse semver
 *  numerically to avoid string-compare surprises ("1.10.0" > "1.9.0"
 *  must hold). Falls back to `false` for malformed inputs so we never
 *  show a false-positive "New version" badge. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = v.replace(/^v/i, "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export interface RemoteHead {
  sha: string;
  date: string;    // ISO committer date
  message: string; // first line
}

/** Newest commit on `main` of the fork (null when offline / private repo). */
export async function getRemoteHead(): Promise<RemoteHead | null> {
  try {
    const raw = sessionStorage.getItem(HEAD_CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (typeof c?.fetchedAt === "number" && Date.now() - c.fetchedAt < CACHE_TTL_MS) {
        return c.head as RemoteHead | null;
      }
    }
  } catch {
    /* ignore cache */
  }
  let head: RemoteHead | null = null;
  try {
    const res = await fetch(HEAD_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (res.ok) {
      const body = await res.json();
      head = {
        sha: typeof body.sha === "string" ? body.sha : "",
        date: typeof body?.commit?.committer?.date === "string" ? body.commit.committer.date : "",
        message: typeof body?.commit?.message === "string" ? body.commit.message.split("\n")[0] : "",
      };
    }
  } catch {
    return null; // offline — don't cache, try again next mount
  }
  try {
    sessionStorage.setItem(HEAD_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), head }));
  } catch {
    /* ignore */
  }
  return head;
}

/** True when GitHub's main is ahead of the commit this app was started from. */
export function isRemoteNewer(head: RemoteHead | null, localSha: string, localDate: string): boolean {
  if (!head?.sha || !localSha) return false;
  if (head.sha === localSha) return false;
  const remote = Date.parse(head.date);
  const local = Date.parse(localDate);
  if (Number.isNaN(remote) || Number.isNaN(local)) return true;
  return remote > local;
}
