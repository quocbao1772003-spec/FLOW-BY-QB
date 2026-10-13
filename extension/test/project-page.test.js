const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('async function boqCheckProjectPage(');
const end = src.indexOf('\n}\n', start) + 3;
let page = '/404';
const chrome = { scripting: { executeScript: async () => [{ result: page }] } };
const check = eval('(' + src.slice(start, end) + ')');
(async () => {
  assert.ok((await check(1, 'wanted')).startsWith('BOQ_PROJECT_UNAVAILABLE'));
  page = '/project/other';
  assert.ok((await check(1, 'wanted')).startsWith('BOQ_PROJECT_PAGE_MISMATCH'));
  page = '/project/wanted';
  assert.equal(await check(1, 'wanted'), null);
  assert.equal((src.match(/const projectError = await boqCheckProjectPage/g) || []).length, 3);
  console.log('ALL PASS: missing and wrong project blocked in upload, upscale, generation');
})().catch(error => { console.error(error); process.exitCode = 1; });
