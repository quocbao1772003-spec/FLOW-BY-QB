const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
const begin = src.indexOf('async function boqFindProjectTab(');
const end = src.indexOf('\n}\n', begin) + 3;
let tabs = [{ id: 1, active: true, url: 'https://flow.google.com/project/other' },
  { id: 2, url: 'https://flow.google.com/project/wanted?authuser=1' }];
let created = [];
const context = vm.createContext({ URL, console,
  boqChooseTab: ts => ts[0] || null, reviveTabIfNeeded: async t => t,
  chrome: { tabs: { query: async () => tabs, create: async options => {
    created.push(options); return { id: 3, ...options };
  } } } });
vm.runInContext(src.slice(begin, end), context);
(async () => {
  assert.equal((await vm.runInContext("boqFindProjectTab('wanted')", context)).id, 2);
  assert.equal(created.length, 0);
  tabs = tabs.slice(0, 1);
  assert.equal((await vm.runInContext("boqFindProjectTab('wanted')", context)).id, 3);
  assert.equal(created[0].url, 'https://flow.google.com/project/wanted');
  console.log('ALL PASS: target project selected, unrelated tab never reused');
})().catch(error => { console.error(error); process.exitCode = 1; });
