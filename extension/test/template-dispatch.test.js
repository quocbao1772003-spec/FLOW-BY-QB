const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(name) {
  const start = src.indexOf('async function ' + name + '(');
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
let captured, replies;
const context = vm.createContext({ console,
  chrome: { scripting: { executeScript: async config => {
    captured = config.args[0]; return [{ result: { mediaId: 'ok' } }];
  } } } });
vm.runInContext(`let boqTemplate = { paths: { inputs: null } }, boqHealth;
  const BOQ_ENDPOINT_PATH = '/x', BOQ_RPC_IMAGE = 'ogiZ0b', BOQ_SITE_KEY = 'k',
    BOQ_IMAGE_MODEL_TAG = 'NARWHAL', BOQ_SURFACE_ID = 22;
  const boqSeed = () => 1, boqGenerateInPage = () => {}, boqTraceOurs = r => r;
  const boqSaveTemplate = () => {};
  ${extract('boqRunOneNow')}
  ${extract('boqRunOneWithFallback')}`, context);
(async () => {
  await vm.runInContext("boqRunOneNow(1,'p','prompt',['ref'],'group',{})", context);
  assert.equal(captured.template, null, 'incompatible text template bypassed');
  assert.equal(captured.mediaInputs[0], 'ref', 'reference retained');
  await vm.runInContext("boqRunOneNow(1,'p','prompt',[],'group',{})", context);
  assert.ok(captured.template, 'text-only still uses learned template');
  replies = [{ error: 'TEMPLATE_NO_REF_SLOT', usedTemplate: true },
    { error: 'RPC_7_PERMISSION_DENIED', reason: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY' }];
  context.boqRunOne = async () => replies.shift();
  const result = await vm.runInContext("boqRunOneWithFallback(1,'p','prompt',['ref'],'group',{})", context);
  assert.equal(result.reason, 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', 'fallback error not hidden');
  console.log('ALL PASS: compatible template selection, refs retained, fallback error');
})().catch(error => { console.error(error); process.exitCode = 1; });
