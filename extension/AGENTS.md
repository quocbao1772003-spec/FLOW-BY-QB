When modifying this extension, increment the version in manifest.json for each delivered change batch. The user uses the version displayed in chrome://extensions to verify which update is loaded.

## 0.2.4 — Flow Video qua tab Flow (`video_ui_call`)

- `video-ui.js` + `cdp-input.js` (FB_CDP, chrome.debugger) are loaded by `importScripts` in `background.js`; dispatch `msg.method === 'video_ui_call'`. New permissions: `debugger`, `downloads`.
- 8 steps reported as `video_ui_progress`: open_tab, manual_mode (Flow Agent toggle off), upload (Frames > Start slot), ingredient (only with `ref_images`), submit (reads "Generating will use N credits", `max_credits` -> OVER_BUDGET before Start), approve (5 s, real mouse only if the button appears), generating, download (More options > Download > 1080p Upscaled, fallback 720p Original, then plain Download; file sent as `video_ui_chunk` 8 MB base64).
- A DOM `.click()` makes Flow Agent cancel itself: every approve/download click is `FB_CDP.clickAt`. Detach in `finally`.
- All selectors/regex: `VU_DEFAULT` in `video-ui.js`, overridden by `params.selectors` (server: `GET/PUT /api/video-ui/selectors`, `storage/video_ui_selectors.json`).
- `probe` opens the Settings popover and returns `models:[{label,leaving}]` + cost line. Server flag `VIDEO_VIA_TAB=1` switches MCP `generate_video` and board video nodes to `gen_video_ui`.
- Tests: `node extension/test/video-ui.test.js` (vm stubs, no real Flow).
