import { useEffect, useState } from "react";

// Current Flowboard Bridge version on this server. The download link carries
// it as ?v= so a CDN can never hand out a zip from before the last update.
let cached: string | null = null;

export function useExtensionVersion(): string | null {
  const [version, setVersion] = useState<string | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    fetch("/api/accounts/extension-info", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d.version === "string") {
          cached = d.version;
          setVersion(d.version);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

export function extensionZipUrl(version: string | null): string {
  return "/api/accounts/extension.zip" + (version ? `?v=${encodeURIComponent(version)}` : `?t=${Date.now()}`);
}
