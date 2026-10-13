// Integration test: run the shipped MAIN-world bridge + BOQ generation with
// a page API replacement. The simulated server validates token action/use,
// project and both references; it does not blindly return success.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');
const background = read('background.js');
const start = background.indexOf('async function boqGenerateInPage(cfg) {');
const generate = background.slice(start, background.indexOf('\n}\n', start) + 3);
const refs = ['c965d893-6d36-4cca-8ce7-c23df3591322', 'f1c1779b-03df-4958-b49f-8d292d243bc9'];
const project = '8c7322f4-a2bc-4951-be2e-c529f88804bf';
const issued = new Map();
let mintCount = 0, networkCount = 0;
const library = async function (key, {action}) {
  assert.equal(this, context.window.grecaptcha.enterprise);
  assert.equal(key, 'PAGE_KEY');
  const token = 'token-' + (++mintCount);
  issued.set(token, action);
  return token;
};
const context = vm.createContext({
  window: {
    location: {pathname: '/project/' + project},
    WIZ_global_data: {SNlM0e: 'AT', cfb2h: 'build', FdrFJe: 'session', xZbWve: 'PAGE_KEY'},
    crypto: require('node:crypto').webcrypto,
    addEventListener() {},
  },
  library, setTimeout, URLSearchParams,
  document: {visibilityState: 'hidden'},
  fetch: async (url, init) => {
    networkCount++;
    const envelope = JSON.parse(new URLSearchParams(init.body).get('f.req'));
    const body = JSON.parse(envelope[0][0][1]);
    const token = body[3][10][0];
    assert.equal(body[1][0][7][10][0], token);
    assert.equal(body[3][5], project);
    assert.deepEqual(body[1][0][2].map(r=>r[0]), refs);
    assert.equal(body[1][0][5], 'GEM_PIX_2');
    const valid = issued.get(token) === 'IMAGE_GENERATION';
    issued.delete(token);
    const frame = valid
      ? ['wrb.fr', 'ogiZ0b', JSON.stringify(['https://flow-content.google/image/3b3645e3-052a-4ed1-9a89-05b4fb361701']), null, null, null, 'generic']
      : ['wrb.fr', 'ogiZ0b', null, null, null, [7, null, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']]]], 'generic'];
    return {ok:true, status:200, text:async()=>")]}'\n" + JSON.stringify([frame])};
  },
});
vm.runInContext(read('captcha-api.js') + '\n' + read('injected.js') + '\n' + generate, context);
vm.runInContext(`
  function pageReplacement(key, options) { return library.call(window.grecaptcha.enterprise, key, {action:'extension_hijack_detected'}); }
  window.grecaptcha = {enterprise: {execute: library}};
  window.grecaptcha.enterprise.execute = pageReplacement;
`, context);
const cfg = {projectId:project, prompt:'Thay bộ nails', modelTag:'GEM_PIX_2', mediaInputs:refs,
  aspect:1, seed:42, surfaceId:22, rpcId:'ogiZ0b', endpoint:'/data/batchexecute', siteKey:'FALLBACK'};
(async()=>{
  // Establish the modeled failure: the replacement ignores the requested action.
  const poisoned = await vm.runInContext("pageReplacement('PAGE_KEY', {action:'IMAGE_GENERATION'})", context);
  assert.equal(issued.get(poisoned), 'extension_hijack_detected');
  const response = await context.boqGenerateInPage(cfg);
  assert.equal(response.error, undefined);
  assert.equal(response.mediaId, '3b3645e3-052a-4ed1-9a89-05b4fb361701');
  assert.equal(networkCount, 1);
  assert.equal(response.traceContext.captchaApi.retained, true);
  // A new API object with no observed library must not reuse the old library.
  vm.runInContext('window.grecaptcha = {enterprise: {execute: pageReplacement}}', context);
  const refused = await context.boqGenerateInPage(cfg);
  assert.equal(refused.error, 'CAPTCHA_API_RELOAD_REQUIRED');
  assert.equal(networkCount, 1);
  console.log('ALL PASS: two-reference generation uses the shared library token, stale API stops before network');
})().catch(e=>{ console.error(e); process.exitCode=1; });
