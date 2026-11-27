const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MP4 = Buffer.from('0000001866747970' + 'ab'.repeat(40), 'hex');

// Fake Flow tab: vuPage is replaced by a state machine so no DOM is needed.
function makeEnv(opts = {}) {
  const log = []; // ordered events
  const sent = [];
  const st = {
    agentPressed: opts.agentPressed !== false,
    cost: opts.cost === undefined ? 20 : opts.cost,
    approveButton: !!opts.approveButton,
    videos: [],
    generated: false,
  };
  const clicks = [];
  const FB_CDP = {
    attach: async (t) => { if (opts.busy) throw new Error('Another debugger is already attached'); log.push('attach'); },
    detach: async () => { log.push('detach'); },
    clickAt: async (t, x, y) => { clicks.push([x, y]); log.push('click@' + x + ',' + y); if (x === 10 && y === 10) st.agentPressed = false; },
    typeText: async (t, text) => { log.push('type:' + text); },
    pressKey: async (t, k) => { log.push('key:' + k); },
  };
  const RECTS = {
    'Flow Agent': [10, 10], 'Settings trigger': [20, 20], '^Video$': [30, 30], '^Frames$': [31, 31],
    '^Ingredients$': [32, 32], '16:9': [33, 33], 'Veo 3\\.1 - Lite(?! \\[)': [34, 34],
    '^x?1$': [35, 35], '^Start$': [36, 36], 'Upload media': [37, 37], 'Start generation': [38, 38],
    'Approve': [39, 39], 'More options': [40, 40], '^Download$': [41, 41], '1080p Upscaled': [42, 42],
    'ProseMirror': [45, 45], 'Settings': [43, 43], 'Return silent': [44, 44],
  };
  const rectFor = (a) => {
    const key = Object.keys(RECTS).find((k) => (a.text && a.text.includes(k)) || (a.sel && a.sel.includes(k)));
    if (a.text && /Approve/.test(a.text) && !st.approveButton) return { found: false };
    return key ? { found: true, x: RECTS[key][0], y: RECTS[key][1], disabled: false, on: false } : { found: false };
  };
  const vuPage = (op, a) => {
    log.push('op:' + op);
    switch (op) {
      case 'identity': return { email: 'a@x.com', hasPrompt: true };
      case 'rect': return rectFor(a);
      case 'pressed': return { found: true, pressed: st.agentPressed };
      case 'count': return st.generated ? 1 : 0;
      case 'match':
        if (/Generating will use/.test(a.text)) return st.cost == null ? { found: false } : { found: true, g1: String(st.cost) };
        if (/credits\?/.test(a.text) && !/Approve/.test(a.text)) return { found: true, g1: '960' };
        return { found: false };
      case 'scanmodels': return { models: [{ label: 'Veo 3.1 - Fast', leaving: 'Leaving Dec 5' }] };
      case 'videos': return st.generated ? ['https://flow.google.com/asb/new'] : [];
      case 'setfile': return { found: true };
      case 'hookfile': return true;
      case 'focus': return { found: true };
      case 'fetchb': return { ok: true, size: MP4.length };
      case 'slice': return { ok: true, b64: MP4.subarray(a.start, a.start + a.len).toString('base64') };
      case 'snapshot': return { buttons: [] };
      default: return true;
    }
  };
  const listeners = [];
  const chrome = {
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: 'https://flow.google.com/u/1/project/abc', active: false }],
      update: async () => ({}), get: async () => ({ id: 7 }), create: async () => ({ id: 8 }),
    },
    windows: { update: async () => ({}) },
    scripting: { executeScript: async ({ args }) => {
      const [op, a] = args;
      if (op === 'videos' || op === 'count') { /* generation finishes once Start was clicked */ }
      if (log.includes('click@38,38')) st.generated = true;
      return [{ result: vuPage(op, a) }];
    } },
    downloads: {
      onCreated: { addListener: (f) => { listeners.push(f); setTimeout(() => f({ id: 5, url: 'https://flow.google.com/asb/new.mp4', startTime: new Date().toISOString() }), 5); }, removeListener: () => {} },
      cancel: async () => {}, erase: async () => {},
    },
  };
  const ctx = vm.createContext({ chrome, FB_CDP, console, setTimeout, Promise, Date, Math, JSON, Array, Object, String, Number, RegExp, Set, Error, fetch: async () => ({}), URL });
  let src = read('video-ui.js');
  src = src.replace(/function vuPage\([\s\S]*?\n}\n\nasync function vuDo/, 'async function vuDo');
  src = src.replace('chrome.scripting.executeScript({ target: { tabId }, world: \'MAIN\', func: vuPage, args: [op, a || {}] })', 'chrome.scripting.executeScript({ target: { tabId }, args: [op, a || {}] })');
  src = src.replace(/const vuSleep = .*\n/, 'const vuSleep = () => new Promise((r) => setTimeout(r, 1));\n');
  vm.runInContext(src, ctx);
  return { ctx, log, sent, clicks, st };
}

const send = (env) => (m) => env.sent.push(m);

(async () => {
  // 1. happy path: 8 steps in order, manual mode toggled with a real mouse click, Frames, cost read, chunking
  {
    const env = makeEnv();
    const out = await vm.runInContext('vuRunJob', env.ctx)(
      { call: 'c1', prompt: 'hello', image: { b64: 'AAAA', name: 'a.png' }, model: 'veo_lite', aspect: '16:9', chunk_bytes: 16, silent: false, max_credits: 30 }, send(env));
    assert.equal(out.ok, true);
    assert.equal(out.cost, 20);
    const steps = env.sent.filter((m) => m.type === 'video_ui_progress').map((m) => m.step);
    assert.deepEqual(steps, ['open_tab', 'manual_mode', 'upload', 'ingredient', 'submit', 'approve', 'generating', 'download']);
    assert.deepEqual(steps, Array.from(vm.runInContext('VU_STEPS', env.ctx)));
    assert.ok(env.clicks.some(([x, y]) => x === 10 && y === 10), 'Flow Agent toggled with real mouse');
    assert.ok(env.log.includes('click@31,31'), 'Video type = Frames');
    assert.ok(env.log.includes('click@36,36'), 'Start frame slot clicked');
    assert.ok(env.log.includes('type:hello'));
    assert.ok(!env.log.includes('click@39,39'), 'no approve click when no approve button (manual mode)');
    assert.ok(env.log.includes('click@42,42'), '1080p Upscaled via real mouse');
    assert.ok(env.log.indexOf('click@38,38') > env.log.indexOf('type:hello'));
    const chunks = env.sent.filter((m) => m.type === 'video_ui_chunk');
    assert.ok(chunks.length > 1 && chunks[chunks.length - 1].last === true && chunks.slice(0, -1).every((c) => !c.last));
    assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_, i) => i));
    assert.equal(Buffer.concat(chunks.map((c) => Buffer.from(c.b64, 'base64'))).equals(MP4), true);
    assert.equal(env.log[env.log.length - 1], 'detach');
  }
  // 2. approve uses CDP clickAt (never el.click) when Flow asks
  {
    const env = makeEnv({ approveButton: true });
    const out = await vm.runInContext('vuRunJob', env.ctx)({ call: 'c2', prompt: 'p', image: { b64: 'AAAA' }, silent: false }, send(env));
    assert.equal(out.ok, true);
    assert.ok(env.log.includes('click@39,39'), 'approve via FB_CDP.clickAt');
    assert.equal(env.st.agentPressed, false);
  }
  // 3. over budget: no Start click
  {
    const env = makeEnv({ cost: 50 });
    await assert.rejects(vm.runInContext('vuRunJob', env.ctx)({ call: 'c3', prompt: 'p', image: { b64: 'AAAA' }, max_credits: 10, silent: false }, send(env)),
      (e) => e.code === 'OVER_BUDGET');
    assert.ok(!env.log.includes('click@38,38'), 'did not submit');
    assert.equal(env.log[env.log.length - 1], 'detach');
  }
  // 4. error mapping through handleVideoUiCall
  {
    const env = makeEnv({ busy: true });
    const replies = [];
    await vm.runInContext('handleVideoUiCall', env.ctx)({ id: 'x', params: { call: 'c4', prompt: 'p', image: { b64: 'A' } } }, (m) => replies.push(m));
    assert.equal(replies.find((m) => m.id === 'x').data.ok, false);
    assert.equal(replies.find((m) => m.id === 'x').data.code, 'DEBUGGER_BUSY');
    const env2 = makeEnv({ cost: 99 });
    const r2 = [];
    await vm.runInContext('handleVideoUiCall', env2.ctx)({ id: 'y', params: { call: 'c5', prompt: 'p', image: { b64: 'A' }, max_credits: 1, silent: false } }, (m) => r2.push(m));
    assert.equal(r2.find((m) => m.id === 'y').data.code, 'OVER_BUDGET');
    const r3 = [];
    await vm.runInContext('handleVideoUiCall', env2.ctx)({ id: 'z', params: null }, (m) => r3.push(m));
    assert.equal(r3[0].error, 'VIDEO_UI_CALL_BAD_PARAMS');
  }
  // 5. probe returns models + leaving tags + cost line
  {
    const env = makeEnv();
    const replies = [];
    await vm.runInContext('handleVideoUiCall', env.ctx)({ id: 'p', params: { probe: true } }, (m) => replies.push(m));
    const d = replies[0].data;
    assert.equal(d.ok, true);
    assert.equal(d.tab_open, true);
    assert.deepEqual(JSON.parse(JSON.stringify(d.models)), [{ label: 'Veo 3.1 - Fast', leaving: 'Leaving Dec 5' }]);
    assert.equal(d.cost_line, 20);
  }
  // 6. wiring
  {
    const bg = read('background.js');
    assert.ok(bg.includes("importScripts('cdp-input.js', 'video-ui.js')"));
    assert.ok(bg.includes("msg.method === 'video_ui_call'"));
    const mf = JSON.parse(read('manifest.json'));
    assert.equal(mf.version, '0.2.4');
    assert.ok(mf.permissions.includes('debugger') && mf.permissions.includes('downloads'));
  }
  console.log('ALL PASS: video-ui steps, real-mouse approve, budget guard, errors, probe, wiring');
})().catch((e) => { console.error(e); process.exitCode = 1; });
