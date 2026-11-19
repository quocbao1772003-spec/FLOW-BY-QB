// Chụp UI thật (vite dev + agent tạm) ở 4 cỡ, mở tab Flow Music + Tài khoản.
// BASE=http://localhost:5191 node docs/design/flow-music/shoot-app.cjs
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'E:/handora-final/node_modules/playwright');

const BASE = process.env.BASE || 'http://localhost:5191';
const OUT = path.join(__dirname, 'shots-app');
fs.mkdirSync(OUT, { recursive: true });
const VPS = [[768, 1024], [1024, 768], [1366, 768], [1920, 1080]];

async function go(page, label) {
  await page.locator('.app-sidebar__item', { hasText: label }).first().click();
  await page.waitForTimeout(1500);
}

function lint() {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  for (const b of document.querySelectorAll('.music-page button, .music-page .accounts-btn, .music-badge, .mcp-card button, .accounts-page button')) {
    if (!vis(b)) continue;
    if (b.scrollWidth > b.clientWidth + 1) out.push(['CLIP', (b.textContent || b.title).trim().slice(0, 24)]);
    const range = document.createRange(); range.selectNodeContents(b);
    const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
    if (lines.size > 2) out.push(['WRAP', (b.textContent || '').trim().slice(0, 24)]);
  }
  for (const row of document.querySelectorAll('.music-qrow,.music-take,.music-lrow,.account-card,.mcp-card__token')) {
    if (!vis(row)) continue; const R = row.getBoundingClientRect();
    for (const c of row.querySelectorAll('button,a,.music-badge')) { if (!vis(c)) continue; const r = c.getBoundingClientRect(); if (r.right > R.right + 1) out.push(['CUT', row.className.slice(0, 18), (c.textContent || c.title || '').trim().slice(0, 20)]); }
  }
  for (const el of document.querySelectorAll('.music-h,.music-badge')) { if (!vis(el)) continue; if (el.getBoundingClientRect().height > 30) out.push(['WRAP-TXT', el.textContent.trim().slice(0, 24)]); }
  const page = document.querySelector('.page');
  if (page && page.scrollWidth > page.clientWidth + 1) out.push(['HSCROLL', page.scrollWidth - page.clientWidth]);
  return out;
}

(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
  const report = [];
  for (const [w, h] of VPS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'vi-VN' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(BASE, '')); });
    await page.goto(BASE);
    await page.waitForTimeout(2000);
    if (await page.locator('input[type=password]').count()) {
      await page.locator('input').first().fill('boss');
      await page.locator('input[type=password]').fill('secret123');
      await page.locator('input[type=password]').press('Enter');
      await page.waitForTimeout(2500);
    }
    await go(page, 'Flow Music');
    // mở rộng bài xong + phát thử bản 1
    const play = page.locator('.music-take .music-play').first();
    if (await play.count()) { await play.click(); await page.waitForTimeout(1200); }
    const pg = page.locator('.page').first();
    const shot = async (name) => {
      const issues = await page.evaluate(lint);
      report.push({ name: `${name}__${w}`, errs: [...errs], issues });
      await pg.evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `${name}__${w}.png`) });
      const full = await pg.evaluate((el) => el.scrollHeight);
      if (full > h + 40) { await pg.evaluate((el) => el.scrollTo(0, el.scrollHeight)); await page.waitForTimeout(300); await page.screenshot({ path: path.join(OUT, `${name}__${w}__end.png`) }); }
    };
    await shot('music-queue');
    await page.locator('.music-tabs .music-tab', { hasText: 'Thư viện' }).click();
    await page.waitForTimeout(800);
    const chk = page.locator('.music-song__chk');
    if (await chk.count() > 1) { await chk.nth(0).click({ force: true }); await chk.nth(1).click({ force: true }); }
    await page.waitForTimeout(400);
    await shot('music-library');
    await go(page, 'Tài khoản');
    await shot('accounts');
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'lint.json'), JSON.stringify(report, null, 1));
  for (const r of report) console.log(r.name, 'errs=' + r.errs.length, JSON.stringify(r.errs.slice(0, 3)), JSON.stringify(r.issues.slice(0, 6)));
})();
