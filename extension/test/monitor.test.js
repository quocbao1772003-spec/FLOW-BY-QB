const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const events = [], sent = [];
class XHR {
  open(method, url) { this.url = url; }
  addEventListener(name, callback) { this.callback = callback; }
  send(body) { this.body = body; this.status = 200; this.responseText = 'https://flow-content.google/image/test'; this.callback?.(); }
}
const window = { location: { pathname: '/project/test' }, dispatchEvent: e => events.push(e),
  fetch: async (input, init) => {
    sent.push(input instanceof Request ? await input.text() : init.body.toString());
    return new Response('https://flow-content.google/image/test', { status: 200 });
  }, grecaptcha: { enterprise: { execute: () => 'token' } } };
const env = { window, XMLHttpRequest: XHR, Request, Response, URLSearchParams,
  document: { visibilityState: 'visible' }, CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } } };
vm.createContext(env);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'boq-monitor.js'), 'utf8'), env);
const url = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=ogiZ0b';
async function flush() { await new Promise(resolve => setTimeout(resolve, 30)); }
(async () => {
  for (const mode of ['string', 'params', 'request', 'xhr']) {
    events.length = 0;
    const body = 'f.req=payload&at=private';
    if (mode === 'request') await window.fetch(new Request(url, { method: 'POST', body }));
    else if (mode === 'xhr') { const xhr = new XHR(); xhr.open('POST', url); xhr.send(new URLSearchParams(body)); }
    else await window.fetch(url, { method: 'POST', body: mode === 'params' ? new URLSearchParams(body) : body });
    await flush();
    assert.ok(events.some(e => e.type === 'FLOWBOARD_BOQ_SAMPLE' && e.detail.body === body), mode);
    assert.ok(events.some(e => e.type === 'FLOWBOARD_BOQ_TRACE' && e.detail.status === 200), mode);
  }
  assert.deepEqual(sent, Array(3).fill('f.req=payload&at=private'));
  window.__flowboardSelfCall = true;
  events.length = 0;
  await window.fetch(url, { body: 'f.req=ours' });
  await flush();
  assert.equal(events.length, 0, 'own request must never become a manual template');
  console.log('ALL PASS: string, URLSearchParams, Request, XHR bodies observed without consuming or changing originals');
})().catch(e => { console.error(e); process.exitCode = 1; });
