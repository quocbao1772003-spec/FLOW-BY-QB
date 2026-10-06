/**
 * Content script — bridge between background.js and injected.js.
 * Injects injected.js into MAIN world and forwards GET_CAPTCHA messages.
 */
// injected.js and boq-monitor.js are registered in manifest.json as MAIN-world
// content scripts at document_start. Injecting them again from here via a
// <script src> tag ran injected.js twice and — once boq-monitor.js dropped out
// of web_accessible_resources on 28/9 — silently failed to load the monitor,
// which switched off template relearning entirely.

// The monitor lives in the MAIN world and cannot talk to the extension
// directly; relay its samples across the isolated-world boundary.
window.addEventListener('FLOWBOARD_BOQ_SAMPLE', (e) => {
  try {
    chrome.runtime.sendMessage({ type: 'BOQ_SAMPLE', sample: e.detail });
  } catch (err) { /* worker asleep — the next sample will do */ }
});

window.addEventListener('FLOWBOARD_BOQ_TRACE', (e) => {
  try {
    chrome.runtime.sendMessage({ type: 'BOQ_TRACE', trace: e.detail });
  } catch (err) { /* worker asleep */ }
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
