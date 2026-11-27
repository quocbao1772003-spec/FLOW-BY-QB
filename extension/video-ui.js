// Flow Video qua tab Flow (ext 0.2.4): drives the real Flow UI for the agent's
// `video_ui_call` command. Loaded into the service worker with importScripts
// (needs cdp-input.js first). Every click that Flow Agent / Polymer cares about
// is a REAL mouse event through chrome.debugger (FB_CDP.clickAt); a DOM .click()
// makes the Flow Agent cancel its own "Approve credits" request.
//
// Selectors / regex live in VU_DEFAULT and are overridden by params.selectors
// (the server sends GET /api/video-ui/selectors content with every call).
// vuPage is serialised into the tab (world MAIN) and must stay self-contained.
//
// 8 steps: open_tab, manual_mode, upload, ingredient (frames), submit, approve,
// generating, download. Manual Mode = Flow Agent toggle off, so normally no
// "Approve credits" button appears (approve step is then skipped after 5 s).

const VU_DEFAULT = {
  prompt_box: 'div.ProseMirror[aria-label="What do you want to create?"]',
  start_button: 'button[aria-label="Start generation"]',
  add_ingredients: 'button[aria-label="Add ingredients to the prompt box"]',
  upload_media: 'button[aria-label="Upload media"]',
  add_media_menu: 'button[aria-label="Add media menu"]',
  settings_button: 'button[aria-label="Settings"]',
  settings_trigger: 'button[aria-label="Settings trigger"]',
  asset_list: '[aria-label="Asset list"]',
  asset_item: '.asset-item',
  add_to_prompt_text: '^Add to prompt$',
  download_button: 'button[aria-label="Download"]',
  more_options: 'button[aria-label="More options"]',
  file_input: 'input[type="file"]',
  menu_sel: 'button,[role=button],[role=option],[role=menuitem],[role=menuitemradio],[role=radio],[role=tab],[role=switch],li',
  approve_text: '^Approve( \\d+)? credits?',
  always_approve_text: 'Always approve in project',
  silent_toggle_text: 'Return silent videos',
  no_credits_text: 'not enough credits|insufficient',
  rejected_text: "couldn.t generate|violat|policy",
  credits_text: '([\\d,]+)\\s*credits?',
  cost_text: 'Generating will use (\\d+) credits?',
  flow_agent_text: 'Flow Agent',
  mode_video_text: '^Video$',
  video_type_frames_text: '^Frames$',
  video_type_ingredients_text: '^Ingredients$',
  aspect_text: { '16:9': '^16:9$|Landscape', '9:16': '^9:16$|Portrait' },
  model_text: {
    veo_lite: 'Veo 3\\.1 - Lite(?! \\[)',
    veo_lite_lowprio: 'Veo 3\\.1 - Lite \\[Lower Priority\\]',
    omni_flash: 'Omni 1\\.2 Flash',
    veo_fast: 'Veo 3\\.1 - Fast',
    veo_quality: 'Veo 3\\.1 - Quality',
  },
  model_scan_text: 'Veo 3\\.1 - [A-Za-z]+(?: \\[[^\\]]+\\])?|Omni [\\d.]+ Flash',
  leaving_text: 'Leaving[^\\n]*',
  resolution_text: '^{res}$',
  duration_text: '^{n}s?$',
  count_text: '^x?1$',
  start_frame_text: '^Start$',
  download_menu_text: '^Download$',
  download_1080: '1080p Upscaled',
  download_720: '720p Original',
  approve_timeout_s: 5,
  generate_timeout_s: 480,
};

const VU_STEPS = ['open_tab', 'manual_mode', 'upload', 'ingredient', 'submit', 'approve', 'generating', 'download'];
const vuSilentDone = new Set(); // tabIds whose "Return silent videos" was verified
const vuCancelled = new Set(); // call ids

class VuError extends Error {
  constructor(code, detail) {
    super(code + (detail ? ': ' + detail : ''));
    this.code = code;
    this.detail = detail || '';
  }
}

const vuSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── in-tab helper (self-contained) ────────────────────────────────────────
function vuPage(op, a) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const txt = (el) => ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
  const find = (sel, text, nth) => {
    const re = text ? new RegExp(text, 'i') : null;
    let list = Array.from(document.querySelectorAll(sel || 'button,[role=button],[role=option],[role=switch],[role=checkbox],[role=menuitem],a'));
    list = list.filter((el) => vis(el) && (!re || re.test((el.innerText || '').trim()) || re.test(el.getAttribute('aria-label') || '')));
    return list[nth || 0] || null;
  };
  const rectOf = (el) => {
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return {
      found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      text: txt(el).slice(0, 120),
      on: el.getAttribute('aria-checked') === 'true' || el.checked === true || el.getAttribute('aria-pressed') === 'true',
    };
  };
  if (op === 'identity') {
    const W = window.WIZ_global_data || {};
    return { email: typeof W.oPEP7c === 'string' ? W.oPEP7c.toLowerCase() : null, hasPrompt: !!document.querySelector(a.prompt_box) };
  }
  if (op === 'rect') return rectOf(find(a.sel, a.text, a.nth));
  if (op === 'pressed') {
    const el = find(a.sel, a.text, 0);
    if (!el) return { found: false };
    const v = el.getAttribute('aria-pressed');
    return { found: true, pressed: v === 'true' ? true : v === 'false' ? false : null };
  }
  if (op === 'count') return document.querySelectorAll(a.sel).length;
  if (op === 'match') {
    const m = new RegExp(a.text, 'i').exec(document.body.innerText || '');
    return m ? { found: true, text: m[0], g1: m[1] || null } : { found: false };
  }
  if (op === 'scanmodels') {
    const lines = (document.body.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const re = new RegExp(a.scan, 'i');
    const lv = new RegExp(a.leaving, 'i');
    const models = [];
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const near = [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join(' ');
      const l = lv.exec(near);
      if (!models.some((x) => x.label === m[0])) models.push({ label: m[0], leaving: l ? l[0] : null });
    }
    return { models };
  }
  if (op === 'focus') {
    const el = document.querySelector(a.sel);
    if (!el) return { found: false };
    el.focus();
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    return { found: true, text: (el.innerText || '').trim().slice(0, 40) };
  }
  if (op === 'assets') {
    const items = Array.from(document.querySelectorAll(a.sel)).filter(vis);
    return items.map((el) => (el.innerText || '').trim().slice(0, 80));
  }
  if (op === 'videos') {
    return Array.from(document.querySelectorAll('video')).map((v) => v.currentSrc || v.src || '').filter(Boolean);
  }
  if (op === 'hookfile') {
    // a programmatic click on a file input would open the OS chooser; capture the input instead.
    if (!window.__fbHooked) {
      window.__fbHooked = true;
      const orig = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') { window.__fbInput = this; return; }
        return orig.apply(this, arguments);
      };
    }
    window.__fbInput = null;
    return true;
  }
  if (op === 'setfile') {
    const bin = atob(a.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], a.name, { type: a.mime || 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    let input = window.__fbInput || document.querySelector(a.inputSel);
    if (!input) return { found: false };
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true };
  }
  if (op === 'snapshot') {
    const buttons = Array.from(document.querySelectorAll('button,[role=button],[role=option],[role=switch],input,[contenteditable=true]'))
      .filter(vis).slice(0, 200).map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), aria: el.getAttribute('aria-label'), text: (el.innerText || '').trim().slice(0, 60),
          cls: String(el.className || '').slice(0, 60), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
      });
    return { url: location.href, title: document.title, buttons, visibility: document.visibilityState };
  }
  if (op === 'fetchb') {
    return fetch(a.url, { credentials: 'include' }).then(async (res) => {
      if (!res.ok) return { ok: false, status: res.status };
      const blob = await res.blob();
      window.__fbVid = blob;
      return { ok: true, size: blob.size, type: blob.type };
    }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  }
  if (op === 'slice') {
    const blob = window.__fbVid;
    if (!blob) return { ok: false };
    const part = blob.slice(a.start, Math.min(blob.size, a.start + a.len));
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve({ ok: true, b64: String(fr.result).split(',')[1] || '', n: part.size });
      fr.onerror = () => resolve({ ok: false });
      fr.readAsDataURL(part);
    });
  }
  if (op === 'release') { window.__fbVid = null; return true; }
  return null;
}

async function vuDo(tabId, op, a) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: vuPage, args: [op, a || {}] });
  return res ? res.result : null;
}

function vuCfg(params) {
  return Object.assign({}, VU_DEFAULT, (params && params.selectors) || {});
}

// ── tab handling ──────────────────────────────────────────────────────────
async function vuFindTab(cfg, account) {
  const tabs = (await chrome.tabs.query({ url: 'https://flow.google.com/*' }))
    .filter((t) => { try { return new URL(t.url).pathname.includes('/project/'); } catch (e) { return false; } });
  const live = tabs.filter((t) => !t.discarded);
  for (const t of (live.length ? live : tabs)) {
    let ident = null;
    try { ident = await vuDo(t.id, 'identity', { prompt_box: cfg.prompt_box }); } catch (e) { /* tab not ready */ }
    if (!ident) continue;
    if (!account || !ident.email || ident.email === String(account).toLowerCase()) return t;
  }
  return null;
}

async function vuOpenTab(cfg, params) {
  let tab = await vuFindTab(cfg, params.account);
  if (!tab) {
    const created = await chrome.tabs.create({ url: 'https://flow.google.com/', active: false });
    tab = created;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      await vuSleep(1500);
      const cur = await chrome.tabs.get(created.id).catch(() => null);
      if (!cur) break;
      tab = cur;
      let ident = null;
      try { ident = await vuDo(cur.id, 'identity', { prompt_box: cfg.prompt_box }); } catch (e) { /* loading */ }
      if (ident && ident.hasPrompt) break;
    }
  }
  if (!tab || tab.id == null) throw new VuError('UI_NOT_FOUND', 'không có tab project Flow');
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

async function vuRaise(tab) {
  // bring the Flow window + tab to the front for the UI phase; return a restore fn.
  let prev = null;
  try {
    const act = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    prev = { tabId: act[0] && act[0].id };
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* best effort */ }
  return async () => {
    try {
      if (prev && prev.tabId != null && prev.tabId !== tab.id) await chrome.tabs.update(prev.tabId, { active: true });
    } catch (e) { /* tab gone */ }
  };
}

// ── primitives ────────────────────────────────────────────────────────────
function vuCheck(call) {
  if (vuCancelled.has(call)) throw new VuError('canceled', 'cancelled');
}

async function vuRect(tabId, a) { return vuDo(tabId, 'rect', a); }

async function vuWaitRect(tabId, a, timeoutMs, call, what) {
  const t0 = Date.now();
  for (;;) {
    vuCheck(call);
    const r = await vuRect(tabId, a);
    if (r && r.found && !r.disabled) return r;
    if (Date.now() - t0 > timeoutMs) throw new VuError('UI_NOT_FOUND', what + ' (' + JSON.stringify(a) + ')');
    await vuSleep(400);
  }
}

// real mouse click on the first visible match
async function vuClick(tabId, a, call, what, timeoutMs) {
  const r = await vuWaitRect(tabId, a, timeoutMs || 10000, call, what);
  await FB_CDP.clickAt(tabId, r.x, r.y);
  await vuSleep(300);
  return r;
}

async function vuCheckErrors(tabId, cfg) {
  const nc = await vuDo(tabId, 'match', { text: cfg.no_credits_text });
  if (nc && nc.found) throw new VuError('NO_CREDITS', nc.text);
  const rj = await vuDo(tabId, 'match', { text: cfg.rejected_text });
  if (rj && rj.found) throw new VuError('FLOW_REJECTED', rj.text);
}

async function vuEnsureSilent(tabId, cfg, call) {
  if (vuSilentDone.has(tabId)) return true;
  await vuClick(tabId, { sel: cfg.settings_button }, call, 'nút Settings');
  await vuSleep(600);
  const row = await vuRect(tabId, { text: cfg.silent_toggle_text });
  if (!row || !row.found) {
    await FB_CDP.pressKey(tabId, 'Escape');
    throw new VuError('UI_NOT_FOUND', 'không thấy "Return silent videos" trong Settings');
  }
  const sw = await vuRect(tabId, { sel: '[role=switch],[role=checkbox],input[type=checkbox]', nth: 0 });
  const target = sw && sw.found ? sw : row;
  if (!target.on) {
    await FB_CDP.clickAt(tabId, target.x, target.y);
    await vuSleep(500);
  }
  await FB_CDP.pressKey(tabId, 'Escape');
  await vuSleep(300);
  vuSilentDone.add(tabId);
  return true;
}

function vuB64Mime(name) {
  return /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png';
}

async function vuImageB64(image) {
  if (image.b64) return image.b64;
  if (image.url) {
    const res = await fetch(image.url);
    if (!res.ok) throw new VuError('UI_NOT_FOUND', 'tải ảnh nguồn lỗi ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  throw new VuError('UI_NOT_FOUND', 'không có ảnh nguồn');
}

// ── manual mode + Settings popover + cost ─────────────────────────────────
async function vuManualMode(tabId, cfg) {
  const a = { sel: cfg.menu_sel, text: cfg.flow_agent_text };
  const r = await vuRect(tabId, a);
  if (!r || !r.found) return 'absent'; // no agent toggle in this Flow build
  const st = await vuDo(tabId, 'pressed', a);
  if (st && st.pressed === true) {
    await FB_CDP.clickAt(tabId, r.x, r.y);
    await vuSleep(500);
    const after = await vuDo(tabId, 'pressed', a);
    if (after && after.pressed === true) throw new VuError('UI_NOT_FOUND', 'không tắt được Flow Agent (Manual Mode)');
    return 'turned_off';
  }
  return 'already';
}

async function vuMenuClick(tabId, cfg, text, call, what, optional) {
  try {
    return await vuClick(tabId, { sel: cfg.menu_sel, text }, call, what, optional ? 2500 : 8000);
  } catch (e) {
    if (optional && e && e.code === 'UI_NOT_FOUND') return null;
    throw e;
  }
}

async function vuOpenSettings(tabId, cfg, call) {
  await vuClick(tabId, { sel: cfg.settings_trigger }, call, 'Settings trigger');
  await vuSleep(600);
}

async function vuCloseSettings(tabId) {
  await FB_CDP.pressKey(tabId, 'Escape').catch(() => {});
  await vuSleep(300);
}

// Settings trigger popover: Mode=Video -> Video type -> aspect -> model -> resolution/duration -> x1
async function vuConfigure(tabId, cfg, params, call, hasRefs) {
  await vuOpenSettings(tabId, cfg, call);
  await vuMenuClick(tabId, cfg, cfg.mode_video_text, call, 'Mode Video', true);
  await vuMenuClick(tabId, cfg, hasRefs ? cfg.video_type_ingredients_text : cfg.video_type_frames_text, call, 'Video type');
  const asp = (cfg.aspect_text || {})[params.aspect || '16:9'];
  if (asp) await vuMenuClick(tabId, cfg, asp, call, 'tỉ lệ ' + params.aspect, true);
  const mt = (cfg.model_text || {})[params.model || 'veo_lite'];
  if (mt) await vuMenuClick(tabId, cfg, mt, call, 'model ' + params.model);
  if (params.resolution) {
    await vuMenuClick(tabId, cfg, String(cfg.resolution_text).replace('{res}', params.resolution), call, 'độ phân giải', true);
  }
  if (params.model === 'omni_flash' && params.duration_s) {
    await vuMenuClick(tabId, cfg, String(cfg.duration_text).replace('{n}', String(params.duration_s)), call, 'thời lượng', true);
  }
  await vuMenuClick(tabId, cfg, cfg.count_text, call, 'số lượng x1', true);
  await vuSleep(400);
}

async function vuReadCost(tabId, cfg) {
  const m = await vuDo(tabId, 'match', { text: cfg.cost_text });
  return m && m.found && m.g1 != null ? Number(String(m.g1).replace(/,/g, '')) : null;
}

// ── steps ─────────────────────────────────────────────────────────────────
async function vuUploadFile(tabId, cfg, image, trigger) {
  const name = image.name || 'frame.png';
  const b64 = await vuImageB64(image);
  await vuDo(tabId, 'hookfile', {});
  await trigger();
  await vuSleep(500);
  const r = await vuDo(tabId, 'setfile', { b64, name, mime: vuB64Mime(name), inputSel: cfg.file_input });
  if (!r || !r.found) throw new VuError('UI_NOT_FOUND', 'không thấy ô tải file');
  await vuSleep(2500);
}

// Frames mode: put the keyframe into the "Start" slot (its own file chooser).
async function vuUpload(tabId, cfg, image, call) {
  await vuUploadFile(tabId, cfg, image, async () => {
    const start = await vuWaitRect(tabId, { sel: cfg.menu_sel + ',div,span', text: cfg.start_frame_text }, 8000, call, 'khung Start');
    await FB_CDP.clickAt(tabId, start.x, start.y);
    await vuSleep(500);
    const up = await vuRect(tabId, { sel: cfg.upload_media });
    if (up && up.found) await FB_CDP.clickAt(tabId, up.x, up.y);
  });
}

// Ingredients mode (request has ref_images): upload each file via Add media menu.
async function vuUploadRefs(tabId, cfg, refs, call) {
  for (const img of refs) {
    await vuUploadFile(tabId, cfg, img, async () => {
      await vuClick(tabId, { sel: cfg.add_media_menu }, call, 'menu Add media');
      const up = await vuRect(tabId, { sel: cfg.upload_media });
      if (up && up.found) await FB_CDP.clickAt(tabId, up.x, up.y);
    });
  }
}

async function vuIngredient(tabId, cfg, image, call) {
  const name = image.name || 'frame.png';
  const bare = name.replace(/\.[A-Za-z0-9]+$/, '');
  await vuClick(tabId, { sel: cfg.add_ingredients }, call, 'nút Add ingredients');
  const t0 = Date.now();
  let idx = -1;
  while (Date.now() - t0 < 60000) {
    vuCheck(call);
    const items = await vuDo(tabId, 'assets', { sel: cfg.asset_item });
    idx = (items || []).findIndex((t) => t.startsWith(name) || t.startsWith(bare));
    if (idx >= 0) break;
    await vuSleep(1500);
  }
  if (idx < 0) throw new VuError('UI_NOT_FOUND', 'ảnh ' + name + ' chưa có trong Asset list');
  await vuClick(tabId, { sel: cfg.asset_item, nth: idx }, call, 'asset ' + name);
  await vuClick(tabId, { text: cfg.add_to_prompt_text }, call, 'nút Add to prompt');
}

async function vuSubmit(tabId, cfg, prompt, call, maxCredits, costRef) {
  const box = await vuWaitRect(tabId, { sel: cfg.prompt_box }, 10000, call, 'ô prompt');
  await FB_CDP.clickAt(tabId, box.x, box.y);
  await vuDo(tabId, 'focus', { sel: cfg.prompt_box });
  await FB_CDP.typeText(tabId, prompt);
  await vuSleep(400);
  let cost = await vuReadCost(tabId, cfg);
  if (cost == null) { // the cost line lives in the Settings popover
    await vuOpenSettings(tabId, cfg, call);
    cost = await vuReadCost(tabId, cfg);
    await vuCloseSettings(tabId);
  }
  costRef.cost = cost;
  if (maxCredits != null && cost != null && cost > maxCredits) {
    throw new VuError('OVER_BUDGET', cost + ' > ' + maxCredits);
  }
  await vuClick(tabId, { sel: cfg.start_button }, call, 'nút Start generation', 15000);
}

async function vuApprove(tabId, cfg, call) {
  const t0 = Date.now();
  const limit = (cfg.approve_timeout_s || 5) * 1000;
  while (Date.now() - t0 < limit) {
    vuCheck(call);
    await vuCheckErrors(tabId, cfg);
    const r = await vuRect(tabId, { text: cfg.approve_text });
    if (r && r.found && !r.disabled) {
      await FB_CDP.clickAt(tabId, r.x, r.y); // real mouse: DOM click makes Flow Agent cancel
      return 'approved';
    }
    await vuSleep(1000);
  }
  return 'skipped'; // Manual Mode / "Always approve in project": Flow did not ask
}

async function vuWaitGenerated(tabId, cfg, before, call) {
  const t0 = Date.now();
  const limit = (cfg.generate_timeout_s || 480) * 1000;
  while (Date.now() - t0 < limit) {
    vuCheck(call);
    await vuCheckErrors(tabId, cfg);
    const vids = await vuDo(tabId, 'videos', {});
    const fresh = (vids || []).filter((u) => !before.videos.includes(u));
    const dl = await vuDo(tabId, 'count', { sel: cfg.download_button });
    if (fresh.length && dl > before.downloads) return fresh[0];
    await vuSleep(4000);
  }
  throw new VuError('TIMEOUT', 'Flow chưa tạo xong video');
}

function vuWatchDownload() {
  let resolveFn;
  const p = new Promise((r) => { resolveFn = r; });
  const startedAt = Date.now();
  const onCreated = (item) => {
    if (new Date(item.startTime || Date.now()).getTime() < startedAt - 2000) return;
    resolveFn(item);
  };
  chrome.downloads.onCreated.addListener(onCreated);
  return {
    wait: (ms) => Promise.race([p, vuSleep(ms).then(() => null)]),
    stop: () => chrome.downloads.onCreated.removeListener(onCreated),
  };
}

async function vuDownload(tabId, cfg, freshSrc, call, send, chunkBytes, quality) {
  const watch = vuWatchDownload();
  let url = null;
  try {
    // tile "More options" -> "Download" -> quality submenu (0 credit), real mouse.
    let used = false;
    try {
      await vuClick(tabId, { sel: cfg.more_options, nth: 0 }, call, 'More options', 6000);
      await vuClick(tabId, { sel: cfg.menu_sel, text: cfg.download_menu_text }, call, 'menu Download', 4000);
      const order = quality === '720p' ? [cfg.download_720] : [cfg.download_1080, cfg.download_720];
      for (const t of order) {
        const r = await vuRect(tabId, { sel: cfg.menu_sel, text: t });
        if (r && r.found) { await FB_CDP.clickAt(tabId, r.x, r.y); used = true; break; }
      }
      if (!used) await FB_CDP.pressKey(tabId, 'Escape').catch(() => {});
    } catch (e) {
      if (e && e.code === 'canceled') throw e;
      await FB_CDP.pressKey(tabId, 'Escape').catch(() => {});
    }
    if (!used) await vuClick(tabId, { sel: cfg.download_button, nth: 0 }, call, 'nút Download');
    const item = await watch.wait(used ? 20000 : 8000);
    if (item) {
      url = item.finalUrl || item.url || null;
      try { await chrome.downloads.cancel(item.id); } catch (e) { /* done already */ }
      try { await chrome.downloads.erase({ id: item.id }); } catch (e) { /* ignore */ }
    }
  } finally {
    watch.stop();
  }
  if (!url || !/^https?:/.test(url)) url = freshSrc;
  if (!url) throw new VuError('DOWNLOAD_FAILED', 'không lấy được URL video');
  let meta = await vuDo(tabId, 'fetchb', { url });
  if ((!meta || !meta.ok) && freshSrc && url !== freshSrc) meta = await vuDo(tabId, 'fetchb', { url: freshSrc });
  if (!meta || !meta.ok) throw new VuError('DOWNLOAD_FAILED', JSON.stringify(meta || {}));
  const size = meta.size;
  let seq = 0;
  for (let start = 0; start < size || seq === 0; start += chunkBytes) {
    vuCheck(call);
    const sl = await vuDo(tabId, 'slice', { start, len: chunkBytes });
    if (!sl || !sl.ok) throw new VuError('DOWNLOAD_FAILED', 'đọc mảnh ' + seq + ' lỗi');
    send({ type: 'video_ui_chunk', call, seq, last: start + chunkBytes >= size, b64: sl.b64 });
    seq += 1;
    if (start + chunkBytes >= size) break;
  }
  await vuDo(tabId, 'release', {});
  return size;
}

// ── probe + job ───────────────────────────────────────────────────────────
async function vuProbe(params) {
  const cfg = vuCfg(params);
  const tab = await vuFindTab(cfg, params.account);
  if (!tab) return { ok: true, tab_open: false };
  const snap = await vuDo(tab.id, 'snapshot', {});
  const ident = await vuDo(tab.id, 'identity', { prompt_box: cfg.prompt_box });
  const aa = await vuDo(tab.id, 'match', { text: cfg.always_approve_text });
  const cr = await vuDo(tab.id, 'match', { text: cfg.credits_text });
  let models = [];
  let cost = null;
  try {
    await FB_CDP.attach(tab.id);
    try {
      await vuOpenSettings(tab.id, cfg, 'probe');
      const scan = await vuDo(tab.id, 'scanmodels', { scan: cfg.model_scan_text, leaving: cfg.leaving_text });
      models = (scan && scan.models) || [];
      cost = await vuReadCost(tab.id, cfg);
      await vuCloseSettings(tab.id);
    } finally {
      await FB_CDP.detach(tab.id);
    }
  } catch (e) { /* popover not reachable: still return the snapshot */ }
  return {
    ok: true, tab_open: true, tab_id: tab.id, email: ident && ident.email, has_prompt_box: !!(ident && ident.hasPrompt),
    models, cost_line: cost,
    silent_on: vuSilentDone.has(tab.id) ? true : null, always_approve: !!(aa && aa.found),
    credits: cr && cr.found && cr.g1 ? Number(String(cr.g1).replace(/,/g, '')) : null, snapshot: snap,
  };
}

async function vuRunJob(params, send) {
  const cfg = vuCfg(params);
  const call = params.call;
  const report = (step, ok) => send({ type: 'video_ui_progress', call, step, ok: ok !== false });
  const image = params.image || {};
  const refs = Array.isArray(params.ref_images) && params.ref_images.length ? params.ref_images : null;
  const costRef = { cost: null };
  const t = await vuOpenTab(cfg, params);
  const tabId = t.id;
  const restore = await vuRaise(t);
  try {
    try { await FB_CDP.attach(tabId); } catch (e) {
      throw new VuError('DEBUGGER_BUSY', String((e && e.message) || e));
    }
    report('open_tab');
    await vuManualMode(tabId, cfg);
    report('manual_mode');
    if (params.silent !== false) await vuEnsureSilent(tabId, cfg, call);
    await vuConfigure(tabId, cfg, params, call, !!refs);
    await vuCloseSettings(tabId);
    const before = {
      videos: (await vuDo(tabId, 'videos', {})) || [],
      downloads: (await vuDo(tabId, 'count', { sel: cfg.download_button })) || 0,
    };
    if (refs) await vuUploadRefs(tabId, cfg, refs, call); else await vuUpload(tabId, cfg, image, call);
    report('upload');
    if (refs) for (const img of refs) await vuIngredient(tabId, cfg, img, call);
    report('ingredient');
    await vuSubmit(tabId, cfg, params.prompt, call, params.max_credits, costRef);
    report('submit');
    await vuApprove(tabId, cfg, call);
    report('approve');
    const src = await vuWaitGenerated(tabId, cfg, before, call);
    report('generating');
    const size = await vuDownload(tabId, cfg, src, call, send, params.chunk_bytes || 8 * 1024 * 1024, params.download_quality);
    report('download');
    const cr = await vuDo(tabId, 'match', { text: cfg.credits_text });
    return {
      ok: true, size, cost: costRef.cost, silent_on: vuSilentDone.has(tabId),
      credits_after: cr && cr.found && cr.g1 ? Number(String(cr.g1).replace(/,/g, '')) : null,
    };
  } finally {
    await FB_CDP.detach(tabId);
    await restore();
    vuCancelled.delete(call);
  }
}

function vuErr(e) {
  if (e instanceof VuError) return { ok: false, code: e.code, detail: e.detail };
  const msg = String((e && e.message) || e);
  if (/already attached|another debugger/i.test(msg)) return { ok: false, code: 'DEBUGGER_BUSY', detail: msg };
  return { ok: false, code: 'UI_NOT_FOUND', detail: msg };
}

// Handler for the agent's WS command {id, method:'video_ui_call', params}.
async function handleVideoUiCall(msg, sendToAgent) {
  const { id, params } = msg;
  if (!params || typeof params !== 'object') {
    sendToAgent({ id, error: 'VIDEO_UI_CALL_BAD_PARAMS' });
    return;
  }
  try {
    if (params.cancel) {
      vuCancelled.add(params.cancel);
      sendToAgent({ id, status: 200, data: { ok: true } });
      return;
    }
    const out = params.probe ? await vuProbe(params) : await vuRunJob(params, sendToAgent);
    sendToAgent({ id, status: 200, data: out });
  } catch (e) {
    sendToAgent({ id, status: 200, data: vuErr(e) });
  }
}
