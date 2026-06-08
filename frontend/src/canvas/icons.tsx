// Icon system — Magnific-style stroke icons (hand-authored, Lucide-like
// geometry; ui/UI_MIGRATION_BRIEF.md §7 forbids copying Magnific's own
// set). All icons render at 1em-ish sizes from a 24px grid, inherit
// currentColor, and take an optional `size` (default 16).

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
}

function Svg({
  size = 16,
  children,
  filled = false,
}: IconProps & { children: ReactNode; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// ── Tools ────────────────────────────────────────────────────────────

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconFrame(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 2v20M18 2v20M2 6h20M2 18h20" />
    </Svg>
  );
}

export function IconUngroup(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="10" height="10" rx="2" />
      <rect x="11" y="11" width="10" height="10" rx="2" />
    </Svg>
  );
}

export function IconGridLayout(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function IconMap(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 3 3.6 5.2A1 1 0 0 0 3 6.1v13.4a1 1 0 0 0 1.4.9L9 18.5l6 2.5 5.4-2.2a1 1 0 0 0 .6-.9V4.5a1 1 0 0 0-1.4-.9L15 5.5 9 3Z" />
      <path d="M9 3v15.5M15 5.5V21" />
    </Svg>
  );
}

// ── Actions ──────────────────────────────────────────────────────────

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p} filled>
      <path d="M7.5 5.1c0-.8.9-1.3 1.6-.9l10 6a1 1 0 0 1 0 1.7l-10 6c-.7.4-1.6-.1-1.6-.9V5.1Z" />
    </Svg>
  );
}

export function IconRunAll(p: IconProps) {
  return (
    <Svg {...p} filled>
      <path d="M3.5 5.6c0-.8.9-1.3 1.5-.9l8.6 5.6a1 1 0 0 1 0 1.6l-8.6 5.5c-.6.4-1.5 0-1.5-.8V5.6Z" />
      <path d="M13.5 5.6c0-.8.9-1.3 1.5-.9l8.1 5.6a1 1 0 0 1 0 1.6l-8.1 5.5c-.6.4-1.5 0-1.5-.8V5.6Z" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v5h-5" />
    </Svg>
  );
}

export function IconDownload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </Svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function IconCopy(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function IconLock(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}

export function IconUnlock(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.7-1.5" />
    </Svg>
  );
}

export function IconCaretDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function IconPencil(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z" />
    </Svg>
  );
}

export function IconCrop(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </Svg>
  );
}

export function IconRotate(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 8a9 9 0 1 0 .5 4" />
      <path d="M21 3v5h-5" />
      <rect x="8" y="10" width="8" height="6" rx="1" />
    </Svg>
  );
}

export function IconArrowUp(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function IconReplace(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h11M11 3l4 4-4 4" />
      <path d="M20 17H9M13 21l-4-4 4-4" />
    </Svg>
  );
}

export function IconScissors(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.5 15.5M14.5 14.5 20 20M8.5 8.5l3 3" />
    </Svg>
  );
}

export function IconSidebar(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </Svg>
  );
}

// Spinner — rotating arc, used everywhere a "⏳" used to be. The
// rotation animation lives in styles.css (.icon-spin).
export function IconSpinner(p: IconProps) {
  return (
    <span className="icon-spin" style={{ display: "inline-flex" }} aria-label="Loading">
      <Svg {...p}>
        <path d="M21 12a9 9 0 1 1-9-9" />
      </Svg>
    </span>
  );
}

// ── Node types ───────────────────────────────────────────────────────

export function IconText(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7V5h16v2M12 5v14M9 19h6" />
    </Svg>
  );
}

export function IconImage(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4.5-4.5a1.4 1.4 0 0 0-2 0L5 20" />
    </Svg>
  );
}

export function IconVideo(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="5" width="14" height="14" rx="3" />
      <path d="m16 10 5-3v10l-5-3" />
    </Svg>
  );
}

export function IconSparkles(p: IconProps) {
  return (
    <Svg {...p} filled>
      <path d="M11 3.6c.2-.8 1.8-.8 2 0l1.2 4.3a1 1 0 0 0 .9.9l4.3 1.2c.8.2.8 1.8 0 2l-4.3 1.2a1 1 0 0 0-.9.9L13 18.4c-.2.8-1.8.8-2 0l-1.2-4.3a1 1 0 0 0-.9-.9L4.6 12c-.8-.2-.8-1.8 0-2l4.3-1.2a1 1 0 0 0 .9-.9L11 3.6Z" />
      <path d="M19 16.5c.1-.4.9-.4 1 0l.4 1.6.2.3 1.6.4c.4.1.4.9 0 1l-1.6.4-.3.2-.4 1.6c-.1.4-.9.4-1 0l-.4-1.6-.2-.3-1.6-.4c-.4-.1-.4-.9 0-1l1.6-.4.3-.2.4-1.6Z" />
    </Svg>
  );
}

export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </Svg>
  );
}

export function IconLayers(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </Svg>
  );
}

export function IconStoryboard(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16M3 12h18" />
    </Svg>
  );
}

export function IconNote(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9l-6 7H6a2 2 0 0 1-2-2V5Z" />
      <path d="M14 21v-5a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function IconUpload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </Svg>
  );
}

// Node-type → icon. Used by the eyebrow label, ctx menu and add menu so
// the whole canvas shares one icon language.
export function NodeTypeIcon({ type, size = 12 }: { type: string; size?: number }) {
  switch (type) {
    case "prompt":
      return <IconText size={size} />;
    case "image":
      return <IconImage size={size} />;
    case "video":
      return <IconVideo size={size} />;
    case "assistant":
      return <IconSparkles size={size} />;
    case "character":
      return <IconUser size={size} />;
    case "visual_asset":
      return <IconLayers size={size} />;
    case "Storyboard":
      return <IconStoryboard size={size} />;
    case "note":
      return <IconNote size={size} />;
    case "group":
      return <IconFrame size={size} />;
    default:
      return <IconImage size={size} />;
  }
}
