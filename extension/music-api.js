// Flow Music bridge: runs fetch() with the Supabase Bearer inside a
// www.flowmusic.app tab (world MAIN) for the agent's `music_call` command.
// Loaded into the service worker with importScripts (classic script).
// flowMusicPageCall is serialised into the tab, so it must stay self-contained.
// params: { path, method?, body?, mode?: 'json'|'text'|'base64', timeoutMs? }

async function flowMusicPageCall(params) {
  const readToken = () => {
    const parts = document.cookie.split('; ')
      .filter((c) => /^sb-[^=]*auth-token(\.\d+)?=/.test(c))
      .sort((a, b) => {
        const n = (s) => Number((s.split('=')[0].match(/\.(\d+)$/) || [0, -1])[1]);
        return n(a) - n(b);
      })
      .map((c) => decodeURIComponent(c.slice(c.indexOf('=') + 1)))
      .join('');
    if (!parts) return null;
    try {
      const raw = parts.startsWith('base64-') ? atob(parts.slice(7).replace(/-/g, '+').replace(/_/g, '/')) : parts;
      return JSON.parse(raw).access_token || null;
    } catch (e) { return null; }
  };
  const tok = readToken();
  if (!tok) return { ok: false, error: 'not_logged_in' };
  try {
    const exp = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
    if (exp && exp * 1000 < Date.now() + 30000) return { ok: false, error: 'token_expired' };
  } catch (e) { /* ignore */ }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), params.timeoutMs || 120000);
  try {
    const res = await fetch('/__api' + params.path, {
      method: params.method || 'GET',
      headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      body: params.body == null ? undefined : JSON.stringify(params.body),
      signal: ctl.signal,
    });
    const out = { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '' };
    const mode = params.mode || 'json';
    if (mode === 'base64') {
      const buf = new Uint8Array(await res.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      out.data = btoa(s);
      out.size = buf.length;
    } else {
      const text = await res.text();
      if (mode === 'json') { try { out.data = JSON.parse(text); } catch (e) { out.data = text; } }
      else out.data = text;
    }
    if (!res.ok) out.error = 'http_' + res.status;
    return out;
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

const FM_ORIGIN = 'https://www.flowmusic.app';

async function fmGetTab() {
  const tabs = await chrome.tabs.query({ url: FM_ORIGIN + '/*' });
  if (tabs.length) return tabs[0];
  const tab = await chrome.tabs.create({ url: FM_ORIGIN + '/', active: false, pinned: true });
  await new Promise((resolve) => {
    const onUpd = (id, info) => {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(); }, 20000);
  });
  await new Promise((r) => setTimeout(r, 2500)); // let Supabase load the session
  return tab;
}

async function fmRunInTab(tabId, params) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: flowMusicPageCall,
    args: [params],
  });
  return (res && res.result) || { ok: false, error: 'no_result' };
}

async function flowMusicCall(params) {
  const tab = await fmGetTab();
  let out = await fmRunInTab(tab.id, params);
  if (!out.ok && (out.error === 'token_expired' || out.status === 401)) {
    await chrome.tabs.reload(tab.id);
    await new Promise((r) => setTimeout(r, 4000));
    out = await fmRunInTab(tab.id, params);
  }
  return out;
}

// Handler for the agent's WS command {id, method:'music_call', params}.
async function handleMusicCall(msg, sendToAgent) {
  const { id, params } = msg;
  if (!params || typeof params.path !== 'string' || !params.path.startsWith('/')) {
    sendToAgent({ id, error: 'INVALID_MUSIC_PATH' });
    return;
  }
  try {
    const out = await flowMusicCall(params);
    sendToAgent({ id, status: out.ok ? 200 : (out.status || 502), data: out });
  } catch (e) {
    sendToAgent({ id, error: 'MUSIC_CALL_' + ((e && e.message) || 'FAILED') });
  }
}
