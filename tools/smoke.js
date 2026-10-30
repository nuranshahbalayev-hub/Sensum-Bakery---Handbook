#!/usr/bin/env node
/* Browser smoke test of the whole app: node tools/smoke.js
 *
 * Serves the repo root on a local port and drives it in headless Chromium at phone width.
 * The Apps Script web app is replaced by an in-page mock (requests to RESULTS_URL are
 * intercepted), so the test never writes to the real results sheet or pings Telegram.
 * Needs Playwright (preinstalled in Claude Code cloud sessions). Exit code 1 on any failure.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const fails = [];
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails.push(what); };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [], posted = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  /* mock of the Apps Script web app: code 1234 is a known employee */
  await page.route('https://script.google.com/**', route => {
    const req = route.request(), url = new URL(req.url());
    let body;
    if (req.method() === 'POST') { posted.push(JSON.parse(req.postData())); body = { ok: true }; }
    else if (url.searchParams.get('action') === 'whoami') {
      body = url.searchParams.get('code') === '1234' ? { ok: true, name: 'Smoke Test', branch: 'Test' } : { ok: false, error: 'unknown_code' };
    } else body = { ok: true, service: 'sensum-learn', version: 'mock' };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });

  await page.goto(base);
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() => ({ drinks: drinks.length, preps: preps.length, vit: vit.length }));
  check(await page.locator('#grid .card').count() === counts.drinks, `drinks grid shows all ${counts.drinks} drinks`);

  for (const t of ['preps', 'vitrina', 'fav', 'more', 'drinks']) {
    await page.click(`nav.tabs button[data-tab="${t}"]`);
    check(await page.locator(`#v-${t}.on`).count() === 1, `tab «${t}» opens`);
  }
  await page.locator('#grid .card').first().click();
  check(await page.locator('#overlay.show').count() === 1, 'drink card opens');
  await page.keyboard.press('Escape');
  check(await page.locator('#overlay.show').count() === 0, 'card closes with Escape');

  await page.click('#langbtn');
  check((await page.locator('#count').innerText()).includes('içki'), 'AZ: drink counter is Azerbaijani');
  await page.click('nav.tabs button[data-tab="preps"]');
  check(!/[А-Яа-яЁё]/.test(await page.getAttribute('#q', 'placeholder')), 'AZ: search placeholder has no Russian');
  await page.click('#langbtn');

  const gen = await page.evaluate(() => {
    let bad = 0, total = 0;
    for (const lang of ['ru', 'az']) {
      setLang(lang);
      for (const scope of ['drinks', 'preps']) {
        L.scope = scope; L.cat = 'all'; L.kind = 'all';
        for (let i = 0; i < 40; i++) for (const q of buildQuiz(learnItems())) {
          total++;
          if (q.opts.length !== 4 || new Set(q.opts).size !== 4 || !q.opts.includes(q.correct) || q.opts.some(o => !o || /undefined|NaN/.test(o))) bad++;
        }
      }
    }
    setLang('ru'); L.scope = 'drinks';
    return { bad, total };
  });
  check(gen.total > 0 && gen.bad === 0, `quiz generator: ${gen.total} questions, ${gen.bad} broken`);

  await page.click('nav.tabs button[data-tab="more"]');
  await page.click('#morehub [data-gotab="learn"]');
  await page.evaluate(() => { LS.me = null; LS.outbox = []; renderLearn(); });
  await page.fill('#lcode', '9999');
  await page.click('#learnroot [data-l="login"]');
  await page.waitForTimeout(300);
  check((await page.locator('#idstat').innerText()).length > 0 && await page.locator('#learnroot .idrow').count() === 0, 'unknown employee code is refused');
  await page.fill('#lcode', '1234');
  await page.click('#learnroot [data-l="login"]');
  await page.waitForSelector('#learnroot .idrow', { timeout: 5000 }).catch(() => {});
  check(await page.locator('#learnroot .idrow').count() === 1, 'employee code logs in');
  await page.click('#learnroot [data-l="quiz"]');
  for (let i = 0; i < 15 && await page.locator('#learnroot [data-l="ans"]').count(); i++) {
    await page.locator('#learnroot [data-l="ans"]').first().click();
    await page.click('#learnroot [data-l="next"]');
  }
  await page.waitForTimeout(500);
  check(await page.locator('#learnroot .score').count() === 1, 'quiz reaches the result screen');
  const p = posted[0] || {};
  check(posted.length === 1 && p.code === '1234' && p.total > 0 && Array.isArray(p.mistakes) && p.ver, 'result is sent once with code, score, mistakes, version');

  check(!(await page.evaluate(() => document.getElementById('scrollArea').scrollWidth > document.getElementById('scrollArea').clientWidth)), 'no horizontal scroll at 390px');
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  server.close();
  console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall smoke checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('smoke test crashed:', e.message); server.close(); process.exit(1); });
