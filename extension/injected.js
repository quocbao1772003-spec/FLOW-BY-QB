/**
 * Injected into the page's MAIN world on flow.google.com — has access to window.grecaptcha.
 *
 * Used solely for reCAPTCHA solving. Media urls still come back on the
 * generation response itself, so no response interception is needed here.
 */
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// All bridge operations share this queue, including BOQ image/upload/upscale.
let captchaMintTail = Promise.resolve();

async function mintCaptcha(pageAction, siteKey) {
  const previous = captchaMintTail.catch(() => {});
  let release;
  captchaMintTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    await waitForGrecaptcha();
    const api = window.__flowboardCaptchaApi;
    if (!api) throw new Error('CAPTCHA_BRIDGE_RELOAD_REQUIRED');
    return await api.execute(siteKey || window.WIZ_global_data?.xZbWve || SITE_KEY, { action: pageAction });
  } finally {
    release();
  }
}

window.__flowboardMintCaptcha = mintCaptcha;

window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    const token = await mintCaptcha(pageAction);
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, token },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, error: e.message },
    }));
  }
});

function waitForGrecaptcha(timeout = 22000) {   // lazily loaded; 10s was optimistic
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.grecaptcha?.enterprise?.execute) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
      setTimeout(check, 200);
    };
    check();
  });
}
