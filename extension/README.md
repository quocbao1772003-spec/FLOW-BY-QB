# Flowboard Bridge (Chrome MV3)

Local extension that proxies Flowboard agent requests to authenticated labs.google sessions.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.

### Update 0.1.15 — one browser profile per agent session

Reload Bridge in the Chrome profile you want to use and confirm **0.1.15**.
Reload its Flow tab once. Update/restart the agent too (development auto-reload
does this automatically). Older extension connections are now refused before
they can receive requests or publish account information.

The first compatible profile owns this agent session. Other profiles cannot
replace it, even while it is temporarily disconnected. The popup explains a
rejected connection; `/api/health` identifies the accepted version and local
profile instance. To intentionally change profiles, Disconnect the old profile,
restart the agent, then Reconnect the desired profile. A callback secret is
rotated on disconnect/reconnect so an older socket cannot finish a new job.

### Update 0.1.14

Reload **Flowboard Bridge** in `chrome://extensions`, confirm version **0.1.14**,
then reload each Flow tab used by the app once. This loads `captcha-api.js` at
document start; reloading the extension alone cannot initialize an already-open
page. No agent restart is required for this extension-only update.

This restores the upstream reCAPTCHA compatibility mechanism with interception
limited to the actual `grecaptcha.enterprise` object, allows legitimate library
updates, and serializes token requests across generation/upload/upscale. A page
whose original library was never observed stops with `CAPTCHA_API_RELOAD_REQUIRED`
before sending a generation. It does not rotate accounts/projects, replay captured
tokens, or automatically retry a server `PUBLIC_ERROR_UNUSUAL_ACTIVITY` rejection.

Local regression tests exercise API initialization/replacement, unrelated
property descriptors, a shared token queue and two-reference generation against
a simulated server. Actual acceptance by Google must still be verified separately.

## How it works

- The service worker connects to `ws://127.0.0.1:9223` automatically when the agent is running.
- On first sign-in at `labs.google/fx/tools/flow` the `Authorization: Bearer ya29.*` token is captured automatically from outgoing request headers.
- Responses to agent `api_request` commands are sent via HTTP POST to `http://127.0.0.1:8101/api/ext/callback` with an `X-Callback-Secret` header (secret supplied by the agent on connect). WS fallback is used if HTTP fails.
- A keepalive `ping` is sent every ~24 s; disconnections retry after 30 s, with backoff up to 4 minutes. The popup Reconnect button retries immediately. Start `MO-APP.bat` if the local agent is offline.
- When an `api_request` includes `captchaAction`, the extension solves a reCAPTCHA Enterprise challenge via the injected MAIN-world script (`injected.js`) running on the Flow tab, then patches the token into the request body before forwarding.
- `trpc_request` commands are proxied directly to `https://labs.google/` with the captured Bearer token and browser credentials.

## Content script + injected script

`content.js` runs at `document_start` on `labs.google/fx/tools/flow*` pages. It injects `injected.js` into the MAIN world so it can reach `window.grecaptcha.enterprise`. The two scripts communicate via `CustomEvent` (`GET_CAPTCHA` / `CAPTCHA_RESULT`).

## Popup

Click the extension icon to see connection status, token age, request counters, and buttons to open the Flow tab or force a token refresh.

## Out of scope (this version)

- Side panel
- Agent-side TRPC media URL forwarding listener

See `docs/PLAN.md` for planned additions.
