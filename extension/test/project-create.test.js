const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('async function boqCreateProjectInPage(');
const end = src.indexOf('\n}\n', start) + 3;
const create = eval('(' + src.slice(start, end) + ')');
const id = 'b44b81a2-5fb9-48a3-be06-8e50611efefb';
let captured, status = 200;
let frame = ['wrb.fr', 'jHPbke', JSON.stringify([id, ['Oct 12 - 09:16']]), null, null, null, 'generic'];
global.window = { WIZ_global_data: { SNlM0e: 'AT', cfb2h: 'BUILD', FdrFJe: 'SID', EP: 'en' },
  location: { pathname: '/' } };
global.fetch = async (url, config) => {
  captured = { url, config };
  return { ok: status === 200, status, text: async () => ")]}'\n\n168\n" + JSON.stringify([frame]) + '\n' };
};
(async () => {
  assert.equal((await create({ title: 'Session' })).projectId, id);
  const body = new URLSearchParams(captured.config.body);
  const request = JSON.parse(body.get('f.req'))[0][0];
  assert.equal(request[0], 'jHPbke');
  assert.deepEqual(JSON.parse(request[1]), ['projects/*', [null, ['Session']], [null, 22]]);
  assert.equal(body.get('at'), 'AT');
  assert.equal(captured.config.credentials, 'include');
  assert.ok(captured.url.startsWith('/_/AiSandboxAngularFrontend/'));
  frame = ['wrb.fr', 'jHPbke', null, null, null, [7], 'generic'];
  assert.equal((await create({ title: 'Session' })).error, 'PROJECT_CREATE_RPC_7');
  status = 401;
  assert.equal((await create({ title: 'Session' })).error, 'PROJECT_CREATE_HTTP_401');
  global.fetch = async () => { throw new TypeError('network unavailable'); };
  const failed = await create({ title: 'Session' });
  assert.equal(failed.error, 'PROJECT_CREATE_OUTCOME_UNKNOWN');
  assert.equal(failed.stage, 'request');
  assert.equal(failed.cause, 'TypeError');
  window.WIZ_global_data = {};
  assert.equal((await create({ title: 'Session' })).error, 'WIZ_DATA_MISSING');
  console.log('ALL PASS: observed project RPC, ID parsing, auth errors, loading guard');
})().catch(e => { console.error(e); process.exitCode = 1; });
