// Chụp prototype Flow Music ở 5 cỡ × sáng/tối + lint bố cục.
// node docs/design/flow-music/shoot.cjs   (Playwright mượn từ E:/handora-final/node_modules)
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require(process.env.PW || 'E:/handora-final/node_modules/playwright');

const DIR = __dirname;
const OUT = path.join(DIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = pathToFileURL(path.join(DIR, 'prototype.html')).href;
const VPS = [[390, 844], [768, 1024], [1024, 768], [1366, 768], [1920, 1080]];
const SCENES = [
  ['music-queue', 'view=music&tab=queue', VPS],
  ['music-compose-mobile', 'view=music&tab=compose', [[390, 844]]],
  ['music-library', 'view=music&tab=lib&sel=1,4&play=l2', VPS],
  ['music-library-table', 'view=music&tab=lib&lib=table&sel=0', [[1366, 768]]],
  ['music-noacc', 'view=music&state=noacc', [[390, 844], [1366, 768]]],
  ['music-empty', 'view=music&state=empty', [[1366, 768]]],
  ['accounts', 'view=accounts', VPS],
  ['accounts-fresh-link', 'view=accounts&fresh=1', [[390, 844], [1366, 768]]],
];

function lint() {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  for (const b of document.querySelectorAll('.btn,.badge,.tab,.fchip,.nav,.seg button')) {
    if (!vis(b)) continue;
    const lh = parseFloat(getComputedStyle(b).lineHeight) || 20;
    const r = b.getBoundingClientRect();
    if (b.scrollWidth > b.clientWidth + 1) out.push(['CLIP', b.className, b.textContent.trim().slice(0, 30)]);
    const range = document.createRange(); range.selectNodeContents(b);
    const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
    if (lines.size > 2 && r.height > 44) out.push(['WRAP', b.className, b.textContent.trim().slice(0, 30)]);
  }
  for (const el of document.querySelectorAll('[data-role]')) {
    if (!vis(el)) continue;
    if (el.getBoundingClientRect().height > (parseFloat(getComputedStyle(el).lineHeight) || 20) * 1.6) out.push(['ROLE-LINES', el.dataset.role, el.textContent.trim().slice(0, 30)]);
  }
  for (const el of document.querySelectorAll('.card,.qrow,.acc,.svc,.kpi,.song')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 1) out.push(['OVERFLOW-X', el.className.slice(0, 30), Math.round(r.right - innerWidth)]);
  }
  for (const row of document.querySelectorAll('.qrow,.take,.acc,.svc,.tok,.lrow')) {
    if (!vis(row)) continue; const R = row.getBoundingClientRect();
    for (const c of row.querySelectorAll('button,.badge')) { if (!vis(c)) continue; const r = c.getBoundingClientRect(); if (r.right > R.right + 1) out.push(['CUT', row.className.slice(0, 20), (c.textContent || c.title || '').trim().slice(0, 20)]); }
  }
  for (const el of document.querySelectorAll('.svc__l1 span,.qtitle div,.acc__who div')) { if (!vis(el)) continue; if (el.getBoundingClientRect().height > 26) out.push(['WRAP-TXT', el.className, el.textContent.trim().slice(0, 30)]); }
  // cùng nhóm cùng cao
  for (const sel of ['.kpi', '.svc', '.song']) {
    const hs = [...document.querySelectorAll(sel)].filter(vis).map((e) => Math.round(e.getBoundingClientRect().height));
    if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 2) out.push(['CARD-HEIGHT', sel, hs.join('/')]);
  }
  out.push(['HSCROLL', document.scrollingElement.scrollWidth - innerWidth]);
  return out.filter((x) => !(x[0] === 'HSCROLL' && x[1] <= 0));
}

(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
  const report = [];
  for (const [name, q, vps] of SCENES) {
    for (const theme of ['dark', 'light']) {
      for (const [w, h] of vps) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'vi-VN', deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(String(e)));
        await page.goto(`${BASE}?${q}&theme=${theme}&nomock=1`);
        await page.waitForTimeout(700);
        const file = `${name}__${w}__${theme}.png`;
        await page.screenshot({ path: path.join(OUT, file), fullPage: true });
        const issues = await page.evaluate(lint);
        report.push({ file, errs, issues });
        await ctx.close();
      }
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'lint.json'), JSON.stringify(report, null, 1));
  const bad = report.filter((r) => r.errs.length || r.issues.length);
  console.log(`shots=${report.length} with_issues=${bad.length}`);
  for (const r of bad) console.log(r.file, JSON.stringify(r.errs), JSON.stringify(r.issues.slice(0, 6)));
})();
