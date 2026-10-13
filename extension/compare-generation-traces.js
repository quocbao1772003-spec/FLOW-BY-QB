// Compare redacted evidence, never replay requests or read credentials.
const fs = require('node:fs');
const path = require('node:path');
function innerOf(row) {
  let inner = row.freq?.[0]?.[0]?.[1];
  if (inner?.__json) inner = inner.__json;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { return null; } }
  return Array.isArray(inner) ? inner : null;
}
function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === 'string') {
    if (/^<LONG_\d+>$/.test(value)) return '<REDACTED>';
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return '<UUID>';
  }
  return value;
}
function normalize(row) {
  const inner = shape(innerOf(row));
  if (!inner) return null;
  for (const item of inner[1] || []) {
    if (!Array.isArray(item)) continue;
    item[3] = '<SEED>';
    item[8] = '<PROMPT>';
  }
  return inner;
}
function diff(a, b, at = '$', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out);
  } else out.push({ path: at, manual: a ?? null, extension: b ?? null });
  return out;
}
function compare(rows) {
  const failures = rows.filter(r => r.rpcids === 'ogiZ0b' && r.kind?.startsWith('ours-') && r.error);
  const failed = failures.at(-1);
  if (!failed) return { state: 'missing_extension_failure' };
  const model = innerOf(failed)?.[1]?.[0]?.[5];
  const manual = rows.filter(r => r.kind === 'app' && r.rpcids === 'ogiZ0b' && r.status === 200
    && r.hasMedia && r.sourcePath === failed.sourcePath && innerOf(r)?.[1]?.[0]?.[5] === model).at(-1);
  if (!manual) return { state: 'missing_matching_manual_success', projectPath: failed.sourcePath,
    model, failureTime: failed.time, error: failed.error };
  const refs = row => (innerOf(row)?.[1]?.[0]?.[2] || []).map(entry => entry[0]);
  const sameReferenceIds = JSON.stringify(refs(manual)) === JSON.stringify(refs(failed));
  return { state: 'pair_available', manualTime: manual.time, failureTime: failed.time,
    projectPath: failed.sourcePath, model, sameBuild: manual.bl === failed.bl,
    sameReferenceIds, manualReferenceCount: refs(manual).length, extensionReferenceCount: refs(failed).length,
    manualContext: manual.context, extensionContext: failed.context,
    differences: diff(normalize(manual), normalize(failed)),
    note: 'Dynamic UUIDs, seeds, prompts and redacted tokens are masked. Equal shapes do not prove equal authentication or server acceptance.' };
}
if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', 'storage', 'diagnostics', 'boq_traces.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  console.log(JSON.stringify(compare(rows), null, 2));
}
module.exports = { compare };
