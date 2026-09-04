// ─────────────────────────────────────────────────────────────────────────
// DISABLED: automatic vision analysis on image upload / replace.
//
// Previously, every time an image was uploaded or replaced on an Image /
// Character / Visual-asset node, the frontend fired a background
// `POST /api/vision/describe` call to generate `data.aiBrief`. That is what
// produced the "✨ Analyzing… / ✨ Đang phân tích image…" hint and blocked
// the Generate button while `aiBriefStatus === "pending"`.
//
// It is now turned off: NodeCard.tsx no longer calls this helper, so no
// vision request is made on upload or replace. Nothing else changes —
// `/api/vision/describe` still exists on the backend, briefs already stored
// on old nodes still render, and prompt synthesis falls back to the node's
// own prompt + upstream context.
//
// TO RESTORE the old behaviour:
//   1. Restore the body of `requestAutoBrief` below (see git history:
//      `git log -p -- frontend/src/api/autoBrief.ts`).
//   2. In frontend/src/canvas/NodeCard.tsx, re-add
//        import { requestAutoBrief } from "../api/autoBrief";
//      and call `requestAutoBrief(rfId, newMediaId);` at the end of each
//      `persistMedia()` (CharacterBody, ImageBody, VisualAssetBody).
// ─────────────────────────────────────────────────────────────────────────

/**
 * No-op. Kept as an explicit, documented kill-switch so the disabled
 * feature stays discoverable instead of vanishing from the codebase.
 */
export async function requestAutoBrief(
  _rfId: string,
  _mediaId: string,
): Promise<void> {
  // intentionally empty — vision auto-analysis is disabled
}
