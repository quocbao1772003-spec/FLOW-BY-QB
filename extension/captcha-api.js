/**
 * Flow compatibility: retain the reCAPTCHA library's execute implementation.
 * Based on the integration in crisng95/flowboard; unlike its broad execute-key
 * hook, this only handles the actual grecaptcha.enterprise object. Unrelated
 * objects, and legitimate API replacements, keep normal descriptor semantics.
 * Loaded in MAIN at document_start, before injected.js.
 */
(function () {
  if (window.__flowboardCaptchaApi) return;
  const define = Object.defineProperty;
  const source = Function.prototype.toString;
  const enterprises = new WeakSet();
  const roots = new WeakSet();
  const watched = new WeakMap();
  const retained = new WeakMap();
  let replacements = 0;
  const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  const marked = fn => typeof fn === 'function' && source.call(fn).includes('extension_hijack_detected');

  function accept(owner, candidate) {
    if (marked(candidate)) {
      replacements++;
      return retained.get(owner) || candidate;
    }
    if (typeof candidate === 'function') {
      retained.set(owner, candidate);
    }
    return candidate;
  }

  function watch(object, key, onRead, onWrite = onRead) {
    const previous = Object.getOwnPropertyDescriptor(object, key);
    const installed = watched.get(object)?.[key];
    if (installed && previous?.get === installed) return;
    if (previous && (!previous.configurable || ('value' in previous && !previous.writable))) {
      if ('value' in previous) onRead(previous.value);
      return;
    }
    // Do not eagerly invoke accessors. Some library getters require a receiver
    // or perform lazy initialization; invoke them only on an actual property read.
    let value = previous && previous.value;
    const get = function () {
      const current = previous?.get ? previous.get.call(this) : value;
      return onRead(current);
    };
    const descriptor = { configurable: true, enumerable: previous ? previous.enumerable : true, get };
    if (!previous || 'value' in previous || previous.set) descriptor.set = function (next) {
      const accepted = onWrite(next);
      if (previous?.set) previous.set.call(this, accepted);
      else value = accepted;
    };
    define(object, key, descriptor);
    const keys = watched.get(object) || {};
    keys[key] = get;
    watched.set(object, keys);
    if (previous && 'value' in previous) onRead(value);
  }

  function enterprise(value) {
    if (!isObject(value)) return value;
    enterprises.add(value);
    watch(value, 'execute', candidate => accept(value, candidate));
    return value;
  }
  function root(value) {
    if (!isObject(value)) return value;
    roots.add(value);
    watch(value, 'enterprise', enterprise);
    return value;
  }

  // Flow also assigns execute with Object.defineProperty. Restrict interception
  // by object identity, never by the property name alone as the upstream did.
  Object.defineProperty = function (object, key, descriptor) {
    const executeSlot = enterprises.has(object) && key === 'execute';
    let next = descriptor;
    if (executeSlot && descriptor && 'value' in descriptor) {
      const candidate = accept(object, descriptor.value);
      if (candidate !== descriptor.value) next = { ...descriptor, value: candidate };
    } else if (executeSlot && descriptor && typeof descriptor.get === 'function') {
      next = { ...descriptor, get: function () { return accept(object, descriptor.get.call(this)); } };
    }
    const result = define.call(Object, object, key, next);
    if (object === window && key === 'grecaptcha') watch(window, 'grecaptcha', root);
    else if (roots.has(object) && key === 'enterprise') watch(object, key, enterprise);
    else if (executeSlot) watch(object, key, candidate => accept(object, candidate));
    return result;
  };

  watch(window, 'grecaptcha', root);
  define(window, '__flowboardCaptchaApi', { configurable: true, value: {
    status() {
      const owner = window.grecaptcha?.enterprise;
      return { retained: isObject(owner) && retained.has(owner), replacements };
    },
    execute(siteKey, options) {
      const owner = window.grecaptcha?.enterprise;
      const execute = isObject(owner) ? accept(owner, owner.execute) : null;
      if (typeof execute !== 'function') throw new Error('GRECAPTCHA_MISSING');
      // An already-open page may contain only the replacement. Never invent a
      // library function or silently submit a known-mismatched action in that case.
      if (marked(execute)) throw new Error('CAPTCHA_API_RELOAD_REQUIRED');
      return execute.call(owner, siteKey, options);
    },
  } });
})();
