import { create } from "zustand";
import { saveUrl } from "../lib/imageExport";

/**
 * One file the user asked to download. Images go through the download
 * dialog (rename + convert); videos are saved straight away.
 */
export interface DownloadItem {
  kind: "image" | "video";
  /** Name the app would have used, with extension — "keep original name". */
  name: string;
  /** Same-origin URL (e.g. /media/<id>) … */
  url?: string;
  /** … or bytes already in hand (e.g. a 2K upscale result). */
  blob?: Blob;
  /** Short context shown in the dialog, e.g. "#cgyl · biến thể 2". */
  label?: string;
}

interface DownloadState {
  items: DownloadItem[];
  open: boolean;
  request(items: DownloadItem[]): void;
  close(): void;
}

export const useDownloadStore = create<DownloadState>((set) => ({
  items: [],
  open: false,
  request(items) {
    const videos = items.filter((i) => i.kind === "video" && i.url);
    const images = items.filter((i) => i.kind === "image" && (i.url || i.blob));
    // Videos can't be converted in the browser — save them as before.
    videos.forEach((v, i) => setTimeout(() => saveUrl(v.url!, v.name), i * 300));
    if (images.length > 0) set({ items: images, open: true });
  },
  close() {
    set({ open: false, items: [] });
  },
}));

/** Shorthand used by every download button in the app. */
export function requestDownload(items: DownloadItem[]): void {
  useDownloadStore.getState().request(items);
}
