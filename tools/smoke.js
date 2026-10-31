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

  /* mock of the Apps Script web app: code 1234 is a known employee; the game numbers are what the sheet would count */
  const ME = { ok: true, name: 'Smoke Test', branch: 'Test', xp: 1140, weekXp: 660, weekTests: 2, streak: 3, owlsMonth: 18, owlsTotal: 18, owlsCap: 50,
    badges: ['first', 'perfect', 'exam100'], exam: null,
    board: { people: [{ name: 'Smoke Test', branch: 'Test', xp: 660, me: true }, { name: 'Other', branch: 'Central Park', xp: 350, me: false }], rank: 1,
      branches: [{ branch: 'Central Park', xp: 70, staff: 5 }] } };
  await page.route('https://script.google.com/**', route => {
    const req = route.request(), url = new URL(req.url());
    let body;
    if (req.method() === 'POST') {
      const d = JSON.parse(req.postData()); posted.push(d);
      body = d.kind === 'exam' ? { ok: true, xp: 300, owls: [{ why: 'Экзамен месяца 100%', n: 15 }] } : { ok: true, xp: 90, owls: [] };
    }
    else if (url.searchParams.get('action') === 'me') body = ME;
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

  /* the new-drink banner, on a stand-in entry so the test does not depend on today's date */
  const spotId = await page.evaluate(() => {
    SPOTLIGHT.splice(0, SPOTLIGHT.length, { id: drinks[0].id, start: '2000-01-01', end: '2999-12-31' });
    renderDrinks(); return drinks[0].id;
  });
  check(await page.locator(`#spot-drinks .spot[data-open="${spotId}"] .pst.on`).count() === 1, 'spotlight banner shows a new drink on sale');
  await page.click('#spot-drinks .spot');
  check(await page.locator('#overlay.show').count() === 1 && (await page.locator('#sheetInner h2').innerText()) === await page.evaluate(id => drinkById[id].name, spotId), 'spotlight banner opens its drink');
  await page.keyboard.press('Escape');
  await page.fill('#q', 'zzzz');
  check(await page.locator('#spot-drinks .spot').count() === 0, 'spotlight banner hides while searching');
  await page.fill('#q', '');
  await page.evaluate(() => { SPOTLIGHT[0].end = '2000-01-02'; renderDrinks(); });
  check(await page.locator('#spot-drinks .spot').count() === 0, 'spotlight banner disappears after its end date');

  /* promo row: active ones first, inactive ones last, at three times of a weekday and on a Sunday */
  const order = await page.evaluate(() => {
    const RealDate = Date, out = [], R = { now: 0, later: 1, ended: 2, day: 2 };
    for (const t of ['2026-11-02T09:00', '2026-11-02T13:00', '2026-11-02T18:30', '2026-11-08T10:00']) {
      window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t])); } };
      renderPromos();
      const ks = [...document.querySelectorAll('#promos-drinks .promo')].map(e => R[promoStatus(promos.find(p => p.id === e.dataset.promo)).k]);
      out.push(ks.length === promos.length && ks.every((k, i) => !i || ks[i - 1] <= k));
    }
    window.Date = RealDate; renderPromos();
    return out;
  });
  check(order.every(Boolean), 'promos: active first, inactive last');

  /* text size (Dynamic Type) in «Ещё»: tokens scale, the tab bar doesn't, the choice survives a reload */
  const fsOf = sel => page.evaluate(s => parseFloat(getComputedStyle(document.querySelector(s)).fontSize), sel);
  await page.click('nav.tabs button[data-tab="more"]');
  const tab0 = await fsOf('nav.tabs button');
  await page.click('#morehub [data-ts="1"]'); await page.click('#morehub [data-ts="1"]');
  await page.reload(); await page.waitForTimeout(300);
  await page.click('nav.tabs button[data-tab="more"]');
  const big = { sample: await fsOf('#morehub .tsample'), tab: await fsOf('nav.tabs button') };
  check(Math.abs(big.sample - 15 * 1.24) < 0.1 && big.tab === tab0, 'text size A+ scales the text, keeps the tab bar, survives a reload');
  while (await page.locator('#morehub [data-ts="-1"]:not([disabled])').count()) await page.click('#morehub [data-ts="-1"]');
  check(Math.abs(await fsOf('#morehub .tsample') - 15 * 0.88) < 0.1 && await page.locator('#morehub [data-ts="-1"][disabled]').count() === 1, 'text size stops at the smallest step');
  await page.evaluate(() => setTextSize(1));
  await page.click('nav.tabs button[data-tab="drinks"]');

  /* a vitrina item with facts from the menu sheet: weight, storage, shelf life, nutrition */
  const vitSheet = async () => {
    await page.click('nav.tabs button[data-tab="vitrina"]');
    await page.locator('#vitgrid .card[data-open="honeycake"]').click();
    const t = await page.locator('#sheetInner').innerText();
    await page.keyboard.press('Escape');
    return t;
  };
  const vr = await vitSheet();
  check(['220 г', 'от +2 до +5 °C', '48 часов', '290 ккал', '~3,5 г'].every(s => vr.includes(s)), 'vitrina card: weight, storage, shelf life, nutrition (RU)');

  await page.click('#langbtn');
  check((await page.locator('#count').innerText()).includes('içki'), 'AZ: drink counter is Azerbaijani');
  await page.click('nav.tabs button[data-tab="preps"]');
  check(!/[А-Яа-яЁё]/.test(await page.getAttribute('#q', 'placeholder')), 'AZ: search placeholder has no Russian');
  const va = await vitSheet();
  check(['ÇƏKİ', '220 q', '2°C ilə 5°C arasında', '48 saat', '290 kkal'].every(s => va.includes(s)) && !/[А-Яа-яЁё]/.test(va), 'AZ: vitrina card facts are Azerbaijani');
  await page.click('#langbtn');

  const gen = await page.evaluate(() => {
    let bad = 0, total = 0, samePhoto = 0;
    const photo = k => (IMAGES[k] || '').split('.').slice(-2, -1)[0]; /* content hash from images/<key>.<hash>.webp */
    for (const lang of ['ru', 'az']) {
      setLang(lang);
      for (const scope of ['drinks', 'preps']) {
        L.scope = scope; L.cat = 'all'; L.kind = 'all';
        for (let i = 0; i < 40; i++) for (const q of buildQuiz(learnItems())) {
          total++;
          if (q.opts.length !== 4 || new Set(q.opts).size !== 4 || !q.opts.includes(q.correct) || q.opts.some(o => !o || /undefined|NaN/.test(o))) bad++;
          /* a photo question must not offer another drink that shows the very same picture */
          if (q.type === 'photo') {
            const h = photo(drinkById[q.id].img);
            if (q.opts.some(o => o !== q.correct && drinks.some(d => d.name === o && photo(d.img) === h))) samePhoto++;
          }
        }
      }
    }
    setLang('ru'); L.scope = 'drinks';
    return { bad, total, samePhoto };
  });
  check(gen.total > 0 && gen.bad === 0, `quiz generator: ${gen.total} questions, ${gen.bad} broken`);
  check(gen.samePhoto === 0, `photo questions: ${gen.samePhoto} offer a drink with the same photo`);

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
  check(p.kind === 'drinks' && (await page.locator('#learnroot #sendstat').innerText()).includes('+90 XP'), 'result says what kind of test it was and shows the XP it earned');
  check(Number.isInteger(p.secs) && p.timeouts === 0 && p.away === 0 && p.aborted === false, 'result carries time, timeouts, exits, aborted');

  /* honesty of a test: the countdown, leaving the app, aborting, a test closed half-way */
  const hideApp = () => page.evaluate(() => {
    for (const v of [true, false]) {
      Object.defineProperty(document, 'hidden', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await page.click('#learnroot [data-l="quiz"]');
  check(await page.locator('#learnroot #qtrow').count() === 1, 'test question shows a countdown');
  await page.evaluate(() => { L.qz.deadline = Date.now() - 1; });
  await page.waitForTimeout(500);
  check((await page.locator('#learnroot .fb').innerText()).includes(await page.evaluate(() => T('q_timeout'))), 'time running out counts the question as wrong');
  await page.click('#learnroot [data-l="next"]');
  await hideApp();
  check((await page.locator('#learnroot .fb').innerText()).includes('📵'), 'leaving the app counts the open question as wrong');
  await page.click('#learnroot [data-l="next"]');
  page.once('dialog', d => d.dismiss());
  await page.click('nav.tabs button[data-tab="drinks"]');
  check(await page.locator('#learnroot #qtrow').count() === 1 && posted.length === 1, 'a tab during a test asks first; «Cancel» stays in the test');
  page.once('dialog', d => d.accept());
  await page.click('nav.tabs button[data-tab="drinks"]');
  await page.waitForTimeout(500);
  const ab = posted[1] || {};
  check(posted.length === 2 && ab.aborted === true && ab.timeouts === 1 && ab.away === 1 && ab.score === 0 && ab.total > 2, 'an aborted test is sent as aborted with its checks');
  await page.click('nav.tabs button[data-tab="more"]');
  await page.click('#morehub [data-gotab="learn"]');
  await page.click('#learnroot [data-l="quiz"]');
  await page.locator('#learnroot [data-l="ans"]').first().click();
  await page.reload();
  await page.waitForTimeout(800);
  const cl = posted[2] || {};
  check(posted.length === 3 && cl.aborted === true && cl.mistakes.length + cl.score === 1, 'a test closed half-way reaches the sheet as aborted');

  /* the game: level, owls, board and badges come from the sheet; the monthly exam */
  await page.click('nav.tabs button[data-tab="more"]');
  await page.click('#morehub [data-gotab="learn"]');
  await page.waitForTimeout(400);
  const home = await page.locator('#learnroot').innerText();
  check(home.includes('1140 XP') && home.includes('🦉 18 / 50') && await page.locator('#learnroot .board li').count() === 2
    && await page.locator('#learnroot .bdg.on').count() === 3, 'game card, weekly board and badges come from the sheet');
  await page.click('#learnroot [data-l="board"][data-v="branches"]');
  check((await page.locator('#learnroot .board').innerText()).includes('Central Park'), 'board switches to branches');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exam"]');
  const ex = await page.evaluate(() => ({ n: L.qz.qs.length, kind: L.qz.kind, preps: L.qz.qs.filter(q => q.isPrep).length }));
  check(ex.n === 20 && ex.kind === 'exam' && ex.preps === 8, 'the monthly exam: 20 questions, drinks and preps together');
  for (let i = 0; i < 25 && await page.locator('#learnroot [data-l="ans"]').count(); i++) {
    await page.locator('#learnroot [data-l="ans"]').first().click();
    await page.click('#learnroot [data-l="next"]');
  }
  await page.waitForTimeout(500);
  const pe = posted[posted.length - 1] || {};
  check(pe.kind === 'exam' && pe.total === 20 && (await page.locator('#learnroot #sendstat').innerText()).includes('🦉 +15'), 'the exam is sent as the exam and shows the owls it earned');
  await page.click('#learnroot [data-l="home"]');
  check(await page.locator('#learnroot [data-l="exam"][disabled]').count() === 1, 'one exam a month: the tile locks after it');
  await page.unroute('https://script.google.com/**');
  await page.route('https://script.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, service: 'sensum-learn', version: 'v4' }) }));
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });  // the old script answers ?action=me with no game data
  await page.waitForTimeout(400);
  check(!(await page.locator('#learnroot').innerText()).includes('undefined') && await page.locator('#learnroot .game').count() === 0,
    'a sheet script older than v5: no game card, nothing broken');

  check(!(await page.evaluate(() => document.getElementById('scrollArea').scrollWidth > document.getElementById('scrollArea').clientWidth)), 'no horizontal scroll at 390px');
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

  /* the style guide renders the real components from index.html's stylesheet */
  const sg = await ctx.newPage(); const sgErr = [];
  sg.on('pageerror', e => sgErr.push(e.message)); sg.on('console', m => { if (m.type() === 'error') sgErr.push(m.text()); });
  await sg.goto(base.replace('index.html', 'styleguide.html'));
  await sg.waitForSelector('[data-sg-ready]', { timeout: 5000 }).catch(() => {});
  check(await sg.locator('.sg section').count() === 9 && await sg.locator('.sg .lbtn.pri').count() >= 1 && await sg.locator('.sg .card').count() === 2
    && !(await sg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) && sgErr.length === 0, 'style guide page renders every component without errors');
  await browser.close();
  server.close();
  console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall smoke checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('smoke test crashed:', e.message); server.close(); process.exit(1); });
