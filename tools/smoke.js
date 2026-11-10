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
  const errors = [], posted = [], progPosts = [], progressDb = {};
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  /* mock of the Apps Script web app: code 1234 is a known employee; the game numbers are what the sheet would count */
  let mockOver = false;  /* the sheet says the result was over the weekly limit */
  const ME = { ok: true, level: 'barista', name: 'Smoke Test', branch: 'Test', progressProtocol: 2, passThreshold: 0.7, xp: 1140, weekXp: 660, weekTests: 2, streak: 3, owlsMonth: 18, owlsTotal: 18, owlsCap: 50,
    badges: ['first', 'perfect', 'exam100'], exam: null,
    board: { people: [{ name: 'Smoke Test', branch: 'Test', xp: 660, me: true }, { name: 'Other', branch: 'Central Park', xp: 350, me: false }], rank: 1,
      branches: [{ branch: 'Central Park', xp: 70, staff: 5 }] } };
  await page.route('https://script.google.com/**', route => {
    const req = route.request(), url = new URL(req.url());
    let body;
    if (req.method() === 'POST') {
      const d = JSON.parse(req.postData());
      if (d.action === 'progress') {  /* protocol 2: patch changed cards, keep other devices' cards */
        progPosts.push(d);
        const old = progressDb[d.code] || { read: [], box: {}, ts: 0, clocks: {} };
        const box = Object.assign({}, old.box), clocks = Object.assign({}, old.clocks);
        Object.entries(d.changes || {}).forEach(([k, c]) => {
          if (c.ifAbsent && k in box) return;
          if (c.ts > (clocks[k] || 0) || (c.ts === clocks[k] && c.v < box[k])) { box[k] = c.v; clocks[k] = c.ts; }
        });
        progressDb[d.code] = { read: [...new Set([...old.read, ...d.read])], box, clocks, ts: Math.max(Date.now(), old.ts + 1, d.ts) };
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, progress: progressDb[d.code] }) });
        return;
      }
      posted.push(d);
      body = d.kind === 'exam' ? { ok: true, xp: 300, owls: [{ why: 'Экзамен месяца 100%', n: 15 }] } : d.kind === 'daily' ? { ok: true, xp: 50, owls: [], daily: { done: true, streak: 3 } } : { ok: true, xp: mockOver ? 0 : 90, owls: [], over: mockOver };
    }
    else if (url.searchParams.get('action') === 'me') body = Object.assign({}, ME, { progress: progressDb[url.searchParams.get('code')] || { read: [], box: {}, ts: 0 } });
    else if (url.searchParams.get('action') === 'whoami') {
      body = ['1234', '5678'].includes(url.searchParams.get('code')) ? { ok: true, name: url.searchParams.get('code') === '1234' ? 'Smoke Test' : 'Second Person', branch: 'Test', level: ME.level } : { ok: false, error: 'unknown_code' };
    } else body = { ok: true, service: 'sensum-learn', version: 'mock' };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });

  await page.goto(base);
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() => ({ drinks: drinks.length, preps: preps.length, vit: vit.length }));
  check(await page.locator('#grid .card').count() === counts.drinks, `drinks grid shows all ${counts.drinks} drinks`);

  for (const t of ['preps', 'vitrina', 'learn', 'more', 'drinks']) {
    await page.click(`nav.tabs button[data-tab="${t}"]`);
    check(await page.locator(`#v-${t}.on`).count() === 1, `tab «${t}» opens`);
  }
  /* «Обучение» is a tab, «Избранное» moved under «Ещё» */
  check(await page.locator('nav.tabs button[data-tab="fav"]').count() === 0 && (await page.locator('nav.tabs button[data-tab="learn"]').innerText()).includes('Обучение'),
    'tab bar: «Обучение» instead of «Избранное»');
  await page.locator('#grid .card .fav').first().click();
  await page.click('nav.tabs button[data-tab="more"]');
  check((await page.locator('#morehub [data-gotab="fav"]').innerText()).includes('Сохранено: 1') && await page.locator('#morehub [data-gotab="learn"]').count() === 0, '«Ещё»: a tile for the favorites with their count, no training tile');
  await page.click('#morehub [data-gotab="fav"]');
  check(await page.locator('#v-fav.on').count() === 1 && await page.locator('#favgrid .card').count() === 1 && await page.locator('nav.tabs button[data-tab="more"].on').count() === 1
    && (await page.locator('#favTitle').innerText()) === 'Избранное', 'favorites open from «Ещё», with «Ещё» highlighted and their own title');
  await page.click('#v-fav .back');
  check(await page.locator('#v-more.on').count() === 1, 'favorites: back returns to «Ещё»');
  await page.click('nav.tabs button[data-tab="drinks"]');
  await page.locator('#grid .card .fav.on').first().click();
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
  check(await page.locator('#promos-drinks').isHidden(), 'drinks: the promos hide while searching');
  await page.evaluate(() => tickPromos());
  check(await page.locator('#promos-drinks').isHidden(), 'drinks: a promo tick does not bring them back during a search');
  await page.fill('#q', '');
  check(await page.locator('#promos-drinks .promo').first().isVisible(), 'drinks: the promos are back when the search is cleared');
  await page.fill('#q', 'zzzz');
  await page.click('#clr');
  check(await page.locator('#promos-drinks .promo').first().isVisible(), 'drinks: the clear button brings the promos back');
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
  /* the vitrina promos give way to a search too, and a search of one tab does not hide the other tab's promos */
  check(await page.locator('#promos-vit .promo').first().isVisible(), 'vitrina: the promos show without a search');
  await page.fill('#q', 'zzzz');
  check(await page.locator('#promos-vit').isHidden() && await page.locator('#vitgrid .card').count() === 0, 'vitrina: the promos hide while searching');
  await page.click('nav.tabs button[data-tab="drinks"]');
  check(await page.locator('#promos-drinks .promo').first().isVisible(), 'a search in the vitrina leaves the drinks promos alone');
  await page.click('nav.tabs button[data-tab="vitrina"]');
  check(await page.locator('#promos-vit').isHidden(), 'vitrina: the search and the hidden promos survive a tab switch');
  await page.fill('#q', '');
  check(await page.locator('#promos-vit .promo').first().isVisible(), 'vitrina: the promos are back when the search is cleared');
  /* the preps tab has no such block today; whatever is marked `.topblock` there (a future notice) gives way the same way */
  await page.click('nav.tabs button[data-tab="preps"]');
  await page.evaluate(() => { const d = document.createElement('div'); d.id = 'tb-test'; d.className = 'topblock'; d.textContent = 'notice'; document.getElementById('v-preps').prepend(d); });
  check(await page.locator('#tb-test').isVisible(), 'preps: a top block shows without a search');
  await page.fill('#q', 'zzzz');
  check(await page.locator('#tb-test').isHidden(), 'preps: a top block hides while searching');
  await page.fill('#q', '');
  check(await page.locator('#tb-test').isVisible(), 'preps: a top block is back when the search is cleared');
  await page.evaluate(() => document.getElementById('tb-test').remove());

  await page.click('#langbtn');
  check((await page.locator('#count').innerText()).includes('içki'), 'AZ: drink counter is Azerbaijani');
  await page.click('nav.tabs button[data-tab="preps"]');
  check(!/[А-Яа-яЁё]/.test(await page.getAttribute('#q', 'placeholder')), 'AZ: search placeholder has no Russian');
  const va = await vitSheet();
  check(['Çəki', '220 q', '2°C ilə 5°C arasında', '48 saat', '290 kkal'].every(s => va.includes(s)) && !/[А-Яа-яЁё]/.test(va), 'AZ: vitrina card facts are Azerbaijani');
  await page.click('#langbtn');

  const gen = await page.evaluate(() => {
    let bad = 0, total = 0, samePhoto = 0;
    const photo = k => (IMAGES[k] || '').split('.').slice(-2, -1)[0]; /* content hash from images/<key>.<hash>.webp */
    for (const lang of ['ru', 'az']) {
      setLang(lang);
      for (const scope of ['drinks', 'preps']) {
        L.scope = scope; L.cat = 'all'; L.kind = 'all';
        for (let i = 0; i < 40; i++) for (const q of buildQuiz(scope === 'drinks' ? trainable(drinks) : trainable(preps), scope)) {
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

  /* exam-style questions across recipes: exactly one option is right, checked here against the recipes themselves */
  const exs = await page.evaluate(() => {
    const out = { n: {}, bad: [] }, NEW = ['has', 'without', 'both', 'most', 'least', 'same'];
    const exact = (d, k) => d.ing.some(([n]) => n.toLowerCase() === k);
    const dose = (d, k, u) => { for (const [n, qq] of d.ing) if (n.toLowerCase() === k) { const p = parseQ(qq); if (p && p.u === u) return p.n; } return null; };
    for (const lang of ['ru', 'az']) {
      setLang(lang); L.scope = 'drinks'; L.cat = 'all';
      const by = Object.fromEntries(drinks.map(d => [d.name, d]));
      for (let i = 0; i < 60; i++) for (const q of buildQuiz(trainable(drinks), 'drinks')) {
        if (!NEW.includes(q.type)) continue;
        out.n[lang + q.type] = (out.n[lang + q.type] || 0) + 1;
        const ds = q.opts.map(o => by[o]), right = by[q.correct], m = q.meta || {};
        const wrong = ds.filter(d => d !== right);
        let ok = ds.every(Boolean) && !!right && wrong.length === 3 && !!q.explain && !/undefined|NaN/.test(q.text + q.explain);
        if (ok && q.type === 'has') ok = exact(right, m.k) && wrong.every(d => !exact(d, m.k));
        if (ok && q.type === 'without') ok = !exact(right, m.k) && wrong.every(d => exact(d, m.k));
        if (ok && q.type === 'both') ok = exact(right, m.ka) && exact(right, m.kb) && wrong.every(d => !(exact(d, m.ka) && exact(d, m.kb)));
        if (ok && (q.type === 'most' || q.type === 'least')) {
          const rv = dose(right, m.k, m.u), more = q.type === 'most';
          ok = rv !== null && wrong.every(d => { const v = dose(d, m.k, m.u); return v !== null && (more ? v < rv : v > rv) && Math.abs(v - rv) / Math.max(v, rv) >= 0.1; });
        }
        if (ok && q.type === 'same') ok = dose(right, m.k, m.u) === m.v && wrong.every(d => { const v = dose(d, m.k, m.u); return v !== null && v !== m.v; });
        if (!ok) out.bad.push(lang + ':' + q.type + ':' + q.id);
      }
    }
    setLang('ru');
    return out;
  });
  const exTotal = Object.values(exs.n).reduce((a, b) => a + b, 0);
  check(exs.bad.length === 0 && exTotal > 0, `exam-style recipe questions: ${exTotal} checked against the recipes, ${exs.bad.length} with a wrong or doubtful answer${exs.bad.length ? ' (' + exs.bad.slice(0, 3).join(', ') + ')' : ''}`);
  /* the vitrina: every generated question is checked against the data, in both languages */
  const vq = await page.evaluate(() => {
    const out = { n: {}, bad: [] };
    const has = (x, k) => { const t = x.desc.toLowerCase(), a = k.toLowerCase(), w = (a.match(/[a-zа-яёəıöüçşğ]+/i) || [''])[0]; return t.includes(a) || (w.length > 3 && t.includes(w)); };
    for (const lang of ['ru', 'az']) {
      setLang(lang);
      for (const x of vit) for (let rep = 0; rep < 8; rep++) for (const g of ['vcomp', 'vhas', 'vnot', 'valg', 'vstor', 'vlife']) {
        const q = GEN[g](x); if (!q) continue;
        out.n[lang + g] = (out.n[lang + g] || 0) + 1;
        const right = q.correct, wrong = q.opts.filter(o => o !== right), tag = lang + ' ' + g + ' ' + x.id;
        if (q.opts.length !== 4 || new Set(q.opts.map(o => o.toLowerCase())).size !== 4 || wrong.length !== 3) { out.bad.push(tag + ': options'); continue; }
        if (g === 'vcomp' && (!has(x, right) || wrong.some(o => has(x, o)))) out.bad.push(tag + ': composition');
        if (g === 'vhas') { const k = q.meta.k; if (!has(x, k) || vit.filter(d => wrong.includes(d.name)).some(d => has(d, k)) || q.correct !== x.name) out.bad.push(tag + ': has'); }
        if (g === 'vnot' && (has(x, right) || wrong.some(o => !has(x, o)))) out.bad.push(tag + ': not');
        if (g === 'valg') { const a = x.alg, fam = k => k.split('_')[0], lab = k => ALG[k], own = [...a.has, ...a.may].map(fam);
          if (!a.has.some(k => lab(k) === right) || wrong.some(o => Object.keys(ALG).some(k => lab(k) === o && own.includes(fam(k))))) out.bad.push(tag + ': allergen'); }
        if (g === 'vstor') { const [lo, hi] = x.stor; if (right !== storTxt(x.stor) || wrong.some(o => o === right)) out.bad.push(tag + ': storage'); }
        if (g === 'vlife' && (right !== lifeTxt(x.life) || wrong.includes(right))) out.bad.push(tag + ': life');
      }
    }
    setLang('ru');
    return out;
  });
  const vqTotal = Object.values(vq.n).reduce((a, b) => a + b, 0);
  check(vq.bad.length === 0 && vqTotal > 0 && ['vcomp', 'vhas', 'vnot', 'valg', 'vstor', 'vlife'].every(g => vq.n['ru' + g] && vq.n['az' + g]),
    `vitrina questions: ${vqTotal} checked against the data in both languages, ${vq.bad.length} wrong or doubtful${vq.bad.length ? ' (' + vq.bad.slice(0, 3).join(', ') + ')' : ''}`);
  check(['has', 'without', 'both', 'same'].every(k => exs.n['ru' + k] && exs.n['az' + k]) && (exs.n.rumost || 0) + (exs.n.ruleast || 0) > 0 && (exs.n.azmost || 0) + (exs.n.azleast || 0) > 0,
    'exam-style recipe questions: every kind appears in both languages');

  await page.click('nav.tabs button[data-tab="learn"]');
  await page.evaluate(() => { switchUser(null); LS.outbox = []; renderLearn(); });
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
  check(p.kind === 'mixed' && (await page.locator('#learnroot #sendstat').innerText()).includes('+90 XP'), 'result says what kind of test it was and shows the XP it earned');
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
  await page.click('nav.tabs button[data-tab="learn"]');
  await page.click('#learnroot [data-l="quiz"]');
  await page.locator('#learnroot [data-l="ans"]').first().click();
  await page.reload();
  await page.waitForTimeout(800);
  const cl = posted[2] || {};
  check(posted.length === 3 && cl.aborted === true && cl.mistakes.length + cl.score === 1, 'a test closed half-way reaches the sheet as aborted');

  /* theory: the question bank, its four kinds of question, the filters, both languages */
  const th = await page.evaluate(() => {
    const out = { total: 0, bad: [], types: {} };
    for (const lang of ['ru', 'az']) {
      setLang(lang);
      if (!TH.length || !Object.keys(TDIRS).length || !Object.keys(TTOPICS).length) out.bad.push(lang + ': no theory data');
      for (const t of TH) for (let i = 0; i < 5; i++) {
        const q = mkTheoryQ(t), o = q.opts || [];
        out.total++; out.types[q.tt] = (out.types[q.tt] || 0) + 1;
        const fine = q.text && q.correct && !/undefined|NaN/.test(q.text + q.correct + o.join()) && (q.tt === 'num' ? Number.isFinite(q.val)
          : o.length === 4 && new Set(o).size === 4 && (q.tt === 'one' ? o.includes(q.correct) : q.tt === 'multi' ? q.set.length >= 2 && q.set.every(x => o.includes(x))
            : [...q.seq].sort().join('|') === [...o].sort().join('|')));
        if (!fine) out.bad.push(lang + ':' + t.id);
      }
    }
    setLang('ru');
    return out;
  });
  check(th.total > 0 && th.bad.length === 0 && ['one', 'multi', 'order', 'num'].every(k => th.types[k]),
    `theory questions: ${th.total} built in both languages, ${th.bad.length} broken${th.bad.length ? ' (' + th.bad.slice(0, 3).join(', ') + ')' : ''}`);


  await page.click('nav.tabs button[data-tab="learn"]');
  /* the general test takes theory only from the topics whose lessons were all counted; a topic without lessons is open from the start */
  await page.evaluate(() => { LS.read = {}; saveLearn(); L.lvlAll = true; renderLearn(); });
  const openTopics = () => page.evaluate(() => [...passedTopics()].sort());
  const LESSON_TOPICS = new Set(await page.evaluate(() => LES.map(l => l.topic)));
  const noRead = await openTopics();
  /* every topic with questions has lessons now: until something is read, only the topics without any lesson (here MN-1: the recipes are generated) are open */
  check(noRead.every(k => !LESSON_TOPICS.has(k)) && (await page.locator('#learnroot').innerText()).includes('открыто тем 0 из'), 'theory: nothing read, no theory topic is open, and the home says so');
  /* the brand needs its lessons like every other topic */
  await page.evaluate(() => { LES.filter(l => l.topic === 'BR-1').slice(0, 5).forEach(l => { LS.read[l.id] = 1; }); });
  check(!(await openTopics()).includes('BR-1'), 'theory: five of the six brand lessons do not open BR-1');
  await page.evaluate(() => { LES.filter(l => l.topic === 'BR-1').forEach(l => { LS.read[l.id] = 1; }); });
  check((await openTopics()).includes('BR-1') && !(await openTopics()).includes('BR-2'), 'theory: all six lessons of BR-1: it opens, BR-2 stays closed');
  await page.evaluate(() => { LS.read = {}; });
  await page.evaluate(() => { LS.read['cf-origin'] = 1; });
  check(!(await openTopics()).includes('CF-1'), 'theory: one of the two lessons of a topic does not open it');
  await page.evaluate(() => { LS.read['cf-farm'] = 1; });
  check((await openTopics()).includes('CF-1') && !(await openTopics()).includes('CF-2'), 'theory: all lessons of a topic read: that topic opens, the others stay closed');
  check(await page.evaluate(() => theoryPool().every(t => passedTopics().has(t.topic))), 'theory: the pool of the test holds questions only from open topics');
  await page.evaluate(() => { L.lvlAll = false; saveLearn(); renderLearn(); });
  /* the composition of the general test: 3 drinks, 2 preps, 2 vitrina, 3 theory of open topics (10 in all); the theory that is missing is made up from the recipes in turn */
  const mixComp = () => page.evaluate(() => { const qs = composeQuestions(MIX_N, true);
    return { n: qs.length, th: qs.filter(q => q.isTheory).length, d: qs.filter(q => !q.isTheory && !q.isPrep && !q.isVit).length, p: qs.filter(q => q.isPrep).length, v: qs.filter(q => q.isVit).length,
      topics: [...new Set(qs.filter(q => q.isTheory).map(q => TH.find(t => t.id === q.id).topic))] }; });
  await page.evaluate(() => { LS.read = {}; });
  let mc = await mixComp();
  check(mc.n === 10 && mc.th === 0 && mc.d === 4 && mc.p === 3 && mc.v === 3, 'general test: nothing read: no theory, the three missing are made up from the recipes (4 + 3 + 3) (' + JSON.stringify(mc) + ')');
  await page.evaluate(() => { LES.forEach(l => { LS.read[l.id] = 1; }); });
  let okMix = true; for (let i = 0; i < 15; i++) { mc = await mixComp(); okMix = okMix && mc.n === 10 && mc.th === 3 && mc.d === 3 && mc.p === 2 && mc.v === 2; }
  check(okMix, 'general test: 10 questions = 3 drinks + 2 preps + 2 vitrina + 3 theory, every time');
  await page.evaluate(() => { LS.read = {}; LES.filter(l => l.topic === 'CF-8').forEach(l => { LS.read[l.id] = 1; }); });
  const cf8n = await page.evaluate(() => TH.filter(t => t.topic === 'CF-8' && LVL_RANK[t.lvl] <= LVL_RANK[myLvl() || 'senior']).length);
  mc = await mixComp();
  check(mc.n === 10 && mc.th === Math.min(3, cf8n) && mc.topics.every(k => k === 'CF-8'), 'general test: one topic read: its theory only (' + JSON.stringify(mc) + ')');
  await page.evaluate(() => { LES.forEach(l => { LS.read[l.id] = 1; }); LS.att = []; LS.lastTest = null; saveLearn(); renderLearn(); });
  check(await page.locator('#learnroot [data-l="scope"], #learnroot [data-l="dir"], #learnroot [data-l="topic"], #learnroot [data-l="lvl"]').count() === 0
    && await page.locator('#learnroot [data-l="quiz"]').count() === 1, 'general test: one tile «Тест недели»: no chips of sections, directions, topics or levels');
  await page.locator('#learnroot [data-l="quiz"]').click();
  const gq = await page.evaluate(() => ({ kind: L.qz.kind, n: L.qz.qs.length, scope: L.qz.scope, th: L.qz.qs.filter(q => q.isTheory).length, att: LS.att.map(a => a.g).join() }));
  check(gq.kind === 'mixed' && gq.n === 10 && gq.scope === 'Общий тест' && gq.th === 3 && gq.att === 'test', 'general test: the tile starts one counted test of 10 questions (' + JSON.stringify(gq) + ')');
  /* each question keeps its own time: a recipe question 15 s, theory 20 / 30 / 25 s */
  check(await page.evaluate(() => { const qs = composeQuestions(MIX_N, true); return qs.every(q => qsec(q) === (q.isTheory ? ({ one: 20, multi: 30, order: 30, num: 25 })[q.tt] : 15)); }), 'general test: the time of a question follows its type (recipe 15 s, theory 20 / 30 / 25 s)');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exit"]');
  await page.waitForTimeout(300);
  const nTheoryBefore = posted.length;
  check(posted[nTheoryBefore - 1].aborted === true && posted[nTheoryBefore - 1].kind === 'mixed' && posted[nTheoryBefore - 1].total === 10, 'general test: an aborted test is sent as kind «mixed»');
  await page.evaluate(() => { LS.att = []; LS.lastTest = null; saveLearn(); });

  /* all four kinds of question, answered right through the screen */
  const startTheory = ids => page.evaluate(ids => { beginQuiz(ids.map(id => mkTheoryQ(TH.find(t => t.id === id))), 'theory', 'Теория · smoke'); }, ids);
  const opt = txt => page.locator('#learnroot .opt', { hasText: txt }).first();
  const nextBtn = () => page.click('#learnroot [data-l="next"]');
  const verdict = async () => (await page.locator('#learnroot .fb').first().getAttribute('class')) || '';
  await startTheory(['CF-06', 'CF-05', 'CF-11', 'SV-17', 'CF-02']);
  const sec0 = await page.evaluate(() => Math.ceil((L.qz.deadline - Date.now()) / 1000));
  check(sec0 > 25 && sec0 <= 30, `theory: a question with several answers gets ${sec0} s, not the 15 s of a recipe question`);
  check(await page.locator('#learnroot [data-l="submit"][disabled]').count() === 1, 'theory: «Проверить» waits for a choice');
  await opt('Пибери').click(); await opt('Тринглс').click();
  check(await page.locator('#learnroot .opt.sel').count() === 2 && await page.locator('#learnroot [data-l="submit"][disabled]').count() === 0, 'theory: marked options are shown, «Проверить» unlocks');
  await page.click('#learnroot [data-l="submit"]');
  check((await verdict()).includes('okn'), 'theory: all the right options marked = right');
  await nextBtn();
  for (const t of ['Серебряная', 'Пергамент', 'Пектиновый', 'Пульпа']) await opt(t).click();
  check(await page.locator('#learnroot .opt .pos').count() === 4, 'theory: a sequence question numbers the options as they are tapped');
  await page.click('#learnroot [data-l="submit"]');
  check((await verdict()).includes('okn'), 'theory: the right order = right');
  await nextBtn();
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'qnum'), 'theory: a number question opens the keyboard');
  await page.keyboard.type('70'); await page.keyboard.press('Enter');
  check((await verdict()).includes('okn'), 'theory: the right number = right (Enter submits)');
  await nextBtn();
  for (const t of ['Приветствие', 'Уточнение', 'Предложение апселла', 'Подтверждение']) await opt(t).click();
  await page.click('#learnroot [data-l="submit"]');
  check((await verdict()).includes('okn'), 'theory: a second sequence, right');
  await nextBtn();
  await opt('Эфиопия').click();
  check((await verdict()).includes('okn') && await page.locator('#learnroot [data-openitem]').count() === 0, 'theory: a single choice is right and offers no recipe to open');
  await nextBtn();
  await page.waitForTimeout(400);
  const tp = posted[posted.length - 1] || {};
  check(await page.evaluate(() => ['CF-06', 'CF-05', 'CF-11', 'SV-17', 'CF-02'].every(id => boxOf(TH.find(t => t.id === id)) === 1)), 'theory: right answers raise a question’s box (progress)');
  check((await page.locator('#learnroot .score').innerText()).startsWith('5') && tp.kind === 'theory' && tp.score === 5 && tp.total === 5 && tp.scope.includes('Теория'),
    'theory: a clean test is sent as kind «theory» with its scope');

  /* the same questions answered wrong: the mistakes are shown, nothing to open, and they can be repeated */
  await startTheory(['CF-06', 'CF-05', 'CF-11', 'CF-02']);
  await opt('Хани').click(); await opt('Бурбон').click(); await page.click('#learnroot [data-l="submit"]');
  check((await verdict()).includes('badn'), 'theory: the wrong options marked = wrong');
  await nextBtn();
  for (const t of ['Пульпа', 'Пектиновый', 'Серебряная', 'Пергамент']) await opt(t).click();
  await page.click('#learnroot [data-l="submit"]');
  const ordered = await page.locator('#learnroot .opt').allInnerTexts();
  check((await verdict()).includes('badn') && /^1/.test(ordered[0].replace(/[^\d]/g, '')) && ordered[0].includes('Серебряная'), 'theory: a wrong order is wrong and the options are then listed in the right order');
  await nextBtn();
  await page.keyboard.type('71'); await page.click('#qsubmit');
  check((await verdict()).includes('badn'), 'theory: a wrong number = wrong');
  await nextBtn();
  await opt('Йемен').click(); await nextBtn();
  await page.waitForTimeout(300);
  check(await page.locator('#learnroot .mist').count() === 4 && await page.locator('#learnroot .mist [data-openitem]').count() === 0, 'theory: four mistakes listed, none offers a recipe');
  const attBefore = await page.evaluate(() => LS.att.length);
  await page.click('#learnroot [data-l="retry"]');
  check(await page.evaluate(n => L.qz.qs.length === 4 && L.qz.kind === 'mix' && LS.att.length === n && L.qz.qs.some(q => q.tt === 'num'), attBefore), 'theory: «Повторить ошибки» repeats them (number question included) and is not an attempt');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exit"]');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => ['CF-06', 'CF-05', 'CF-11', 'CF-02'].every(id => boxOf(TH.find(t => t.id === id)) === 0) && boxOf(TH.find(t => t.id === 'SV-17')) === 1),
    'theory: a wrong answer sends the question back to box 0, a right one keeps its box');


  /* AZ */
  await page.click('#langbtn');
  const azHome = await page.locator('#learnroot [data-l="quiz"]').innerText();
  const azTitle = await page.evaluate(() => T('quiz_week_t'));
  check(azHome.includes(azTitle) && /[a-zə]/i.test(azTitle) && !/[А-Яа-яЁё]/.test(azHome) && (await page.locator('#learnroot').innerText()).includes('Sənin səviyyən: Barista'),
    'AZ: the test tile and the level panel are Azerbaijani (' + azTitle + ')');
  await page.locator('#learnroot [data-l="quiz"]').click();
  check(await page.evaluate(() => L.qz.qs.length === 10 && L.qz.qs.every(q => !/[А-Яа-яЁё]/.test(q.text + (q.opts || []).join(' ')))), 'AZ: all ten questions of the general test are in Azerbaijani');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exit"]');
  await page.waitForTimeout(300);
  await page.click('#langbtn');
  await page.evaluate(() => { LS.att = []; LS.lastTest = null; saveLearn(); renderLearn(); });

  /* levels: cumulative, taken from the staff sheet at login */
  const lvlCount = () => page.evaluate(() => levelSet(myLvl()).length);
  const home1 = await page.locator('#learnroot').innerText();
  check(home1.includes('Smoke Test · Test · Бариста') && home1.includes('Твой уровень: Бариста'), 'levels: the login shows the level and the level panel');
  const nAll = await page.evaluate(() => TH.length), nTrainee = await page.evaluate(() => TH.filter(t => t.lvl === 'trainee').length), nBarista = await page.evaluate(() => TH.filter(t => t.lvl !== 'senior').length);
  check(await lvlCount() === nBarista && nBarista < nAll && await page.evaluate(() => levelSet(myLvl()).every(t => t.lvl !== 'senior')), 'levels: a barista gets the trainee and barista questions (' + nBarista + '), none of the senior ones');
  ME.level = 'trainee';  /* the trainer sets the level in the sheet; the app picks it up with the next stats refresh */
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);
  check(await lvlCount() === nTrainee, 'levels: a trainee gets only the ' + nTrainee + ' trainee questions');
  check(await page.evaluate(() => { let ok = true; for (let i = 0; i < 10; i++) composeQuestions(MIX_N, true).filter(q => q.isTheory).forEach(q => { ok = ok && TH.find(t => t.id === q.id).lvl === 'trainee'; }); return ok; }),
    'levels: the theory of the general test takes only trainee questions for a trainee');
  await page.evaluate(() => { levelSet('trainee').forEach(t => { const k = boxKey(t); LS.box[k] = 2; touchProgress(k); }); renderLearn(); });
  check((await page.locator('#learnroot').innerText()).includes('Ты готов к уровню «Бариста»'), 'levels: 80% of the level learned = «ready for the next level»');
  ME.level = 'senior';
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);
  check((await page.locator('#learnroot').innerText()).includes('Высший уровень') && await lvlCount() === nAll, 'levels: a senior sees everything and the top-level note');
  ME.level = '';
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);
  check(await lvlCount() === nAll && !(await page.locator('#learnroot').innerText()).includes('Твой уровень'), 'levels: no level (an older sheet script, an empty cell) = all questions, no panel');
  ME.level = 'barista';
  await page.evaluate(() => { Object.keys(LS.box).forEach(k => { LS.box[k] = 0; touchProgress(k); }); LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);

  /* the quota of tests a week: the sheet's script says how many (3, a trainee 5); aborted tests count, retries and the exam do not */
  const refreshStats = async () => { await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); }); await page.waitForTimeout(500); };
  const tile = () => page.locator('#learnroot [data-l="quiz"]');
  ME.limits = { test: 3 }; ME.week = { test: 0 };
  await page.evaluate(() => { LS.att = []; LS.lastTest = null; });
  await refreshStats();
  check((await tile().innerText()).includes('На этой неделе: 0 / 3') && await tile().isEnabled(), 'limit: the test tile shows the tests of the week (0 / 3)');
  for (let i = 0; i < 3; i++) {
    await tile().click();
    page.once('dialog', d => d.accept());
    await page.click('#learnroot [data-l="exit"]');
    await page.waitForTimeout(250);
  }
  check(await tile().isDisabled() && (await page.locator('#learnroot .att-full').innerText()).includes('3 / 3'), 'limit: three tests (aborted ones too) use the week up; the tile locks and says why');
  check(await page.evaluate(() => { startQuiz(); return L.view !== 'quiz'; }), 'limit: a start at the limit does nothing');
  check(await page.locator('#learnroot [data-l="mat"]').isEnabled(), 'limit: materials and cards stay open');
  const rulesT = await page.locator('#learnroot .rules').textContent();
  check(rulesT.includes('Тестов в неделю: 3') && rulesT.includes('новичку 5') && rulesT.includes('Тренировки из «Материалов»'), 'limit: the rules say 3 tests a week, 5 for a trainee, and that practice does not count');
  await page.evaluate(() => { LS.att = []; renderLearn(); });
  ME.week = { test: 3 }; await refreshStats();
  check(await tile().isDisabled(), 'limit: the sheet’s count blocks the test even if the phone forgot its own');
  ME.week = { test: 0 }; await refreshStats();
  await page.evaluate(() => { LS.att = [1, 2, 3].map(() => ({ g: 'test', ts: weekStartTs() - 60000 })); renderLearn(); });
  check(await tile().isEnabled() && (await tile().innerText()).includes('0 / 3'), 'limit: tests of the previous week do not count');
  ME.limits = { test: 5 }; await refreshStats();
  check((await tile().innerText()).includes('На этой неделе: 0 / 5'), 'limit: a trainee’s quota of five comes from the sheet');
  ME.limits = { test: 3 }; await refreshStats();
  await page.evaluate(() => { LS.read = {}; renderLearn(); });  /* nothing read: no theory in the test, every question is a plain tap */
  mockOver = true;
  await tile().click();
  for (let i = 0; i < 15 && await page.locator('#learnroot [data-l="ans"]').count(); i++) { await page.locator('#learnroot [data-l="ans"]').first().click(); await page.click('#learnroot [data-l="next"]'); }
  await page.waitForSelector('#learnroot #sendstat .badn', { timeout: 5000 }).catch(() => {});
  check((await page.locator('#learnroot #sendstat').innerText()).includes('сверх недельного лимита'), 'limit: the result says when the sheet counted it over the limit');
  mockOver = false;
  await page.click('#learnBack');
  delete ME.limits; delete ME.week;
  await page.evaluate(() => { LS.att = []; LS.lastTest = null; });
  await refreshStats();
  check(!(await tile().innerText()).includes('На этой неделе') && await tile().isEnabled(), 'limit: a sheet script without limits (older) means no limit');
  /* the game: level, owls, board and badges come from the sheet; the monthly exam */
  await page.click('nav.tabs button[data-tab="learn"]');
  await page.waitForTimeout(400);
  const home = await page.locator('#learnroot').innerText();
  check(home.includes('1140 XP') && home.includes('🦉 18 / 50') && await page.locator('#learnroot .board li').count() === 2
    && await page.locator('#learnroot .bdg.on').count() === 3, 'game card, weekly board and badges come from the sheet');
  await page.click('#learnroot [data-l="board"][data-v="branches"]');
  check((await page.locator('#learnroot .board').innerText()).includes('Central Park'), 'board switches to branches');

  /* the order of the training home: level, rank, progress, materials, test, and the weekly board well below the test */
  await page.click('#learnroot [data-l="board"][data-v="people"]');
  const tops = await page.evaluate(() => {
    const r = document.getElementById('learnroot'), sa = document.getElementById('scrollArea'), y = el => el ? el.getBoundingClientRect().top - sa.getBoundingClientRect().top + sa.scrollTop : -1;
    const lp = txt => [...r.querySelectorAll('.lpanel')].find(e => e.innerText.includes(txt));
    const quiz = r.querySelector('[data-l="quiz"]'), big = r.querySelector('h4.lsect.big');
    return { id: y(r.querySelector('.idrow')), plan: y(r.querySelector('.lpanel.plan')), rank: y(r.querySelector('.lpanel.game')), level: y(r.querySelector('.lpanel.game .lvlbox')),
      exam: y(r.querySelector('[data-l="exam"]')), mat: y(r.querySelector('.mode[data-l="mat"]')), test: y(r.querySelector('h4.lsect')), quiz: y(quiz), rating: y(big), board: y(r.querySelector('.board')),
      progress: lp('Твой прогресс') ? 1 : 0, gap: big && quiz ? big.getBoundingClientRect().top - quiz.getBoundingClientRect().bottom : -1 };
  });
  const seq = ['id', 'plan', 'rank', 'level', 'exam', 'mat', 'test', 'quiz', 'rating', 'board'].map(k => tops[k]);
  check(seq.every(v => v >= 0) && seq.every((v, i) => i === 0 || v > seq[i - 1]) && !tops.progress, 'training home order: employee, plan for today, rank card with the level inside, exam, materials, test, rating; no «Твой прогресс»' + (seq.every((v, i) => v >= 0 && (i === 0 || v > seq[i - 1])) ? '' : ' ' + JSON.stringify(tops)));
  check(tops.gap >= 24, `training home: the weekly board starts ${Math.round(tops.gap)} px below the test`);
  const homeTxt = await page.locator('#learnroot').innerText();
  check(homeTxt.includes('Твой уровень: Бариста') && /ранг \d/.test(homeTxt) && !/уровень \d/.test(homeTxt), 'the level is the employee’s level, the XP level is called a rank');

  /* answers the running quiz through the app's own functions: the first `right` questions right, the rest wrong; returns the view it ends on */
  const playQuiz = right => page.evaluate(r => {
    const n = L.qz.qs.length;
    for (let k = 0; k < n; k++) {
      const q = L.qz.qs[L.qz.i], good = k < r;
      if (!q.tt || q.tt === 'one') answer(good ? q.opts.indexOf(q.correct) : q.opts.findIndex(o => o !== q.correct)); else answer(-3, { ok: good, your: 'x' });
      nextQ();
    }
    return L.view;
  }, right);
  /* «План на сегодня»: the next lesson of the level, a counted test, ticked when done today; the dot on the tab says nothing was done today */
  const keepLim = await page.evaluate(() => JSON.stringify({ limits: LS.stats.limits, week: LS.stats.week }));
  await page.evaluate(() => { LS.read = {}; LS.today = null; LS.att = []; LS.stats.limits = { test: 3 }; LS.stats.week = { test: 1 }; LS.stats.at = Date.now(); saveLearn(); renderLearn(); });
  const plan = async () => page.evaluate(() => [...document.querySelectorAll('#learnroot .plan .tile')].map(b => ({ v: b.dataset.v, done: b.classList.contains('read'), next: b.classList.contains('next'), t: b.innerText })));
  let pl = await plan();
  const dotOn = () => page.evaluate(() => getComputedStyle(document.getElementById('learndot')).display !== 'none');
  check(pl.length === 2 && pl[0].v.startsWith('les:') && pl[0].next && pl[1].v.startsWith('test:') && /На этой неделе: \d \/ \d/.test(pl[1].t) && await dotOn(),
    'plan: a lesson to read first, then a counted test with the attempts left; the dot is on (' + JSON.stringify(pl) + ')');
  const firstLes = pl[0].v.slice(4);
  check(await page.evaluate(id => { const my = new Set(levelSet(myLvl()).map(t => t.topic)); return my.has(LES.find(l => l.id === id).topic); }, firstLes), 'plan: the lesson is of a topic of the person’s level');
  await page.click('#learnroot .plan .tile.next');
  check(await page.evaluate(id => L.view === 'lesson' && L.lid === id, firstLes), 'plan: the lesson row opens that lesson');
  await page.click('#learnroot [data-l="lcheck"]');
  check(await playQuiz(3) === 'result' && await page.evaluate(id => !!LS.read[id], firstLes), 'plan: a lesson counts after its check (3 of 3), not by a button');
  await page.click('#learnBack');
  await page.click('#learnBack');
  pl = await plan();
  check(pl[0].done && pl[0].t.includes('Дальше:') && pl[1].next && !(await dotOn()) && (await page.locator('#learnroot .plan .lph').innerText()).includes('1 / 2'),
    'plan: a lesson read ticks the study row, the test row is next, the dot goes out');
  await page.evaluate(() => { LS.today = { day: '2000-01-01', done: ['study', 'test'] }; renderLearn(); });
  check(!(await plan())[0].done && await dotOn(), 'plan: yesterday’s ticks do not count today');
  await page.evaluate(() => { LS.read = Object.fromEntries(LES.map(l => [l.id, 1])); LS.today = null; renderLearn(); });
  pl = await plan();
  check(pl[0].v.startsWith('cards:'), 'plan: with every lesson read, the weakest card deck is offered');
  /* the week used up: the exam, or practice */
  await page.evaluate(() => { LS.stats.week = { test: 3 }; renderLearn(); });
  pl = await plan();
  check(pl[1].v === 'exam' || pl[1].v === 'mat', 'plan: no attempts left, the exam or practice is offered (' + pl[1].v + ')');
  check(await page.locator('#learnroot .att-full').count() === 0 || await page.locator('#learnroot [data-l="plan"][data-v="mat"].lbtn').count() === 1, 'limit: a used-up week offers practice in «Материалы»');
  await page.evaluate(k => { const o = JSON.parse(k); LS.stats.limits = o.limits; LS.stats.week = o.week; LS.read = {}; LS.today = null; saveLearn(); renderLearn(); }, keepLim);

  /* materials: cards for drinks, preps and the vitrina */
  const runCards = async () => { for (let i = 0; i < 60 && await page.evaluate(() => L.view) === 'cards'; i++) {
    if (await page.locator('#learnroot .fc.back').count()) await page.click('#learnroot [data-l="know"]');
    else { await page.click('#learnroot [data-l="flip"]'); await page.locator('#learnroot .fc.back').waitFor(); }
  } };
  await page.evaluate(() => { L.nav = []; });
  await page.click('#learnroot [data-l="mat"]');
  check(await page.locator('#learnroot [data-l="matcat"]').count() === 3, 'materials: drinks, preps and vitrina');
  const backTxt0 = () => page.locator('#learnBack').innerText();
  const ttl = () => page.locator('#learnTitle').innerText();
  check(await ttl() === 'Материалы' && !(await page.locator('#learnroot').innerText()).includes('📖') && await page.locator('#learnroot .hint.lead').count() === 1, 'title: «Материалы» is the big title of the top bar, no grey duplicate under it, the description stays');
  check((await backTxt0()).includes('Обучение') && await page.locator('#learnroot [data-l="home"]').count() === 0 && (await page.locator('#learnroot').innerText()).indexOf('К обучению') < 0, 'back: materials returns to «Обучение» (the button names it) and has no extra link');

  /* lessons: a category tile, a list, a lesson, «прочитано», and a theory test on the lesson's topic */
  await page.evaluate(() => { LS.read = {}; saveLearn(); renderLearn(); });
  const lcatTxt = async k => page.locator(`#learnroot [data-l="lcat"][data-v="${k}"]`).innerText();
  check(await page.locator('#learnroot [data-l="lcat"]').count() === 4 && (await lcatTxt('CF')).includes('0 / 17') && (await lcatTxt('SV')).includes('0 / 12') && (await lcatTxt('SN')).includes('0 / 3') && (await lcatTxt('BR')).includes('0 / 14'),
    'lessons: four category tiles (coffee 0 / 17, service and sales 0 / 12, sanitation 0 / 3, brand 0 / 14)');
  await page.click('#learnroot [data-l="lcat"][data-v="CF"]');
  check(await page.locator('#learnroot [data-l="lesson"]').count() === 17, 'lessons: the list has the 17 coffee lessons');
  check((await backTxt0()).includes('Материалы') && await ttl() === 'Кофе', 'back: the lesson list returns to «Материалы», its title is «Кофе»');
  await page.click('#learnroot [data-l="lesson"]:nth-child(3)');
  check((await backTxt0()).includes('Кофе') && await ttl() === await page.evaluate(() => LES[2].title) && (await page.locator('#learnroot .qtop').first().innerText()).includes('Урок 3 из 17'), 'back: a lesson returns to its list («Кофе»), its title is the lesson’s, «Урок 3 из 17» under it');
  const les3 = await page.evaluate(() => ({ id: L.lid, title: LES.find(x => x.id === L.lid).title }));
  const lt = await page.locator('#learnroot').innerText();
  check(les3.id === 'cf-species' && (await page.locator('#learnTitle').innerText()) === les3.title && !lt.includes(les3.title) && await page.locator('#learnroot table.ltab').count() === 1 && lt.includes('2–3 %'), 'lesson: the title only in the top bar (not repeated in the text), the arabica / robusta table and its numbers');
  check(await page.locator('#learnroot [data-l="lcheck"]').count() === 1 && await page.locator('#learnroot [data-l="lread"]').count() === 0 && await page.locator('#learnroot [data-l="ltest"]').count() === 0,
    'lesson: an unread lesson offers only the check, no «mark read» button and no free test');
  check((await page.locator('#learnroot .lbtns + .hint').innerText()).includes('2 из 3'), 'lesson: the hint says 2 of 3 are needed');
  /* a failed check: nothing counts, no attempt, nothing sent; the missed theory questions link to the lessons of their topic */
  const sent0 = posted.length, att0 = await page.evaluate(() => LS.att.length);
  await page.click('#learnroot [data-l="lcheck"]');
  const ck = await page.evaluate(() => ({ kind: L.qz.kind, practice: L.qz.practice, rec: !!L.qz.rec, n: L.qz.qs.length, topics: [...new Set(L.qz.qs.map(q => TH.find(t => t.id === q.id).topic))] }));
  check(ck.kind === 'check' && ck.practice && !ck.rec && ck.n === 3 && ck.topics.length === 1, 'lesson check: 3 questions of the lesson’s topic, a practice test (' + ck.topics + ')');
  check(await ttl() === 'Проверка урока', 'lesson check: the top bar says «Проверка урока»');
  check(await playQuiz(0) === 'result' && await page.evaluate(() => !LS.read['cf-species']), 'lesson check: 0 of 3 does not count the lesson');
  check(await ttl() === 'Проверка урока', 'lesson check: the result is titled «Проверка урока», not «Тренировка»');
  const failTxt = await page.locator('#learnroot').innerText();
  check(failTxt.includes('нужно 2 верных из 3') && await page.locator('#learnroot [data-l="lcheck2"]').count() === 1 && await page.locator('#learnroot [data-l="retry"]').count() === 0 && await page.locator('#learnroot [data-l="quiz"]').count() === 0,
    'lesson check: the result says why, offers «Ещё раз» and no counted test');
  check(posted.length === sent0 && await page.evaluate(() => LS.att.length) === att0 && await page.evaluate(() => LS.outbox.length === 0 && !LS.live), 'lesson check: nothing is sent, no attempt is used');
  const chipLes = await page.evaluate(() => [...document.querySelectorAll('#learnroot .mist [data-l="lesson"]')].map(b => b.dataset.v));
  check(chipLes.length >= 3 && await page.evaluate(([ids, t]) => ids.every(id => LES.find(l => l.id === id).topic === t), [chipLes, ck.topics[0]]), 'theory mistakes: each links to the lessons of its topic (' + chipLes.length + ' links)');
  await page.locator('#learnroot .mist [data-l="lesson"]').first().click();
  check(await page.evaluate(() => L.view === 'lesson') && await page.locator('#learnroot [data-l="lcheck"], #learnroot [data-l="ltest"]').count() >= 1, 'theory mistakes: the link opens that lesson');
  await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'lesson' && L.lid === 'cf-species'), 'back: from a linked lesson to the lesson the check was started from');
  /* a passed check counts the lesson, dated in Baku */
  await page.click('#learnroot [data-l="lcheck"]');
  check(await playQuiz(2) === 'result' && await page.evaluate(() => /^\d{4}-\d\d-\d\d$/.test(LS.read['cf-species'])), 'lesson check: 2 of 3 counts the lesson, stored with its day (' + await page.evaluate(() => LS.read['cf-species']) + ')');
  check((await page.locator('#learnroot').innerText()).includes('Урок засчитан') && await page.locator('#learnroot [data-l="lnext"]').count() === 1, 'lesson check: «Урок засчитан» and the next lesson on offer');
  await page.click('#learnBack');
  check(await page.locator('#learnroot [data-l="lcheck"]').count() === 0 && await page.locator('#learnroot [data-l="ltest"]').count() === 1 && (await page.locator('#learnroot').innerText()).includes('Урок пройден'), 'lesson: after the check it reads «Урок пройден» and offers the free test');
  /* a topic without questions keeps the plain button */
  await page.evaluate(() => { LES.push({ id: 'zz-test', cat: 'CF', topic: 'ZZ-0', title: 'Test lesson', blocks: [{ p: 'x' }] }); L.lid = 'zz-test'; renderLearn(); });
  check(await page.locator('#learnroot [data-l="lread"]').count() === 1 && await page.locator('#learnroot [data-l="lcheck"]').count() === 0, 'lesson without questions: the plain «mark read» button stays');
  await page.click('#learnroot [data-l="lread"]');
  check(await page.evaluate(() => !!LS.read['zz-test']), 'lesson without questions: it can be marked read');
  await page.evaluate(() => { LES.pop(); delete LS.read['zz-test']; L.lid = 'cf-species'; renderLearn(); });
  await page.click('#learnBack');
  check((await page.locator('#learnroot .tile.read').count()) === 1 && (await page.locator('#learnroot .lpanel').first().innerText()).includes('1 / 17'), 'lessons: the list shows the read lesson and 1 / 17');
  /* a long lesson title fits the top bar: two lines at most, no side scroll */
  await page.evaluate(() => { L.view = 'lesson'; L.lid = 'cf-equip'; renderLearn(); });
  const bar = await page.evaluate(() => { const h = document.getElementById('learnTitle'), sa = document.getElementById('scrollArea'); return { h: h.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(h).lineHeight), wide: sa.scrollWidth > sa.clientWidth, txt: h.textContent }; });
  check(bar.txt.length > 25 && bar.h <= bar.lh * 2 + 2 && !bar.wide, 'title: a long lesson title takes two lines at most (' + Math.round(bar.h) + ' px) without side scroll');
  await page.evaluate(() => { L.view = 'lessons'; renderLearn(); });
  /* the scroll position comes back with the screen */
  await page.click('#learnroot [data-l="lesson"]:nth-child(14)');
  const y14 = await page.evaluate(() => { const y = L.nav[L.nav.length - 1].y; return y; });
  await page.click('#learnBack');
  check(y14 > 0 && Math.abs(await page.evaluate(() => document.getElementById('scrollArea').scrollTop) - y14) <= 2, 'back: the list is scrolled where it was (' + y14 + ' px)');
  await page.click('#learnBack');
  check((await lcatTxt('CF')).includes('1 / 17'), 'materials: the tile counts the read lessons');
  await page.evaluate(() => { LS.att = []; if (LS.stats) LS.stats.week = { recipes: 0, theory: 0 }; });
  await page.click('#learnroot [data-l="lcat"][data-v="CF"]');
  await page.click('#learnroot [data-l="lesson"][data-v="cf-milk"]');
  const nPosted = posted.length, nAtt = await page.evaluate(() => LS.att.length);
  /* the check takes 3 questions of this lesson's topic only (CF-8); leaving it asks first and the lesson stays unread */
  await page.click('#learnroot [data-l="lcheck"]');
  check(await page.evaluate(() => L.view === 'quiz' && L.qz.kind === 'check' && L.qz.qs.length === 3 && L.qz.qs.every(q => TH.find(t => t.id === q.id).topic === 'CF-8')), 'lesson check: «Молоко» asks 3 questions of CF-8 only');
  page.once('dialog', d => d.accept());
  await page.click('#learnBack');
  await page.waitForTimeout(250);
  check(await page.evaluate(() => L.view === 'lesson' && !LS.read['cf-milk']), 'lesson check: leaving it keeps the lesson unread');
  await page.evaluate(() => { LS.read['cf-milk'] = bakuDay(); renderLearn(); });
  await page.click('#learnroot [data-l="ltest"]');
  const lq = await page.evaluate(() => ({ view: L.view, kind: L.qz && L.qz.kind, practice: L.qz && L.qz.practice, rec: L.qz && !!L.qz.rec, topic: L.qz && [...new Set(L.qz.qs.map(q => TH.find(t => t.id === q.id).topic))], n: L.qz && L.qz.qs.length, scope: L.qz && L.qz.scope }));
  check(lq.view === 'quiz' && lq.practice === true && lq.rec === false && lq.topic.length === 1 && lq.topic[0] === 'CF-8' && lq.n >= 3 && lq.scope.includes('Молоко'), 'lesson test: a theory test of this lesson’s topic only (CF-8, ' + lq.n + ' questions)');
  check((await page.locator('#learnroot').innerText()).includes('Тренировка') || await page.locator('#learnBack').count() === 1, 'practice: the quiz screen is titled «Тренировка»');
  page.once('dialog', d => { if (!d.message().includes('не отправляется')) fails.push('practice exit asked the wrong question: ' + d.message()); d.accept(); });
  await page.click('#learnBack');
  await page.waitForTimeout(250);
  check(await page.evaluate(() => L.view === 'lesson' && L.lid === 'cf-milk' && !L.qz), 'back: leaving a test started from a lesson returns to that lesson');
  await page.evaluate(() => { delete LS.read['cf-milk']; });
  check(posted.length === nPosted && await page.evaluate(() => LS.att.length) === nAtt && await page.evaluate(() => !LS.live && LS.outbox.length === 0), 'practice: leaving it sends nothing, uses no attempt and leaves nothing waiting');
  /* a lesson of «Сервис и продажи»: its test takes only SV-3 questions */
  await page.evaluate(() => { LS.att = []; if (LS.stats) LS.stats.week = { recipes: 0, theory: 0 }; L.nav = []; L.view = 'materials'; renderLearn(); });
  await page.click('#learnroot [data-l="lcat"][data-v="SV"]');
  check(await page.locator('#learnroot [data-l="lesson"]').count() === 12 && await ttl() === 'Сервис и продажи', 'lessons: «Сервис и продажи» lists 12 lessons');
  await page.click('#learnroot [data-l="lesson"][data-v="sv-order"]');
  check(await page.locator('#learnroot ol.ll li').count() === 6 && (await page.locator('#learnroot').innerText()).includes('Подтверждение заказа'), 'lesson: the order steps are a six-step list');
  await page.evaluate(() => { LS.read['sv-order'] = bakuDay(); renderLearn(); });
  await page.click('#learnroot [data-l="ltest"]');
  check(await page.evaluate(() => L.view === 'quiz' && L.qz.qs.length > 0 && L.qz.qs.every(q => TH.find(t => t.id === q.id).topic === 'SV-3')), 'lesson test: «Приём заказа» tests only the topic SV-3');
  page.once('dialog', d => d.accept());
  await page.click('#learnBack');
  await page.waitForTimeout(250);
  /* a lesson of «Бренд»: its test takes only BR-1 questions */
  await page.evaluate(() => { L.nav = []; L.view = 'materials'; renderLearn(); });
  await page.click('#learnroot [data-l="lcat"][data-v="BR"]');
  check(await page.locator('#learnroot [data-l="lesson"]').count() === 14 && await ttl() === 'Бренд SENSUM', 'lessons: «Бренд SENSUM» lists 14 lessons');
  await page.click('#learnroot [data-l="lesson"][data-v="br-mission"]');
  check((await page.locator('#learnroot').innerText()).includes('Кредо компании') && (await page.locator('#learnroot').innerText()).includes('Талант'), 'lesson: the mission lesson carries the credo');
  await page.evaluate(() => { LS.read['br-mission'] = bakuDay(); renderLearn(); });
  await page.click('#learnroot [data-l="ltest"]');
  check(await page.evaluate(() => L.view === 'quiz' && L.qz.practice && L.qz.qs.length > 0 && L.qz.qs.every(q => TH.find(t => t.id === q.id).topic === 'BR-1')), 'lesson test: «Миссия» tests only the topic BR-1');
  page.once('dialog', d => d.accept());
  await page.click('#learnBack');
  await page.waitForTimeout(250);
  await page.evaluate(() => { delete LS.read['sv-order']; delete LS.read['br-mission']; });
  await page.evaluate(() => { L.nav = [{ view: 'home', y: 0 }]; L.view = 'materials'; renderLearn(); });
  await page.click('#learnroot [data-l="lcat"][data-v="CF"]');
  await page.click('#learnroot [data-l="lesson"][data-v="cf-milk"]');
  /* a language switch keeps the screen */
  await page.click('#langbtn');
  const azLes = await page.locator('#learnroot').innerText();
  check(await page.evaluate(() => L.view === 'lesson' && L.lid === 'cf-milk') && azLes.includes('Süd') && !/[А-Яа-яЁё]/.test(azLes + await backTxt0()), 'language switch: an open lesson stays open, now in Azerbaijani');
  await page.click('#langbtn');
  await page.click('#learnBack'); await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'materials'), 'back: lesson → list → materials');
  await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'home' && L.nav.length === 0) && !(await page.locator('#learnBack').isVisible()), 'back: materials → «Обучение», a tab of its own with no back button');
  await page.click('#learnroot [data-l="mat"]'); await page.click('#learnroot [data-l="lcat"][data-v="CF"]');
  await page.click('nav.tabs button[data-tab="learn"]');
  check(await page.evaluate(() => L.view === 'home' && L.nav.length === 0), 'tab bar: tapping «Обучение» again goes back to its first screen');
  const lessonProblems = async () => page.evaluate(() => { const bad = [], sa = document.getElementById('scrollArea'); sa.scrollLeft = 0;
    for (const les of LES) { L.lid = les.id; L.view = 'lesson'; renderLearn(); const t = document.getElementById('learnroot').innerText;
      if (sa.scrollWidth > sa.clientWidth) bad.push(les.id + ': wider than the screen');
      if (t.includes('undefined') || document.getElementById('learnTitle').textContent !== les.title) bad.push(les.id + ': text');  /* the title is the big title of the top bar */
      if (LANG === 'az' && /[А-Яа-яЁё]/.test(t)) bad.push(les.id + ': Russian letters'); }
    L.view = 'home'; renderLearn(); return bad; });
  const badRu = await lessonProblems();
  check(badRu.length === 0, 'every lesson renders at 390px without side scroll (RU)' + (badRu.length ? ': ' + badRu.join(' | ') : ''));
  await page.evaluate(() => { L.view = 'home'; L.nav = []; renderLearn(); });
  await page.click('#learnroot [data-l="mat"]');
  await page.click('#learnroot [data-l="matcat"][data-v="v"]');
  check(await page.locator('#learnroot [data-l="mvcat"]').count() === 4 && await page.locator('#learnroot [data-l="cards"]').count() === 1, 'materials: the vitrina has its category chips and a cards button');
  await page.click('#learnroot [data-l="mvcat"][data-v="dessert"]');
  check(await ttl() === 'Витрина', 'title: a card deck is titled with its source');
  await page.click('#learnroot [data-l="cards"]');
  check(await ttl() === 'Карточки' && (await backTxt0()).includes('Витрина'), 'title: the cards screen is «Карточки», the button leads back to «Витрина»');
  const front = await page.locator('#learnroot .fc').innerText();
  check(await page.evaluate(() => L.fc.src === 'v' && L.fc.deck.every(id => vitById[id].cat === 'dessert')) && !front.includes('Аллерген'), 'vitrina card: the front shows the name only, from the chosen category');
  const vitName = await page.evaluate(() => vitById[L.fc.deck[0]].name);
  await page.click('#learnroot [data-l="flip"]');
  const backTxt = await page.locator('#learnroot .fc.back').innerText();
  check(backTxt.includes(vitName) && backTxt.includes(await page.evaluate(() => T('sec_sostav'))) && backTxt.toLowerCase().includes((await page.evaluate(() => T('sec_allergens'))).toLowerCase()), 'vitrina card: the back shows composition and allergens');
  await page.click('#learnroot [data-l="know"]');
  check(await page.evaluate(id => LS.box['v:' + id] === 1, await page.evaluate(() => L.fc.deck[0])), 'vitrina card: «Знаю» raises the card’s box (v:<id>)');
  await runCards();
  check(await page.locator('#learnroot [data-l="cardsquiz"]').count() === 1 && (await backTxt0()).includes('Витрина'), 'vitrina cards done: a practice test is offered, «назад» returns to the deck');
  await page.click('#learnroot [data-l="cardsquiz"]');
  check(await page.evaluate(() => L.view === 'quiz' && L.qz.practice && !L.qz.rec && L.qz.qs.length > 0 && L.qz.qs.every(q => q.isVit)), 'practice: the test after vitrina cards is about the vitrina and nothing is sent');
  page.once('dialog', d => d.accept());
  await page.click('#learnBack');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => L.view === 'matdeck'), 'back: leaving the practice test returns to the deck it started from');
  await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'materials'), 'back: deck → materials');
  await page.click('#learnroot [data-l="matcat"][data-v="d"]');
  await page.click('#learnroot [data-l="cards"]');
  await page.click('#learnroot [data-l="flip"]');
  await page.locator('#learnroot .fc.back').waitFor();
  check(await page.locator('#learnroot .fc.back table.ing').count() === 1, 'drink card: the back still shows the recipe');
  await runCards();
  check(await page.locator('#learnroot [data-l="cardsquiz"]').count() === 1, 'drink cards done: the recipe test is offered');
  await page.click('#langbtn');
  check(await page.evaluate(() => L.view === 'cardsdone'), 'language switch: the finished cards screen stays');
  await page.click('#learnBack'); await page.click('#learnBack');
  const azMat = await page.locator('#learnTitle').innerText() + ' ' + await page.locator('#learnroot').innerText();
  check(azMat.includes('Materiallar') && azMat.includes('Vitrin') && !/[А-Яа-яЁё]/.test(azMat), 'AZ: the materials screen is Azerbaijani');
  const badAz = await lessonProblems();
  check(badAz.length === 0, 'every lesson renders at 390px without side scroll, no Russian letters (AZ)' + (badAz.length ? ': ' + badAz.join(' | ') : ''));
  await page.evaluate(() => { L.view = 'materials'; renderLearn(); });
  await page.click('#langbtn');
  check(await page.evaluate(() => L.view === 'materials'), 'language switch: the materials screen stays');
  await page.click('#learnBack');
  /* practice after a card deck: also outside the limit, nothing is sent */
  await page.evaluate(() => { L.nav = []; L.view = 'materials'; renderLearn(); });
  await page.click('#learnroot [data-l="matcat"][data-v="p"]');
  await page.click('#learnroot [data-l="cards"]');
  await runCards();
  const pBefore = await page.evaluate(() => ({ att: LS.att.length, quiz: LS.quiz.length }));
  const nPost0 = posted.length;
  await page.click('#learnroot [data-l="cardsquiz"]');
  check(await page.evaluate(() => L.view === 'quiz' && L.qz.practice === true && !L.qz.rec && L.qz.qs.every(q => q.isPrep)), 'practice: the quiz after a prep deck is practice, about preps, with nothing to send');
  for (let i = 0; i < 30 && await page.locator('#learnroot [data-l="ans"]').count(); i++) {
    await page.locator('#learnroot [data-l="ans"]').first().click();
    await page.click('#learnroot [data-l="next"]');
  }
  await page.waitForTimeout(300);
  const pTxt = await page.locator('#learnroot').innerText();
  check(await page.locator('#learnroot .score').count() === 1 && pTxt.includes('Это тренировка') && await page.locator('#learnroot #sendstat').count() === 0 && await page.locator('#learnroot [data-l="quiz"]').count() === 0,
    'practice: the result says so, shows no send status and offers no new counted test');
  check(posted.length === nPost0 && await page.evaluate(() => LS.att.length) === pBefore.att && await page.evaluate(() => LS.quiz.length) === pBefore.quiz && await page.evaluate(() => LS.outbox.length === 0 && !LS.live),
    'practice: a finished practice test is not sent, not an attempt, not in the last-tests history');
  await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'matdeck'), 'practice: «назад» from the result returns to the deck');
  await page.evaluate(() => { L.nav = []; L.view = 'home'; renderLearn(); });

  /* every code has its own progress on one phone, and the sheet keeps a copy */
  await page.evaluate(() => { LS.read['cf-milk'] = 1; touchProgress(); });
  const snap = () => page.evaluate(() => ({ read: Object.keys(LS.read), box: Object.values(LS.box).filter(v => v > 0).length, quiz: LS.quiz.length }));
  const mine = await snap();
  check(mine.read.length > 0 && mine.box > 0 && mine.quiz > 0, 'progress: the first code has lessons read, cards learned and a test history');
  await page.click('#learnroot [data-l="logout"]');
  check(await page.evaluate(() => !LS.me && Object.keys(LS.read).length === 0 && Object.keys(LS.box).length === 0), 'progress: logged out, nothing of the previous person is shown');
  await page.fill('#lcode', '5678');
  await page.click('#learnroot [data-l="login"]');
  await page.waitForSelector('#learnroot .idrow', { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => LS.me && LS.me.code === '5678' && Object.keys(LS.read).length === 0 && Object.keys(LS.box).length === 0 && LS.quiz.length === 0 && LS.att.length === 0 && !passedTopics().has('CF-8')),
    'progress: the second code starts clean: nothing read, nothing learned, no history, the coffee topics closed');
  await page.evaluate(() => { LS.read['cf-milk'] = 1; LS.box['d:latte'] = 2; touchProgress('d:latte'); pushProgress(); });
  await page.waitForTimeout(500);
  check(progPosts.some(d => d.code === '5678' && d.read.join() === 'cf-milk' && d.protocol === 2 && d.changes['d:latte'] && d.changes['d:latte'].v === 2), 'progress: the second code’s progress goes to the sheet under its own code');
  await page.click('#learnroot [data-l="logout"]');
  await page.fill('#lcode', '1234');
  await page.click('#learnroot [data-l="login"]');
  await page.waitForSelector('#learnroot .idrow', { timeout: 5000 }).catch(() => {});
  const back = await snap();
  check(mine.read.every(id => back.read.includes(id)) && back.box === mine.box && back.quiz === mine.quiz, 'progress: back on the first code, its lessons, cards and history are as they were (' + JSON.stringify([back.read.length, back.box, back.quiz]) + ' vs ' + JSON.stringify([mine.read.length, mine.box, mine.quiz]) + ')');
  /* a new or cleaned phone: the progress comes back from the sheet */
  await page.evaluate(() => { LS.progDirty = 1; pushProgress(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { localStorage.removeItem('sensum_learn_u_1234'); });
  await page.reload();
  await page.waitForTimeout(500);
  await page.click('nav.tabs button[data-tab="learn"]');
  await page.waitForTimeout(800);
  const restored = Object.assign(await snap(), { me: await page.evaluate(() => LS.me && LS.me.code) });
  check(restored.me === '1234' && mine.read.every(id => restored.read.includes(id)) && restored.box === mine.box && restored.quiz === 0, 'progress: after the phone’s data is gone, lessons read and cards learned come back from the sheet (' + JSON.stringify(restored) + ')');

  /* older versions kept everything under one key: it moves to the code that was logged in */
  await page.evaluate(() => {
    localStorage.removeItem('sensum_learn_u_5678');
    localStorage.setItem('sensum_learn', JSON.stringify({ epoch: RESET_EPOCH, me: { code: '5678', name: 'Second Person', branch: 'Test', level: 'barista' }, outbox: [], box: { 'd:legacy': 3 }, read: { 'cf-milk': 1 }, quiz: [], att: [] }));
  });
  await page.reload();
  await page.waitForTimeout(300);
  const mig = await page.evaluate(() => ({ me: LS.me.code, box: LS.box['d:legacy'], read: LS.read['cf-milk'],
    dev: JSON.parse(localStorage.getItem('sensum_learn')), usr: JSON.parse(localStorage.getItem('sensum_learn_u_5678') || 'null') }));
  check(mig.me === '5678' && mig.box === 3 && mig.read === 1 && !('box' in mig.dev) && !('read' in mig.dev) && mig.usr && mig.usr.box['d:legacy'] === 3,
    'progress: data kept by an older version moves under the code that was logged in, the device key keeps only who is logged in');
  /* a reset epoch (end of the test period): everything personal is wiped once, the login stays, a second start keeps what is made after it */
  const keep1234 = await page.evaluate(() => { saveLearn(); return localStorage.getItem('sensum_learn_u_1234'); });
  await page.evaluate(() => {
    localStorage.setItem('sensum_learn', JSON.stringify({ epoch: RESET_EPOCH - 1, me: { code: '5678', name: 'Second Person', branch: 'Test', level: 'barista' },
      outbox: [{ id: 'old1', code: '5678', scope: 'x', kind: 'drinks', score: 1, total: 1, mistakes: [], lang: 'ru', ver: '1', ts: 1 }], live: { id: 'old2' }, box: { 'd:old': 2 }, read: { 'cf-milk': 1 }, quiz: [{ x: 1 }], att: [{ x: 1 }] }));
    localStorage.setItem('sensum_learn_u_5678', JSON.stringify({ box: { 'd:old': 2 }, read: { 'cf-milk': 1 }, quiz: [{ x: 1 }], att: [{ x: 1 }] }));
    localStorage.setItem('sensum_learn_u__guest', JSON.stringify({ box: { 'd:g': 1 }, read: {}, quiz: [], att: [] }));
    localStorage.setItem('sensum_lang', 'ru');
  });
  await page.reload();
  await page.waitForTimeout(300);
  const rs = await page.evaluate(() => ({ me: LS.me && LS.me.code, box: Object.keys(LS.box).length, read: Object.keys(LS.read).length, quiz: LS.quiz.length, att: LS.att.length, out: LS.outbox.length, live: LS.live,
    ep: JSON.parse(localStorage.getItem('sensum_learn')).epoch, buckets: Object.keys(localStorage).filter(k => k.indexOf('sensum_learn_u_') === 0), lang: localStorage.getItem('sensum_lang') }));
  check(rs.me === '5678' && !rs.box && !rs.read && !rs.quiz && !rs.att && !rs.out && !rs.live && rs.ep === 1 && !rs.buckets.some(k => k !== 'sensum_learn_u_5678') && rs.lang === 'ru',
    'reset epoch: progress, history, queue and the other buckets are gone once, the login and the settings stay (' + JSON.stringify(rs) + ')');
  await page.evaluate(() => { LS.read['cf-milk'] = 1; LS.box['d:new'] = 1; touchProgress('d:new'); });
  await page.reload();
  await page.waitForTimeout(300);
  check(await page.evaluate(() => LS.read['cf-milk'] === 1 && LS.box['d:new'] === 1), 'reset epoch: the next start keeps what was made after it');
  await page.evaluate(v => { if (v) localStorage.setItem('sensum_learn_u_1234', v); }, keep1234);  /* the other tests go on with the first code's progress */
  await page.click('nav.tabs button[data-tab="learn"]');
  await page.evaluate(lv => { switchUser({ code: '1234', name: 'Smoke Test', branch: 'Test', level: lv }); renderLearn(); }, ME.level);
  await page.waitForTimeout(400);

  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exam"]');
  const ex = await page.evaluate(() => ({ n: L.qz.qs.length, kind: L.qz.kind, preps: L.qz.qs.filter(q => q.isPrep).length }));
  /* nothing read in this state is not the case here: everything is read, so the theory part is full */
  const exParts = await page.evaluate(() => { const qs = L.qz.qs; return { n: qs.length, kind: L.qz.kind, th: qs.filter(q => q.isTheory).length, vit: qs.filter(q => q.isVit).length,
    preps: qs.filter(q => q.isPrep).length, drinks: qs.filter(q => !q.isTheory && !q.isPrep && !q.isVit).length,
    openOnly: qs.filter(q => q.isTheory).every(q => passedTopics().has(TH.find(t => t.id === q.id).topic)),
    plain: qs.filter(q => !q.isTheory).every(q => ['dose', 'comp', 'photo', 'vessel', 'shelf', 'used', 'storage', 'vcomp', 'vhas', 'vnot', 'valg', 'vstor', 'vlife'].includes(q.type)) }; });
  check(exParts.n === 20 && exParts.kind === 'exam' && exParts.drinks === 6 && exParts.preps === 4 && exParts.vit === 4 && exParts.th === 6 && exParts.openOnly && exParts.plain,
    'the monthly exam: 20 questions, 6 drinks, 4 preps, 4 vitrina, 6 theory from the open topics (' + JSON.stringify(exParts) + ')');
  /* the exam has theory questions of every kind: pick, order or type something for each, then go on */
  for (let i = 0; i < 25 && await page.evaluate(() => L.view === 'quiz'); i++) {
    if (await page.locator('#learnroot [data-l="ans"]').count()) await page.locator('#learnroot [data-l="ans"]').first().click();
    else if (await page.locator('#learnroot #qnum').count()) { await page.fill('#qnum', '1'); await page.click('#qsubmit'); }
    else { const n = await page.locator('#learnroot [data-l="pick"]').count(); for (let k = 0; k < Math.min(n, 4); k++) await page.locator('#learnroot [data-l="pick"]').nth(k).click().catch(() => {});
      await page.click('#learnroot [data-l="submit"]'); }
    await page.click('#learnroot [data-l="next"]');
  }
  await page.waitForTimeout(500);
  const pe = posted[posted.length - 1] || {};
  check(pe.kind === 'exam' && pe.total === 20 && (await page.locator('#learnroot #sendstat').innerText()).includes('🦉 +15'), 'the exam is sent as the exam and shows the owls it earned');

  /* «Вопрос дня» (script v5.6): first row of the plan, 3 questions, sent as daily, not an attempt, not in the test history, once a day */
  const nDaily = { posted: posted.length, att: await page.evaluate(() => (LS.att || []).length), quiz: await page.evaluate(() => LS.quiz.length) };
  ME.daily = { done: false, streak: 2 };
  await page.click('nav.tabs button[data-tab="learn"]');
  await page.evaluate(() => { LS.dailyDay = ''; LS.today = null; });
  await refreshStats();
  let dp = await page.evaluate(() => [...document.querySelectorAll('#learnroot .plan .tile')].map(b => b.dataset.v));
  check(dp[0] === 'daily' && (await page.locator('#learnroot .gstats.four').count()) === 1 && (await page.evaluate(() => { const c = document.querySelectorAll('#learnroot .gstats.four > div')[3]; return !!c && !!c.querySelector('b svg.sym') && c.querySelector('b').textContent.trim() === '2'; })),
    '«Вопрос дня»: the first row of the plan, the run of days in the rank card (' + JSON.stringify(dp) + ')');
  await page.click('#learnroot .plan [data-v="daily"]');
  const dq0 = await page.evaluate(() => ({ n: L.qz.qs.length, kind: L.qz.kind, th: L.qz.qs.filter(q => q.isTheory).length, title: document.getElementById('learnTitle').innerText }));
  check(dq0.n === 3 && dq0.kind === 'daily' && dq0.th === 1 && dq0.title === 'Вопрос дня', '«Вопрос дня»: 3 questions, one of them theory of an open topic (' + JSON.stringify(dq0) + ')');
  for (let i = 0; i < 5 && await page.evaluate(() => L.view === 'quiz'); i++) {
    if (await page.locator('#learnroot [data-l="ans"]').count()) await page.locator('#learnroot [data-l="ans"]').first().click();
    else if (await page.locator('#learnroot #qnum').count()) { await page.fill('#qnum', '1'); await page.click('#qsubmit'); }
    else { const n = await page.locator('#learnroot [data-l="pick"]').count(); for (let k = 0; k < Math.min(n, 4); k++) await page.locator('#learnroot [data-l="pick"]').nth(k).click().catch(() => {});
      await page.click('#learnroot [data-l="submit"]'); }
    await page.click('#learnroot [data-l="next"]');
  }
  await page.waitForTimeout(500);
  const pd = posted[posted.length - 1] || {};
  const after = await page.evaluate(() => ({ att: (LS.att || []).length, quiz: LS.quiz.length, newBtn: !!document.querySelector('#learnroot [data-l="quiz"]') }));
  check(posted.length === nDaily.posted + 1 && pd.kind === 'daily' && pd.total === 3 && after.att === nDaily.att && after.quiz === nDaily.quiz && !after.newBtn,
    '«Вопрос дня»: sent as daily, not a weekly attempt, not in the test history, no «new test» button');
  check((await page.locator('#learnroot #sendstat').innerText()).includes('+50 XP') && (await page.locator('#learnroot #sendstat').innerText()).includes('подряд: 3 дня'), '«Вопрос дня»: the result shows the XP and the run of days');
  await page.click('nav.tabs button[data-tab="learn"]');
  dp = await page.evaluate(() => [...document.querySelectorAll('#learnroot .plan .tile')].map(b => ({ v: b.dataset.v, done: b.classList.contains('read') })));
  await page.evaluate(() => startDaily());
  check(dp[0].done && await page.evaluate(() => L.view === 'home'), '«Вопрос дня»: done for today, a second one does not start');
  /* without script v5.6 there is no «Вопрос дня» (an older script would file it as a test) */
  delete ME.daily; await refreshStats();
  check(await page.locator('#learnroot .plan [data-v="daily"]').count() === 0 && await page.evaluate(() => !dailyOpen()), '«Вопрос дня»: hidden with an older script');
  await page.click('#langbtn');  /* the finished test’s texts are in the old language: «язык» leaves the result for the screen the test started from */
  check(await page.evaluate(() => L.view === 'home' && !L.qz && L.nav.length === 0), 'language switch: a finished test’s result gives way to the screen before the test');
  await page.click('#langbtn');
  check(await page.locator('#learnroot [data-l="exam"][disabled]').count() === 1, 'one exam a month: the tile locks after it');
  /* the exam when little is read: the theory share is made up from the recipes, still 20 */
  const lowExam = await page.evaluate(() => { const keep = LS.read; const out = {};
    LS.read = {}; let qs = examQuestions(); out.none = { n: qs.length, th: qs.filter(q => q.isTheory).length, d: qs.filter(q => !q.isTheory && !q.isPrep && !q.isVit).length, p: qs.filter(q => q.isPrep).length, v: qs.filter(q => q.isVit).length };
    LS.read = {}; LES.filter(l => l.topic === 'CF-8').forEach(l => { LS.read[l.id] = 1; }); qs = examQuestions();
    out.one = { n: qs.length, th: qs.filter(q => q.isTheory).length, topics: [...new Set(qs.filter(q => q.isTheory).map(q => TH.find(t => t.id === q.id).topic))] };
    LS.read = keep; return out; });
  check(lowExam.none.n === 20 && lowExam.none.th === 0 && lowExam.none.d === 8 && lowExam.none.p === 6 && lowExam.none.v === 6, 'exam: nothing read, no theory, the recipes make up the 20 (8 drinks, 6 preps, 6 vitrina)');
  const cf8 = await page.evaluate(() => TH.filter(t => t.topic === 'CF-8' && LVL_RANK[t.lvl] <= LVL_RANK[myLvl() || 'senior']).length);
  check(lowExam.one.n === 20 && lowExam.one.th === Math.min(6, cf8) && lowExam.one.topics.join() === 'CF-8', 'exam: one topic read: its ' + Math.min(6, cf8) + ' questions are taken (at most 6), the rest comes from the recipes (' + JSON.stringify(lowExam.one) + ')');
  /* the vitrina is part of the general test (checked above); a deck of vitrina cards ends with a practice test as before */

  /* ---- the rhythm of the week (script v5.10): 3 tests a week (a trainee 5), one counted test a day, the strip of the week ---- */
  const setRhythm = async (over = {}, planOver = {}, N = 3) => {
    Object.assign(ME, { limits: { test: N }, perDay: 1, week: { test: 0 }, todayUsed: 0,
      plan: Object.assign({ tests: { test: 0 }, tried: { test: 0 }, testsDone: 0, testsNeed: N, lessons: 0, lessonsNeed: 2, full: false }, planOver) }, over);
    await page.evaluate(m => { LS.att = []; LS.lastTest = null; LS.read = {}; LS.today = null; LS.stats = Object.assign({}, m, { at: Date.now() }); L.nav = []; L.view = 'home'; saveLearn(); renderLearn(); }, ME);
  };
  const stripN = () => page.locator('#learnroot .wstrip .ws').count();
  await setRhythm();
  check((await tile().innerText()).includes('На этой неделе: 0 / 3') && await tile().isEnabled(), 'rhythm: an open week shows «0 / 3»');
  check(await stripN() === 5 && (await page.locator('#learnroot .wstrip small').innerText()).includes('0 из 5'), 'rhythm: for a barista the strip of the week has 3 tests + 2 lessons');
  check((await page.locator('#learnroot .gstats').innerText()).includes('0 / 3'), 'rhythm: the rank card counts the tests of the week out of three');
  await setRhythm({}, {}, 5);
  check((await tile().innerText()).includes('На этой неделе: 0 / 5') && await stripN() === 7 && (await page.locator('#learnroot .wstrip small').innerText()).includes('0 из 7') && (await page.locator('#learnroot .gstats').innerText()).includes('0 / 5'),
    'rhythm: for a trainee (quota 5) the tile, the strip (5 + 2) and the rank card say five');
  await setRhythm({ week: { test: 3 } }, { tests: { test: 3 }, testsDone: 3 });
  check(!(await tile().isEnabled()) && (await page.locator('#learnroot .att-full').innerText()).includes('сданы (3 / 3)') && await page.locator('#learnroot .wstrip .ws.done').count() === 3, 'rhythm: all three tests done: the tile is locked with the reason, the strip ticks them');
  check(await page.evaluate(() => planTest() === null), 'rhythm: the plan has no counted test left');
  await setRhythm({}, { tried: { test: 1 } });
  check(await page.evaluate(() => planTest().att.tried === true) && (await tile().innerText()).includes('ниже 70%') && await tile().isEnabled() && await page.locator('#learnroot .wstrip .ws.tried').count() === 1,
    'rhythm: a test taken below 70% does not use a slot: the tile says it can be taken again, the strip shows a ring');
  /* one counted test a day */
  await setRhythm({ todayUsed: 1 });
  check(!(await tile().isEnabled()) && (await page.locator('#learnroot .att-full').innerText()).includes('Сегодня зачётный тест уже сдан'), 'rhythm: a test already taken today locks the tile with the reason');
  check(await page.evaluate(() => { startQuiz(); return L.view === 'home'; }), 'rhythm: startQuiz refuses on that day');
  check((await page.locator('#learnroot .plan').innerText()).includes('откроется завтра') && await page.locator('#learnroot [data-l="plan"][data-v="mat"].lbtn, #learnroot .att-full + .lbtns [data-v="mat"]').count() >= 1,
    'rhythm: the plan says the next test opens tomorrow; practice stays on offer');
  await setRhythm();
  await page.evaluate(() => { LS.lastTest = bakuDay(); renderLearn(); });
  check(!(await tile().isEnabled()), 'rhythm: this phone remembers the test of today even when the stats are old');
  await page.evaluate(() => { LS.lastTest = bakuDay(Date.now() - 864e5); renderLearn(); });
  check(await tile().isEnabled(), 'rhythm: the next day the test opens again');
  /* starting and finishing: a test below 70% gives the slot back, the day stays taken */
  await setRhythm();
  await tile().click();
  check(await page.evaluate(() => L.view === 'quiz' && LS.att.length === 1 && LS.att[0].g === 'test' && LS.lastTest === bakuDay()), 'rhythm: a started test takes a slot and the day');
  await playQuiz(3);
  check(await page.evaluate(() => LS.att.length === 0 && LS.lastTest === bakuDay()), 'rhythm: finished below 70%: the slot is given back, the day stays taken');
  await page.evaluate(() => { L.nav = []; L.view = 'home'; renderLearn(); });
  await setRhythm();
  await tile().click();
  await playQuiz(9);
  check(await page.evaluate(() => LS.att.length === 1), 'rhythm: finished from 70%: the slot stays used');
  /* the strip: counted tests, a retry ring, lessons also from this phone */
  await setRhythm({}, { tests: { test: 2 }, tried: { test: 1 }, testsDone: 2, lessons: 1 });
  await page.evaluate(() => { LS.read['cf-milk'] = bakuDay(); LS.read['cf-farm'] = bakuDay(); renderLearn(); });
  check(await page.locator('#learnroot .wstrip .ws.done').count() === 4 && await page.locator('#learnroot .wstrip .ws.tried').count() === 1 && (await page.locator('#learnroot .wstrip small').innerText()).includes('4 из 5'),
    'rhythm: the strip shows 2 tests and 2 lessons done and the ring of a test below 70% (lessons counted from this phone too)');
  check((await page.locator('#learnroot .gstats').innerText()).includes('2 / 3'), 'rhythm: the rank card shows 2 / 3');
  const rulesTxt = await page.locator('#learnroot details.rules').textContent();
  check(rulesTxt.includes('Не больше одного зачётного теста в день') && rulesTxt.includes('прерванный засчитывает') && rulesTxt.includes('+3 — полная неделя'), 'rhythm: the rules list explains the quota, the day and the full week');
  /* the days of the lessons go to the sheet, and come back */
  const nProg = progPosts.length;
  await page.evaluate(() => { LS.read['cf-milk'] = bakuDay(); LS.read['cf-old'] = 1; touchProgress(); pushProgress(); });
  await page.waitForTimeout(500);
  const lp = progPosts[progPosts.length - 1];
  check(progPosts.length > nProg && lp.readAt && lp.readAt['cf-milk'] === (await page.evaluate(() => bakuDay())) && !('cf-old' in lp.readAt) && lp.read.includes('cf-old'), 'progress: the day of a counted lesson is sent, a lesson without a day only as read');
  check(await page.evaluate(() => { LS.read['zz-x'] = 1; applyProgress({ read: ['zz-x'], readAt: { 'zz-x': '2026-10-01' }, box: {}, ts: Date.now() + 5000 }); return LS.read['zz-x'] === '2026-10-01'; }), 'progress: a lesson known without a day gets its day from the sheet');
  /* an older script (no `limits.test`: the two pools or none) still works: a test without a limit and without the strip */
  delete ME.perDay; delete ME.todayUsed; delete ME.plan; ME.limits = { recipes: 4, theory: 2 }; ME.week = { recipes: 1, theory: 0 };
  await page.evaluate(m => { delete LS.stats.perDay; delete LS.stats.plan; LS.stats.limits = m.limits; LS.stats.week = m.week; LS.stats.at = Date.now(); LS.att = []; LS.lastTest = null; LS.read = {}; L.nav = []; L.view = 'home'; renderLearn(); }, ME);
  check(await page.locator('#learnroot .wstrip').count() === 0 && !(await tile().innerText()).includes('На этой неделе') && await tile().isEnabled(), 'rhythm: with the older script no strip and no limit on the general test');
  delete ME.limits; delete ME.week;

  /* ---- «План месяца» (script v5.9): the share of the plan, what it costs, the trial month, the warning ---- */
  const kpiBase = { month: '2026-11', state: 'trial', pct: 74, parts: { weeks: 79, exam: null, quality: 100, regularity: 100 }, weeksDone: 2, weeksTotal: 5, absentDays: 0, graceUntil: '',
    examPending: true, loss: 6, lossIfExamMissed: 12, threshold: 80, cap: 30 };
  const setKpi = async (k, now) => page.evaluate(([kk, n]) => {
    if (n) { if (!window.__dn) window.__dn = Date.now.bind(Date); Date.now = () => n; }
    LS.stats = Object.assign(LS.stats || {}, { kpi: kk, at: Date.now() }); L.nav = []; L.view = 'home'; renderLearn();
  }, [k, now || 0]);
  await setKpi(kpiBase, Date.parse('2026-11-11T10:00:00Z'));  // a Wednesday in the middle of the month
  const kc = () => page.locator('#learnroot .lpanel.kpi');
  const ktxt = async () => (await kc().innerText()).replace(/\s+/g, ' ');
  let kt = await ktxt();
  check(await kc().count() === 1 && kt.includes('План месяца') && kt.includes('74% · нужно 80%') && kt.includes('Недели') && kt.includes('Качество тестов') && kt.includes('Регулярность') && kt.includes('Экзамен месяца ещё не сдан'),
    '«План месяца»: the percent against the threshold and the four parts, the exam still to be taken (' + kt.slice(0, 120) + ')');
  check(kt.includes('Пробный месяц: ничего не списывается.') && kt.includes('Так выглядел бы минус: −6% KPI обучения.') && kt.includes('без него минус KPI обучения будет до −12%'), '«План месяца»: a trial month shows what the loss would be, and what missing the exam would add');
  check(await page.evaluate(() => { const u = document.querySelector('.kbar u'), i = document.querySelector('.kbar i'); return u.style.left === '80%' && i.style.width === '74%'; }), '«План месяца»: the bar fills to the percent and shows the threshold');
  check(await kc().evaluate(el => !el.classList.contains('warn')), '«План месяца»: no warning in the middle of the month on a Wednesday');
  check(await page.evaluate(() => { const r = document.getElementById('learnroot'), y = e => e.getBoundingClientRect().top; return y(r.querySelector('.lpanel.plan')) < y(r.querySelector('.lpanel.kpi')) && y(r.querySelector('.lpanel.kpi')) < y(r.querySelector('.lpanel.game')); }), '«План месяца»: under «План на сегодня», above the rank card');
  await setKpi(Object.assign({}, kpiBase, { state: 'live', examPending: false, parts: { weeks: 79, exam: 100, quality: 100, regularity: 100 } }), Date.parse('2026-11-11T10:00:00Z'));
  kt = await ktxt();
  check(!kt.includes('Пробный месяц') && kt.includes('Если ничего не менять: −6% KPI обучения.') && !kt.includes('без него'), '«План месяца»: after the trial the loss is stated as a loss');
  await setKpi(Object.assign({}, kpiBase, { pct: 90, loss: 0, lossIfExamMissed: 0, examPending: false, state: 'live' }), Date.parse('2026-11-11T10:00:00Z'));
  check((await ktxt()).includes('Потерь нет: план выполнен на 80% и больше.'), '«План месяца»: from the threshold nothing is lost');
  await setKpi(Object.assign({}, kpiBase, { pct: null, parts: { weeks: null, exam: null, quality: null, regularity: null }, loss: 0 }), Date.parse('2026-11-02T10:00:00Z'));
  check((await ktxt()).includes('Месяц только начался'), '«План месяца»: before the first week is over there is no percent');
  await setKpi(Object.assign({}, kpiBase, { graceUntil: '2026-11-14', absentDays: 5 }), Date.parse('2026-11-11T10:00:00Z'));
  kt = await ktxt();
  check(kt.includes('Льгота новичка до 14 ноября: списаний нет.') && kt.includes('Отсутствие: 5 дн. не считаются.'), '«План месяца»: a newcomer’s grace and the days of leave are named');
  // the warning: on a Friday, or in the last two days of the month, when something would be lost
  await setKpi(kpiBase, Date.parse('2026-11-13T10:00:00Z'));
  check(await kc().evaluate(el => el.classList.contains('warn')) && (await ktxt()).includes('Внимание: до конца месяца 17 дн., план выполнен на 74% из 80%.'), '«План месяца»: a warning on Friday');
  await setKpi(kpiBase, Date.parse('2026-11-29T10:00:00Z'));
  check(await kc().evaluate(el => el.classList.contains('warn')) && (await ktxt()).includes('до конца месяца 1 дн.'), '«План месяца»: a warning in the last days of the month');
  await setKpi(Object.assign({}, kpiBase, { loss: 0, lossIfExamMissed: 0, pct: 95 }), Date.parse('2026-11-13T10:00:00Z'));
  check(await kc().evaluate(el => !el.classList.contains('warn')), '«План месяца»: nothing to be warned of when nothing would be lost');
  const rulesTxt2 = await page.locator('#learnroot details.rules').textContent();
  check(rulesTxt2.includes('План месяца: недели 60%, экзамен 20%') && rulesTxt2.includes('От 80% потерь нет') && rulesTxt2.includes('не больше 30%'), '«План месяца»: the rules panel tells how the percent is made');
  await page.evaluate(() => { delete LS.stats.kpi; renderLearn(); });
  check(await kc().count() === 0, '«План месяца»: an older script (no kpi) means no card');
  await page.evaluate(() => { Date.now = window.__dn; });
  await page.unroute('https://script.google.com/**');
  await page.route('https://script.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, service: 'sensum-learn', version: 'v4' }) }));
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });  // the old script answers ?action=me with no game data
  await page.waitForTimeout(400);
  check(!(await page.locator('#learnroot').innerText()).includes('undefined') && await page.locator('#learnroot .game').count() === 0,
    'a sheet script older than v5: no game card, nothing broken');

  /* search: Russian spellings of the Latin names, every word separately, the Azerbaijani İ */
  await page.evaluate(() => { if (LANG !== 'ru') setLang('ru'); switchTab('drinks'); });
  const hits = async q => { await page.fill('#q', q); await page.waitForTimeout(80); return page.evaluate(() => [...document.querySelectorAll('#grid .card')].map(c => c.dataset.open)); };
  const capp = await hits('капучино'), flat = await hits('флэт уайт'), rafv = await hits('раф ваниль');
  check(capp.includes('cappuccino') && flat.includes('flatwhite') && rafv.length > 0 && rafv.length < 6 && (await hits('ЛАТТЕ')).length === (await hits('латте')).length,
    `search: Russian typing finds the Latin names (капучино ${capp.length}, флэт уайт ${flat.length}, раф ваниль ${rafv.length})`);
  check((await hits('zzzz')).length === 0 && (await hits('  latte  ')).length === (await hits('latte')).length, 'search: nonsense finds nothing, surrounding spaces are ignored');
  await page.evaluate(() => setLang('az'));
  check(await page.evaluate(() => document.documentElement.lang) === 'az', '<html lang> follows the language (screen readers)');
  check((await hits('isti')).length > 0 && (await hits('isti')).length === (await hits('İsti')).length, 'search AZ: «isti» and «İsti» find the same');
  await page.fill('#q', ''); await page.evaluate(() => { setLang('ru'); renderDrinks(); });

  /* the system «back»: card, then nothing left to close; a training screen steps back */
  await page.evaluate(() => switchTab('drinks'));
  await page.locator('#grid .card').first().click(); await page.waitForTimeout(300);
  const histOpen = await page.evaluate(() => history.length);
  await page.goBack(); await page.waitForTimeout(300);
  check(page.url().includes('index.html') && await page.evaluate(() => !document.getElementById('overlay').classList.contains('show')),
    'system «back» closes an open card and stays in the app');
  check(await page.evaluate(() => !history.state || !history.state.sensum), 'no history entry left behind once nothing is open');
  await page.evaluate(() => { switchTab('learn'); learnGo('materials'); });
  await page.waitForTimeout(200);
  await page.goBack(); await page.waitForTimeout(300);
  check(page.url().includes('index.html') && await page.evaluate(() => L.view === 'home'), 'system «back» in «Обучение» steps back one screen');

  /* the login never hangs: a script that does not answer gives a message */
  await page.evaluate(() => { switchUser(null); renderLearn(); API_WAIT.get = 600; });
  const silent = () => {};
  await page.route('https://script.google.com/**', silent);  // newest route wins: no answer at all
  await page.fill('#lcode', '1234'); await page.click('#learnroot [data-l="login"]');
  await page.locator('#learnroot [data-l="login"]').click();  // a second tap while waiting sends nothing more
  await page.waitForTimeout(1200);
  check((await page.locator('#idstat').innerText()) === await page.evaluate(() => T('id_timeout')), 'login: a script that never answers gives «Сервер не ответил» instead of «…»');
  await page.unroute('https://script.google.com/**', silent);
  await page.evaluate(() => { API_WAIT.get = 20000; });

  check(!(await page.evaluate(() => document.getElementById('scrollArea').scrollWidth > document.getElementById('scrollArea').clientWidth)), 'no horizontal scroll at 390px');
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

  /* the style guide renders the real components from index.html's stylesheet */
  const sg = await ctx.newPage(); const sgErr = [];
  sg.on('pageerror', e => sgErr.push(e.message)); sg.on('console', m => { if (m.type() === 'error') sgErr.push(m.text()); });
  await sg.goto(base.replace('index.html', 'styleguide.html'));
  await sg.waitForSelector('[data-sg-ready]', { timeout: 5000 }).catch(() => {});
  check(await sg.locator('.sg section').count() === 8 && await sg.locator('.sg .lbtn.pri').count() >= 1 && await sg.locator('.sg .card').count() === 2
    && await sg.locator('.sg #icg svg.sym').count() >= 30 && await sg.locator('.sg #sw .sw i').count() >= 25
    && !(await sg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) && sgErr.length === 0, 'style guide page renders the v2 foundations (roles, icons) and every component without errors');
  await browser.close();
  server.close();
  console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall smoke checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('smoke test crashed:', e.message); server.close(); process.exit(1); });
