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

  function report(url, body, text) {
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
    if (this.__fbUrl && String(this.__fbUrl).indexOf(ENDPOINT) !== -1 && !window.__flowboardSelfCall) {
      const self = this;
      this.addEventListener('loadend', function () {
        try { report(self.__fbUrl, b, String(self.responseText || '')); } catch (e) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url);
    const watch = u && String(u).indexOf(ENDPOINT) !== -1
      && !window.__flowboardSelfCall
      && init && typeof init.body === 'string';
    const res = await origFetch.apply(this, arguments);
    if (watch) {
      res.clone().text().then(function (t) { report(u, init.body, t); }).catch(function () {});
    }
    return res;
  };
})();
