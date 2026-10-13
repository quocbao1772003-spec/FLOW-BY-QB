const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let identity = { email: 'old@example.com', session: 'one' };
let tabs = [{ id: 1, active: false }, { id: 2, active: true }];
let sent = [];
const context = vm.createContext({ console, sent, WebSocket: { OPEN: 1 },
  chrome: { tabs: { query: async () => tabs }, storage: { local: { remove() {} } },
    scripting: { executeScript: async () => [{ result: identity }] } } });
vm.runInContext(`let flowKey = 'OLD', cachedUserInfo = null;
  const boqSpentModels = {}, ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  ${src.slice(src.indexOf('let _identityPushed ='), src.indexOf('const BOQ_ENDPOINT_PATH'))}`, context);
const run = code => vm.runInContext(code, context);
(async () => {
  assert.equal(run('boqChooseTab([{id:1},{id:2,active:true}]).id'), 2);
  await run('pushIdentityFromFlowTab(true)');
  assert.equal(sent.at(-1).userInfo.email, 'old@example.com');
  run('boqSpentModels.NARWHAL = 123');
  await run('pushIdentityFromFlowTab(true)');
  assert.equal(run('boqSpentModels.NARWHAL'), 123, 'same session keeps quota');
  identity = { email: 'new@example.com', session: 'two' };
  await run('pushIdentityFromFlowTab(true)');
  assert.equal(sent.at(-1).userInfo.email, 'new@example.com');
  assert.equal(run('Object.keys(boqSpentModels).length'), 0, 'switch clears old quota');
  assert.equal(run('flowKey'), null, 'old token discarded');
  tabs = [{ id: 1 }, { id: 2 }];
  assert.equal((await run('boqExistingProjectTab()')).id, 2, 'scan retains selected tab');
  console.log('ALL PASS: account switch, quota reset, active tab, scan selection');
})().catch(error => { console.error(error); process.exitCode = 1; });
