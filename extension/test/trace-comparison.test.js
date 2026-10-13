const assert = require('node:assert/strict');
const { compare } = require('../compare-generation-traces');
function row(kind, success, seed, role = 1) {
  return { kind, rpcids: 'ogiZ0b', sourcePath: '/project/p', status: 200, hasMedia: success,
    error: success ? null : 'RPC_7_PERMISSION_DENIED', bl: 'b',
    freq: [[['ogiZ0b', { __json: [null, [[null, null, [['id', null, null, null, role]], seed, 1, 'GEM_PIX_2', null,
      [null, 22, null, null, null, 'p', null, null, null, null, ['<LONG_2489>', 1]], [[[seed ? 'x' : 'y']]]]], 1] }]]] };
}
const failed = row('ours-template', false, 2);
assert.equal(compare([failed]).state, 'missing_matching_manual_success');
assert.equal(compare([{ ...row('app', true, 1), sourcePath: '/project/other' }, failed]).state, 'missing_matching_manual_success');
assert.equal(compare([row('app', true, 1), failed]).differences.length, 0);
assert.equal(compare([row('app', true, 1), failed]).sameReferenceIds, true);
const textOnly = row('app', true, 1);
textOnly.freq[0][0][1].__json[1][0][2] = null;
assert.equal(compare([textOnly, failed]).sameReferenceIds, false);
const changed = compare([row('app', true, 1, 2), failed]);
assert.equal(changed.differences.length, 1);
assert.equal(changed.differences[0].path, '$[1][0][2][0][4]');
console.log('ALL PASS: comparison requires same project/model, masks dynamics, reports structural changes without assigning cause');
