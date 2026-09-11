/**
 * Content script — bridge between background.js and injected.js.
 * Injects injected.js into MAIN world and forwards GET_CAPTCHA messages.
 */
(function () {
  for (const file of ['injected.js', 'boq-monitor.js']) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(file);
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }
})();

// The monitor lives in the MAIN world and cannot talk to the extension
// directly; relay its samples across the isolated-world boundary.
window.addEventListener('FLOWBOARD_BOQ_SAMPLE', (e) => {
  try {
    chrome.runtime.sendMessage({ type: 'BOQ_SAMPLE', sample: e.detail });
  } catch (err) { /* worker asleep — the next sample will do */ }
});

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type !== 'GET_CAPTCHA') return;

  const { requestId, pageAction } = msg;

  const handler = (e) => {
    if (e.detail?.requestId === requestId) {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      clearTimeout(timer);
      reply({ token: e.detail.token, error: e.detail.error });
    }
  };

  const timer = setTimeout(() => {
    window.removeEventListener('CAPTCHA_RESULT', handler);
    reply({ error: 'CONTENT_TIMEOUT' });
  }, 25000);

  window.addEventListener('CAPTCHA_RESULT', handler);

  window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
    detail: { requestId, pageAction },
  }));

  return true; // keep channel open for async reply
});
