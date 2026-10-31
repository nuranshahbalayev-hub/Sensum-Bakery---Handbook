#!/usr/bin/env node
/* Browser checks of the test cases in docs/TEST_CASES.md that tools/smoke.js does not cover: node tools/cases.js
 *
 * Every line starts with the case id from docs/TEST_CASES.md, so a failure points straight at its case.
 * Same setup as smoke.js: the repo root is served locally, headless Chromium at phone width, and the
 * Apps Script backend is an in-page mock (code 1234 is the known employee) — nothing reaches the real
 * results sheet or Telegram. The last part runs with a real service worker to check the offline mode.
 * KNOWN lines are open issues (the «Известные проблемы» section): they don't fail the run, and when one
 * starts passing the run says so, so its case can move to the normal checks. Exit code 1 on any FAIL.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const fails = [], fixed = [];
const check = (id, ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + id + '  ' + what); if (!ok) fails.push(id); };
const known = (id, ok, what) => { console.log((ok ? 'FIXED ' : 'KNOWN ') + id + '  ' + what); if (ok) fixed.push(id); };

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
  /* the browser logs the deliberately cut-off backend (LRN-14) as an error; that one is expected */
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) errors.push(m.text()); });

  /* backend mock; `backend` switches it: 'ok', 'down' (no network), 'unknown' (the code was removed from the sheet) */
  let backend = 'ok';
  await page.route('https://script.google.com/**', route => {
    const req = route.request(), url = new URL(req.url());
    if (backend === 'down') return route.abort('internetdisconnected');
    let body;
    if (req.method() === 'POST') { posted.push(JSON.parse(req.postData())); body = backend === 'unknown' ? { ok: false, error: 'unknown_code' } : { ok: true, xp: 10, owls: [] }; }
    else if (url.searchParams.get('action') === 'whoami') body = url.searchParams.get('code') === '1234' ? { ok: true, name: 'Cases Test', branch: 'Test' } : { ok: false, error: 'unknown_code' };
    else body = { ok: true, service: 'sensum-learn', version: 'mock' };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });

  await page.goto(base);
  await page.waitForTimeout(400);
  const tab = t => page.click(`nav.tabs button[data-tab="${t}"]`);
  const cards = sel => page.locator(sel + ' .card').count();
  const ids = sel => page.evaluate(s => [...document.querySelectorAll(s + ' .card')].map(c => c.dataset.open), sel);

  /* ---------- FLT: filters and search ---------- */
  const total = await cards('#grid');
  await page.click('#tempchips [data-temp="cold"]');
  const cold = await page.evaluate(() => [...document.querySelectorAll('#grid .card')].map(c => drinkById[c.dataset.open].temp));
  await page.click('#tempchips [data-temp="all"]');
  check('FLT-01', cold.length > 0 && cold.length < total && cold.every(t => t === 'cold') && await cards('#grid') === total, `«Холодные»: ${cold.length} из ${total}, все холодные; «Все» возвращает список`);

  const cat = await page.evaluate(() => drinks[0].cat);
  await page.click(`#catchips [data-cat="${cat}"]`);
  const cats = await page.evaluate(() => [...document.querySelectorAll('#grid .card')].map(c => drinkById[c.dataset.open].cat));
  await page.click('#catchips [data-cat="all"]');
  check('FLT-02', cats.length > 0 && cats.length < total && cats.every(c => c === cat), `категория «${cat}»: ${cats.length} карточек только этой категории`);

  const probe = await page.evaluate(() => { /* a word from an ingredient that is not in the drink's own name */
    for (const d of drinks) for (const [n] of d.ing) { const w = n.split(' ')[0]; if (w.length > 4 && !d.name.toLowerCase().includes(w.toLowerCase())) return { w, id: d.id }; }
  });
  await page.fill('#q', probe.w);
  check('FLT-03', (await ids('#grid')).includes(probe.id), `поиск по ингредиенту «${probe.w}» находит ${probe.id}`);
  await page.fill('#q', probe.w.toUpperCase());
  check('FLT-04', (await ids('#grid')).includes(probe.id), `регистр не важен («${probe.w.toUpperCase()}»)`);
  await page.fill('#q', 'zzzzqq');
  check('FLT-05', await cards('#grid') === 0 && /^0\s/.test(await page.locator('#count').innerText()), 'нет совпадений: 0 карточек, счётчик «0 …»');
  await page.click('#clr');
  check('FLT-06', await cards('#grid') === total && (await page.inputValue('#q')) === '', '× очищает поиск и возвращает все напитки');

  await page.fill('#q', 'latte');
  await tab('preps');
  const prepQ = await page.inputValue('#q'), prepN = await cards('#prepgrid'), prepAll = await page.evaluate(() => preps.length);
  await tab('drinks');
  check('FLT-07', prepQ === '' && prepN === prepAll && (await page.inputValue('#q')) === 'latte', 'у каждой вкладки свой поиск: в «Заготовках» пусто, в «Напитках» запрос сохранился');
  await page.click('#clr');

  await tab('preps');
  const used = await page.evaluate(() => { for (const p of preps) for (const u of (p.usedin || [])) if (!p.name.toLowerCase().includes(u[0].toLowerCase().split(' ')[0])) return { q: u[0], id: p.id }; });
  await page.fill('#q', used.q);
  check('FLT-08', (await ids('#prepgrid')).includes(used.id), `заготовка находится по напитку, где используется («${used.q}» → ${used.id})`);
  await page.click('#clr');
  await page.click('#kindchips [data-kind="syrup"]');
  const kinds = await page.evaluate(() => [...document.querySelectorAll('#prepgrid .card')].map(c => prepById[c.dataset.open].kind));
  await page.click('#kindchips [data-kind="all"]');
  check('FLT-09', kinds.length > 0 && kinds.every(k => k === 'syrup'), `фильтр «Сиропы»: ${kinds.length}, только сиропы`);

  await tab('vitrina');
  const vc = await page.evaluate(() => vit.find(v => v.cat !== vit[0].cat).cat);
  await page.click(`#vitchips [data-vcat="${vc}"]`);
  const vcs = await page.evaluate(() => [...document.querySelectorAll('#vitgrid .card')].map(c => vitById[c.dataset.open].cat));
  await page.click('#vitchips [data-vcat="all"]');
  check('FLT-10', vcs.length > 0 && vcs.every(c => c === vc), `витрина, категория «${vc}»: ${vcs.length}, только она`);

  /* ---------- FAV: favorites ---------- */
  await tab('drinks');
  const fid = await page.evaluate(() => drinks[2].id), vid = await page.evaluate(() => vit[0].id), pid = await page.evaluate(() => preps[0].id);
  await page.click(`#grid [data-fav="${fid}"]`);
  check('FAV-01', await page.locator('#overlay.show').count() === 0 && (await page.locator(`#grid [data-fav="${fid}"]`).innerText()) === '★', '☆ → ★, карточка при этом не открывается');
  await tab('vitrina'); await page.click(`#vitgrid [data-favv="${vid}"]`);
  await tab('preps'); await page.click(`#prepgrid [data-favp="${pid}"]`);
  await page.reload(); await page.waitForTimeout(300);
  await tab('fav');
  check('FAV-02', await page.locator(`#favgrid [data-open="${fid}"]`).count() === 1 && await page.locator(`#favprepgrid [data-open="${pid}"]`).count() === 1
    && await page.locator(`#favvitgrid [data-open="${vid}"]`).count() === 1, 'напиток, заготовка и витрина в «Избранном» после перезагрузки');
  await page.click(`#favgrid [data-fav="${fid}"]`); await page.click(`#favprepgrid [data-favp="${pid}"]`); await page.click(`#favvitgrid [data-favv="${vid}"]`);
  check('FAV-03', await page.locator('#favempty').isVisible(), 'сняты все звёзды — пустой экран с подсказкой');

  /* ---------- CRD: the card sheet ---------- */
  await tab('drinks');
  const link = await page.evaluate(() => { for (const d of drinks) for (const [n] of d.ing) { const p = prepFor(n); if (p) return { d: d.id, p, n }; } });
  await page.locator(`#grid .card[data-open="${link.d}"]`).click();
  await page.locator(`#sheetInner [data-openitem="${link.p}"]`).first().click();
  check('CRD-03', (await page.locator('#sheetInner h2').innerText()) === await page.evaluate(id => prepById[id].name, link.p), `ингредиент «${link.n}» открывает заготовку ${link.p}`);
  await page.mouse.click(195, 30); /* the backdrop above the sheet */
  await page.waitForTimeout(200);
  check('CRD-04', await page.locator('#overlay.show').count() === 0 && await page.evaluate(() => getComputedStyle(document.getElementById('scrollArea')).overflowY) !== 'hidden', 'тап по фону закрывает, список снова прокручивается');
  await page.locator('#grid .card').first().click();
  const x = page.locator('#sheetInner [data-close]');
  const hasX = await x.count(); if (hasX) await x.first().click();
  check('CRD-05', hasX > 0 && await page.locator('#overlay.show').count() === 0, '✕ закрывает карточку');
  await page.locator('#grid .card').first().click();
  const sb = await page.locator('#sheet').boundingBox();
  const drag = async dy => { await page.mouse.move(195, sb.y + 20); await page.mouse.down(); await page.mouse.move(195, sb.y + 20 + dy, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(400); };
  await drag(240);
  check('CRD-06', await page.locator('#overlay.show').count() === 0, 'свайп вниз на 240 px закрывает');
  await page.locator('#grid .card').first().click();
  await drag(40);
  check('CRD-07', await page.locator('#overlay.show').count() === 1, 'короткий свайп (40 px) не закрывает, лист возвращается');
  const hero = page.locator('#sheetInner .hero:not(.noimg)');
  if (await hero.count()) { await hero.first().click({ force: true }); await page.waitForTimeout(300); }
  const pv = await page.evaluate(() => document.getElementById('photoView').classList.contains('show'));
  if (pv) await page.click('[data-pclose]');
  check('CRD-08', pv && !(await page.evaluate(() => document.getElementById('photoView').classList.contains('show'))), 'тап по фото — полноэкранный просмотр, × его закрывает');
  await page.keyboard.press('Escape');

  /* ---------- VIT: allergens ---------- */
  await tab('vitrina');
  const alg = await page.evaluate(() => ({
    'VIT-03': ['alg_has', vit.find(v => v.alg && v.alg.has.length)],
    'VIT-04': ['alg_may', vit.find(v => v.alg && v.alg.may.length)],
    'VIT-05': ['alg_none', vit.find(v => !v.alg || (!v.alg.has.length && !v.alg.may.length))]
  }));
  for (const [id, [key, v]] of Object.entries(alg)) {
    if (!v) { check(id, true, `нет позиции для «${key}» — пропуск`); continue; }
    await page.locator(`#vitgrid .card[data-open="${v.id}"]`).click();
    const t = await page.locator('#sheetInner').innerText(), want = await page.evaluate(k => T(k), key);
    await page.keyboard.press('Escape');
    check(id, t.includes(want), `${v.id}: в карточке «${want}»`);
  }

  /* ---------- PRM: promos ---------- */
  await tab('drinks');
  const pr = await page.evaluate(() => promos.map(p => ({ id: p.id, br: !!p.branches })));
  await page.locator(`#promos-drinks [data-promo="${pr[0].id}"]`).click();
  check('PRM-02', await page.locator('#overlay.show').count() === 1 && (await page.locator('#sheetInner').innerText()).length > 20, `карточка акции ${pr[0].id} открывается`);
  await page.keyboard.press('Escape');
  const brp = pr.find(p => p.br);
  if (brp) check('PRM-03', (await page.locator(`#promos-drinks [data-promo="${brp.id}"]`).innerText()).includes('📍'), `акция только для части филиалов показывает 📍 (${brp.id})`);
  else check('PRM-03', true, 'нет акций с ограничением по филиалам — пропуск');

  /* ---------- SET / LNG: theme and language ---------- */
  await page.click('#themebtn');
  const dark = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload(); await page.waitForTimeout(300);
  check('SET-01', dark === 'dark' && await page.evaluate(() => document.documentElement.dataset.theme) === 'dark'
    && !(await page.evaluate(() => document.getElementById('scrollArea').scrollWidth > document.getElementById('scrollArea').clientWidth)), 'тёмная тема включается, сохраняется после перезагрузки, без горизонтальной прокрутки');
  await page.click('#themebtn');

  await page.click('#langbtn'); await page.reload(); await page.waitForTimeout(300);
  check('LNG-03', await page.evaluate(() => LANG) === 'az' && !/[А-Яа-яЁё]/.test(await page.locator('nav.tabs').innerText()), 'AZ сохраняется после перезагрузки, нижнее меню без кириллицы');
  check('LNG-04', await page.evaluate(() => upperLocale('içki') === 'İÇKİ'), 'заглавные в AZ: «içki» → «İÇKİ»');
  await page.locator('#grid .card').first().click();
  check('LNG-05', !/[А-Яа-яЁё]/.test(await page.locator('#sheetInner').innerText()), 'AZ: карточка напитка без кириллицы');
  await page.keyboard.press('Escape');
  const azRu = await page.evaluate(() => { const bad = []; for (const k of ['drinks', 'preps', 'vitrina', 'promos']) for (const x of DATA[k + '_az']) if (/[А-Яа-яЁё]/.test(JSON.stringify(x))) bad.push(k + '/' + x.id); return bad; });
  check('LNG-06', azRu.length === 0, 'AZ-данные без кириллицы' + (azRu.length ? ': ' + azRu.join(', ') : ''));
  await page.click('#langbtn');

  /* ---------- CHG: unseen changes ---------- */
  await page.evaluate(() => localStorage.removeItem('sensum_seen_change'));
  await page.reload(); await page.waitForTimeout(300);
  check('CHG-01', await page.evaluate(() => localStorage.getItem('sensum_seen_change') === CHANGELOG[0].id) && !(await page.locator('#changesdot').isVisible()), 'первый запуск: история считается прочитанной, точки нет');
  await page.evaluate(() => localStorage.setItem('sensum_seen_change', CHANGELOG[2].id));
  await page.reload(); await page.waitForTimeout(300);
  const dot = await page.locator('#changesdot').isVisible();
  await tab('more');
  const cnt = await page.locator('#morehub [data-gotab="changes"] .cnt').innerText().catch(() => '');
  check('CHG-02', dot && /2/.test(cnt), `2 непрочитанные записи: точка на «Ещё», на плитке «${cnt}»`);
  const newBefore = await page.evaluate(() => [...newSet]);
  await page.click('#morehub [data-gotab="changes"]');
  await tab('drinks');
  check('CHG-03', await page.evaluate(() => localStorage.getItem('sensum_seen_change') === CHANGELOG[0].id) && !(await page.locator('#changesdot').isVisible()), 'открыл «Изменения» — точка пропала, прочитанное запомнено');
  const stuck = await page.evaluate(ids => ids.filter(id => document.querySelector(`.card[data-open="${id}"] .newr`)), newBefore);
  known('KNOWN-02', stuck.length === 0, 'бейдж «Новинка» гаснет сразу после просмотра «Изменений»' + (stuck.length ? ` (висит до перезапуска: ${stuck.join(', ')})` : ''));

  /* ---------- LRN: training ---------- */
  await tab('more'); await page.click('#morehub [data-gotab="learn"]');
  await page.evaluate(() => { LS.me = null; LS.outbox = []; saveLearn(); renderLearn(); });
  await page.click('#learnroot [data-l="quiz"]').catch(() => {});
  await page.waitForTimeout(200);
  check('LRN-04', await page.locator('#learnroot [data-l="ans"]').count() === 0 && await page.locator('#lcode').count() === 1, 'без входа тест не начинается, просит код');
  await page.fill('#lcode', '12a'); await page.click('#learnroot [data-l="login"]');
  check('LRN-02', (await page.locator('#idstat').innerText()) === await page.evaluate(() => T('id_bad')), 'код короче 4 цифр отклоняется сразу, без запроса');

  await page.click('#learnroot [data-l="cards"]');
  await page.waitForTimeout(200);
  const fc = await page.evaluate(() => ({ n: L.fc && L.fc.deck.length, id: L.fc && L.fc.deck[0] }));
  let lt = false, msg = 'карточки не открылись';
  if (fc.n) {
    await page.click('#learnroot [data-l="flip"]'); await page.click('#learnroot [data-l="know"]');
    const box = await page.evaluate(id => LS.box[boxKey(itemById(id, L.fc.isPrep))], fc.id);
    await page.click('#learnroot [data-l="flip"]'); await page.click('#learnroot [data-l="again"]');
    const after = await page.evaluate(() => ({ n: L.fc.deck.length, box: LS.box[boxKey(itemById(L.fc.deck[1], L.fc.isPrep))] }));
    lt = box >= 1 && after.n === fc.n + 1 && after.box === 0;
    msg = `«Знаю» → уровень ${box}; «Повторить» → уровень 0, карточка ещё раз в конце (${fc.n} → ${after.n})`;
  }
  check('LRN-13', lt, msg);
  await page.evaluate(() => { L.view = 'home'; renderLearn(); });

  const login = async () => { await page.fill('#lcode', '1234'); await page.click('#learnroot [data-l="login"]'); await page.waitForSelector('#learnroot .idrow', { timeout: 4000 }).catch(() => {}); };
  const runQuiz = async () => {
    await page.click('#learnroot [data-l="quiz"]');
    for (let i = 0; i < 15 && await page.locator('#learnroot [data-l="ans"]').count(); i++) { await page.locator('#learnroot [data-l="ans"]').first().click(); await page.click('#learnroot [data-l="next"]'); }
    await page.waitForTimeout(500);
  };
  await login();
  backend = 'down';
  await runQuiz();
  const queued = await page.evaluate(() => LS.outbox.length);
  backend = 'ok';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(600);
  check('LRN-14', queued === 1 && await page.evaluate(() => LS.outbox.length) === 0 && posted.length === 1, `без сети результат ждёт в очереди и уходит, когда сеть появилась (${queued} → 0)`);

  backend = 'unknown';
  await page.evaluate(() => { L.view = 'home'; renderLearn(); });
  await runQuiz();
  check('LRN-15', await page.evaluate(() => LS.me === null && LS.outbox.length === 0), 'код удалён из таблицы: телефон выходит из аккаунта, результат не копится в очереди');
  backend = 'ok';

  await page.evaluate(() => { L.view = 'home'; renderLearn(); });
  await login();
  await page.click('#learnroot [data-l="quiz"]');
  page.once('dialog', d => d.dismiss());
  await page.click('#langbtn');
  const stayed = await page.evaluate(() => LANG) === 'ru' && await page.locator('#learnroot #qtrow').count() === 1;
  page.once('dialog', d => d.accept());
  await page.click('#langbtn'); await page.waitForTimeout(300);
  check('LRN-16', stayed && await page.evaluate(() => LANG) === 'az' && await page.locator('#learnroot #qtrow').count() === 0, 'смена языка во время теста: «Отмена» — тест идёт; «ОК» — тест прерван, язык сменился');
  await page.click('#langbtn');

  await page.evaluate(() => { L.view = 'home'; renderLearn(); });
  const out = page.locator('#learnroot [data-l="logout"]');
  if (await out.count()) { page.once('dialog', d => d.accept()); await out.click(); await page.waitForTimeout(200); }
  check('LRN-17', await page.evaluate(() => LS.me === null) && await page.locator('#lcode').count() === 1, '«Выйти» возвращает поле для кода');

  /* ---------- KNOWN-01: drink names are Latin, Russian typing finds nothing ---------- */
  await tab('drinks');
  const ru = {};
  for (const w of ['латте', 'капучино', 'раф']) { await page.fill('#q', w); ru[w] = await cards('#grid'); }
  await page.click('#clr');
  known('KNOWN-01', Object.values(ru).every(n => n > 0), 'поиск напитка по-русски: ' + Object.entries(ru).map(([w, n]) => `«${w}» → ${n}`).join(', '));

  check('UI-02', errors.length === 0, 'нет ошибок JS за весь прогон' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();

  /* ---------- PWA: a real service worker, then offline ---------- */
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await c2.newPage();
  await p2.goto(base);
  await p2.evaluate(() => navigator.serviceWorker.ready);
  await p2.waitForFunction(async () => (await (await caches.open('sensum-img')).keys()).length >= new Set(Object.values(IMAGES)).size, null, { timeout: 15000 }).catch(() => {});
  const photos = await p2.evaluate(async () => [(await (await caches.open('sensum-img')).keys()).length, new Set(Object.values(IMAGES)).size]);
  check('PWA-02', photos[0] >= photos[1], `все фото скачаны для офлайна (${photos[0]}/${photos[1]})`);
  await c2.setOffline(true);
  await p2.reload().catch(() => {}); await p2.waitForTimeout(800);
  const off = await p2.locator('#grid .card').count().catch(() => 0);
  check('PWA-01', off > 0, `без сети приложение открывается из кэша (${off} карточек)`);

  await browser.close();
  server.close();
  if (fixed.length) console.log(`\n${fixed.join(', ')}: проблема больше не воспроизводится — переведи кейс из «Известных проблем» в обычные`);
  console.log(fails.length ? `\n${fails.length} check(s) failed: ${fails.join(', ')}` : '\nall case checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('cases test crashed:', e.message); server.close(); process.exit(1); });
