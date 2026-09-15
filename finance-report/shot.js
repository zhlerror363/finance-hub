// shot.js — screenshot finance year/range reports
const { chromium } = require('playwright-core');
const path = require('path');

const CHROME = 'C:/Users/lzhh/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const SHOTS = 'E:/DSHWorkspace/02-zcode/finance-report/shots';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const p = await ctx.newPage();

  const targets = [
    ['file:///E:/DSHWorkspace/02-zcode/finance-report/tests/out-2026-08.html', '01-month-2026-08.png'],
    ['file:///E:/DSHWorkspace/02-zcode/finance-report/year_2026.html', '02-year-2026-full.png'],
    ['file:///E:/DSHWorkspace/02-zcode/finance-report/range_2026_h1.html', '03-range-2026-h1.png'],
  ];

  for (const [url, name] of targets) {
    await p.goto(url);
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(SHOTS, name), fullPage: true });
    console.log('OK', name);
  }

  // 4: per-section screenshots of year report
  await p.goto('file:///E:/DSHWorkspace/02-zcode/finance-report/year_2026.html');
  await p.waitForTimeout(400);
  const sections = await p.$$('.section');
  const secNames = ['overview', 'bars', 'trend', 'cats', 'yoy', 'mom', 'monthcards'];
  for (let i = 0; i < sections.length; i++) {
    const name = `04-year-${secNames[i] || ('sec' + (i+1))}.png`;
    await sections[i].scrollIntoViewIfNeeded();
    await sections[i].screenshot({ path: path.join(SHOTS, name) });
    console.log('OK', name);
  }

  await ctx.close();
  await browser.close();
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
