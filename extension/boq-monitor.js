/**
 * Runs in the Flow page's MAIN world. Watches the app make its own
 * batchexecute calls and hands successful generates to the extension, which
 * uses them to relearn the payload layout when Google moves something.
 *
 * Only calls whose reply contains a media URL are reported — that is the
 * cheapest proof that the request was a real, accepted generate rather than a
 * housekeeping RPC. Our own shim's requests are skipped so the template can
 * never be learned from itself.
 *
 * Nothing is stored here. The payload is handed straight to the background
 * worker, which extracts the field positions and then blanks every value it
 * located before anything touches disk.
 */
(function () {
  if (window.__flowboardMonitor) return;
  window.__flowboardMonitor = true;

  const ENDPOINT = '/data/batchexecute';
  const watched = url => String(url).includes(ENDPOINT)
    || String(url).includes('/api/trpc/project.createProject');

  function bodyText(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return null;
  }

  function pageContext() {
    const execute = window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute;
    return { path: window.location.pathname, visibility: document.visibilityState,
      captchaApiHasRejectionMarker: typeof execute === 'function'
        ? Function.prototype.toString.call(execute).includes('extension_hijack_detected') : null };
  }

  function trace(url, body, status, text) {
    try {
      window.dispatchEvent(new CustomEvent('FLOWBOARD_BOQ_TRACE', {
        detail: {
          url: String(url),
          body: typeof body === 'string' ? body.slice(0, 200000) : null,
          status: status,
          head: String(text || '').slice(0, 4000),
          hasMedia: String(text || '').indexOf('flow-content.google') !== -1,
          context: pageContext(),
        },
      }));
    } catch (e) { /* ignore */ }
  }

  function report(url, body, text, status) {
    trace(url, body, status, text);
    if (typeof body !== 'string' || !body) return;
    if (String(text).indexOf('flow-content.google') === -1) return;
    try {
      window.dispatchEvent(new CustomEvent('FLOWBOARD_BOQ_SAMPLE', {
        detail: { url: String(url), body: body },
      }));
    } catch (e) { /* page tore down mid-flight */ }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__fbUrl = u;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__fbUrl && watched(this.__fbUrl) && !window.__flowboardSelfCall) {
      // Record before navigation to the new project can destroy this page.
      const textBody = bodyText(b);
      trace(this.__fbUrl, textBody, null, 'REQUEST_STARTED');
      const self = this;
      this.addEventListener('loadend', function () {
        try { report(self.__fbUrl, textBody, String(self.responseText || ''), self.status); } catch (e) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url);
    const watch = u && watched(u)
      && !window.__flowboardSelfCall;
    let body = Promise.resolve(null);
    if (watch) {
      if (init && init.body != null) body = Promise.resolve(bodyText(init.body));
      else if (typeof Request !== 'undefined' && input instanceof Request) {
        try { body = input.clone().text().catch(() => null); } catch (e) { /* consumed */ }
      }
      body.then(b => trace(u, b, null, 'REQUEST_STARTED')).catch(() => {});
    }
    // The observer never consumes the original body or delays the request.
    const res = await origFetch.apply(this, arguments);
    if (watch) {
      Promise.all([body, res.clone().text()])
        .then(([b, t]) => report(u, b, t, res.status)).catch(() => {});
    }
    return res;
  };
})();
