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
  let mockOver = false;  /* the sheet says the result was over the weekly limit */
  const ME = { ok: true, level: 'barista', name: 'Smoke Test', branch: 'Test', xp: 1140, weekXp: 660, weekTests: 2, streak: 3, owlsMonth: 18, owlsTotal: 18, owlsCap: 50,
    badges: ['first', 'perfect', 'exam100'], exam: null,
    board: { people: [{ name: 'Smoke Test', branch: 'Test', xp: 660, me: true }, { name: 'Other', branch: 'Central Park', xp: 350, me: false }], rank: 1,
      branches: [{ branch: 'Central Park', xp: 70, staff: 5 }] } };
  await page.route('https://script.google.com/**', route => {
    const req = route.request(), url = new URL(req.url());
    let body;
    if (req.method() === 'POST') {
      const d = JSON.parse(req.postData()); posted.push(d);
      body = d.kind === 'exam' ? { ok: true, xp: 300, owls: [{ why: 'Экзамен месяца 100%', n: 15 }] } : { ok: true, xp: mockOver ? 0 : 90, owls: [], over: mockOver };
    }
    else if (url.searchParams.get('action') === 'me') body = ME;
    else if (url.searchParams.get('action') === 'whoami') {
      body = url.searchParams.get('code') === '1234' ? { ok: true, name: 'Smoke Test', branch: 'Test', level: ME.level } : { ok: false, error: 'unknown_code' };
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

  /* exam-style questions across recipes: exactly one option is right, checked here against the recipes themselves */
  const exs = await page.evaluate(() => {
    const out = { n: {}, bad: [] }, NEW = ['has', 'without', 'both', 'most', 'least', 'same'];
    const exact = (d, k) => d.ing.some(([n]) => n.toLowerCase() === k);
    const dose = (d, k, u) => { for (const [n, qq] of d.ing) if (n.toLowerCase() === k) { const p = parseQ(qq); if (p && p.u === u) return p.n; } return null; };
    for (const lang of ['ru', 'az']) {
      setLang(lang); L.scope = 'drinks'; L.cat = 'all';
      const by = Object.fromEntries(drinks.map(d => [d.name, d]));
      for (let i = 0; i < 60; i++) for (const q of buildQuiz(learnItems())) {
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
  check(['has', 'without', 'both', 'same'].every(k => exs.n['ru' + k] && exs.n['az' + k]) && (exs.n.rumost || 0) + (exs.n.ruleast || 0) > 0 && (exs.n.azmost || 0) + (exs.n.azleast || 0) > 0,
    'exam-style recipe questions: every kind appears in both languages');

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

  await page.click('nav.tabs button[data-tab="more"]');
  await page.click('#morehub [data-gotab="learn"]');
  await page.click('#learnroot [data-l="scope"][data-v="theory"]');
  check(await page.locator('#learnroot [data-l="dir"]').count() === 5 && await page.locator('#learnroot [data-l="cards"]').count() === 0
    && await page.locator('#learnroot [data-l="quiz"]').count() === 1, 'theory: a chip per direction, a test, no flashcards');
  await page.click('#learnroot [data-l="dir"][data-v="CF"]');
  check(await page.locator('#learnroot [data-l="topic"]').count() === 11, 'theory: a direction shows its topics');
  await page.click('#learnroot [data-l="topic"][data-v="CF-8"]');
  await page.click('#learnroot [data-l="quiz"]');
  check(await page.evaluate(() => L.qz.qs.length === 4 && L.qz.qs.every(q => q.id.startsWith('CF-4') || /^CF-/.test(q.id)) && L.qz.scope.includes('Молоко')),
    'theory: a topic test takes only that topic and names it');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exit"]');
  await page.waitForTimeout(300);
  const nTheoryBefore = posted.length;
  check(posted[nTheoryBefore - 1].aborted === true && posted[nTheoryBefore - 1].kind === 'theory', 'theory: an aborted test is sent as a theory test');

  /* all four kinds of question, answered right through the screen */
  const startTheory = ids => page.evaluate(ids => { L.scope = 'theory'; beginQuiz(ids.map(id => mkTheoryQ(TH.find(t => t.id === id))), 'theory', scopeLabel()); }, ids);
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
  /* the «last test» line keeps the scope in the language it was taken in, so only the chips and the test tile are checked */
  const azHome = (await page.locator('#learnroot .lchips').allInnerTexts()).join(' ') + ' ' + await page.locator('#learnroot [data-l="quiz"]').innerText();
  check(azHome.includes('Qəhvə: nəzəriyyə') && azHome.includes('Nəzəriyyə') && azHome.includes('Mənim səviyyəm') && !/[А-Яа-яЁё]/.test(azHome)
    && (await page.locator('#learnroot').innerText()).includes('Sənin səviyyən: Barista'), 'AZ: theory chips, level chips, level panel and test tile are Azerbaijani');
  await page.click('#learnroot [data-l="dir"][data-v="SV"]');
  await page.click('#learnroot [data-l="quiz"]');
  check(await page.locator('#learnroot .qtext').count() === 1 && !/[А-Яа-яЁё]/.test(await page.locator('#learnroot .qtext').innerText()), 'AZ: a theory question is in Azerbaijani');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exit"]');
  await page.waitForTimeout(300);
  await page.click('#langbtn');
  await page.click('#learnroot [data-l="scope"][data-v="drinks"]');

  /* levels: cumulative, taken from the staff sheet at login */
  const lvlCount = () => page.evaluate(() => theoryItems().length);
  await page.click('#learnroot [data-l="scope"][data-v="theory"]');
  const home1 = await page.locator('#learnroot').innerText();
  check(home1.includes('Smoke Test · Test · Бариста') && home1.includes('Твой уровень: Бариста') && await page.locator('#learnroot [data-l="lvl"]').count() === 2,
    'levels: the login shows the level; the theory home shows the level panel and the two level chips');
  check(await lvlCount() === 92 && await page.evaluate(() => theoryItems().every(t => t.lvl !== 'senior')), 'levels: a barista gets the trainee and barista questions (92), none of the senior ones');
  await page.click('#learnroot [data-l="lvl"][data-v="all"]');
  check(await lvlCount() === 101, 'levels: «Все уровни» shows all 101');
  await page.click('#learnroot [data-l="lvl"][data-v="my"]');
  ME.level = 'trainee';  /* the trainer sets the level in the sheet; the app picks it up with the next stats refresh */
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); L.dir = 'all'; L.topic = 'all'; });
  await page.waitForTimeout(500);
  check(await lvlCount() === 31 && await page.evaluate(() => theoryItems().every(t => t.lvl === 'trainee')), 'levels: a trainee gets only the 31 trainee questions');
  await page.click('#learnroot [data-l="dir"][data-v="CF"]');
  const cfTopics = await page.locator('#learnroot [data-l="topic"]').count();
  const cfExpected = await page.evaluate(() => new Set(TH.filter(t => t.lvl === 'trainee' && t.topic.startsWith('CF-')).map(t => t.topic)).size + 1);
  check(cfTopics === cfExpected && cfTopics < 11, `levels: a trainee sees only the coffee topics that have trainee questions (${cfTopics - 1} of 10)`);
  await page.click('#learnroot [data-l="quiz"]');
  check(await page.evaluate(() => L.qz.qs.length > 0 && L.qz.qs.every(q => TH.find(t => t.id === q.id).lvl === 'trainee') && L.qz.scope.includes('Стажёр')),
    'levels: the test takes only trainee questions and names the level in its scope');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exit"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => { levelSet('trainee').forEach(t => { LS.box[boxKey(t)] = 2; }); L.dir = 'all'; L.topic = 'all'; renderLearn(); });
  check((await page.locator('#learnroot').innerText()).includes('Ты готов к уровню «Бариста»'), 'levels: 80% of the level learned = «ready for the next level»');
  ME.level = 'senior';
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);
  check((await page.locator('#learnroot').innerText()).includes('Высший уровень') && await lvlCount() === 101, 'levels: a senior sees everything and the top-level note');
  ME.level = '';
  await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);
  check(await page.locator('#learnroot [data-l="lvl"]').count() === 0 && await lvlCount() === 101 && !(await page.locator('#learnroot').innerText()).includes('Твой уровень'),
    'levels: no level (an older sheet script, an empty cell) = all questions, no level chips, no panel');
  ME.level = 'barista';
  await page.evaluate(() => { LS.box = {}; saveLearn(); L.lvlAll = false; LS.stats = null; statsBusy = false; fetchStats(); });
  await page.waitForTimeout(500);
  await page.click('#learnroot [data-l="scope"][data-v="drinks"]');

  /* weekly limit of attempts: the sheet's script says how many; aborted tests count, retries and the exam do not */
  const refreshStats = async () => { await page.evaluate(() => { LS.stats = null; statsBusy = false; fetchStats(); }); await page.waitForTimeout(500); };
  const tile = () => page.locator('#learnroot [data-l="quiz"]');
  ME.limits = { recipes: 3, theory: 2 }; ME.week = { recipes: 0, theory: 0 };
  await page.evaluate(() => { LS.att = []; L.scope = 'drinks'; L.cat = 'all'; });
  await refreshStats();
  check((await tile().innerText()).includes('Попыток на неделе: 0 / 3') && await tile().isEnabled(), 'limit: the test tile shows the attempts of the week');
  for (let i = 0; i < 3; i++) {
    await tile().click();
    page.once('dialog', d => d.accept());
    await page.click('#learnroot [data-l="exit"]');
    await page.waitForTimeout(250);
  }
  check(await tile().isDisabled() && (await page.locator('#learnroot .att-full').innerText()).includes('3 / 3'), 'limit: three attempts (aborted ones too) use the week up; the tile locks and says why');
  check(await page.evaluate(() => { startQuiz(); return L.view !== 'quiz'; }), 'limit: a start at the limit does nothing');
  check(await page.locator('#learnroot [data-l="mat"]').isEnabled(), 'limit: materials and cards stay open');
  await page.click('#learnroot [data-l="scope"][data-v="preps"]');
  check(await tile().isDisabled(), 'limit: preps share the limit of the recipe tests');
  await page.click('#learnroot [data-l="scope"][data-v="theory"]');
  check((await tile().innerText()).includes('Попыток на неделе: 0 / 2') && await tile().isEnabled(), 'limit: theory has its own limit of two');
  check((await page.locator('#learnroot .rules').textContent()).includes('3 по рецептам и 2 по теории'), 'limit: the rules list says the limits');
  await page.evaluate(() => { LS.att = []; L.scope = 'drinks'; renderLearn(); });
  ME.week = { recipes: 3, theory: 0 }; await refreshStats();
  check(await tile().isDisabled(), 'limit: the sheet’s count blocks the test even if the phone forgot its own');
  ME.week = { recipes: 0, theory: 0 }; await refreshStats();
  await page.evaluate(() => { LS.att = [1, 2, 3].map(() => ({ g: 'recipes', ts: weekStartTs() - 60000 })); renderLearn(); });
  check(await tile().isEnabled() && (await tile().innerText()).includes('0 / 3'), 'limit: attempts of the previous week do not count');
  mockOver = true;
  await tile().click();
  for (let i = 0; i < 15 && await page.locator('#learnroot [data-l="ans"]').count(); i++) { await page.locator('#learnroot [data-l="ans"]').first().click(); await page.click('#learnroot [data-l="next"]'); }
  await page.waitForSelector('#learnroot #sendstat .badn', { timeout: 5000 }).catch(() => {});
  check((await page.locator('#learnroot #sendstat').innerText()).includes('сверх недельного лимита'), 'limit: the result says when the sheet counted it over the limit');
  mockOver = false;
  await page.click('#learnBack');
  delete ME.limits; delete ME.week;
  await page.evaluate(() => { LS.att = []; });
  await refreshStats();
  check(!(await tile().innerText()).includes('Попыток на неделе') && await tile().isEnabled(), 'limit: a sheet script without limits (older) means no limit');

  /* the game: level, owls, board and badges come from the sheet; the monthly exam */
  await page.click('nav.tabs button[data-tab="more"]');
  await page.click('#morehub [data-gotab="learn"]');
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
    return { id: y(r.querySelector('.idrow')), level: y(lp('Твой уровень')), rank: y(r.querySelector('.lpanel.game')), progress: y(lp('Твой прогресс')),
      mat: y(r.querySelector('[data-l="mat"]')), test: y(r.querySelector('h4.lsect')), quiz: y(quiz), rating: y(big), board: y(r.querySelector('.board')),
      gap: big && quiz ? big.getBoundingClientRect().top - quiz.getBoundingClientRect().bottom : -1 };
  });
  const seq = ['id', 'level', 'rank', 'progress', 'mat', 'test', 'quiz', 'rating', 'board'].map(k => tops[k]);
  check(seq.every(v => v >= 0) && seq.every((v, i) => i === 0 || v > seq[i - 1]), 'training home order: employee, level, rank, progress, materials, test, rating' + (seq.every((v, i) => v >= 0 && (i === 0 || v > seq[i - 1])) ? '' : ' ' + JSON.stringify(tops)));
  check(tops.gap >= 24, `training home: the weekly board starts ${Math.round(tops.gap)} px below the test`);
  const homeTxt = await page.locator('#learnroot').innerText();
  check(homeTxt.includes('Твой уровень: Бариста') && /ранг \d/.test(homeTxt) && !/уровень \d/.test(homeTxt), 'the level is the employee’s level, the XP level is called a rank');

  /* materials: cards for drinks, preps and the vitrina */
  const runCards = async () => { for (let i = 0; i < 60 && await page.evaluate(() => L.view) === 'cards'; i++) {
    if (await page.locator('#learnroot .fc.back').count()) await page.click('#learnroot [data-l="know"]');
    else { await page.click('#learnroot [data-l="flip"]'); await page.locator('#learnroot .fc.back').waitFor(); }
  } };
  await page.evaluate(() => { L.nav = []; });
  await page.click('#learnroot [data-l="mat"]');
  check(await page.locator('#learnroot [data-l="matcat"]').count() === 3, 'materials: drinks, preps and vitrina');
  const backTxt0 = () => page.locator('#learnBack').innerText();
  check((await backTxt0()).includes('Обучение') && await page.locator('#learnroot [data-l="home"]').count() === 0 && (await page.locator('#learnroot').innerText()).indexOf('К обучению') < 0, 'back: materials returns to «Обучение» (the button names it) and has no extra link');

  /* lessons: a category tile, a list, a lesson, «прочитано», and a theory test on the lesson's topic */
  check(await page.locator('#learnroot [data-l="lcat"]').count() === 1 && (await page.locator('#learnroot [data-l="lcat"]').innerText()).includes('0 / 17'), 'lessons: one category tile (coffee) with 0 / 17 read');
  await page.click('#learnroot [data-l="lcat"]');
  check(await page.locator('#learnroot [data-l="lesson"]').count() === 17, 'lessons: the list has the 17 coffee lessons');
  check((await backTxt0()).includes('Материалы'), 'back: the lesson list returns to «Материалы»');
  await page.click('#learnroot [data-l="lesson"]:nth-child(3)');
  check((await backTxt0()).includes('Кофе'), 'back: a lesson returns to its list, the button says «Кофе»');
  const les3 = await page.evaluate(() => ({ id: L.lid, title: LES.find(x => x.id === L.lid).title }));
  const lt = await page.locator('#learnroot').innerText();
  check(les3.id === 'cf-species' && lt.includes(les3.title) && await page.locator('#learnroot table.ltab').count() === 1 && lt.includes('2–3 %'), 'lesson: title, the arabica / robusta table and its numbers');
  check(await page.locator('#learnroot [data-l="lread"]').count() === 1 && await page.locator('#learnroot [data-l="ltest"]').count() === 1, 'lesson: «mark read» and «test yourself» buttons');
  await page.click('#learnroot [data-l="lread"]');
  check(await page.evaluate(() => LS.read['cf-species'] === 1) && await page.locator('#learnroot [data-l="lread"]').count() === 0, 'lesson: marked read, remembered in sensum_learn.read');
  await page.click('#learnBack');
  check((await page.locator('#learnroot .tile.read').count()) === 1 && (await page.locator('#learnroot .lpanel').first().innerText()).includes('1 / 17'), 'lessons: the list shows the read lesson and 1 / 17');
  /* the scroll position comes back with the screen */
  await page.click('#learnroot [data-l="lesson"]:nth-child(14)');
  const y14 = await page.evaluate(() => { const y = L.nav[L.nav.length - 1].y; return y; });
  await page.click('#learnBack');
  check(y14 > 0 && Math.abs(await page.evaluate(() => document.getElementById('scrollArea').scrollTop) - y14) <= 2, 'back: the list is scrolled where it was (' + y14 + ' px)');
  await page.click('#learnBack');
  check((await page.locator('#learnroot [data-l="lcat"]').innerText()).includes('1 / 17'), 'materials: the tile counts the read lessons');
  await page.evaluate(() => { LS.att = []; if (LS.stats) LS.stats.week = { recipes: 0, theory: 0 }; });
  await page.click('#learnroot [data-l="lcat"]');
  await page.click('#learnroot [data-l="lesson"][data-v="cf-milk"]');
  await page.click('#learnroot [data-l="ltest"]');
  const lq = await page.evaluate(() => ({ view: L.view, kind: L.qz && L.qz.kind, topic: L.qz && [...new Set(L.qz.qs.map(q => TH.find(t => t.id === q.id).topic))], n: L.qz && L.qz.qs.length, scope: L.qz && L.qz.scope }));
  check(lq.view === 'quiz' && lq.kind === 'theory' && lq.topic.length === 1 && lq.topic[0] === 'CF-8' && lq.n >= 3 && lq.scope.includes('Молоко'), 'lesson test: a theory test of this lesson’s topic only (CF-8, ' + lq.n + ' questions)');
  page.once('dialog', d => d.accept());
  await page.click('#learnBack');
  await page.waitForTimeout(250);
  check(await page.evaluate(() => L.view === 'lesson' && L.lid === 'cf-milk' && !L.qz), 'back: leaving a test started from a lesson returns to that lesson');
  /* a language switch keeps the screen */
  await page.click('#langbtn');
  const azLes = await page.locator('#learnroot').innerText();
  check(await page.evaluate(() => L.view === 'lesson' && L.lid === 'cf-milk') && azLes.includes('Süd') && !/[А-Яа-яЁё]/.test(azLes + await backTxt0()), 'language switch: an open lesson stays open, now in Azerbaijani');
  await page.click('#langbtn');
  await page.click('#learnBack'); await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'materials'), 'back: lesson → list → materials');
  await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'home' && L.nav.length === 0) && (await backTxt0()).includes('Ещё'), 'back: materials → «Обучение», whose button says «Ещё»');
  await page.click('#learnBack');
  check(await page.evaluate(() => state.tab === 'more'), 'back: the last step leaves «Обучение» for «Ещё»');
  await page.click('#morehub [data-gotab="learn"]');
  const lessonProblems = async () => page.evaluate(() => { const bad = [], sa = document.getElementById('scrollArea'); sa.scrollLeft = 0;
    for (const les of LES) { L.lid = les.id; L.view = 'lesson'; renderLearn(); const t = document.getElementById('learnroot').innerText;
      if (sa.scrollWidth > sa.clientWidth) bad.push(les.id + ': wider than the screen');
      if (t.includes('undefined') || !t.includes(les.title)) bad.push(les.id + ': text');
      if (LANG === 'az' && /[А-Яа-яЁё]/.test(t)) bad.push(les.id + ': Russian letters'); }
    L.view = 'home'; renderLearn(); return bad; });
  const badRu = await lessonProblems();
  check(badRu.length === 0, 'every lesson renders at 390px without side scroll (RU)' + (badRu.length ? ': ' + badRu.join(' | ') : ''));
  await page.evaluate(() => { L.view = 'home'; L.nav = []; renderLearn(); });
  await page.click('#learnroot [data-l="mat"]');
  await page.click('#learnroot [data-l="matcat"][data-v="v"]');
  check(await page.locator('#learnroot [data-l="mvcat"]').count() === 4 && await page.locator('#learnroot [data-l="cards"]').count() === 1, 'materials: the vitrina has its category chips and a cards button');
  await page.click('#learnroot [data-l="mvcat"][data-v="dessert"]');
  await page.click('#learnroot [data-l="cards"]');
  const front = await page.locator('#learnroot .fc').innerText();
  check(await page.evaluate(() => L.fc.src === 'v' && L.fc.deck.every(id => vitById[id].cat === 'dessert')) && !front.includes('Аллерген'), 'vitrina card: the front shows the name only, from the chosen category');
  const vitName = await page.evaluate(() => vitById[L.fc.deck[0]].name);
  await page.click('#learnroot [data-l="flip"]');
  const backTxt = await page.locator('#learnroot .fc.back').innerText();
  check(backTxt.includes(vitName) && backTxt.includes(await page.evaluate(() => T('sec_sostav'))) && backTxt.toLowerCase().includes((await page.evaluate(() => T('sec_allergens'))).toLowerCase()), 'vitrina card: the back shows composition and allergens');
  await page.click('#learnroot [data-l="know"]');
  check(await page.evaluate(id => LS.box['v:' + id] === 1, await page.evaluate(() => L.fc.deck[0])), 'vitrina card: «Знаю» raises the card’s box (v:<id>)');
  await runCards();
  check(await page.locator('#learnroot [data-l="cardsquiz"]').count() === 0 && (await backTxt0()).includes('Витрина'), 'vitrina cards done: no recipe test offered, «назад» returns to the deck');
  await page.click('#learnBack'); await page.click('#learnBack');
  check(await page.evaluate(() => L.view === 'materials'), 'back: cards → deck → materials');
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
  const azMat = await page.locator('#learnroot').innerText();
  check(azMat.includes('Materiallar') && azMat.includes('Vitrin') && !/[А-Яа-яЁё]/.test(azMat), 'AZ: the materials screen is Azerbaijani');
  const badAz = await lessonProblems();
  check(badAz.length === 0, 'every lesson renders at 390px without side scroll, no Russian letters (AZ)' + (badAz.length ? ': ' + badAz.join(' | ') : ''));
  await page.evaluate(() => { L.view = 'materials'; renderLearn(); });
  await page.click('#langbtn');
  check(await page.evaluate(() => L.view === 'materials'), 'language switch: the materials screen stays');
  await page.click('#learnBack');
  page.once('dialog', d => d.accept());
  await page.click('#learnroot [data-l="exam"]');
  const ex = await page.evaluate(() => ({ n: L.qz.qs.length, kind: L.qz.kind, preps: L.qz.qs.filter(q => q.isPrep).length }));
  check(ex.n === 20 && ex.kind === 'exam' && ex.preps === 8, 'the monthly exam: 20 questions, drinks and preps together');
  check(await page.evaluate(() => L.qz.qs.every(q => ['dose', 'comp', 'photo', 'vessel', 'shelf', 'used', 'storage'].includes(q.type))), 'the monthly exam keeps its plain question set');
  for (let i = 0; i < 25 && await page.locator('#learnroot [data-l="ans"]').count(); i++) {
    await page.locator('#learnroot [data-l="ans"]').first().click();
    await page.click('#learnroot [data-l="next"]');
  }
  await page.waitForTimeout(500);
  const pe = posted[posted.length - 1] || {};
  check(pe.kind === 'exam' && pe.total === 20 && (await page.locator('#learnroot #sendstat').innerText()).includes('🦉 +15'), 'the exam is sent as the exam and shows the owls it earned');
  await page.click('#langbtn');  /* the finished test’s texts are in the old language: «язык» leaves the result for the screen the test started from */
  check(await page.evaluate(() => L.view === 'home' && !L.qz && L.nav.length === 0), 'language switch: a finished test’s result gives way to the screen before the test');
  await page.click('#langbtn');
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
