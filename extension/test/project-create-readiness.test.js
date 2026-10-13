const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
  const start = src.indexOf('async function ' + name + '(');
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
function setup({ stuck = false, redirected = false, missingResult = false } = {}) {
  let now = 0, sleeps = 0, probes = 0, mutations = 0;
  const sent = [], targets = [];
  const env = {
    URL, Date: { now: () => now },
    sleep: async ms => { now += ms; sleeps++; },
    boqChooseTab: tabs => tabs[0], reviveTabIfNeeded: async tab => tab,
    boqCreateProjectInPage: function createMutation() {},
    sendToAgent: message => sent.push(message),
    chrome: {
      tabs: {
        query: async () => [],
        create: async () => ({ id: 12, status: 'loading' }),
        get: async () => ({ id: 12, status: stuck || sleeps === 0 ? 'loading' : 'complete',
          url: redirected ? 'https://accounts.google.com/login' : 'https://flow.google.com/' }),
      },
      scripting: { executeScript: async options => {
        if (options.func.name === 'createMutation') {
          mutations++;
          targets.push(options.target);
          return missingResult ? [] : [{ frameId: 0, result: { projectId: 'new-project' } }];
        }
        probes++;
        // First probe loses its result during navigation; second sees a
        // document without WIZ yet; only the third is safe for mutation.
        if (probes === 1) return [];
        return [{ frameId: 0, documentId: 'ready-document', result: { ready: probes >= 3 } }];
      } },
    },
  };
  vm.createContext(env);
  vm.runInContext(functionSource('boqWaitForProjectCreationTab') + '\n'
    + functionSource('handleCreateProjectViaBoq'), env);
  return { run: () => env.handleCreateProjectViaBoq({ id: 'job', params: {} }),
    sent, targets, counts: () => ({ probes, mutations, sleeps }) };
}
(async () => {
  const ready = setup();
  await ready.run();
  assert.equal(ready.counts().mutations, 1);
  assert.equal(ready.counts().probes, 3);
  assert.equal(ready.sent[0].status, 200);
  assert.equal(ready.targets[0].documentIds[0], 'ready-document');
  const stuck = setup({ stuck: true });
  await stuck.run();
  assert.equal(stuck.counts().mutations, 0);
  assert.equal(stuck.sent[0].error, 'PROJECT_CREATE_FLOW_NOT_READY');
  const login = setup({ redirected: true });
  await login.run();
  assert.equal(login.counts().mutations, 0);
  assert.equal(login.sent[0].error, 'PROJECT_CREATE_FLOW_SIGN_IN_REQUIRED');
  const unknown = setup({ missingResult: true });
  await unknown.run();
  assert.equal(unknown.counts().mutations, 1);
  assert.equal(unknown.sent[0].error, 'PROJECT_CREATE_OUTCOME_UNKNOWN');
  console.log('ALL PASS: loading tab, empty probe, WIZ readiness, document pinning, timeout, sign-in, no duplicate create');
})().catch(error => { console.error(error); process.exitCode = 1; });
