const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'injected.js'), 'utf8');
let active = 0, peak = 0, count = 0;
const execute = async () => {
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, 5));
  active--; count++;
  if (count === 1) throw new Error('captcha unavailable');
  return 'token-' + count;
};
const window = { grecaptcha: { enterprise: { execute } }, addEventListener() {} };
const context = vm.createContext({ window, setTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'captcha-api.js'), 'utf8'), context);
vm.runInContext(src, context);
(async () => {
  const results = await Promise.allSettled([
    window.__flowboardMintCaptcha('IMAGE_UPLOAD', 'page-key'),
    window.__flowboardMintCaptcha('IMAGE_GENERATION', 'page-key'),
    window.__flowboardMintCaptcha('IMAGE_UPSCALE', 'page-key'),
  ]);
  assert.equal(peak, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].value, 'token-2');
  assert.equal(results[2].value, 'token-3');
  assert.equal(vm.runInContext('mintCaptcha', context), window.__flowboardMintCaptcha);
  console.log('ALL PASS: shared captcha serialization across upload/generate/upscale and recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
