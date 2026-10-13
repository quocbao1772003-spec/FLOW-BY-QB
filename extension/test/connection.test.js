const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');
const begin = src.indexOf('function connectToAgent(');
const end = src.indexOf('// ─── Send to Agent', begin);
let now = 1000, sockets = [], alarms = [], sent = [];
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() { this.readyState = 0; sockets.push(this); }
  send(raw) { sent.push(JSON.parse(raw)); }
}
const context = vm.createContext({ WebSocket: Socket, Date: { now: () => now }, console,
  chrome: { runtime: { getManifest: () => ({version: '0.1.15'}) }, alarms: { create: (_, value) => alarms.push(value), clear() {} },
    storage: { local: { set() {} } } }, setState() {}, fetchAndPushUserInfo() {},
    pushIdentityFromFlowTab: async () => false,
    getBridgeInstanceId: async () => 'test-profile-instance' });
vm.runInContext(`let ws = null, manualDisconnect = false, reconnectAttempts = 0,
  reconnectAt = 0, flowKey = null, cachedUserInfo = null,
  bridgeInstanceId = 'test-profile-instance', bridgeAccepted = false, callbackSecret = null;
  const metrics = {}, AGENT_WS_URL = 'ws://127.0.0.1:9223';
  ${src.slice(begin, end)}`, context);
const run = code => vm.runInContext(code, context);
(async () => {
run('connectToAgent(); connectToAgent()');
assert.equal(sockets.length, 1, 'no duplicate connecting socket');
sockets[0].onerror(); sockets[0].readyState = 3; sockets[0].onclose();
assert.equal(alarms.at(-1).when, now + 30000);
run('keepAlive()');
assert.equal(sockets.length, 1, 'keepalive respects retry deadline');
now += 30000; run('connectToAgent()');
sockets[1].readyState = 3; sockets[1].onclose();
assert.equal(alarms.at(-1).when, now + 60000);
run('connectToAgent(true)');
assert.equal(sockets.length, 3, 'manual retry bypasses deadline');
sockets[2].readyState = 1; await sockets[2].onopen();
assert.equal(sent.at(-1).type, 'bridge_hello');
assert.equal(sent.at(-1).protocol, 2);
assert.equal(sent.at(-1).instanceId, 'test-profile-instance');
assert.equal(run('bridgeAccepted'), false, 'socket open alone is not an accepted profile');
await sockets[2].onmessage({data: JSON.stringify({type:'callback_secret',secret:'test'})});
assert.equal(run('metrics.lastError'), null);
assert.equal(run('reconnectAttempts'), 0);
run('manualDisconnect = true; scheduleReconnect(); connectToAgent(true)');
assert.equal(sockets.length, 3, 'manual disconnect blocks retry');
const manifest = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'manifest.json'), 'utf8'));
assert.ok(manifest.host_permissions.includes('http://127.0.0.1:8101/*'));
console.log('ALL PASS: connection backoff, manual retry, recovery, callback permission');
})().catch(error => { console.error(error); process.exitCode = 1; });
