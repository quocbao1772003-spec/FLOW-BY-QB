const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'captcha-api.js'), 'utf8');
function setup(initial = '') {
  const context = vm.createContext({ window: {} });
  vm.runInContext(`
    let calls = [];
    function library(key, options) { calls.push({ key, action: options.action, owner: this }); return options.action; }
    function replacement(key, options) { return library(key, { action: 'extension_hijack_detected' }); }
    ${initial}
  `, context);
  vm.runInContext(src, context);
  return code => vm.runInContext(code, context);
}

// As on document_start: script initializes grecaptcha in several assignments.
let run = setup();
run('window.grecaptcha = {}; window.grecaptcha.enterprise = {}; window.grecaptcha.enterprise.execute = library');
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_GENERATION' })"), 'IMAGE_GENERATION');
run('window.grecaptcha.enterprise.execute = replacement');
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_GENERATION' })"), 'IMAGE_GENERATION');
assert.equal(run('calls[1].owner === window.grecaptcha.enterprise'), true);
assert.equal(run('calls[1].key'), 'site');

// Defining an unrelated execute property was incorrectly intercepted upstream.
run(`let other = {}; Object.defineProperty(other, 'execute', {value: replacement, configurable: true});`);
assert.equal(run('other.execute === replacement'), true);
run(`let reads = 0; let otherGetter = {}; Object.defineProperty(otherGetter, 'execute', {get() { reads++; return replacement; }});`);
assert.equal(run('reads'), 0);
assert.equal(run('otherGetter.execute === replacement'), true);
assert.equal(run('reads'), 1);
assert.equal(run('Object.getOwnPropertyDescriptor(other, "execute").enumerable'), false);

run("Object.defineProperty(window.grecaptcha.enterprise, 'execute', { value: replacement, writable: true, configurable: true })");
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_UPLOAD' })"), 'IMAGE_UPLOAD');
// Legitimate replacement is respected; never pin a stale library forever.
run("function library2() { return 'new-library'; } window.grecaptcha.enterprise.execute = library2;");
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_GENERATION' })"), 'new-library');
run("Object.defineProperty(window.grecaptcha.enterprise, 'execute', { configurable: true, get() { return replacement; } })");
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_GENERATION' })"), 'new-library');

// Re-injection does not stack wrappers.
assert.equal(run('globalThis.originalWrapper = Object.defineProperty; true'), true);
run(src);
assert.equal(run('Object.defineProperty === originalWrapper'), true);

// Accessors are lazy and have their receiver, and assignments through root
// descriptors install the nested observers before the page replaces execute.
run = setup();
run(`let getterReads = 0; const api = {execute: library};
  Object.defineProperty(window, 'grecaptcha', { configurable: true, get() { getterReads++; return { enterprise: api }; } });`);
assert.equal(run('getterReads'), 0);
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_GENERATION' })"), 'IMAGE_GENERATION');
assert.equal(run('getterReads'), 1);

// No old account/library reference is substituted into a different API object.
run = setup();
run(`Object.defineProperty(window, 'grecaptcha', { value: {enterprise: {execute:library}}, configurable: false, writable: false });
  window.grecaptcha.enterprise.execute = replacement;`);
assert.equal(run("window.__flowboardCaptchaApi.execute('site', { action: 'IMAGE_GENERATION' })"), 'IMAGE_GENERATION');
assert.equal(run("Object.getOwnPropertyDescriptor(window, 'grecaptcha').configurable"), false);

// No old account/library reference is substituted into a different API object.
run = setup('window.grecaptcha = {enterprise: {execute: library}};');
run('window.grecaptcha = {enterprise: {execute: replacement}}');
assert.throws(() => run("window.__flowboardCaptchaApi.execute('site', {action:'IMAGE_GENERATION'})"), /CAPTCHA_API_RELOAD_REQUIRED/);
assert.equal(run('calls.length'), 0);

// Too-late injection cannot recover a function it never observed.
run = setup('window.grecaptcha = {enterprise: {execute: replacement}};');
assert.throws(() => run("window.__flowboardCaptchaApi.execute('site', {action:'IMAGE_GENERATION'})"), /CAPTCHA_API_RELOAD_REQUIRED/);
assert.equal(run('calls.length'), 0);
console.log('ALL PASS: scoped captcha compatibility, correct action/receiver, lifecycle and late-load handling');
