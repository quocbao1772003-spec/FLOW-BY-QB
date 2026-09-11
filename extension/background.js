/**
 * Flowboard Bridge — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures Bearer token and proxies API calls through the browser context.
 */

const AGENT_WS_URL  = 'ws://127.0.0.1:9223';
const CALLBACK_URL  = 'http://127.0.0.1:8101/api/ext/callback';

let ws               = null;
let flowKey          = null;
let callbackSecret   = null; // Auth secret received from agent on WS connect
let state            = 'off'; // off | idle | running
let manualDisconnect = false;
let metrics = {
  tokenCapturedAt: null,
  requestCount:    0,
  successCount:    0,
  failedCount:     0,
  lastError:       null,
};

// Every URL shape a live Google Flow app tab can have. Flow moved off
// labs.google onto its own flow.google.com domain in 2026 — a signed-in
// visit to labs.google/fx/tools/flow now redirects there, which is what
// silently broke captcha solving (the redirected tab stopped matching
// this list, so every generate ended in CAPTCHA_FAILED: NO_FLOW_TAB).
// Both domains stay listed: labs.google still serves the tool page (and
// still loads reCAPTCHA Enterprise) and is the safe fallback.
const flowUrls = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];

// ─── URL → Log Type Classifier ─────────────────────────────

function classifyUrl(url) {
  if (url.includes('batchGenerateImages'))     return 'GEN_IMG';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync'))         return 'POLL';
  return 'API';
}

// ─── Request Log (last 50 entries) ─────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 50) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
});

async function init() {
  // Note: deliberately not restoring `userInfo` from storage. We used
  // to persist it here, but Google profile fields (name + email) are
  // PII and chrome.storage.local is plaintext + readable by other
  // extensions on the profile that hold the `storage` permission.
  // The agent replays user_info on every WS reconnect anyway via
  // fetchAndPushUserInfo(token), so persistence buys nothing.
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret']);
  if (data.flowKey)        flowKey        = data.flowKey;
  if (data.metrics)        Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    const tokenChanged = flowKey !== token;
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });

    // Only emit on the WS when the token actually rotated. The listener
    // fires on EVERY outbound aisandbox-pa request — and the agent's
    // own poll loops generate dozens per minute. Re-sending the same
    // string each time pushed the agent into an effective infinite
    // /v1/credits refresh loop (one credits GET per poll). The agent
    // side has a defensive dedupe too, but quiet at the source first.
    if (tokenChanged) {
      console.log('[Flowboard] Bearer token captured');
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      }
      // Resolve the user's identity (email/name/picture) once per token —
      // saves the popup + AccountPanel from showing "Connected via
      // extension" placeholders. The token already has the userinfo.email
      // + userinfo.profile scopes Flow needs anyway, so this is a free
      // call. Errors are non-fatal and silent.
      fetchAndPushUserInfo(token);
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*', 'https://flow.google.com/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let cachedUserInfo = null;

async function fetchAndPushUserInfo(token) {
  try {
    const resp = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      console.warn('[Flowboard] userinfo fetch returned', resp.status);
      return;
    }
    const info = await resp.json();
    // In-memory only — DO NOT persist to chrome.storage.local. PII
    // there is plaintext on disk and readable by other extensions
    // with the `storage` permission. Lifetime = service-worker
    // lifetime; rebuilt on next token rotation if the SW recycles.
    cachedUserInfo = info;
    console.log('[Flowboard] userinfo captured for', info?.email || '<no email>');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: info }));
    }
  } catch (e) {
    console.warn('[Flowboard] userinfo fetch failed:', e?.message || e);
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[Flowboard] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Flowboard] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    const tokenAge = flowKey && metrics.tokenCapturedAt
      ? Date.now() - metrics.tokenCapturedAt
      : null;

    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge,
    }));

    // Resend token immediately so agent can start without waiting for a capture
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
    // Replay cached userinfo so the agent's AccountPanel populates on
    // reconnect without waiting for the next token rotation. If we
    // never resolved one yet but a token IS present, kick off a fetch.
    if (cachedUserInfo) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
    } else if (flowKey) {
      fetchAndPushUserInfo(flowKey);
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[Flowboard] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response — no-op
      } else if (msg.type === 'logout') {
        // Agent's /api/auth/logout invoked — drop in-memory identity
        // so the next reconnect picks up fresh credentials. Don't
        // touch chrome.storage (we don't persist identity there
        // anyway, but be explicit). The WS stays open; agent will
        // re-greet when the user logs back in.
        console.log('[Flowboard] logout requested by agent');
        cachedUserInfo = null;
        flowKey = null;
      } else if (msg.type === 'please_resend_userinfo') {
        // No Bearer token means the userinfo endpoint is unreachable; the Flow
        // page still knows who is signed in.
        if (!flowKey) { pushIdentityFromFlowTab(true); return; }
        // Agent's /api/auth/scan asks us to re-fetch userinfo when
        // its own cache is empty (e.g. agent restarted, or user
        // clicked "Scan extension" before WS finished its first
        // round-trip). If we have a cached profile, replay it
        // immediately; otherwise refetch from Google's userinfo
        // endpoint with whatever Bearer token we currently hold.
        if (cachedUserInfo) {
          ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
        } else if (flowKey) {
          fetchAndPushUserInfo(flowKey);
        } else {
          console.log('[Flowboard] please_resend_userinfo: no token captured yet');
        }
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      }
    } catch (e) {
      console.error('[Flowboard] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[Flowboard] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5 s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

// ─── Send to Agent ──────────────────────────────────────────

/**
 * Route a message to the agent.
 * Responses (msg.id present) go via HTTP callback — immune to WS drops.
 * Falls back to WS on HTTP failure. Non-response messages use WS directly.
 */
function sendToAgent(msg) {
  if (msg.id) {
    fetch(CALLBACK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Callback-Secret': callbackSecret || '',
      },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fall back to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status, token_captured)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params || {};

  // Image generation no longer exists on aisandbox-pa. Route it to the boq
  // shim before the bearer-token gate below — that token is never issued
  // any more, so the old path can only fail with NO_FLOW_KEY.
  if (typeof url === 'string' && url.indexOf(':batchGenerateImages') !== -1) {
    return handleBatchGenerateImagesViaBoq(msg);
  }
  if (typeof url === 'string' && url.indexOf('/v1/flow/uploadImage') !== -1) {
    return handleUploadImageViaBoq(msg);
  }
  if (typeof url === 'string' && url.indexOf('/v1/flow/upsampleImage') !== -1) {
    return handleUpsampleImageViaBoq(msg);
  }

  if (!url || !url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, status: 400, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  addRequestLog({
    id,
    type:   classifyUrl(url),
    time:   new Date().toISOString(),
    status: 'processing',
    url,
  });

  try {
    // Step 0: Fail fast if we have no bearer token. Avoids burning a reCAPTCHA
    // solve (rate-limited + single-use) only to discover later that we can't
    // send the request.
    if (!flowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(id, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[Flowboard] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(id, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body clone if present
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    const fetchHeaders = { ...(headers || {}), authorization: `Bearer ${flowKey}` };

    const response = await fetch(url, {
      method:      method || 'POST',
      headers:     fetchHeaders,
      credentials: 'include',
      body:        method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({ id, status: response.status, data: responseData });

    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(id, { status: 'success', httpStatus: response.status });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(id, { status: 'failed', httpStatus: response.status, error: `API_${response.status}` });
    }
  } catch (e) {
    sendToAgent({ id, status: 500, error: e.message || 'API_REQUEST_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message || 'API_REQUEST_FAILED'; }
    updateRequestLog(id, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── Token Refresh (minimal) ────────────────────────────────

let _openingFlowTab = false;

const FLOW_URL = 'https://labs.google/fx/tools/flow';

/**
 * Open a Flow tab even when Chrome has zero windows. `chrome.tabs.create`
 * throws "No current window" in that state because it needs a window
 * context to attach to; `chrome.windows.create` spawns a fresh window
 * and tab in one call. Falls back through both paths so we recover from
 * "all-windows-closed but service-worker-still-alive" silently.
 */
async function openFlowTabResilient(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    const msg = e?.message || '';
    if (!msg.includes('No current window')) throw e;
    console.log('[Flowboard] No Chrome window — spawning a fresh one for Flow');
    const win = await chrome.windows.create({
      url: FLOW_URL,
      focused: false,
      state: 'minimized',
    });
    return win.tabs?.[0] ?? null;
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  if (!tabs.length) {
    if (_openingFlowTab) return;
    _openingFlowTab = true;
    try {
      console.log('[Flowboard] No Flow tab — opening in background');
      await openFlowTabResilient(false);
    } catch (e) {
      console.error('[Flowboard] Failed to open Flow tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }

  try {
    // Trigger a credentialed request so the page re-issues an Authorization header
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      // Re-fetch whatever the tab is already showing — the path differs
      // between flow.google.com and labs.google/fx/tools/flow.
      func:   () => fetch(location.href, { credentials: 'include' }),
    });
    console.log('[Flowboard] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[Flowboard] Token refresh failed:', e);
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry. Both the inject + re-send can
    // throw "No current window" / "No tab with id" if the tab dies in
    // between (Chrome aggressively discards background tabs). Surface
    // those verbatim so solveCaptcha's loop can move to the next
    // candidate instead of bubbling a confusing message to the user.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

/** Try to wake a discarded Flow tab so `sendMessage` can reach it.
 *  Chrome auto-discards backgrounded tabs to save memory; the tab still
 *  shows up in `chrome.tabs.query` but cross-context calls fail with
 *  "No current window" / "No tab with id". A reload re-hydrates it. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    const fresh = await chrome.tabs.get(tab.id);
    return fresh;
  } catch {
    return null;
  }
}

async function solveCaptcha(requestId, captchaAction) {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  // No Flow tab at all — spawn one (handles "no Chrome window" via the
  // resilient helper).
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  // Try each Flow tab in turn — gracefully skip dead/discarded ones
  // instead of bubbling "No current window" up to the user. Re-query
  // because we might have just spawned a new one above.
  const candidates = await chrome.tabs.query({ url: flowUrls });
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await Promise.race([
        requestCaptchaFromTab(live.id, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
      ]);
      if (resp?.token) return resp;
      // Soft failure — this tab answered, but couldn't produce a token
      // (page still booting, or a Flow surface that doesn't load
      // reCAPTCHA Enterprise at all). Keep the reason and try the next
      // candidate rather than failing the whole generation on it.
      errors.push(resp?.error || 'EMPTY_CAPTCHA_RESPONSE');
      continue;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      // Tab evaporated mid-call (window closed, tab discarded again,
      // or page navigated away). Move on to the next candidate.
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  // All candidates failed — last-ditch: spawn a fresh Flow tab and try
  // it once. This handles the case where every existing Flow tab was
  // in a closed window we couldn't recover from.
  try {
    await openFlowTabResilient(false);
    await sleep(3000);
    const fresh = await chrome.tabs.query({ url: flowUrls });
    const target = fresh.find((t) => !t.discarded) || fresh[0];
    if (!target) return { error: 'NO_FLOW_TAB' };
    const resp = await Promise.race([
      requestCaptchaFromTab(target.id, requestId, captchaAction),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
    ]);
    if (resp?.token) return resp;
    return { error: resp?.error || errors[0] || 'NO_FLOW_TAB' };
  } catch (e) {
    const msg = e?.message || (errors[0] ?? 'NO_FLOW_TAB');
    return { error: msg };
  }
}

// ─── Self-healing payload template ──────────────────────────────────────
//
// The shim builds boq payloads from hard-coded slot positions (seed at 3,
// INPUTS at 2, captcha at […,[token,1]]). Google reshuffles those without
// notice, and a shifted slot is the most common way this breaks.
//
// So: rather than hard-code, LEARN. Watch the Flow app make one successful
// generate of its own, then locate our known values inside the payload it
// sent — the prompt text, the project id, the captcha token, the seed, the
// reference media ids. Where each value sits IS the template. Future requests
// clone the captured skeleton and write our values into those same paths, so
// an inserted slot, a renamed rpcid or a new constant field all come along for
// free.
//
// What this cannot learn: a field that must vary per request by a rule we
// can't see, or a change of auth scheme. Those still need a human.
//
// Nothing secret is persisted: once the paths are known, every located value
// is blanked out of the stored skeleton — captcha token, project id and the
// user's prompt included.

const BOQ_UUID_UPPER_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** Every index path at which `value` occurs (strict equality). */
function boqFindPaths(tree, value, path, out) {
  path = path || [];
  out = out || [];
  if (Array.isArray(tree)) {
    for (let i = 0; i < tree.length; i++) boqFindPaths(tree[i], value, path.concat(i), out);
    return out;
  }
  if (tree === value) out.push(path.slice());
  return out;
}

/** Every path holding a string that satisfies `pred`. */
function boqFindPathsBy(tree, pred, path, out) {
  path = path || [];
  out = out || [];
  if (Array.isArray(tree)) {
    for (let i = 0; i < tree.length; i++) boqFindPathsBy(tree[i], pred, path.concat(i), out);
    return out;
  }
  if (typeof tree === 'string' && pred(tree)) out.push(path.slice());
  return out;
}

function boqGetAt(tree, path) {
  let n = tree;
  for (let i = 0; i < path.length; i++) {
    if (!Array.isArray(n)) return undefined;
    n = n[path[i]];
  }
  return n;
}

function boqSetAt(tree, path, value) {
  if (!path || !path.length) return false;
  let n = tree;
  for (let i = 0; i < path.length - 1; i++) {
    if (!Array.isArray(n)) return false;
    n = n[path[i]];
  }
  if (!Array.isArray(n)) return false;
  n[path[path.length - 1]] = value;
  return true;
}

function boqClone(x) { return JSON.parse(JSON.stringify(x)); }

/**
 * Derive a template from one observed request.
 *
 * `sample` = { rpcId, bl, endpoint, inner, values } where `values` holds the
 * actual strings/numbers that request used. Returns `{ template }` or
 * `{ error }` — a missing anchor means the payload no longer looks like
 * anything we understand, and guessing would be worse than failing.
 */
function boqLearnTemplate(sample) {
  const inner = sample.inner;
  const v = sample.values || {};
  if (!Array.isArray(inner)) return { error: 'INNER_NOT_ARRAY' };

  const paths = {};

  const promptPaths = boqFindPaths(inner, v.prompt);
  if (!promptPaths.length) return { error: 'PROMPT_NOT_FOUND' };
  paths.prompt = promptPaths[0];

  paths.project = boqFindPaths(inner, v.projectId);
  if (!paths.project.length) return { error: 'PROJECT_NOT_FOUND' };

  paths.token = boqFindPaths(inner, v.token);
  if (!paths.token.length) return { error: 'TOKEN_NOT_FOUND' };

  const seedPaths = boqFindPaths(inner, v.seed);
  if (!seedPaths.length) return { error: 'SEED_NOT_FOUND' };
  paths.seed = seedPaths[0];

  // Reference images, when the observed call had any. The id sits inside a
  // per-input entry; the entry's parent is the container we rewrite.
  paths.inputs = null;
  paths.inputEntry = null;
  paths.inputIdIndex = 0;
  const firstMedia = (v.mediaIds && v.mediaIds.length) ? v.mediaIds[0] : null;
  if (firstMedia) {
    const mp = boqFindPaths(inner, firstMedia);
    if (!mp.length) return { error: 'MEDIA_NOT_FOUND' };
    const idPath = mp[0];
    if (idPath.length < 2) return { error: 'MEDIA_PATH_TOO_SHALLOW' };
    paths.inputIdIndex = idPath[idPath.length - 1];
    const entryPath = idPath.slice(0, -1);
    paths.inputs = entryPath.slice(0, -1);
    const entry = boqGetAt(inner, entryPath);
    if (!Array.isArray(entry)) return { error: 'MEDIA_ENTRY_NOT_ARRAY' };
    paths.inputEntry = boqClone(entry);
    paths.inputEntry[paths.inputIdIndex] = null;
  }

  // Client-generated UUIDs. The batch id is the one the response echoes; the
  // rest are per-item and get fresh values every request.
  const uuidPaths = boqFindPathsBy(inner, (x) => BOQ_UUID_UPPER_RE.test(x));
  paths.group = [];
  paths.uuids = [];
  for (const up of uuidPaths) {
    const val = boqGetAt(inner, up);
    if (v.groupId && val === v.groupId) paths.group.push(up);
    else paths.uuids.push(up);
  }

  // Blank every located value before this is persisted.
  const skeleton = boqClone(inner);
  boqSetAt(skeleton, paths.prompt, null);
  for (const p of paths.project) boqSetAt(skeleton, p, null);
  for (const p of paths.token) boqSetAt(skeleton, p, null);
  boqSetAt(skeleton, paths.seed, null);
  for (const p of paths.group) boqSetAt(skeleton, p, null);
  for (const p of paths.uuids) boqSetAt(skeleton, p, null);
  if (paths.inputs) boqSetAt(skeleton, paths.inputs, null);

  return {
    template: {
      rpcId: sample.rpcId,
      bl: sample.bl,
      endpoint: sample.endpoint,
      learnedAt: Date.now(),
      hadInputs: !!paths.inputs,
      paths,
      skeleton,
    },
  };
}

/** Rebuild a payload from a template. `values.uuids` is an optional queue of
 *  UUIDs to consume in path order — used by the verifier to reproduce the
 *  original byte-for-byte. */
function boqBuildFromTemplate(tpl, values) {
  const inner = boqClone(tpl.skeleton);
  const P = tpl.paths;
  const queue = values.uuids ? values.uuids.slice() : null;
  const nextUuid = () => (queue && queue.length ? queue.shift() : values.newUuid());

  boqSetAt(inner, P.prompt, values.prompt);
  for (const p of P.project) boqSetAt(inner, p, values.projectId);
  for (const p of P.token) boqSetAt(inner, p, values.token);
  boqSetAt(inner, P.seed, values.seed);
  for (const p of P.group) boqSetAt(inner, p, values.groupId);
  for (const p of P.uuids) boqSetAt(inner, p, nextUuid());

  if (P.inputs) {
    const ids = values.mediaIds || [];
    const entries = ids.map((id) => {
      const e = boqClone(P.inputEntry);
      e[P.inputIdIndex] = id;
      return e;
    });
    boqSetAt(inner, P.inputs, entries.length ? entries : null);
  }
  return inner;
}

/**
 * Round-trip check: rebuild the very request the template was learned from and
 * require an exact match. Costs nothing, spends no credits, and is the gate
 * that keeps a mislearned template from ever reaching Google.
 */
function boqVerifyTemplate(tpl, sample) {
  const v = sample.values || {};
  const originalUuids = (tpl.paths.uuids || []).map((p) => boqGetAt(sample.inner, p));
  let rebuilt;
  try {
    rebuilt = boqBuildFromTemplate(tpl, {
      prompt: v.prompt,
      projectId: v.projectId,
      token: v.token,
      seed: v.seed,
      groupId: v.groupId,
      mediaIds: v.mediaIds || [],
      uuids: originalUuids,
      newUuid: () => 'X',
    });
  } catch (e) {
    return { ok: false, reason: 'REBUILD_THREW: ' + ((e && e.message) || 'unknown') };
  }
  const a = JSON.stringify(rebuilt);
  const b = JSON.stringify(sample.inner);
  if (a !== b) return { ok: false, reason: 'ROUND_TRIP_MISMATCH' };
  return { ok: true };
}

/**
 * Pull the values out of a captured request so it can be learned from. The
 * captcha token is the long opaque string; the seed is the integer that is not
 * a timestamp-sized number; media ids are lowercase uuids that are not the
 * project id.
 */
function boqExtractSampleValues(inner, projectId) {
  const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let token = null, prompt = null, seed = null, groupId = null;
  const mediaIds = [];

  const walk = (n, path) => {
    if (Array.isArray(n)) {
      for (let i = 0; i < n.length; i++) walk(n[i], path.concat(i));
      return;
    }
    if (typeof n === 'string') {
      if (n.length > 500) { if (!token || n.length > token.length) token = n; return; }
      if (LOWER_UUID.test(n)) { if (n !== projectId && mediaIds.indexOf(n) === -1) mediaIds.push(n); return; }
      if (BOQ_UUID_UPPER_RE.test(n)) return;
      if (n && n !== projectId && (prompt === null || n.length > prompt.length)) prompt = n;
      return;
    }
    if (typeof n === 'number' && n > 1000 && Number.isInteger(n)) {
      if (seed === null) seed = n;
    }
  };
  walk(inner, []);

  // The batch id is the uppercase uuid sitting outside the per-item block —
  // in every capture it is the last top-level element.
  const tail = inner[inner.length - 1];
  if (Array.isArray(tail) && typeof tail[0] === 'string' && BOQ_UUID_UPPER_RE.test(tail[0])) {
    groupId = tail[0];
  }

  return { prompt, token, seed, groupId, projectId, mediaIds };
}

// ─── Template lifecycle: detect → learn → verify ────────────────────────

const BOQ_STALE_AFTER_FAILURES = 2;

let boqTemplate = null;                       // in memory; mirrored to storage
let boqHealth = { failures: 0, stale: false, reason: null, lastLearnError: null };

async function boqLoadTemplate() {
  try {
    const got = await chrome.storage.local.get(['boqTemplate', 'boqHealth']);
    if (got && got.boqTemplate) boqTemplate = got.boqTemplate;
    if (got && got.boqHealth) boqHealth = got.boqHealth;
  } catch (e) { /* first run */ }
}
boqLoadTemplate();

function boqSaveTemplate() {
  chrome.storage.local.set({ boqTemplate, boqHealth }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'BOQ_TEMPLATE_UPDATE', template: boqTemplateStatus() }).catch(() => {});
  // The agent folds this into its failure report — "was the template already
  // stale when this broke?" is the first thing worth knowing.
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'boq_template', status: boqTemplateStatus() }));
    } catch (e) { /* socket closing */ }
  }
}

function boqTemplateStatus() {
  return {
    learned: !!boqTemplate,
    rpcId: boqTemplate ? boqTemplate.rpcId : null,
    bl: boqTemplate ? boqTemplate.bl : null,
    learnedAt: boqTemplate ? boqTemplate.learnedAt : null,
    hadInputs: boqTemplate ? boqTemplate.hadInputs : false,
    stale: boqHealth.stale,
    reason: boqHealth.reason,
    failures: boqHealth.failures,
    lastLearnError: boqHealth.lastLearnError,
  };
}

function boqMarkFailure(reason) {
  boqHealth.failures = (boqHealth.failures || 0) + 1;
  if (boqHealth.failures >= BOQ_STALE_AFTER_FAILURES && !boqHealth.stale) {
    boqHealth.stale = true;
    boqHealth.reason = 'repeated failures: ' + reason;
    console.warn('[Flowboard] payload template marked stale —', boqHealth.reason);
  }
  boqSaveTemplate();
}

function boqMarkSuccess() {
  if (boqHealth.failures || boqHealth.stale) {
    boqHealth = { failures: 0, stale: false, reason: null, lastLearnError: boqHealth.lastLearnError };
    boqSaveTemplate();
  }
}

/**
 * A sample arrived from the page monitor. Learn from it only when there is a
 * reason to: nothing stored yet, Google shipped a new frontend build, or the
 * current template has been failing. Adoption is gated on a byte-exact
 * round-trip so a misread sample can never reach Google.
 */
function boqOnSample(sample) {
  let url, body;
  try {
    url = new URL(sample.url, 'https://flow.google.com');
    body = new URLSearchParams(sample.body);
  } catch (e) { return; }

  const rpcId = url.searchParams.get('rpcids');
  const bl = url.searchParams.get('bl');
  const sourcePath = url.searchParams.get('source-path') || '';
  const freq = body.get('f.req');
  if (!rpcId || !freq) return;

  const needs = !boqTemplate
    || boqHealth.stale
    || (bl && boqTemplate.bl && bl !== boqTemplate.bl)
    || rpcId !== boqTemplate.rpcId;
  if (!needs) return;

  let envelope, inner;
  try {
    envelope = JSON.parse(freq);
    inner = JSON.parse(envelope[0][0][1]);
  } catch (e) {
    boqHealth.lastLearnError = 'UNPARSEABLE_SAMPLE';
    boqSaveTemplate();
    return;
  }

  const projectId = (sourcePath.match(/\/project\/([^/?#]+)/) || [])[1] || null;
  const values = boqExtractSampleValues(inner, projectId);
  if (!values.prompt || !values.token || values.seed === null || !projectId) {
    boqHealth.lastLearnError = 'SAMPLE_MISSING_ANCHORS';
    boqSaveTemplate();
    return;
  }

  const learned = boqLearnTemplate({
    rpcId, bl, endpoint: url.pathname, inner, values,
  });
  if (learned.error) {
    boqHealth.lastLearnError = learned.error;
    boqSaveTemplate();
    return;
  }

  const verdict = boqVerifyTemplate(learned.template, { inner, values });
  if (!verdict.ok) {
    // Keep the last known good template rather than adopt one we cannot prove.
    boqHealth.lastLearnError = 'VERIFY_' + verdict.reason;
    boqSaveTemplate();
    console.warn('[Flowboard] refused a new template:', verdict.reason);
    return;
  }

  boqTemplate = learned.template;
  boqHealth = { failures: 0, stale: false, reason: null, lastLearnError: null };
  boqSaveTemplate();
  console.log('[Flowboard] learned a new payload template from the Flow app —',
    'rpc=' + rpcId, 'bl=' + bl, 'refs=' + learned.template.hadInputs);
}

// ─── Identity, read from the Flow page ──────────────────────────────────
//
// The account panel used to be filled from Google's userinfo endpoint, called
// with the Bearer token. That token no longer exists, so the panel went blank
// even though everything else works. The signed-in address is sitting in the
// page's own `WIZ_global_data` under `oPEP7c`, so read it from there instead.
//
// Only the email is available this way — display name, avatar and the
// Pro/Ultra label all came from endpoints that are gone.

let _identityPushed = false;

/** An existing Flow project tab, or null. Deliberately does NOT open one:
 *  spawning a tab to fill in a label would be rude. */
async function boqExistingProjectTab() {
  const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/project/*' });
  return tabs.find((t) => !t.discarded) || tabs[0] || null;
}

async function pushIdentityFromFlowTab(force) {
  if (_identityPushed && !force) return false;
  const tab = await boqExistingProjectTab();
  if (!tab || tab.id == null) return false;
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const W = window.WIZ_global_data || {};
        return typeof W.oPEP7c === 'string' ? W.oPEP7c : null;
      },
    });
    const email = out && out.result;
    if (!email) return false;
    cachedUserInfo = { email, verified_email: true };
    _identityPushed = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
    }
    console.log('[Flowboard] identity read from Flow page for', email);
    return true;
  } catch (e) {
    console.warn('[Flowboard] identity read failed:', (e && e.message) || e);
    return false;
  }
}

// ─── Flow boq bridge (batchexecute) ─────────────────────────
//
// Sep 2026: Google retired the aisandbox-pa REST API this extension was
// built around. The Flow web app now drives everything through its own
// internal boq RPC endpoint, on its own origin:
//
//   POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
//        ?rpcids=ogiZ0b&source-path=/project/<id>&bl=<build>&f.sid=<sid>&rt=c
//   body: f.req=[[["ogiZ0b","<inner json>",null,"generic"]]]&at=<xsrf>
//
// Auth is the Google session cookie plus the `at` XSRF token read from
// `WIZ_global_data`, so the request MUST originate from a flow.google.com
// page — the agent's Python process can never satisfy that. The whole
// exchange therefore runs inside the Flow tab via chrome.scripting in the
// MAIN world, where both `WIZ_global_data` and `grecaptcha` live.
//
// The agent is deliberately left untouched: handleApiRequest spots the old
// `:batchGenerateImages` URL, routes it here, and this shim hands back the
// `{ media: [...] }` shape flow_sdk.extract_media_entries already parses.

const BOQ_ENDPOINT_PATH  = '/_/AiSandboxAngularFrontend/data/batchexecute';
const BOQ_RPC_IMAGE      = 'ogiZ0b';
const BOQ_RPC_UPLOAD     = 'maseQ';
// The upload RPC wants its own single-use captcha token, and the action string
// it expects was not recoverable from the capture (a token is opaque). Try the
// plausible ones in order; the first that yields a media id wins.
const BOQ_UPLOAD_ACTIONS = ['IMAGE_UPLOAD', 'IMAGE_GENERATION'];
const BOQ_RPC_UPSCALE    = 'SPrCad';
const BOQ_UPSCALE_ACTIONS = ['IMAGE_GENERATION', 'IMAGE_UPSCALE'];
const BOQ_SITE_KEY       = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
// "NARWHAL" is the model tag (Nano Banana 2). The integer beside it is a
// per-call SEED, not a model id — two captures of the same model came back
// with different values (859710828 / 2087997909), and both were echoed
// verbatim in the response. Hard-coding it would make every variant of a
// prompt render identically.
const BOQ_IMAGE_MODEL_TAG = 'NARWHAL';
const boqSeed = () => Math.floor(Math.random() * 2147483647);
const BOQ_SURFACE_ID      = 22;
const BOQ_MAX_VARIANTS    = 4;

/**
 * Runs in the Flow page (MAIN world). Solves reCAPTCHA, fires one
 * batchexecute generate, and digs the signed media URL out of the reply.
 * Must stay self-contained — chrome.scripting serialises it across worlds,
 * so it cannot close over anything defined above.
 */
async function boqGenerateInPage(cfg) {
  const W = window.WIZ_global_data || {};
  const at = W.SNlM0e;
  const bl = W.cfb2h;
  const sid = W.FdrFJe;
  const hl = W.EP || 'en';
  if (!at || !bl) return { error: 'WIZ_DATA_MISSING' };
  if (!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute)) {
    return { error: 'GRECAPTCHA_MISSING' };
  }

  const uuid = () => (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      })).toUpperCase();

  let token;
  try {
    token = await window.grecaptcha.enterprise.execute(W.xZbWve || cfg.siteKey, { action: 'IMAGE_GENERATION' });
  } catch (e) {
    return { error: 'CAPTCHA_' + ((e && e.message) || 'FAILED') };
  }
  if (!token) return { error: 'CAPTCHA_EMPTY' };

  // The captcha token rides inside the payload at [..., [token, 1]] — the
  // same array appears twice, once per request item and once at top level.
  const ctx = [null, cfg.surfaceId, null, null, null, cfg.projectId,
               null, null, null, null, [token, 1]];

  // Slot 2 of the request item carries the reference images (i2i). Text-only
  // sends null there; conditioning on existing media sends one entry per
  // image. The trailing 1 is the input's role — the only value observed so
  // far, on a plain reference.
  const inputs = Array.isArray(cfg.mediaInputs) && cfg.mediaInputs.length
    ? cfg.mediaInputs.map((mid) => [mid, null, null, null, 1])
    : null;

  let inner;
  if (cfg.template) {
    // A template learned from the app's own traffic. Clone its skeleton and
    // write our values at the positions that were observed, so a payload
    // Google has reshuffled still comes out right.
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const setAt = (t, p, val) => {
      if (!p || !p.length) return;
      let n = t;
      for (let k = 0; k < p.length - 1; k++) { if (!Array.isArray(n)) return; n = n[p[k]]; }
      if (Array.isArray(n)) n[p[p.length - 1]] = val;
    };
    const P = cfg.template.paths;
    inner = clone(cfg.template.skeleton);
    setAt(inner, P.prompt, cfg.prompt);
    for (const p of P.project) setAt(inner, p, cfg.projectId);
    for (const p of P.token) setAt(inner, p, token);
    setAt(inner, P.seed, cfg.seed);
    for (const p of P.group) setAt(inner, p, cfg.groupId || uuid());
    for (const p of P.uuids) setAt(inner, p, uuid());
    if (P.inputs) {
      const ids = cfg.mediaInputs || [];
      setAt(inner, P.inputs, ids.length
        ? ids.map((id) => { const e = clone(P.inputEntry); e[P.inputIdIndex] = id; return e; })
        : null);
    }
  } else {
    // No template learned yet — the layout captured by hand in Sep 2026.
    inner = [
      null,
      [[null, null, inputs, cfg.seed, 1, cfg.modelTag, null, ctx,
        [[[cfg.prompt]]], null, null, null, uuid(), uuid()]],
      1,
      ctx,
      // Trailing slot is a BATCH id, not a per-request id: the app's own
      // "4 images at once" fires four separate calls that all carry the same
      // value here, differing only by seed. Variants of one dispatch must
      // therefore share it.
      [cfg.groupId || uuid()],
    ];
  }

  const url = cfg.endpoint
    + '?rpcids=' + encodeURIComponent(cfg.rpcId)
    + '&source-path=' + encodeURIComponent('/project/' + cfg.projectId)
    + '&bl=' + encodeURIComponent(bl)
    + '&f.sid=' + encodeURIComponent(sid == null ? '' : sid)
    + '&hl=' + encodeURIComponent(hl)
    + '&_reqid=' + (Math.floor(Math.random() * 900000) + 100000)
    + '&rt=c';

  let res, text;
  try {
    window.__flowboardSelfCall = true;
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        'f.req': JSON.stringify([[[cfg.rpcId, JSON.stringify(inner), null, 'generic']]]),
        at,
      }).toString(),
    });
    text = await res.text();
  } catch (e) {
    return { error: 'FETCH_' + ((e && e.message) || 'FAILED') };
  } finally {
    window.__flowboardSelfCall = false;
  }
  if (!res.ok) return { error: 'HTTP_' + res.status, head: String(text).slice(0, 200) };

  // Envelope is `)]}'` then length-prefixed JSON chunks, and the useful
  // payload is a JSON *string* nested inside one of them. Rather than index
  // into ~8 levels of positional array (Google reshuffles those freely and
  // silently), walk everything and take the first signed media URL. The
  // media id is the uuid in its path.
  const found = (function () {
    // Frames are length-prefixed, but that length is a UTF-8 BYTE count while
    // JS slices by UTF-16 code unit. Any non-ASCII in the payload — a
    // Vietnamese prompt, say — desynchronises the two and every frame then
    // fails to parse, which is exactly how a perfectly good reply turned into
    // BOQ_NO_MEDIA_URL. Match brackets and ignore the prefix.
    const frames = [];
    const b = String(text).replace(/^\)\]\}'\s*/, '');
    let i = 0;
    while (i < b.length) {
      while (i < b.length && b[i] !== '[') i++;
      if (i >= b.length) break;
      let depth = 0, inStr = false, esc = false, j = i;
      for (; j < b.length; j++) {
        const c = b[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) { j++; break; } }
      }
      try { frames.push(JSON.parse(b.slice(i, j))); } catch (e) { /* not a frame */ }
      i = (j > i) ? j : i + 1;
    }
    const hits = [];
    const walk = (node) => {
      if (typeof node === 'string') {
        if (node.indexOf('https://flow-content.google/') === 0) { hits.push(node); return; }
        if (node.length > 2 && (node[0] === '[' || node[0] === '{')) {
          try { walk(JSON.parse(node)); } catch (e) { /* ordinary text */ }
        }
        return;
      }
      if (Array.isArray(node)) for (let k = 0; k < node.length; k++) walk(node[k]);
    };
    walk(frames);
    return hits[0] || null;
  })();

  // Last-ditch: scan the raw text. Costs nothing, and keeps a generation that
  // actually succeeded from being thrown away if the tree walk ever misses.
  let mediaUrl = found;
  if (!mediaUrl) {
    const raw = String(text);
    const at0 = raw.indexOf('https://flow-content.google/');
    if (at0 !== -1) {
      let end = at0;
      while (end < raw.length && raw[end] !== '"') end++;
      mediaUrl = raw.slice(at0, end)
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/');
    }
  }
  if (!mediaUrl) return { error: 'NO_MEDIA_URL', head: String(text).slice(0, 400) };
  const m = mediaUrl.match(/\/image\/([0-9a-fA-F-]{36})/);
  if (!m) return { error: 'NO_MEDIA_ID', head: mediaUrl.slice(0, 200) };
  return { mediaId: m[1], url: mediaUrl };
}

/**
 * Runs in the Flow page (MAIN world). Uploads raw image bytes and returns the
 * media id Flow assigns — an uploaded media id and a generated one are the
 * same kind of handle, so it slots straight into ogiZ0b's reference list.
 * Self-contained: chrome.scripting serialises it across worlds.
 */
async function boqUploadInPage(cfg) {
  const W = window.WIZ_global_data || {};
  const at = W.SNlM0e;
  const bl = W.cfb2h;
  const sid = W.FdrFJe;
  const hl = W.EP || 'en';
  if (!at || !bl) return { error: 'WIZ_DATA_MISSING' };
  if (!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute)) {
    return { error: 'GRECAPTCHA_MISSING' };
  }

  const uuid = () => (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      })).toUpperCase();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let lastError = 'UPLOAD_FAILED';

  for (let a = 0; a < cfg.actions.length; a++) {
    let token;
    try {
      token = await window.grecaptcha.enterprise.execute(W.xZbWve || cfg.siteKey, { action: cfg.actions[a] });
    } catch (e) {
      lastError = 'CAPTCHA_' + ((e && e.message) || 'FAILED');
      continue;
    }
    if (!token) { lastError = 'CAPTCHA_EMPTY'; continue; }

    const ctx = [null, cfg.surfaceId, null, null, null, cfg.projectId,
                 null, null, null, null, [token, 1]];
    // [ctx, <base64 bytes, no data: prefix>, mime, 1, …, fileName, …, uuid, uuid]
    const inner = [ctx, cfg.imageBase64, cfg.mimeType, 1,
                   null, null, null, null, cfg.fileName, null, uuid(), uuid()];

    const url = cfg.endpoint
      + '?rpcids=' + encodeURIComponent(cfg.rpcId)
      + '&source-path=' + encodeURIComponent('/project/' + cfg.projectId)
      + '&bl=' + encodeURIComponent(bl)
      + '&f.sid=' + encodeURIComponent(sid == null ? '' : sid)
      + '&hl=' + encodeURIComponent(hl)
      + '&_reqid=' + (Math.floor(Math.random() * 900000) + 100000)
      + '&rt=c';

    let res, text;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({
          'f.req': JSON.stringify([[[cfg.rpcId, JSON.stringify(inner), null, 'generic']]]),
          at,
        }).toString(),
      });
      text = await res.text();
    } catch (e) {
      lastError = 'FETCH_' + ((e && e.message) || 'FAILED');
      continue;
    }
    if (!res.ok) { lastError = 'HTTP_' + res.status; continue; }

    // Same length-prefixed envelope as ogiZ0b. The new media id is the first
    // uuid in the reply that is not the project id.
    const ids = (function () {
      // Length prefixes are UTF-8 BYTE counts while JS slices by UTF-16 code
      // unit, so anything non-ASCII in the payload desynchronises them and
      // every frame fails to parse. Match brackets, ignore the prefix.
      const frames = [];
      const b = String(text).replace(/^\)\]\}'\s*/, '');
      let i = 0;
      while (i < b.length) {
        while (i < b.length && b[i] !== '[') i++;
        if (i >= b.length) break;
        let depth = 0, inStr = false, esc = false, j = i;
        for (; j < b.length; j++) {
          const c = b[j];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
          } else if (c === '"') inStr = true;
          else if (c === '[') depth++;
          else if (c === ']') { depth--; if (depth === 0) { j++; break; } }
        }
        try { frames.push(JSON.parse(b.slice(i, j))); } catch (e) { /* not a frame */ }
        i = (j > i) ? j : i + 1;
      }
      const hits = [];
      const walk = (n) => {
        if (typeof n === 'string') {
          if (UUID_RE.test(n)) { hits.push(n); return; }
          if (n.length > 2 && (n[0] === '[' || n[0] === '{')) {
            try { walk(JSON.parse(n)); } catch (e) { /* plain text */ }
          }
          return;
        }
        if (Array.isArray(n)) for (let k = 0; k < n.length; k++) walk(n[k]);
      };
      walk(frames);
      return hits;
    })();

    const mediaId = ids.find((x) => x.toLowerCase() !== String(cfg.projectId).toLowerCase());
    if (mediaId) return { mediaId, action: cfg.actions[a] };
    // A 200 with no media is most likely a rejected captcha action — fall
    // through and retry with the next candidate.
    lastError = 'NO_MEDIA_ID';
  }
  return { error: lastError };
}

/**
 * Runs in the Flow page (MAIN world). Upscales an existing media id and
 * returns the result as base64 — SPrCad answers with the bytes inline, not a
 * signed URL, so there is nothing to fetch afterwards and nothing to re-fetch
 * later if the caller drops them.
 * Self-contained: chrome.scripting serialises it across worlds.
 */
async function boqUpscaleInPage(cfg) {
  const W = window.WIZ_global_data || {};
  const at = W.SNlM0e;
  const bl = W.cfb2h;
  const sid = W.FdrFJe;
  const hl = W.EP || 'en';
  if (!at || !bl) return { error: 'WIZ_DATA_MISSING' };
  if (!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute)) {
    return { error: 'GRECAPTCHA_MISSING' };
  }

  let lastError = 'UPSCALE_FAILED';

  for (let a = 0; a < cfg.actions.length; a++) {
    let token;
    try {
      token = await window.grecaptcha.enterprise.execute(W.xZbWve || cfg.siteKey, { action: cfg.actions[a] });
    } catch (e) {
      lastError = 'CAPTCHA_' + ((e && e.message) || 'FAILED');
      continue;
    }
    if (!token) { lastError = 'CAPTCHA_EMPTY'; continue; }

    // Note the shortened context: unlike ogiZ0b and maseQ, the project id slot
    // is null here — upscaling is addressed by media id alone.
    const ctx = [null, cfg.surfaceId, null, null, null, null,
                 null, null, null, null, [token, 1]];
    const inner = [cfg.mediaId, cfg.level, ctx];

    const url = cfg.endpoint
      + '?rpcids=' + encodeURIComponent(cfg.rpcId)
      + '&source-path=' + encodeURIComponent('/project/' + cfg.projectId)
      + '&bl=' + encodeURIComponent(bl)
      + '&f.sid=' + encodeURIComponent(sid == null ? '' : sid)
      + '&hl=' + encodeURIComponent(hl)
      + '&_reqid=' + (Math.floor(Math.random() * 900000) + 100000)
      + '&rt=c';

    let res, text;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({
          'f.req': JSON.stringify([[[cfg.rpcId, JSON.stringify(inner), null, 'generic']]]),
          at,
        }).toString(),
      });
      text = await res.text();
    } catch (e) {
      lastError = 'FETCH_' + ((e && e.message) || 'FAILED');
      continue;
    }
    if (!res.ok) { lastError = 'HTTP_' + res.status; continue; }

    // The payload is dominated by one very long base64 string (~1 MB for 2K),
    // so "longest base64-looking string" identifies it without depending on
    // the positional layout around it.
    const blob = (function () {
      // Length prefixes are UTF-8 BYTE counts while JS slices by UTF-16 code
      // unit, so anything non-ASCII in the payload desynchronises them and
      // every frame fails to parse. Match brackets, ignore the prefix.
      const frames = [];
      const b = String(text).replace(/^\)\]\}'\s*/, '');
      let i = 0;
      while (i < b.length) {
        while (i < b.length && b[i] !== '[') i++;
        if (i >= b.length) break;
        let depth = 0, inStr = false, esc = false, j = i;
        for (; j < b.length; j++) {
          const c = b[j];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
          } else if (c === '"') inStr = true;
          else if (c === '[') depth++;
          else if (c === ']') { depth--; if (depth === 0) { j++; break; } }
        }
        try { frames.push(JSON.parse(b.slice(i, j))); } catch (e) { /* not a frame */ }
        i = (j > i) ? j : i + 1;
      }
      let best = null;
      const walk = (n) => {
        if (typeof n === 'string') {
          if (n.length > 2 && (n[0] === '[' || n[0] === '{')) {
            try { walk(JSON.parse(n)); return; } catch (e) { /* plain text */ }
          }
          if (n.length > 5000 && /^[A-Za-z0-9+/_=-]+$/.test(n)) {
            if (!best || n.length > best.length) best = n;
          }
          return;
        }
        if (Array.isArray(n)) for (let k = 0; k < n.length; k++) walk(n[k]);
      };
      walk(frames);
      return best;
    })();

    if (blob) return { imageBase64: blob, action: cfg.actions[a] };
    lastError = 'NO_IMAGE_BLOB';
  }
  return { error: lastError };
}

/** A tab already sitting on a Flow *project* page — that page is the only
 *  one carrying the AiSandboxAngularFrontend build label. flow.google.com
 *  root and /about are a different boq app and would send a wrong `bl`. */
async function boqFindProjectTab(projectId) {
  const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/project/*' });
  const existing = tabs.find((t) => !t.discarded) || tabs[0] || null;
  if (existing) {
    const live = await reviveTabIfNeeded(existing);
    if (live) return live;
  }
  try {
    return await chrome.tabs.create({
      url: 'https://flow.google.com/project/' + encodeURIComponent(projectId),
      active: false,
    });
  } catch (e) {
    console.error('[Flowboard] could not open a Flow project tab:', e);
    return null;
  }
}

/** Angular + the reCAPTCHA script boot well after document load, so poll
 *  until both are actually reachable instead of guessing a sleep. */
async function boqWaitForApp(tabId, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => !!(window.WIZ_global_data && window.WIZ_global_data.SNlM0e
                    && window.WIZ_global_data.cfb2h
                    && window.grecaptcha && window.grecaptcha.enterprise
                    && window.grecaptcha.enterprise.execute),
      });
      if (out && out.result) return true;
    } catch (e) { /* still navigating — keep waiting */ }
    await sleep(750);
  }
  return false;
}

async function boqRunOne(tabId, projectId, prompt, mediaInputs, groupId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: boqGenerateInPage,
    args: [{
      projectId,
      prompt,
      mediaInputs: mediaInputs || [],
      seed:       boqSeed(),
      groupId:    groupId || null,
      template:   boqTemplate,
      endpoint:   (boqTemplate && boqTemplate.endpoint) || BOQ_ENDPOINT_PATH,
      rpcId:      (boqTemplate && boqTemplate.rpcId) || BOQ_RPC_IMAGE,
      siteKey:    BOQ_SITE_KEY,
      modelTag:   BOQ_IMAGE_MODEL_TAG,
      surfaceId:  BOQ_SURFACE_ID,
    }],
  });
  return (out && out.result) || { error: 'NO_RESULT' };
}

async function boqUploadOne(tabId, projectId, imageBase64, mimeType, fileName) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: boqUploadInPage,
    args: [{
      projectId, imageBase64, mimeType, fileName,
      endpoint:  BOQ_ENDPOINT_PATH,
      rpcId:     BOQ_RPC_UPLOAD,
      siteKey:   BOQ_SITE_KEY,
      surfaceId: BOQ_SURFACE_ID,
      actions:   BOQ_UPLOAD_ACTIONS,
    }],
  });
  return (out && out.result) || { error: 'NO_RESULT' };
}

/** Translation shim for the agent's legacy `/v1/flow/uploadImage` call. */
async function handleUploadImageViaBoq(msg) {
  const { id, params } = msg;
  const { url, body } = params || {};

  setState('running');
  metrics.requestCount++;
  addRequestLog({ id, type: 'API', time: new Date().toISOString(), status: 'processing', url });

  const fail = (status, error) => {
    sendToAgent({ id, status, error });
    metrics.failedCount++;
    metrics.lastError = error;
    chrome.storage.local.set({ metrics });
    updateRequestLog(id, { status: 'failed', error });
    setState('idle');
  };

  const projectId = body && body.clientContext && body.clientContext.projectId;
  const imageBase64 = body && body.imageBytes;
  if (!projectId) return fail(400, 'BOQ_NO_PROJECT_ID');
  if (typeof imageBase64 !== 'string' || !imageBase64) return fail(400, 'BOQ_NO_IMAGE_BYTES');

  const tab = await boqFindProjectTab(projectId);
  if (!tab || tab.id == null) return fail(503, 'BOQ_NO_FLOW_TAB');
  if (!(await boqWaitForApp(tab.id))) return fail(503, 'BOQ_APP_NOT_READY');

  try {
    const r = await boqUploadOne(
      tab.id, projectId, imageBase64,
      (body && body.mimeType) || 'image/png',
      (body && body.fileName) || 'upload.png',
    );
    if (!r || r.error) return fail(502, 'BOQ_UPLOAD_' + ((r && r.error) || 'UNKNOWN'));
    // Shape mirrors the retired REST reply, which flow_sdk reads as
    // `data.media.name`.
    sendToAgent({ id, status: 200, data: { media: { name: r.mediaId } } });
    metrics.successCount++;
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    updateRequestLog(id, { status: 'success', httpStatus: 200 });
    setState('idle');
  } catch (e) {
    fail(500, 'BOQ_UPLOAD_' + ((e && e.message) || 'DISPATCH_FAILED'));
  }
}

/** Translation shim for the agent's legacy `/v1/flow/upsampleImage` call.
 *  The retired REST endpoint also answered with the bytes inline
 *  (`data.encodedImage`), so the agent side needs no change at all. */
async function handleUpsampleImageViaBoq(msg) {
  const { id, params } = msg;
  const { url, body } = params || {};

  setState('running');
  metrics.requestCount++;
  addRequestLog({ id, type: 'API', time: new Date().toISOString(), status: 'processing', url });

  const fail = (status, error) => {
    sendToAgent({ id, status, error });
    metrics.failedCount++;
    metrics.lastError = error;
    chrome.storage.local.set({ metrics });
    updateRequestLog(id, { status: 'failed', error });
    setState('idle');
  };

  const mediaId = body && body.mediaId;
  const projectId = body && body.clientContext && body.clientContext.projectId;
  if (!mediaId) return fail(400, 'BOQ_NO_MEDIA_ID');
  if (!projectId) return fail(400, 'BOQ_NO_PROJECT_ID');

  // 2K was captured as level 1; 4K is the obvious next value but has not been
  // observed, so it is a documented guess rather than a verified mapping.
  const res4k = String((body && body.targetResolution) || '').indexOf('4K') !== -1;
  const level = res4k ? 2 : 1;

  const tab = await boqFindProjectTab(projectId);
  if (!tab || tab.id == null) return fail(503, 'BOQ_NO_FLOW_TAB');
  if (!(await boqWaitForApp(tab.id))) return fail(503, 'BOQ_APP_NOT_READY');

  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: boqUpscaleInPage,
      args: [{
        mediaId, projectId, level,
        endpoint:  BOQ_ENDPOINT_PATH,
        rpcId:     BOQ_RPC_UPSCALE,
        siteKey:   BOQ_SITE_KEY,
        surfaceId: BOQ_SURFACE_ID,
        actions:   BOQ_UPSCALE_ACTIONS,
      }],
    });
    const r = (out && out.result) || { error: 'NO_RESULT' };
    if (r.error) return fail(502, 'BOQ_UPSCALE_' + r.error);
    sendToAgent({ id, status: 200, data: { encodedImage: r.imageBase64 } });
    metrics.successCount++;
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    updateRequestLog(id, { status: 'success', httpStatus: 200 });
    setState('idle');
  } catch (e) {
    fail(500, 'BOQ_UPSCALE_' + ((e && e.message) || 'DISPATCH_FAILED'));
  }
}

/**
 * Translation shim for the agent's legacy `:batchGenerateImages` call.
 * In: the old REST body. Out: the old REST response shape. Everything in
 * between now speaks boq.
 */
async function handleBatchGenerateImagesViaBoq(msg) {
  const { id, params } = msg;
  const { url, body } = params || {};

  setState('running');
  metrics.requestCount++;
  addRequestLog({ id, type: 'GEN_IMG', time: new Date().toISOString(), status: 'processing', url });

  const fail = (status, error) => {
    sendToAgent({ id, status, error });
    metrics.failedCount++;
    metrics.lastError = error;
    chrome.storage.local.set({ metrics });
    updateRequestLog(id, { status: 'failed', error });
    setState('idle');
  };

  const projectId = (String(url).match(/\/projects\/([^/]+)\/flowMedia/) || [])[1];
  if (!projectId) return fail(400, 'BOQ_NO_PROJECT_ID');

  const items = (body && Array.isArray(body.requests)) ? body.requests : [];

  // One job per request item: its prompt plus the media it is conditioned on.
  // `imageInputType` (BASE_IMAGE vs REFERENCE) has no observed counterpart in
  // the boq payload — every captured input ended in the same trailing 1 — so
  // order is preserved and the distinction is dropped for now.
  const jobs = items
    .map((it) => {
      const parts = it && it.structuredPrompt && it.structuredPrompt.parts;
      const prompt = Array.isArray(parts)
        ? parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join(' ')
        : '';
      const inputs = (it && Array.isArray(it.imageInputs) ? it.imageInputs : [])
        .map((inp) => (inp && typeof inp.name === 'string' ? inp.name : null))
        .filter(Boolean);
      return { prompt, inputs };
    })
    .filter((j) => j.prompt)
    .slice(0, BOQ_MAX_VARIANTS);
  if (!jobs.length) return fail(400, 'BOQ_NO_PROMPT');

  const tab = await boqFindProjectTab(projectId);
  if (!tab || tab.id == null) return fail(503, 'BOQ_NO_FLOW_TAB');
  if (!(await boqWaitForApp(tab.id))) return fail(503, 'BOQ_APP_NOT_READY');

  try {
    // One boq call per variant — the app itself sends a single item per
    // request, and each needs its own single-use captcha token.
    // One batch id for the whole dispatch — mirrors how the app groups the
    // variants of a single "x4" press.
    const groupId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).toUpperCase();
    const results = await Promise.all(
      jobs.map((j) => boqRunOne(tab.id, projectId, j.prompt, j.inputs, groupId)),
    );
    const media = [];
    for (const r of results) {
      if (!r || r.error) {
        // `head` is the first slice of whatever Flow actually replied. Without
        // it a bare NO_MEDIA_URL / HTTP_400 is undiagnosable from the node.
        const detail = (r && r.head) ? ' — ' + String(r.head).replace(/\s+/g, ' ').slice(0, 220) : '';
        boqMarkFailure((r && r.error) || 'UNKNOWN');
        return fail(502, 'BOQ_' + ((r && r.error) || 'UNKNOWN') + detail);
      }
      media.push({ name: r.mediaId, image: { generatedImage: { fifeUrl: r.url } } });
    }
    // Shape mirrors the retired REST reply so flow_sdk parses it unchanged.
    sendToAgent({ id, status: 200, data: { media } });
    boqMarkSuccess();
    // Cheap moment to fill the account panel: we already have a live tab.
    pushIdentityFromFlowTab(false);
    metrics.successCount++;
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    updateRequestLog(id, { status: 'success', httpStatus: 200 });
    setState('idle');
  } catch (e) {
    fail(500, 'BOQ_' + ((e && e.message) || 'DISPATCH_FAILED'));
  }
}


// ─── TRPC Request Proxy ─────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  // Tightly scoped to TRPC endpoints — prevents the agent from navigating to
  // arbitrary labs.google paths (e.g. /fx/api/trpc/account.deleteAccount would
  // also match /fx/api/trpc/ but account-level mutations should be gated server
  // side if they're ever needed).
  const TRPC_PREFIXES = [
    'https://labs.google/fx/api/trpc/',
    'https://flow.google.com/fx/api/trpc/',
  ];
  if (!url || !TRPC_PREFIXES.some((p) => url.startsWith(p))) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls are silent — don't add to request log, don't bump metrics

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body:    body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[Flowboard] tRPC request failed:', e);
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── State & Badge ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors  = { idle: '#22c55e', running: '#f5b301', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[newState] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[newState] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

// ─── Popup Message Handlers ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected:       ws?.readyState === WebSocket.OPEN,
      flowKeyPresent:  !!flowKey,
      manualDisconnect,
      tokenAge:        metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount:  metrics.failedCount,
        lastError:    metrics.lastError,
      },
      state,
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    ws?.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'BOQ_SAMPLE') {
    // Raw payload from the page. It still holds the captcha token and the
    // user's prompt; boqOnSample keeps them in memory only and blanks every
    // located value before anything is written to storage.
    try { boqOnSample(msg.sample || {}); } catch (e) {
      console.warn('[Flowboard] sample rejected:', (e && e.message) || e);
    }
    return false;
  }

  if (msg.type === 'BOQ_TEMPLATE_STATUS') {
    reply(boqTemplateStatus());
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({ url: flowUrls }).then(async (tabs) => {
      try {
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          reply({ ok: true, tabId: tabs[0].id });
        } else {
          // User-initiated → focus the new window so they can see it.
          const tab = await openFlowTabResilient(true);
          reply({ ok: true, tabId: tab?.id });
        }
      } catch (e) {
        reply({ error: e.message });
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  return true;
});

console.log('[Flowboard] Extension loaded');
