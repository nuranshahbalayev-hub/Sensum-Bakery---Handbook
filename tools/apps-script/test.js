// Runs Code.gs against in-memory mocks of the Apps Script services: node tools/apps-script/test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
/* built at runtime so no token-shaped literal sits in the repo; it only has to pass setupTelegram's format check */
const FAKE_TOKEN = '1:' + 'x'.repeat(36);

function makeSheet(rows, maxRows, cols) {
  const data = rows.map(r => r.slice());
  const sh = {
    data, maxRows: maxRows || 1000, formats: {}, cols: cols || 0,
    getMaxColumns() { return this.cols || Math.max(1, ...data.map(r => r.length)); },
    insertColumnAfter() { this.cols = this.getMaxColumns() + 1; },
    getLastRow() { for (let i = data.length - 1; i >= 0; i--) if (data[i].some(v => v !== '' && v != null)) return i + 1; return 0; },
    getMaxRows() { return this.maxRows; },
    insertRowsAfter(_, n) { this.maxRows += n; },
    appendRow(row) { data.push(row.slice()); },
    setFrozenRows() {},
    getRange(r, c, nr = 1, nc = 1) {
      return {
        insertCheckboxes() { (sh.checkboxes = sh.checkboxes || []).push(r + ':' + c); return this; },
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((data[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
        setValues(v) { v.forEach((row, i) => { while (data.length < r + i) data.push([]); row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; }); }); },
        setNumberFormat(f) { sh.formats[r + ':' + c] = f; return this; },
        copyFormatToRange() {},
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; return this; },
        getValue() { return this.getValues()[0][0]; }
      };
    }
  };
  return sh;
}

function env(opts = {}) {
  const staff = makeSheet([['Код', 'Имя', 'Филиал', 'Должность', 'Активен'],
    ['9001', 'Тест-1', 'Central Park', 'Бариста', true], ['9002', 'Тест-2', 'White City', 'Бариста', true],
    ['1111', 'Ушёл', 'White City', 'Бариста', false], ['9003', 'Тест-3', 'Port II', 'Бариста', true],
    ['9009', 'Тренер', 'Тест', 'Тренинг-менеджер', true]], 100, 5);
  const results = makeSheet([['Дата и время', 'Код', 'Сотрудник', 'Филиал', 'Раздел', 'Правильных', 'Вопросов', 'Результат', 'Сдан', 'Ошибки', 'Язык', 'Версия', 'ID']]);
  const sheets = { 'Результаты': results, 'Сотрудники': staff };
  const named = { PassThreshold: opts.threshold ?? 0.7, DigestHour: 21, WeeklyHour: 10 };
  if ('notifyAll' in opts) named.NotifyAll = opts.notifyAll;
  const props = Object.assign({}, opts.props || { TELEGRAM_TOKEN: 'mock-token', TELEGRAM_CHAT_ID: '42' });
  const sent = [], alerts = [], triggers = [];
  let lockHeld = false;
  const ui = { alerts, ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' }, alert: m => alerts.push(m),
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => opts.promptText || '' }),
    createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } };
  /* opts.now freezes the clock inside the script, so day/week/month logic doesn't depend on when the tests run */
  const RealDate = Date;
  const ClockDate = opts.now ? class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [opts.now])); }
    static now() { return opts.now; }
    static [Symbol.hasInstance](x) { return x instanceof RealDate; }
  } : Date;
  const ctx = {
    console, Date: ClockDate, JSON, Math, Number, String, Map, Set, Array, Object, isFinite,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n], insertSheet: n => (sheets[n] = makeSheet([])),
      getRangeByName: n => (n in named ? { getValue: () => named[n] } : null) }), getUi: () => ui },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.strictEqual(lockHeld, false, 'script locks must not be nested'); lockHeld = true; },
      releaseLock() { assert.strictEqual(lockHeld, true); lockHeld = false; }
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
    UrlFetchApp: { fetch(url, o) {
      const method = url.split('/').pop(), body = JSON.parse(o.payload);
      if (opts.tgDown) return { getContentText: () => 'oops', getResponseCode: () => 502 };
      if (opts.tgThrow) throw new Error('Address unavailable: ' + url);
      if (opts.tgError) return { getContentText: () => JSON.stringify({ ok: false, description: opts.tgError }), getResponseCode: () => 400 };
      if (method === 'sendMessage') sent.push(body.text);
      const result = method === 'getMe' ? { username: 'sensum_bot' } : method === 'getUpdates'
        ? (opts.updates || []) : { message_id: 1 };
      return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Utilities: { formatDate(d, tz, f) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(d).map(x => [x.type, x.value]));
      return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH:mm', '12:00');
    } },
    ScriptApp: { WeekDay: { MONDAY: 'MON' }, getProjectTriggers: () => triggers.map(h => ({ getHandlerFunction: () => h })), deleteTrigger() {},
      newTrigger(h) { const b = { timeBased: () => b, everyDays: () => b, onWeekDay: () => b, atHour: x => { b.h = x; return b; }, inTimezone: () => b, create: () => triggers.push(h + '@' + b.h) }; return b; } }
  };
  vm.createContext(ctx);
  let code = SRC;
  if (opts.kpiStart) { assert.ok(code.includes("const KPI_START = '';")); code = code.replace("const KPI_START = '';", `const KPI_START = '${opts.kpiStart}';`); }
  vm.runInContext(code + '\n;this.__api={doGet,doPost,dailyDigest,weeklyReport,monthlyReport_,setupTelegram,findChat,installTriggers,testNotify,hardQuestions,kpiMonths,assessSetup};', ctx);
  const api = ctx.__api;
  const post = d => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(d) } }).text);
  const me = code => JSON.parse(api.doGet({ parameter: { action: 'me', code } }).text);
  return { api, post, me, results, staff, sheets, props, sent, alerts, triggers, isLocked: () => lockHeld };
}

const M = [{ q: 'Café Latte: сколько «Молоко»?', a: '180 мл', c: '220 мл' }];
let t;

// 1. whoami
t = env();
assert.deepStrictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '9001' } }).text), { ok: true, name: 'Тест-1', branch: 'Central Park', level: 'barista' });
assert.strictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '1111' } }).text).ok, false, 'inactive staff rejected');
assert.strictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '12' } }).text).ok, false);

// 2. passing result: row written, no instant notification
let r = t.post({ id: 'a1', code: '9002', scope: 'Напитки', score: 9, total: 10, mistakes: [], lang: 'az', ver: '1.78' });
assert.strictEqual(r.ok, true); assert.strictEqual(r.xp, 90, 'old app: no kind, still XP');
const row2 = t.results.data[1];
assert.strictEqual(row2[1], '9002'); assert.strictEqual(row2[2], 'Тест-2'); assert.strictEqual(row2[7], '=IF(G2=0,0,F2/G2)');
assert.strictEqual(row2[8], '=IF(Q2="да","нет",IF(H2>=PassThreshold,"да","нет"))');
assert.deepStrictEqual(row2.slice(13), ['', '', '', '', ''], 'older app: check columns stay blank');
assert.deepStrictEqual(t.results.data[0].slice(13), ['Время теста', 'Время вышло', 'Выходы из приложения', 'Прерван', 'Тип'], 'headers added once'); assert.strictEqual(t.results.formats['2:2'], '@');
assert.strictEqual(t.sent.length, 0);

// 3. failing result: notification with mistakes; duplicate id ignored
r = t.post({ id: 'a2', code: '9001', scope: 'Напитки · Эспрессо-бар', score: 6, total: 10, mistakes: M, lang: 'ru', ver: '1.78' });
assert.strictEqual(r.ok, true);
assert.strictEqual(t.sent.length, 1);
console.log('--- fail notification ---\n' + t.sent[0]);
assert.ok(t.sent[0].includes('60%') && t.sent[0].includes('Тест-1 · Central Park') && t.sent[0].includes('180 мл (верно: 220 мл)'));
assert.deepStrictEqual(t.post({ id: 'a2', code: '9001', scope: 'x', score: 6, total: 10 }), { ok: true, xp: 60, owls: [], over: false, duplicate: true });
assert.strictEqual(t.results.getLastRow(), 3, 'duplicate not appended');

// 4. bad input
assert.strictEqual(t.post({ code: '9999', score: 1, total: 10 }).error, 'unknown_code');
assert.strictEqual(t.post({ code: '9001', score: 11, total: 10 }).error, 'bad_score');
assert.strictEqual(t.post({ code: '9001', score: 1.5, total: 10 }).error, 'bad_score');
assert.strictEqual(JSON.parse(t.api.doPost({ postData: { contents: 'not json' } }).text).error, 'bad_json');

// 5. formula injection is neutralised; offline timestamp kept; old timestamp ignored
const ts = Date.now() - 3 * 3600e3;
t.post({ id: 'a3', code: '9003', scope: '=IMPORTXML("x")', score: 8, total: 10, mistakes: [{ q: '=HYPERLINK("x")', a: 'a', c: 'b' }], ts });
const row4 = t.results.data[3];
assert.strictEqual(row4[4], '\'=IMPORTXML("x")'); assert.ok(row4[9].startsWith("'="));
assert.strictEqual(row4[0].getTime(), ts);
t.post({ id: 'a4', code: '9003', scope: 'Заготовки', score: 5, total: 10, ts: Date.now() - 30 * 864e5 });
assert.ok(Date.now() - t.results.data[4][0].getTime() < 5000, 'stale ts replaced by now');

// 6. Telegram down: result still saved, response ok
const t2 = env({ tgDown: true });
assert.strictEqual(t2.post({ id: 'b1', code: '9001', scope: 'Напитки', score: 2, total: 10 }).ok, true);
assert.strictEqual(t2.results.getLastRow(), 2);

// 7. threshold typed as 70 instead of 70%
const t3 = env({ threshold: 70 });
t3.post({ id: 'c1', code: '9001', scope: 'Напитки', score: 8, total: 10 });
assert.strictEqual(t3.sent.length, 0, '80% passes with threshold 70');

// 8. daily digest + weekly report
t.post({ id: 'a5', code: '9001', scope: 'Напитки', score: 5, total: 10, mistakes: M });
t.api.dailyDigest({ triggerUid: 1 });
console.log('--- daily digest ---\n' + t.sent[t.sent.length - 1]);
assert.ok(t.sent[t.sent.length - 1].includes('Частые ошибки') && t.sent[t.sent.length - 1].includes('(2 раза)'));
t.api.weeklyReport();
console.log('--- weekly report ---\n' + t.sent[t.sent.length - 1]);
const empty = env(); empty.api.dailyDigest(); assert.ok(empty.alerts[0].includes('тестов не было'));

// 8b. «Уведомлять о каждом тесте»: passed tests notify too, with ✅; off keeps fails only
const n1 = env({ notifyAll: true });
n1.post({ id: 'n1', code: '9002', scope: 'Напитки', score: 9, total: 10, mistakes: M });
assert.strictEqual(n1.sent.length, 1); assert.ok(n1.sent[0].startsWith('✅ Тест сдан: 90%') && n1.sent[0].includes('Тест-2 · White City'));
console.log('--- pass notification ---\n' + n1.sent[0]);
n1.post({ id: 'n2', code: '9001', scope: 'Напитки', score: 3, total: 10 });
assert.ok(n1.sent[1].startsWith('⚠️ Тест не сдан: 30%'));
const n2 = env({ notifyAll: false });
n2.post({ id: 'n3', code: '9002', scope: 'Напитки', score: 9, total: 10 });
assert.strictEqual(n2.sent.length, 0, 'unchecked box: passed tests stay quiet');

// 8c. ?action=status: version, flags, last Telegram outcome; never the token or chat id
const st = env({ notifyAll: true, tgError: 'Bad Request: chat not found' });
st.post({ id: 's1', code: '9002', scope: 'Напитки', score: 9, total: 10 });
const s1 = JSON.parse(st.api.doGet({ parameter: { action: 'status' } }).text);
console.log('--- status ---\n' + JSON.stringify(s1));
assert.strictEqual(s1.version, 'v5.12'); assert.strictEqual(s1.telegramToken, true); assert.strictEqual(s1.telegramChat, true);
assert.ok(s1.lastNotifyError.includes('chat not found')); assert.ok(!JSON.stringify(s1).includes('mock-token') && !JSON.stringify(s1).includes('"42"'));
assert.strictEqual(JSON.parse(st.api.doGet({}).text).version, 'v5.12');
const thr = env({ notifyAll: true, tgThrow: true });
thr.post({ id: 's2', code: '9002', scope: 'Напитки', score: 9, total: 10 });
const s2 = JSON.parse(thr.api.doGet({ parameter: { action: 'status' } }).text);
assert.ok(s2.lastNotifyError.includes('bot***') && !s2.lastNotifyError.includes('mock-token'), 'token masked in errors');
const okEnv = env({ notifyAll: true });
okEnv.post({ id: 's3', code: '9002', scope: 'Напитки', score: 9, total: 10 });
const s3 = JSON.parse(okEnv.api.doGet({ parameter: { action: 'status' } }).text);
assert.ok(s3.lastNotifyOk && !s3.lastNotifyError);
const noChat = env({ props: { TELEGRAM_TOKEN: 'mock-token' }, notifyAll: true });
noChat.api.testNotify(); assert.ok(noChat.alerts[0].startsWith('Не получилось отправить: Чат для уведомлений не выбран'));

// 8d. honesty checks from the app: time, timeouts, leaving the app, aborted test
const h = env({ notifyAll: false });
h.post({ id: 'h1', code: '9001', scope: 'Напитки', score: 9, total: 10, secs: 130, timeouts: 1, away: 0, aborted: false });
assert.deepStrictEqual(h.results.data[1].slice(13), ['2:10', 1, 0, '', '']); assert.strictEqual(h.results.formats['2:14'], '@');
assert.strictEqual(h.results.formats['2:12'], '@', 'app version kept as text');
assert.strictEqual(h.sent.length, 0, 'clean pass stays quiet when only fails are notified');
h.post({ id: 'h2', code: '9002', scope: 'Напитки', score: 9, total: 10, secs: 95, timeouts: 0, away: 2, aborted: false });
assert.strictEqual(h.sent.length, 1, 'leaving the app is always reported');
assert.ok(h.sent[0].startsWith('✅ Тест сдан: 90%') && h.sent[0].includes('⏱ 1:35 · 📵 выходы из приложения: 2'));
h.post({ id: 'h3', code: '9003', scope: 'Заготовки', score: 8, total: 10, secs: 61, timeouts: 2, away: 1, aborted: true });
console.log('--- aborted test ---\n' + h.sent[1]);
assert.ok(h.sent[1].startsWith('⛔ Тест прерван: 80%') && h.sent[1].includes('⏱ 1:01 · время вышло: 2 · 📵 выходы из приложения: 1'));
assert.deepStrictEqual(h.results.data[3].slice(13), ['1:01', 2, 1, 'да', '']);
assert.strictEqual(h.results.data[3][8], '=IF(Q4="да","нет",IF(H4>=PassThreshold,"да","нет"))', 'aborted never passes');
h.post({ id: 'h4', code: '9001', scope: 'Напитки', score: 5, total: 10, secs: -3, timeouts: 'x', away: 1.5 });
assert.deepStrictEqual(h.results.data[4].slice(13), ['', '', '', '', ''], 'junk check values are dropped');
h.api.dailyDigest({ triggerUid: 1 });
const dg = h.sent[h.sent.length - 1];
console.log('--- digest with checks ---\n' + dg);
assert.ok(dg.includes('Тест-3 (Port II): Заготовки, 8 из 10, прерван') && dg.includes('Выходили из приложения во время теста:') && dg.includes('Тест-2 (White City): 2 раза'));

// 8e. the game: XP, owls, the exam, the board
const NOW = Date.parse('2026-10-30T19:00:00Z');  // Friday 30.10.2026, 23:00 in Baku
const g = env({ notifyAll: false, now: NOW });
const at = (days, h = 12) => Date.parse('2026-10-30T00:00:00Z') - days * 864e5 + h * 3600e3;
/* this week: Mon 26.10 = at(4), Tue at(3), Wed at(2), Thu at(1), Fri at(0). One counted test a day, each section once (theory twice). */
/* the general test (kind mixed): a barista takes 3 counted tests a week, one a day */
let gr = g.post({ id: 'g1', code: '9001', scope: 'Общий тест', kind: 'mixed', score: 9, total: 10, ts: at(4, 8) });
assert.strictEqual(gr.xp, 90); assert.deepStrictEqual(gr.owls, [{ why: 'Тест на 90%+', n: 1 }]);
gr = g.post({ id: 'g2', code: '9001', scope: 'Общий тест', kind: 'mixed', score: 10, total: 10, ts: at(3, 9) });
assert.strictEqual(gr.xp, 150, 'flawless: +50'); assert.deepStrictEqual(gr.owls, [{ why: 'Тест на 90%+', n: 1 }], 'the second «90%+» owl of the week');
gr = g.post({ id: 'g3', code: '9001', scope: 'Общий тест', kind: 'mixed', score: 7, total: 10, ts: at(2, 9) });
assert.deepStrictEqual([gr.xp, gr.owls], [70, []], '70% uses the third slot of the week, no owl for it');
assert.strictEqual(g.results.data[g.results.data.length - 1][17], 'mixed', 'type column R');
gr = g.post({ id: 'g3b', code: '9001', scope: 'Общий тест', kind: 'mixed', score: 10, total: 10, ts: at(2, 10) });
assert.deepStrictEqual([gr.ok, gr.xp, gr.over, gr.owls], [true, 0, true, []], 'a second counted test the same day is saved but over: no XP, no owls');
gr = g.post({ id: 'g3c', code: '9001', scope: 'Общий тест', kind: 'mixed', score: 10, total: 10, ts: at(1, 9) });
assert.deepStrictEqual([gr.xp, gr.over, gr.owls], [0, true, []], 'a fourth test in the week is over: the quota of a barista is 3');
const pgr = g.post({ action: 'progress', code: '9001', read: ['cf-origin', 'cf-farm'], box: {}, ts: NOW - 1000, readAt: { 'cf-origin': '2026-10-28', 'cf-farm': '2026-10-29' } });
assert.deepStrictEqual(pgr.owls, [{ why: 'Полная учебная неделя', n: 3 }], 'the two lessons complete the week: 3 tests and 2 lessons');
gr = g.post({ id: 'g4', code: '9001', scope: 'Экзамен месяца', kind: 'exam', score: 20, total: 20, ts: at(0, 10) });
assert.strictEqual(gr.xp, 350, 'exam: 15 per answer + 50'); assert.deepStrictEqual(gr.owls, [{ why: 'Экзамен месяца 100%', n: 15 }]);
assert.deepStrictEqual(g.post({ id: 'g5', code: '9001', scope: 'Экзамен месяца', kind: 'exam', score: 5, total: 20, ts: at(0, 11) }), { ok: false, error: 'exam_done' });
assert.ok(!g.results.data.some(x => x[12] === 'g5'), 'a second exam in a month is not saved');
gr = g.post({ id: 'g6', code: '9001', scope: 'Напитки', kind: 'drinks', score: 10, total: 10, ts: at(0, 12), aborted: true });
assert.strictEqual(gr.xp, 0); assert.deepStrictEqual(gr.owls, [], 'aborted: nothing');
gr = g.post({ id: 'g7', code: '9002', scope: 'Напитки', kind: 'drinks', score: 10, total: 10, ts: at(0, 12), away: 1 });
assert.deepStrictEqual(gr.owls, [], 'left the app: no «90%+» owl');
/* retries («mix») are not limited, so the daily cap of 5 is still reachable */
for (let i = 0; i < 4; i++) g.post({ id: 'g8' + i, code: '9002', scope: 'Напитки', kind: 'mix', score: 5, total: 10, ts: at(0, 13 + i) });
gr = g.post({ id: 'g9', code: '9002', scope: 'Напитки', kind: 'mix', score: 9, total: 10, ts: at(0, 18) });
assert.strictEqual(gr.xp, 0, 'only the first 5 tests of a day give XP');
assert.deepStrictEqual(gr.owls, [], 'a retry of mistakes earns no owl');
const ledger = g.sheets['Совы'];
assert.deepStrictEqual(ledger.data[0], ['Дата', 'Код', 'Сотрудник', 'Филиал', 'За что', 'Совы', 'Внесено в Sensum OS', 'Ключ', 'ID попытки']);
assert.strictEqual(ledger.data.length, 1 + 4, 'four owl rows so far');
assert.deepStrictEqual(ledger.checkboxes, ['2:7', '3:7', '4:7', '5:7'], 'a checkbox in each owl row');
assert.strictEqual(ledger.formats['2:2'], '@', 'code kept as text');
assert.deepStrictEqual(ledger.data.slice(1).map(x => x[7]), ['good:2026-10-26:2026-10-26', 'good:2026-10-26:2026-10-27', 'plan:2026-10-26', 'exam:2026-10'], 'period keys');
// the real «Совы» sheet had unticked checkboxes down to row 1000: owls must still go right under the header
const pre = env({ notifyAll: false, now: NOW });
const preRows = [['Дата', 'Код', 'Сотрудник', 'Филиал', 'За что', 'Совы', 'Внесено в Sensum OS', 'Ключ']];
for (let i = 0; i < 999; i++) preRows.push(['', '', '', '', '', '', false, '']);
pre.sheets['Совы'] = makeSheet(preRows);
pre.post({ id: 'p1', code: '9002', scope: 'Напитки', kind: 'drinks', score: 9, total: 10, ts: at(0, 9) });
const preSh = pre.sheets['Совы'];
assert.strictEqual(preSh.data[1][1], '9002', 'first owl goes to row 2, not under the checkboxes');
assert.strictEqual(preSh.data.length, 1000, 'nothing appended below row 1000');
assert.deepStrictEqual(preSh.checkboxes, ['2:7']);
pre.post({ id: 'p2', code: '9001', scope: 'Напитки', kind: 'drinks', score: 9, total: 10, ts: at(0, 10) });
assert.strictEqual(preSh.data[2][1], '9001', 'the next one right under it');
assert.strictEqual(JSON.parse(pre.api.doGet({ parameter: { action: 'me', code: '9002' } }).text).owlsMonth, 1, 'owls read back from the ledger');
// a theory test (v5.2): its type is kept in column R and it earns XP like any other test
const th = env({ notifyAll: false, now: NOW });
const thR = th.post({ id: 'th1', code: '9002', scope: 'Теория · Кофе: теория', kind: 'theory', score: 8, total: 10, ts: at(0, 9) });
assert.strictEqual(thR.xp, 80, 'theory: 10 XP per right answer');
assert.strictEqual(th.results.data[th.results.data.length - 1][17], 'theory', 'type column R says «theory»');
assert.strictEqual(th.results.data[th.results.data.length - 1][4], 'Теория · Кофе: теория', 'the topic stays in the scope');
// levels (v5.3): column D of «Сотрудники» is read as a level, spelled any way the trainer types it
const lv = env({ notifyAll: false, now: NOW });
lv.staff.data.push(['9004', 'Тест-4', 'Port II', 'Стажер', true], ['9005', 'Тест-5', 'Port II', ' СТАРШИЙ ', true],
  ['9006', 'Тест-6', 'Port II', 'Администратор', true], ['9007', 'Тест-7', 'Port II', '', true]);
const lvl = code => JSON.parse(lv.api.doGet({ parameter: { action: 'whoami', code } }).text).level;
assert.deepStrictEqual(['9001', '9004', '9005', '9006', '9007'].map(lvl), ['barista', 'trainee', 'senior', '', ''], 'level from the role column; unknown text = no level');
assert.strictEqual(lv.me('9004').level, 'trainee', '?action=me carries the level too');
// the rhythm of the week (v5.10): one general test, a quota of tests a week (3, a trainee 5), one counted test a day, a test below 70% uses no slot
const rh = env({ notifyAll: true, now: NOW });
const rp = (id, kind, days, h, o) => rh.post(Object.assign({ id, code: '9002', scope: 'Тест', kind, score: 10, total: 10, ts: at(days, h) }, o));
const x1 = rp('r1', 'mixed', 4, 8), x2 = rp('r2', 'mixed', 3, 8), x3 = rp('r3', 'mixed', 2, 8);
assert.ok([x1, x2, x3].every(x => x.over === false && x.xp > 0), 'the first three tests of the week count');
const x4 = rp('r4', 'mixed', 2, 9), x5 = rp('r5', 'mixed', 1, 8);
assert.deepStrictEqual([x4.ok, x4.xp, x4.over, x4.owls], [true, 0, true, []], 'a second counted test the same day is saved but over');
assert.deepStrictEqual([x5.xp, x5.over], [0, true], 'a fourth test of the week is over: the quota is used up');
assert.ok(rh.results.data.some(x => x[12] === 'r5'), 'the result over the limit is not lost');
assert.ok(rh.sent[rh.sent.length - 1].includes('Сверх лимита'), 'the trainer\u2019s message says it was over the limit');
let rme = rh.me('9002');
assert.deepStrictEqual([rme.week, rme.limits, rme.perDay, rme.plan.tests, rme.plan.testsDone, rme.plan.testsNeed, rme.plan.lessons, rme.plan.full], [{ test: 3 }, { test: 3 }, 1, { test: 3 }, 3, 3, 0, false],
  '?action=me: slots used, the quota, the tests of the plan');
// the old kinds by section (an old app) share the same quota
const old = env({ notifyAll: false, now: NOW });
['drinks', 'preps', 'theory', 'vitrina'].forEach((kind, i) => old.post({ id: 'o' + i, code: '9002', scope: 'x', kind, score: 10, total: 10, ts: at(4 - i, 8) }));
assert.deepStrictEqual([old.me('9002').week, old.results.data.slice(1).map(x => x[17])], [{ test: 3 }, ['drinks', 'preps', 'theory', 'vitrina']], 'drinks, preps and theory use the quota; the fourth is over');
assert.strictEqual(old.me('9002').plan.testsDone, 3);
// a test below 70% uses no slot but takes the day; the person can take another on another day
const lo = env({ notifyAll: false, now: NOW });
const l1 = lo.post({ id: 'l1', code: '9002', scope: 'x', kind: 'mixed', score: 5, total: 10, ts: at(4, 8) });
assert.ok(l1.over === false && l1.xp === 50, 'a test below 70% is saved with its XP');
assert.strictEqual(lo.post({ id: 'l2', code: '9002', scope: 'x', kind: 'mixed', score: 9, total: 10, ts: at(4, 9) }).over, true, 'but it took the day');
rme = lo.me('9002');
assert.deepStrictEqual([rme.week, rme.plan.tried, rme.plan.testsDone], [{ test: 0 }, { test: 1 }, 0], 'no slot used; listed as tried');
assert.strictEqual(lo.post({ id: 'l3', code: '9002', scope: 'x', kind: 'mixed', score: 8, total: 10, ts: at(3, 8) }).over, false, 'another day it can be taken again');
assert.deepStrictEqual([lo.me('9002').week, lo.me('9002').todayUsed], [{ test: 1 }, 0]);
// an aborted test uses a slot and the day
const ab = env({ notifyAll: false, now: NOW });
ab.post({ id: 'a1', code: '9002', scope: 'x', kind: 'mixed', score: 2, total: 10, ts: at(4, 9), aborted: true });
assert.deepStrictEqual(ab.me('9002').week, { test: 1 }, 'an aborted test uses a slot');
assert.strictEqual(ab.post({ id: 'a2', code: '9002', scope: 'x', kind: 'mixed', score: 10, total: 10, ts: at(4, 10) }).over, true, 'and the day');
// today's tests: any result of a counted test counts for the day
const td = env({ notifyAll: false, now: NOW });
td.post({ id: 't1', code: '9002', scope: 'x', kind: 'mixed', score: 5, total: 10, ts: at(0, 8) });
assert.strictEqual(td.me('9002').todayUsed, 1);
// exam, retries and «Вопрос дня» do not take the day or a slot; a test with no kind is not limited
const fr = env({ notifyAll: false, now: NOW });
fr.post({ id: 'f1', code: '9001', scope: 'x', kind: 'mix', score: 5, total: 10, ts: at(0, 8) });
fr.post({ id: 'f2', code: '9001', scope: 'x', kind: 'exam', score: 15, total: 20, ts: at(0, 9) });
fr.post({ id: 'f3', code: '9001', kind: 'daily', scope: 'Вопрос дня', score: 2, total: 3, ts: at(0, 10) });
assert.strictEqual(fr.post({ id: 'f4', code: '9001', scope: 'x', kind: 'mixed', score: 10, total: 10, ts: at(0, 11) }).over, false, 'retries, the exam and the daily question are not counted tests');
assert.strictEqual(fr.me('9001').todayUsed, 1);
assert.strictEqual(fr.post({ id: 'f5', code: '9001', scope: 'Напитки', score: 10, total: 10, ts: at(0, 12) }).over, false, 'no kind, no limit');
// last week's tests do not count
const wk = env({ notifyAll: false, now: NOW });
for (const d of [8, 9, 10, 11]) wk.results.data.push([new Date(at(d)), '9002', 'Тест-2', 'White City', 'x', 10, 10, '', '', '', 'ru', '1.9', 'w' + d, '', '', '', '', 'mixed']);
assert.strictEqual(wk.me('9002').week.test, 0, 'last week\u2019s tests are not counted');
assert.strictEqual(wk.post({ id: 'w1', code: '9002', scope: 'x', kind: 'mixed', score: 10, total: 10, ts: at(0, 8) }).over, false, 'a new week starts from zero');
// a trainee takes 5 tests a week; a promotion in the sheet makes it 3
const tr = env({ notifyAll: false, now: NOW });
tr.staff.data.push(['9004', 'Тест-4', 'Port II', 'Стажер', true], ['9010', 'Тест-10', 'Port II', 'Бариста', true]);
for (const d of [11, 10, 9, 8]) tr.results.data.push([new Date(at(d)), '9004', 'Тест-4', 'Port II', 'x', 8, 10, '', '', '', 'ru', '1.9', 'tr' + d, '', '', '', '', 'mixed']);
for (const d of [11, 10, 9]) tr.results.data.push([new Date(at(d)), '9010', 'Тест-10', 'Port II', 'x', 8, 10, '', '', '', 'ru', '1.9', 'bs' + d, '', '', '', '', 'mixed']);
const tr5 = tr.post({ id: 't5', code: '9004', scope: 'x', kind: 'mixed', score: 8, total: 10, ts: at(6, 8) }), tr6 = tr.post({ id: 't6', code: '9004', scope: 'x', kind: 'mixed', score: 8, total: 10, ts: at(5, 8) });
const b4 = tr.post({ id: 'b4', code: '9010', scope: 'x', kind: 'mixed', score: 8, total: 10, ts: at(6, 8) });
assert.deepStrictEqual([tr5.over, tr6.over, b4.over], [false, true, true], 'a trainee\u2019s fifth test counts and the sixth is over; a barista\u2019s fourth is over');
assert.deepStrictEqual([tr.me('9004').limits, tr.me('9004').plan.testsNeed, tr.me('9010').limits], [{ test: 5 }, 5, { test: 3 }], 'the quota follows the role in the sheet');
tr.staff.data[tr.staff.data.findIndex(r => r[0] === '9004')][3] = 'Бариста';
assert.deepStrictEqual([tr.me('9004').limits, tr.me('9004').plan.testsNeed], [{ test: 3 }, 3], 'promoted: 3 tests a week');
const tz = env({ notifyAll: false, now: NOW });
tz.staff.data.push(['9011', 'Тест-11', 'Port II', '', true]);
assert.deepStrictEqual(tz.me('9011').limits, { test: 3 }, 'an empty role: the usual 3');
// progress (v5.5): read lessons and card boxes live on the sheet «Прогресс», per code
const pg = env({ notifyAll: false, now: NOW });
assert.deepStrictEqual(pg.me('9001').progress, { read: [], box: {}, ts: 0, readAt: {} }, 'nothing stored yet: an empty progress, no sheet needed');
let pr = pg.post({ action: 'progress', code: '9001', read: ['cf-origin', 'cf-farm'], box: { 'd:latte': 2, 'v:minituna': 1, 't:CF-01': 3 }, ts: 1000 });
assert.deepStrictEqual([pr.ok, pr.progress.read, pr.progress.box, pr.progress.ts], [true, ['cf-origin', 'cf-farm'], { 'd:latte': 2, 'v:minituna': 1, 't:CF-01': 3 }, 1000], 'first write is stored');
assert.deepStrictEqual(pg.sheets['Прогресс'].data[0], ['Код', 'Сотрудник', 'Обновлено (мс)', 'Прочитанные уроки', 'Ящики карточек', 'Версии карточек'], 'the sheet is created with its header');
assert.strictEqual(pg.sheets['Прогресс'].data[1][0], '9001');
// another employee never sees it
pg.post({ action: 'progress', code: '9002', read: ['sv-first'], box: { 'p:syrup': 4 }, ts: 1500 });
assert.deepStrictEqual(pg.me('9001').progress.read, ['cf-origin', 'cf-farm']); assert.deepStrictEqual(pg.me('9002').progress.read, ['sv-first']);
assert.strictEqual(pg.sheets['Прогресс'].data.length, 3, 'one row per employee');
// lessons only grow; the newer box write wins whole, an older one is ignored
pr = pg.post({ action: 'progress', code: '9001', read: ['cf-milk'], box: { 'd:latte': 0, 'd:flatwhite': 1 }, ts: 2000 });
assert.deepStrictEqual(pr.progress.read, ['cf-origin', 'cf-farm', 'cf-milk'], 'read lessons are merged');
assert.deepStrictEqual(pr.progress.box, { 'd:flatwhite': 1 }, 'the newer boxes replace the older ones (a reset card is gone)');
pr = pg.post({ action: 'progress', code: '9001', read: ['cf-brew'], box: { 'd:old': 5 }, ts: 1200 });
assert.deepStrictEqual([pr.progress.read.includes('cf-brew'), pr.progress.box, pr.progress.ts], [true, { 'd:flatwhite': 1 }, 2000], 'a stale phone adds lessons but cannot overwrite the boxes');
assert.deepStrictEqual(pg.me('9001').progress, pr.progress, '?action=me returns the stored progress');
// bad input is dropped, not stored
pr = pg.post({ action: 'progress', code: '9003', read: ['ok-id', '<b>x</b>', 'A B', 5], box: { 'x:bad': 1, 'd:fine': 9, 'd:ok': 2, 'v:..': 1 }, ts: 3000 });
assert.deepStrictEqual([pr.progress.read, pr.progress.box], [['ok-id', '5'], { 'd:ok': 2 }], 'ids and boxes that do not look right are ignored');
assert.strictEqual(pg.post({ action: 'progress', code: '9999', read: ['x'], box: {}, ts: 1 }).error, 'unknown_code', 'an unknown code stores nothing');
assert.strictEqual(pg.sheets['Прогресс'].data.length, 4, 'and adds no row');
pr = pg.post({ action: 'progress', code: '9003', read: Array.from({ length: 400 }, (_, i) => 'l' + i), box: {}, ts: 4000 });
assert.ok(pr.progress.read.length <= 300, 'the number of lessons is capped');
// a progress write is not a test: no result row, no XP, no message
assert.strictEqual(pg.results.getLastRow(), 1, 'the results sheet is untouched'); assert.strictEqual(pg.sent.length, 0);
// monthly cap
const cap = env({ notifyAll: false, now: NOW });
cap.post({ id: 'c1', code: '9003', scope: 'x', kind: 'drinks', score: 10, total: 10, ts: at(2) });  // +1, creates «Совы»
cap.sheets['Совы'].data.push([new Date(at(3)), '9003', 'Тест-3', 'Port II', 'Раньше', 48, false, 'manual']);  // 49 this month
const capR = cap.post({ id: 'c2', code: '9003', scope: 'Экзамен месяца', kind: 'exam', score: 20, total: 20 });
assert.deepStrictEqual(capR.owls, [{ why: 'Экзамен месяца 100%', n: 1 }], 'at most 50 a month');
// what the app shows
const m = g.me('9001'); assert.deepStrictEqual(m.limits, { test: 3 }, 'a barista: 3 tests a week');
console.log('--- me ---\n' + JSON.stringify(m));
assert.strictEqual(m.ok, true); assert.strictEqual(m.name, 'Тест-1');
assert.strictEqual(m.owlsMonth, 20); assert.strictEqual(m.owlsCap, 50); assert.strictEqual(m.streak, 1, 'this week is full: 5 tests and 2 lessons');
assert.deepStrictEqual(m.plan, { tests: { test: 3 }, tried: { test: 0 }, testsDone: 3, testsNeed: 3, lessons: 2, lessonsNeed: 2, full: true });
assert.deepStrictEqual(m.progress.readAt, { 'cf-origin': '2026-10-28', 'cf-farm': '2026-10-29' }, 'the days of the lessons come back');
assert.ok(m.badges.includes('first') && m.badges.includes('perfect') && m.badges.includes('exam100') && !m.badges.includes('streak4'));
assert.deepStrictEqual(m.exam, { score: 20, total: 20, aborted: false, month: '2026-10' });
assert.strictEqual(m.board.people[0].name, 'Тест-1'); assert.strictEqual(m.board.people[0].me, true); assert.strictEqual(m.board.rank, 1);
assert.ok(!JSON.stringify(m.board).includes('Тренер') && !m.board.branches.some(b => b.branch === 'Тест'), 'the test account is not on the board');
assert.deepStrictEqual(g.me('0000'), { ok: false, error: 'unknown_code' });
g.post({ id: 't1', code: '9009', scope: 'Напитки', kind: 'drinks', score: 10, total: 10 });
assert.ok(!g.me('9001').board.people.some(p => p.name === 'Тренер'));
// weekly report: board and owls to credit; monthly: exam results for the KPI
g.api.weeklyReport();
const wr = g.sent[g.sent.length - 1];
console.log('--- weekly with game ---\n' + wr);
assert.ok(wr.includes('🏆 Рейтинг недели:') && wr.includes('🦉 Начислить в Sensum OS:') && wr.includes('Тест-1 (Central Park): +20') && !wr.includes('Тренер'));
assert.ok(wr.includes('🏅 Полная неделя (тесты и 2 урока): 1 из 3'), 'the weekly report counts the full weeks');
g.api.monthlyReport_(new Date('2026-11-01T17:00:00Z'));
const mr = g.sent[g.sent.length - 1];
console.log('--- monthly ---\n' + mr);
assert.ok(mr.startsWith('📝 Экзамен месяца, 10.2026') && mr.includes('Тест-1: 20 из 20, 100%') && mr.includes('Тест-2: не сдавал') && mr.includes('Тест-1: 20'));

// 8f. «Вопрос дня» (v5.6): its own sheet, XP once a day, no limit, no owls, no message; a run of days; the hard questions
const dq = env({ notifyAll: true, now: NOW });
const d1 = dq.post({ id: 'q1', code: '9001', kind: 'daily', scope: 'Вопрос дня', score: 3, total: 3, mistakes: [], ts: at(0, 9) });
assert.strictEqual(d1.ok, true); assert.strictEqual(d1.xp, 50, 'three right: 30 + 20'); assert.deepStrictEqual(d1.owls, []);
assert.deepStrictEqual(d1.daily, { done: true, streak: 1 });
assert.strictEqual(dq.results.getLastRow(), 1, 'not written to «Результаты»'); assert.strictEqual(dq.sheets['Вопрос дня'].getLastRow(), 2);
assert.strictEqual(dq.sheets['Вопрос дня'].formats['2:2'], '@');
assert.strictEqual(dq.sent.length, 0, 'no instant message, even with «Уведомлять о каждом тесте»');
assert.deepStrictEqual(dq.post({ id: 'q1', code: '9001', kind: 'daily', score: 3, total: 3 }), { ok: true, duplicate: true });
assert.strictEqual(dq.post({ id: 'q2', code: '9001', kind: 'daily', score: 2, total: 3, mistakes: M, ts: at(0, 10) }).xp, 0, 'the second of a day: no XP');
assert.strictEqual(dq.post({ id: 'q3', code: '9001', kind: 'daily', score: 9, total: 10 }).error, 'bad_score', 'at most 5 questions');
assert.strictEqual(dq.post({ id: 'q3', code: '9999', kind: 'daily', score: 1, total: 3 }).error, 'unknown_code');
dq.post({ id: 'q4', code: '9001', kind: 'daily', score: 1, total: 3, ts: at(1) });
dq.post({ id: 'q5', code: '9001', kind: 'daily', score: 0, total: 3, ts: at(2), aborted: true });
dq.post({ id: 'q6', code: '9001', kind: 'daily', score: 3, total: 3, ts: at(3) });
const dm = dq.me('9001');
assert.deepStrictEqual(dm.daily, { done: true, streak: 2 }, 'today and yesterday; the aborted day breaks the run');
assert.strictEqual(dm.xp, 50 + 10 + 0 + 50, 'XP of the first of each day, none for an aborted one');
assert.deepStrictEqual(dm.week, { test: 0 }, 'not a weekly attempt');
assert.strictEqual(dm.weekTests, 0, 'not a test of the study week'); assert.strictEqual(dm.streak, 0);
assert.ok(!dm.badges.includes('first'), '«Вопрос дня» is not a first test');
assert.strictEqual(dm.board.people[0].xp, 110, 'its XP counts on the weekly board');
assert.deepStrictEqual(dq.me('9002').daily, { done: false, streak: 0 });
const w7 = [];
for (let i = 1; i <= 7; i++) w7.push(dq.post({ id: 'w' + i, code: '9002', kind: 'daily', score: 3, total: 3, ts: at(i - 1, 8) }));
const d7 = dq.me('9002');
assert.strictEqual(d7.daily.streak, 7); assert.ok(d7.badges.includes('days7'), 'seven days in a row: the badge');
assert.ok(w7.slice(0, 6).every(x => x.owls.length === 0), 'no owl before the seventh day');
assert.deepStrictEqual(w7[6].owls, [{ why: '«Вопрос дня» 7 дней подряд', n: 1 }], 'seven days in a row: an owl');
assert.strictEqual(dq.sheets['Совы'].data.length, 2); assert.strictEqual(dq.sheets['Совы'].data[1][7], 'daily7:2026-10-24');
assert.deepStrictEqual(dq.post({ id: 'w7', code: '9002', kind: 'daily', score: 3, total: 3, ts: at(6, 8) }), { ok: true, duplicate: true }, 'a repeated daily does not pay twice');
// five tests a day give XP (retries are not limited); «Вопрос дня» does not take one of the five
for (let i = 1; i <= 5; i++) dq.post({ id: 'x' + i, code: '9003', scope: 'Напитки', kind: 'mix', score: 10, total: 10, ts: at(0, 11) });
dq.post({ id: 'qx', code: '9003', kind: 'daily', score: 3, total: 3, ts: at(0, 12) });
assert.strictEqual(dq.me('9003').xp, 5 * 150 + 50, 'five tests and the daily all get XP');
// the hard questions: tests and «Вопрос дня» of 7 days, without the trainer's account; the sheet is rebuilt, not appended
dq.post({ id: 'r1', code: '9002', scope: 'Напитки · Эспрессо-бар', kind: 'drinks', score: 9, total: 10, mistakes: M, ts: at(1) });
dq.post({ id: 'r2', code: '9003', scope: 'Напитки', kind: 'drinks', score: 9, total: 10, mistakes: M, ts: at(1) });
dq.post({ id: 'r3', code: '9009', scope: 'Напитки', kind: 'drinks', score: 9, total: 10, mistakes: M, ts: at(1) });
dq.post({ id: 'r4', code: '9002', scope: 'Теория · Кофе', kind: 'theory', score: 9, total: 10, mistakes: [{ q: 'Где родина кофе?', a: 'Бразилия', c: 'Эфиопия' }], ts: at(1) });
dq.api.weeklyReport();
const hs = dq.sheets['Сложные вопросы'].data;
console.log('--- hard questions ---\n' + hs.map(r => r.join(' | ')).join('\n'));
assert.ok(String(hs[0][0]).startsWith('Вопрос (7 дней до 30.10.2026)'));
assert.deepStrictEqual(hs[1], [M[0].q, 3, 3, 'White City, Port II, Central Park', 'Напитки, Вопрос дня', '220 мл'], 'two tests + one «Вопрос дня», the trainer left out');
assert.deepStrictEqual(hs[2].slice(0, 3), ['Где родина кофе?', 1, 1]);
const dwk = dq.sent[dq.sent.length - 1];
console.log("--- weekly with «Вопрос дня» ---\n" + dwk);
assert.ok(dwk.includes("📅 Вопрос дня: ") && dwk.includes("❓ Сложные вопросы недели") && dwk.includes(M[0].q + " — ошибок: 3, сотрудников: 3") && !dwk.includes('Где родина кофе?'), 'the report lists repeated mistakes only');
dq.api.hardQuestions();
assert.strictEqual(dq.sheets['Сложные вопросы'].getLastRow(), 3, 'rebuilt, not appended'); assert.ok(dq.alerts[dq.alerts.length - 1].includes('обновлён: 2 вопроса'));
const noHard = env({ now: NOW }); noHard.api.hardQuestions(); assert.ok(noHard.alerts[0].includes('ошибок не было'));

// 8g. Reliability: a saved result stays retryable until its award is committed.
const recover = env({ now: NOW, notifyAll: true });
recover.sheets['Совы'] = { getLastRow() { throw new Error('simulated ledger outage'); } };
const recoverEvent = { id: 'recover-1', code: '9001', kind: 'drinks', score: 10, total: 10, ts: NOW };
assert.deepStrictEqual(recover.post(recoverEvent), { ok: false, error: 'reward_pending', saved: true });
assert.strictEqual(recover.results.getLastRow(), 2, 'the result survives the award failure');
assert.strictEqual(recover.isLocked(), false, 'the lock is released after failure');
delete recover.sheets['Совы'];
const recovered = recover.post(recoverEvent);
assert.deepStrictEqual(recovered, { ok: true, xp: 150, owls: [{ why: 'Тест на 90%+', n: 1 }], over: false, duplicate: true });
assert.strictEqual(recover.results.getLastRow(), 2, 'retry never duplicates the result');
assert.strictEqual(recover.sent.length, 1, 'retry never duplicates the notification');
recover.sheets['Совы'].data[1][6] = true; // already transferred by the manager
assert.deepStrictEqual(recover.post(recoverEvent), recovered, 'lost responses replay the original award');
assert.strictEqual(recover.sheets['Совы'].data[1][6], true, 'retry never resets a credited award');
assert.strictEqual(recover.sheets['Совы'].getLastRow(), 2);

// Two rules earned by one attempt: retry completes the missing row after a partial write.
const partial = env({ now: NOW, notifyAll: true });
['mixed', 'mixed'].forEach((kind, i) => partial.post({ id: 'qualify-' + i, code: '9001', kind, score: 7, total: 10, ts: at(4 - i, 8) }));
partial.post({ action: 'progress', code: '9001', read: ['cf-origin', 'cf-farm'], box: {}, ts: NOW - 1000, readAt: { 'cf-origin': '2026-10-28', 'cf-farm': '2026-10-29' } });
const partialLedger = makeSheet([ledger.data[0]]), nativeRange = partialLedger.getRange;
partial.sheets['Совы'] = partialLedger;
let awardWrites = 0, simulateFailure = true;
partialLedger.getRange = function(r, c, nr = 1, nc = 1) {
  const range = nativeRange.call(this, r, c, nr, nc);
  const write = range.setValues, read = range.getValues;
  range.getValues = function() { assert.strictEqual(partial.isLocked(), true, 'award eligibility and ledger reads share the write lock'); return read.call(this); };
  range.setValues = function(values) {
    if (r > 1 && c === 1 && nc === 9 && ++awardWrites === 2 && simulateFailure) throw new Error('simulated second award failure');
    return write.call(this, values);
  };
  return range;
};
const partialEvent = { id: 'partial-1', code: '9001', kind: 'mixed', score: 10, total: 10, ts: at(2, 10) };
assert.strictEqual(partial.post(partialEvent).error, 'reward_pending');
assert.strictEqual(partialLedger.getLastRow(), 2, 'only the first award committed');
simulateFailure = false;
const completedAward = partial.post(partialEvent);
assert.deepStrictEqual(completedAward.owls, [{ why: 'Тест на 90%+', n: 1 }, { why: 'Полная учебная неделя', n: 3 }]);
assert.strictEqual(partialLedger.getLastRow(), 3, 'one row per rule, including after recovery');
assert.ok(partialLedger.data.slice(1).every(r => r[8] === 'partial-1'), 'awards are linked to the attempt');
assert.strictEqual(partial.isLocked(), false);

// The streak counts full weeks (5 tests from 70% and 2 lessons); the current week joins it once it is full.
const streak = env({ now: NOW, notifyAll: false });
const fullWeek = (monday, lessons) => {  // rows of an earlier week straight into the sheet, its lessons through the progress action
  ['drinks', 'preps', 'vitrina', 'theory', 'theory'].forEach((kind, i) => streak.results.data.push([new Date(Date.parse(monday + 'T08:00:00Z') + i * 864e5), '9001', 'Тест-1', 'Central Park', 'x', 8, 10,
    '', '', '', 'ru', '1.9', 'fw' + monday + i, '', '', '', '', kind]));
  return lessons;
};
fullWeek('2026-10-12'); fullWeek('2026-10-19');
streak.post({ action: 'progress', code: '9001', read: ['cf-a', 'cf-b', 'cf-c', 'cf-d'], box: {}, ts: NOW - 5000,
  readAt: { 'cf-a': '2026-10-13', 'cf-b': '2026-10-15', 'cf-c': '2026-10-20', 'cf-d': '2026-10-22' } });
assert.strictEqual(streak.me('9001').streak, 2, 'two full weeks behind us');
['drinks', 'preps', 'vitrina', 'theory'].forEach((kind, i) => streak.post({ id: 'st-' + i, code: '9001', kind, score: 8, total: 10, ts: at(4 - i, 8) }));
assert.strictEqual(streak.me('9001').streak, 2, 'a partly done week keeps last week\u2019s streak');
streak.post({ id: 'st-4', code: '9001', kind: 'theory', score: 8, total: 10, ts: at(0, 8) });
assert.deepStrictEqual([streak.me('9001').streak, streak.me('9001').plan.full], [2, false], 'five tests are not enough without the lessons');
let sp = streak.post({ action: 'progress', code: '9001', read: ['cf-e'], box: {}, ts: NOW - 4000, readAt: { 'cf-e': '2026-10-30' } });
assert.deepStrictEqual([sp.owls, streak.me('9001').plan.lessons], [[], 1], 'one lesson of this week: still not full, no owl');
sp = streak.post({ action: 'progress', code: '9001', read: ['cf-f'], box: {}, ts: NOW - 3000, readAt: { 'cf-f': '2026-10-29' } });
assert.deepStrictEqual(sp.owls, [{ why: 'Полная учебная неделя', n: 3 }], 'a lesson can be the last step of the week');
assert.ok(!('lessonsAdded' in sp), 'the internal flag is not sent out');
assert.deepStrictEqual([streak.me('9001').streak, streak.me('9001').badges.includes('streak4')], [3, false], 'this week is full: three in a row');
sp = streak.post({ action: 'progress', code: '9001', read: ['cf-g'], box: {}, ts: NOW - 2000, readAt: { 'cf-g': '2026-10-29' } });
assert.deepStrictEqual(sp.owls, [], 'the owl of a week is paid once');
assert.strictEqual(streak.me('9001').progressProtocol, 2);
assert.strictEqual(streak.me('9001').passThreshold, 0.7);
const customPass = env({ now: NOW, threshold: 0.8 });
assert.strictEqual(customPass.me('9001').passThreshold, 0.8);
assert.ok(streak.isLocked() === false);

// the days of the lessons: only lessons that are read, never in the future, the earlier day wins; an old client sends none
const ra = env({ now: NOW, notifyAll: false });
const rpg = o => ra.post(Object.assign({ action: 'progress', code: '9003', box: {}, ts: NOW - 1000 }, o));
let rr = rpg({ read: ['cf-a', 'cf-b'], readAt: { 'cf-a': '2026-10-29', 'cf-b': '2026-10-31', 'cf-zz': '2026-10-29', 'cf-c': 'yesterday' } });
assert.deepStrictEqual(rr.progress.readAt, { 'cf-a': '2026-10-29' }, 'a future day, a lesson not read and a bad format are dropped');
rr = rpg({ read: ['cf-a'], readAt: { 'cf-a': '2026-10-27' } });
assert.strictEqual(rr.progress.readAt['cf-a'], '2026-10-27', 'the earlier day wins');
rr = rpg({ read: ['cf-a'], readAt: { 'cf-a': '2026-10-29' } });
assert.strictEqual(rr.progress.readAt['cf-a'], '2026-10-27', 'a later day does not replace it');
rr = rpg({ read: ['cf-old'] });
assert.deepStrictEqual([rr.progress.read.includes('cf-old'), rr.progress.readAt['cf-old']], [true, undefined], 'a lesson without a day is read but dated to no week');
assert.strictEqual(ra.me('9003').plan.lessons, 1, 'only the dated lesson of this week counts for the week');
// all the lessons of a category: an owl once, with the category named
const cat = env({ now: NOW, notifyAll: false });
const cf = Array.from({ length: 17 }, (_, i) => 'cf-l' + (i + 1));
let cp = cat.post({ action: 'progress', code: '9002', read: cf.slice(0, 16), box: {}, ts: NOW - 1000 });
assert.deepStrictEqual(cp.owls, [], 'one lesson short: nothing');
cp = cat.post({ action: 'progress', code: '9002', read: cf, box: {}, ts: NOW - 900 });
assert.deepStrictEqual(cp.owls, [{ why: 'Все уроки: Кофе', n: 3 }]);
cp = cat.post({ action: 'progress', code: '9002', read: ['cf-l1', 'sn-1', 'sn-2', 'sn-3'], box: {}, ts: NOW - 800 });
assert.deepStrictEqual(cp.owls, [{ why: 'Все уроки: Санитария', n: 1 }], 'the coffee owl is not paid again');
assert.deepStrictEqual(cat.sheets['Совы'].data.slice(1).map(x => x[7]), ['cat:CF', 'cat:SN']);
// the sizes of the categories are the app's lessons
const ids = JSON.parse(fs.readFileSync(__dirname + '/../lessons.json', 'utf8'));
const lessonList = ids.lessons;
const totals = (/const LESSON_TOTALS = (\{[^}]*\})/.exec(SRC) || [])[1];
const sizes = {}; lessonList.forEach(l => { const p = l.id.split('-')[0]; sizes[p] = (sizes[p] || 0) + 1; });
assert.deepStrictEqual(sizes, eval('(' + totals + ')'), 'LESSON_TOTALS matches tools/lessons.json');

// Protocol 2: independent devices merge only edited cards; zero resets are not resurrected.
const delta = env({ now: NOW, notifyAll: false });
delta.post({ action: 'progress', code: '9001', read: ['cf-origin'], box: { 'd:latte': 1, 'd:cappuccino': 1 }, ts: 1000 });
const change = (changes, extra = {}) => delta.post(Object.assign({ action: 'progress', protocol: 2, code: '9001', read: [], changes, ts: 1000 }, extra));
assert.strictEqual(change({ 'd:latte': { v: 2, ts: 2000 } }).ok, true);
change({ 'd:cappuccino': { v: 3, ts: 3000 } });
change({ 'd:latte': { v: 3, ts: 4000 } }, { box: { 'd:cappuccino': 1 }, read: ['cf-milk'] });
assert.deepStrictEqual(delta.me('9001').progress.box, { 'd:latte': 3, 'd:cappuccino': 3 }, 'a stale whole snapshot is ignored');
change({ 'd:latte': { v: 5, ts: 2000 } });
assert.strictEqual(delta.me('9001').progress.box['d:latte'], 3, 'late delivery of an old card edit cannot overwrite a new edit');
change({ 'd:cappuccino': { v: 0, ts: 5000 }, 'd:latte': { v: 0, ts: 4000 } });
change({ 'd:cappuccino': { v: 4, ts: 5000 }, 'd:latte': { v: 3, ts: 4000 } });
assert.deepStrictEqual(delta.me('9001').progress.box, { 'd:latte': 0, 'd:cappuccino': 0 }, 'a zero reset wins tied timestamps and survives replay');
change({ 'd:latte': { v: 5, ts: 6000, ifAbsent: true }, 'd:flatwhite': { v: 2, ts: 6000, ifAbsent: true } });
assert.deepStrictEqual(delta.me('9001').progress.box, { 'd:latte': 0, 'd:cappuccino': 0, 'd:flatwhite': 2 }, 'unknown legacy baseline only fills missing cards');
const beforeLegacy = delta.me('9001').progress;
assert.deepStrictEqual(delta.post({ action: 'progress', code: '9001', read: [], box: { 'd:latte': 5 }, ts: NOW }), { ok: false, error: 'progress_update_required' });
assert.deepStrictEqual(delta.me('9001').progress, beforeLegacy, 'an old client cannot replace migrated card progress');
change({ 'bad:key': { v: 1, ts: 7000 }, 'd:bad': { v: 6, ts: 7000 }, 'd:future': { v: 2, ts: NOW + 3600000 } });
assert.deepStrictEqual(delta.me('9001').progress.box, beforeLegacy.box);
assert.deepStrictEqual(delta.me('9001').progress.read, ['cf-origin', 'cf-milk']);
assert.deepStrictEqual(delta.me('9002').progress, { read: [], box: {}, ts: 0, readAt: {} }, 'changes remain scoped to the employee');


// 8h. KPI обучения (v5.9): the plan of a month in percent, a loss from the threshold, leave and a newcomer's grace, the rows for the trainer
const NOW2 = Date.parse('2026-11-05T09:00:00Z');  // a Thursday; October is over
const kenv = o => env(Object.assign({ notifyAll: false, now: NOW2 }, o));
const addDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const MON = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];  // the weeks whose Sunday is in October
const K5 = ['drinks', 'preps', 'vitrina', 'theory', 'theory'];
const krow = (e, code, day, kind, score, total, aborted) => e.results.data.push([new Date(day + 'T08:00:00Z'), code, 'x', 'Central Park', 'x', score, total,
  '', '', '', 'ru', '1.9', 'k' + e.results.data.length, '', '', '', aborted ? 'да' : '', kind]);
/* `tests` counted tests and `lessons` counted lessons in each of the given weeks; the lessons are sent as progress with their days */
const kweeks = (e, code, tests, lessons, mons = MON, extra = {}) => {
  const read = [], at = Object.assign({}, extra);
  mons.forEach((m, wi) => {
    for (let i = 0; i < tests; i++) krow(e, code, addDay(m, i), K5[i], 8, 10);
    for (let i = 0; i < lessons; i++) { const id = 'l-' + code + '-' + m + '-' + i; read.push(id); at[id] = addDay(m, i); }
  });
  Object.keys(extra).forEach(id => read.push(id));
  if (read.length) e.post({ action: 'progress', code, read, box: {}, ts: NOW2 - 1000, readAt: at });
};
const kfill = e => {
  e.staff.cols = 6;
  e.staff.data.push(['9005', 'Тест-5', 'Port II', 'Бариста', true, '2026-10-05'], ['9006', 'Тест-6', 'Port II', 'Бариста', true, '2026-10-20'],
    ['9007', 'Тест-7', 'White City', 'Бариста', true, ''], ['9008', 'Тест-8', 'White City', 'Бариста', true, '']);
  const gap = { ['gap' + 0]: '2026-10-28' };  // a lesson late in the month so that nobody has a run of idle days at its end
  kweeks(e, '9001', 5, 2, MON, { gap1: '2026-10-28' }); krow(e, '9001', '2026-10-20', 'exam', 18, 20);
  kweeks(e, '9003', 3, 0, MON, { gap3: '2026-10-28' }); krow(e, '9003', '2026-10-21', 'exam', 18, 20);
  kweeks(e, '9005', 5, 2, [MON[3]], { gap5: '2026-10-28' });
  kweeks(e, '9007', 5, 2, MON, { gap7: '2026-10-28' }); krow(e, '9007', '2026-10-22', 'exam', 10, 20);
  kweeks(e, '9008', 5, 2, MON.slice(0, 2)); krow(e, '9008', '2026-10-06', 'exam', 20, 20);
  kweeks(e, '9009', 5, 2);  // the trainer's test account
};
const kRows = e => e.sheets['Списания KPI'].data.slice(1).map(r => r.slice(0, 12)).concat([]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
const byCode = (rows, c) => rows.find(r => r[1] === c);
const k0 = kenv(); kfill(k0);
k0.api.kpiMonths();
assert.ok(k0.alerts[k0.alerts.length - 1].includes('посчитано сотрудников: 6') && k0.alerts[k0.alerts.length - 1].includes('пробный месяц'), 'the menu item reports the month it built');
assert.strictEqual(k0.staff.data[0][5], 'Начало работы', 'column F of «Сотрудники» is made'); assert.ok(k0.sheets['Отсутствия'] && k0.sheets['Списания KPI']);
assert.deepStrictEqual(k0.sheets['Списания KPI'].data[0], ['Месяц', 'Код', 'Сотрудник', 'Филиал', '% выполнения', 'Недели %', 'Экзамен %', 'Качество %', 'Регулярность %', 'Отсутствовал дней', 'Минус % KPI', 'Статус', 'Решение тренера', 'Комментарий', 'Внесено в Sensum OS', 'Ключ']);
let rows = kRows(k0);
assert.deepStrictEqual(rows.map(r => r[1]), ['9001', '9002', '9003', '9005', '9007', '9008'], 'everyone scored, the trainer’s account and a newcomer excused all month are not');
assert.deepStrictEqual(byCode(rows, '9001').slice(0, 12), ['2026-10', '9001', 'Тест-1', 'Central Park', 100, 100, 100, 100, 100, 0, 0, 'Пробный месяц'], 'a full plan: 100%, nothing lost');
assert.deepStrictEqual(byCode(rows, '9002').slice(4, 12), [0, 0, 0, 0, 0, 0, 30, 'Пробный месяц'], 'nothing done: 0%, the loss stops at the cap of 30');
assert.deepStrictEqual(byCode(rows, '9003').slice(4, 12), [76, 60, 100, 100, 100, 0, 4, 'Пробный месяц'], '3 of the 5 steps of a barista\u2019s week: 76%, 80 - 76 = 4');
assert.deepStrictEqual(byCode(rows, '9005').slice(4, 12), [80, 100, 0, 100, 100, 18, 0, 'Пробный месяц'], 'a newcomer: the weeks before the start and the grace days are excused; exactly 80% loses nothing');
assert.deepStrictEqual(byCode(rows, '9007').slice(4, 11), [94, 100, 71, 100, 100, 0, 0], 'an exam of 10 of 20 earns 10/20 / 70% of its weight');
assert.deepStrictEqual(byCode(rows, '9008').slice(4, 11), [63, 50, 100, 100, 29, 0, 17], 'two empty weeks and 22 idle days: weeks 50%, regularity 29%');
assert.strictEqual(k0.sheets['Списания KPI'].data[1][15], '2026-10:9001', 'the key is month:code'); assert.strictEqual(k0.sheets['Списания KPI'].formats['2:2'], '@');
assert.ok(k0.sheets['Списания KPI'].checkboxes.length === 6, 'a checkbox «Внесено в Sensum OS» in each row');
// a decision of the trainer is never overwritten; the rest is recomputed, no row is added twice
const dr = k0.sheets['Списания KPI'].data.findIndex(r => r[1] === '9002');
k0.sheets['Списания KPI'].data[dr][12] = 'Снять';
krow(k0, '9002', '2026-10-20', 'drinks', 8, 10); krow(k0, '9003', '2026-10-13', 'exam', 5, 20);
k0.api.kpiMonths();
assert.strictEqual(k0.sheets['Списания KPI'].data.length, 7, 'recomputed, not appended');
assert.deepStrictEqual(k0.sheets['Списания KPI'].data[dr].slice(4, 13), [0, 0, 0, 0, 0, 0, 30, 'Пробный месяц', 'Снять'], 'a row with a decision is left as it was');
// live months: the loss becomes a proposal
const k1 = kenv({ kpiStart: '2026-09-01' }); kfill(k1); k1.api.kpiMonths();
rows = kRows(k1);
assert.deepStrictEqual([byCode(rows, '9001')[11], byCode(rows, '9002')[11], byCode(rows, '9005')[11]], ['Без списания', 'Предложено', 'Без списания'], 'a month after the trial: proposed only where something is lost');
assert.ok(k1.alerts[k1.alerts.length - 1].endsWith('посчитано сотрудников: 6.'));
const k2 = kenv({ kpiStart: '2026-09-15' }); kfill(k2); k2.api.kpiMonths();
assert.strictEqual(byCode(kRows(k2), '9002')[11], 'Пробный месяц', 'a start in the middle of September: October is the first full month, a trial');
// leave and sick days shorten the week they fall in; a whole week of leave is skipped
const k3 = kenv(); kfill(k3);
k3.sheets['Отсутствия'] = makeSheet([['Код', 'С', 'По', 'Причина', 'Комментарий'], ['9003', '2026-10-12', '2026-10-18', 'отпуск', ''], ['9003', '2026-10-21', '2026-10-23', 'больничный', '']]);
k3.api.kpiMonths();
assert.deepStrictEqual(byCode(kRows(k3), '9003').slice(4, 11), [84, 73, 100, 100, 100, 10, 0], '(3/5 + 3/5 + 2 of the 2 steps left) / 3 = 73%; the leave week is skipped; 10 days away; 84% loses nothing');
const k4 = kenv(); kfill(k4);
k4.sheets['Отсутствия'] = makeSheet([['Код', 'С', 'По'], ['9002', '2026-09-28', '2026-11-02']]);
k4.api.kpiMonths();
assert.ok(!byCode(kRows(k4), '9002'), 'away for the whole month: not scored, nothing to lose');
// a trainee's week needs 7 steps (5 tests and 2 lessons), so the same 3 tests are worth less
const ktr = kenv(); kfill(ktr);
ktr.staff.data.push(['9012', 'Тест-12', 'Port II', 'Стажёр', true, '']);
kweeks(ktr, '9012', 3, 0, MON, { gapx: '2026-10-28' }); krow(ktr, '9012', '2026-10-21', 'exam', 18, 20);
ktr.api.kpiMonths();
assert.deepStrictEqual(byCode(kRows(ktr), '9012').slice(4, 8), [66, 43, 100, 100], 'a trainee: 3 of 7 steps = 43% for the weeks, 66% in all');
// the message on the 1st: the trial says nothing is lost; the names and the percents are for the trainer only
const m1 = kenv({ now: Date.parse('2026-11-01T17:00:00Z') }); kfill(m1);
m1.api.dailyDigest({ triggerUid: 1 });
const km = m1.sent.find(x => x.startsWith('📉 KPI обучения за 10.2026'));
console.log('--- KPI monthly ---\n' + km);
assert.ok(km && km.includes('пробный месяц, ничего не списывается') && km.includes('План выполнен на 80% и больше: 3 из 6') && km.includes('Тест-2 (White City): 0% → −30%') && km.includes('Тест-3 (Port II): 76% → −4%') && !km.includes('Тренер'));
assert.ok(m1.sheets['Списания KPI'].getLastRow() === 7, 'the 1st builds the rows by itself');
const m2 = kenv({ now: Date.parse('2026-11-01T17:00:00Z'), kpiStart: '2026-09-01' }); kfill(m2); m2.api.dailyDigest({ triggerUid: 1 });
assert.ok(m2.sent.find(x => x.startsWith('📉 KPI обучения')).includes('предложения по списанию, подтвердите на листе «Списания KPI»'));
// a failure in the KPI never costs the digest
const m3 = kenv({ now: Date.parse('2026-11-01T17:00:00Z') }); m3.sheets['Списания KPI'] = { getLastRow() { throw new Error('boom'); } };
assert.doesNotThrow(() => m3.api.dailyDigest({ triggerUid: 1 }));
// the month in progress, for the app: only the weeks that are over, the exam pending, what missing it would cost
const r1 = kenv({ now: Date.parse('2026-11-12T09:00:00Z') }); kfill(r1);
kweeks(r1, '9001', 5, 2, ['2026-10-26', '2026-11-02']);
const kv = r1.me('9001').kpi, kv2 = r1.me('9002').kpi;
assert.deepStrictEqual([kv.month, kv.state, kv.weeksDone, kv.weeksTotal, kv.pct, kv.parts.weeks, kv.parts.exam, kv.examPending, kv.loss, kv.threshold, kv.cap], ['2026-11', 'trial', 2, 5, 100, 100, null, true, 0, 80, 30]);
assert.deepStrictEqual([kv2.pct, kv2.loss, kv2.lossIfExamMissed, kv2.examPending], [0, 30, 30, true], 'an idle person in the middle of a month: 0%');
assert.strictEqual(r1.me('9001').kpi.lossIfExamMissed, 0, 'missing the exam would still leave 80%');
const early = kenv({ now: Date.parse('2026-11-01T09:00:00Z') });
assert.deepStrictEqual([early.me('9001').kpi.pct, early.me('9001').kpi.loss, early.me('9001').kpi.weeksDone], [null, 0, 0], 'no week is over yet: no percent, nothing to lose');
r1.api.weeklyReport();
const wrk = r1.sent[r1.sent.length - 1];
console.log('--- weekly with KPI risk ---\n' + wrk);
assert.ok(wrk.includes('⚠️ Риск минуса KPI обучения в этом месяце') && wrk.includes('пробный месяц') && wrk.includes('• Тест-2 (White City): 0% → −30%') && !wrk.includes('Тест-1 (Central Park): 100%'), 'the Monday report lists who is below the threshold so far');
assert.ok(r1.isLocked() === false);
// the settings of the plan: weights add up to 100%, the threshold and the cap are the owner's numbers
const consts = /const KPI_WEIGHTS = (\{[^}]*\})/.exec(SRC)[1]; const wts = eval('(' + consts + ')');
assert.ok(Math.abs(Object.values(wts).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'the weights make 100%');
assert.ok(/const KPI_THRESHOLD = 80;/.test(SRC) && /const KPI_CAP = 30;/.test(SRC) && /const KPI_GRACE_DAYS = 14;/.test(SRC));

// 8b. KPI checks of the trainer (v5.11): a checklist of items 1–5 or skipped; % = sum / (5 × rated); the last check of a month counts
const ak = env({ notifyAll: false, now: NOW });
ak.staff.data.push(['9020', 'Шеф-1', 'Port II', 'Шеф бариста', true]);
const nRes = ak.results.data.length;
const a0 = ak.me('9001');
assert.strictEqual(a0.assess, null, 'a barista does not get the trainer part');
assert.strictEqual(a0.assessMine, null, 'no check yet');
assert.ok(!ak.sheets['Чек-листы'] && !ak.sheets['Проверки KPI'], 'an employee reading the stats creates no sheet');
const am = ak.me('9009');
assert.ok(am.assess && am.assess.checklists.length === 1 && am.assess.max === 5);
const cl0 = am.assess.checklists[0];
assert.strictEqual(cl0.id, 'barista'); assert.strictEqual(cl0.items.length, 10);
assert.ok(cl0.items[2].star === true && cl0.items[2].src === 'allergens' && cl0.items[2].sec.ru === 'Аллергены' && cl0.items[2].q.az.length > 5, 'the allergens item is starred and has the mini-check');
assert.ok(cl0.items.filter(i => i.star).length === 1 && cl0.t.az && cl0.items.every(i => i.q.ru && i.q.az && i.sec.ru && i.sec.az));
assert.strictEqual(ak.sheets['Чек-листы'].data.length, 11, 'the checklist sheet is made with its ten items');
assert.deepStrictEqual(am.assess.staff.map(x => x.code).sort(), ['9001', '9002', '9003', '9020'], 'baristas and chef-baristas, active, not the test account');
assert.ok(am.assess.staff.every(x => x.last === null));
const P = (o) => ak.post(Object.assign({ action: 'assess', code: '9009', staff: '9001', checklist: 'barista', scores: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], comment: '', secs: 300, ts: NOW - 60000 }, o));
assert.strictEqual(P({ code: '9001', staff: '9002', id: 'z0' }).error, 'not_assessor', 'only the trainer checks');
assert.strictEqual(P({ staff: '9009', id: 'z1' }).error, 'bad_staff', 'the trainer’s own test account is not checked');
assert.strictEqual(P({ staff: '1111', id: 'z2' }).error, 'bad_staff', 'an inactive employee is not checked');
assert.strictEqual(P({ checklist: 'nope', id: 'z3' }).error, 'bad_checklist');
assert.strictEqual(P({ scores: [5, 5, 5], id: 'z4' }).error, 'bad_scores', 'one score per item');
assert.strictEqual(P({ scores: [6, 5, 5, 5, 5, 5, 5, 5, 5, 5], id: 'z5' }).error, 'bad_scores', 'a score is 1..5');
assert.strictEqual(P({ scores: [0, 5, 5, 5, 5, 5, 5, 5, 5, 5], id: 'z6' }).error, 'bad_scores');
assert.strictEqual(P({ scores: Array(10).fill(null), id: 'z7' }).error, 'nothing_rated');
assert.ok(!ak.sheets['Проверки KPI'] || ak.sheets['Проверки KPI'].getLastRow() <= 1, 'refused checks write nothing');
const ok1 = P({ id: 'a1', comment: '=молодец' });
assert.deepStrictEqual([ok1.ok, ok1.pct, ok1.sum, ok1.max, ok1.skipped, ok1.replaced], [true, 100, 50, 50, 0, false], 'all ten on 5 = 100%');
const ash = ak.sheets['Проверки KPI'], ar = ash.data[1];
assert.deepStrictEqual(ash.data[0], ['Дата', 'Месяц', 'Код', 'Сотрудник', 'Филиал', 'Должность', 'Чек-лист', '% KPI', 'Баллы', 'Из', 'Пропущено',
  'Оценки', 'Комментарий', 'Время проверки', 'Проверяющий', 'ID', 'Оценки JSON', 'Часть']);
assert.ok(ar[1] === '2026-10' && ar[2] === '9001' && ar[3] === 'Тест-1' && ar[6] === 'Аттестация навыков → Barista' && ar[7] === 100 && ar[12] === "'=молодец" && ar[13] === '5:00' && ar[14] === 'Тренер' && ar[15] === 'a1');
assert.ok(ar[11].startsWith('1. Рецептуры: 5') && ar[11].includes('3. Аллергены: 5'));
assert.ok(ak.sent.some(t => t.includes('📋 Проверка KPI вживую: Тест-1 (Central Park) — 100% по 10 пунктам')), 'the trainer gets a message');
assert.strictEqual(ak.results.data.length, nRes, 'a check never touches «Результаты»');
const dupA = P({ id: 'a1', scores: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
assert.ok(dupA.duplicate && dupA.pct === 100 && ash.getLastRow() === 2, 'a repeated id writes nothing and answers the first result');
const sk = P({ id: 'a2', staff: '9002', scores: [5, 5, null, 5, 5, 5, 5, 5, 5, 5] });
assert.deepStrictEqual([sk.pct, sk.sum, sk.max, sk.skipped], [100, 45, 45, 1], 'a skipped item does not count: 9 on 5 = 100%');
assert.ok(!ash.data[2][11].includes('3. Аллергены') && ash.data[2][17] === 'вживую');
const mix = P({ id: 'a3', scores: [5, 4, 3, 5, 5, 5, 5, 5, 5, 1], comment: 'Латте-арт подтянуть' });
assert.deepStrictEqual([mix.pct, mix.sum, mix.max, mix.replaced], [86, 43, 50, true], '43 of 50 = 86%, and it replaces the first check of the month');
assert.ok(ak.sent[ak.sent.length - 1].includes('Заменяет прошлую живую проверку'));
const chef = P({ id: 'a4', staff: '9020', scores: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4] });
assert.ok(chef.ok && chef.pct === 80, 'a chef-barista is checked too (role written with a space)');
const am2 = ak.me('9009');
const lastOf = c => am2.assess.staff.filter(x => x.code === c)[0].last;
assert.ok(lastOf('9001').pct === 86 && lastOf('9002').pct === 100 && lastOf('9020').pct === 80 && lastOf('9003') === null, 'the trainer sees this month’s last result per person');
const mine = ak.me('9001').assessMine;
assert.ok(mine && mine.pct === 86 && mine.sum === 43 && mine.max === 50 && mine.month === '2026-10' && mine.comment === 'Латте-арт подтянуть' && mine.title.ru === 'Аттестация навыков → Barista');
assert.ok(mine.items.length === 10 && mine.items[1].score === 4 && mine.items[9].score === 1 && mine.items[0].sec.ru === 'Рецептуры', 'the employee sees their own items');
assert.ok(!('assess' in ak.me('9001')) || ak.me('9001').assess === null);
const mine2 = ak.me('9002').assessMine;
assert.ok(mine2.pct === 100 && mine2.items[2].score === null && !JSON.stringify(mine2).includes('Тест-1'), 'each one sees only their own check');
assert.deepStrictEqual(ak.me('9020').limits, { test: 3 }, 'a chef-barista keeps the quota of three');
/* the trainer edits the sheet: a renamed item and a new checklist show up without a new script */
ak.sheets['Чек-листы'].data[1][6] = 'Техкарты без подсказок';
ak.sheets['Чек-листы'].data.push(['shift', 'Смена', '', 1, 'Открытие', '', 'Бар открыт вовремя', '', '', '']);
const am3 = ak.me('9009').assess.checklists;
assert.ok(am3.length === 2 && am3[0].items[0].q.ru === 'Техкарты без подсказок' && am3[1].items.length === 1 && am3[1].t.az === 'Смена' && am3[1].items[0].q.az === 'Бар открыт вовремя', 'the checklists follow the sheet; a missing AZ text falls back to RU');
assert.strictEqual(ak.post({ action: 'assess', code: '9009', staff: '9001', checklist: 'shift', scores: [3], id: 'a5', ts: NOW }).pct, 60);
assert.ok(ak.isLocked() === false);
const as2 = env({ notifyAll: false, now: NOW }); as2.api.assessSetup();
assert.ok(as2.sheets['Чек-листы'].data.length === 11 && as2.sheets['Проверки KPI'].data.length === 1 && as2.alerts[0].includes('Чек-листы'), 'the menu item makes both sheets');

{ // 8c. the employee's own KPI test (v5.12): question items 3 questions each, score = share right × 5; the trainer checks the live items; the month joins both
const kt = env({ notifyAll: false, now: NOW });
kt.staff.data.push(['9020', 'Шеф-1', 'Port II', 'Шеф-бариста', true]);
const k0 = kt.me('9001').kpiTest;
assert.ok(k0 && k0.per === 3 && k0.checklist === 'barista' && k0.done === null && !kt.sheets['Чек-листы'], 'an employee gets the test from the default checklist, no sheet is made');
assert.strictEqual(k0.items.map(i => i.i).join(), '0,1,2,5,6,7,8', 'seven question items; Техника, Латте-арт, Касса are live');
assert.deepStrictEqual(k0.items.map(i => i.src), ['drinks', 'seasonal', 'allergens', 'theory', 'theory', 'theory', 'theory']);
assert.deepStrictEqual([k0.items[3].topics, k0.items[4].topics, k0.items[5].topics, k0.items[6].topics, k0.items[1].ids], [['CF-7'], ['SV-1'], ['SV-2'], ['SV-3'], []]);
assert.strictEqual(kt.me('9009').kpiTest, null, 'the trainer takes no KPI test');
assert.ok(kt.me('9020').kpiTest, 'a chef-barista takes it too');
const KT = o => kt.post(Object.assign({ action: 'kpitest', code: '9001', checklist: 'barista', items: [0, 1, 2, 5, 6, 7, 8].map(i => ({ i, right: 3, total: 3 })),
  mistakes: [], secs: 400, away: 0, aborted: false, ts: NOW - 60000 }, o));
assert.strictEqual(KT({ code: '9009', id: 'k0' }).error, 'not_assessed');
assert.strictEqual(KT({ id: 'k1', items: [{ i: 3, right: 3, total: 3 }] }).error, 'bad_items', 'a live item is not the employee’s');
assert.strictEqual(KT({ id: 'k2', items: [{ i: 0, right: 4, total: 3 }] }).error, 'bad_items');
assert.strictEqual(KT({ id: 'k3', items: [{ i: 0, right: 1, total: 3 }, { i: 0, right: 1, total: 3 }] }).error, 'bad_items', 'an item once');
assert.strictEqual(KT({ id: 'k4', items: [] }).error, 'bad_items');
assert.strictEqual(KT({ id: 'k5', checklist: 'nope' }).error, 'bad_checklist');
assert.ok(!kt.sheets['Проверки KPI'] || kt.sheets['Проверки KPI'].getLastRow() <= 1, 'refused tests write nothing');
const kr = KT({ id: 'k6', items: [{ i: 0, right: 3, total: 3 }, { i: 1, right: 2, total: 3 }, { i: 2, right: 3, total: 3 }, { i: 5, right: 1, total: 3 },
  { i: 6, right: 3, total: 3 }, { i: 7, right: 3, total: 3 }, { i: 8, right: 0, total: 3 }], mistakes: [{ q: 'Q', a: 'A', c: 'C' }], away: 1 });
/* 5 + 3.3 + 5 + 1.7 + 5 + 5 + 0 = 25 of 35 = 71% */
assert.ok(kr.ok && kr.pct === 71 && kr.month.status === 'wait_live' && kr.month.test.pct === 71 && kr.month.live === null, 'the test part: 25 of 35 = 71%, waiting for the trainer');
const krow = kt.sheets['Проверки KPI'].data[1];
assert.ok(krow[17] === 'тест' && krow[14] === 'сам (тест)' && krow[7] === 71 && krow[8] === 25 && krow[9] === 35 && krow[10] === 3, 'the row: part «тест», the share, three items left to the trainer');
assert.ok(krow[11].includes('2. Сезонное меню: 2 из 3 → 3.3') && krow[11].includes('Выходы из приложения: 1') && krow[12].includes('Q → A (верно: C)'));
assert.ok(kt.sent.some(t => t.includes('📝 Тест KPI: Тест-1 (Central Park) — 71% тестовой части') && t.includes('Ждёт живой проверки')), 'the trainer is told');
assert.strictEqual(KT({ id: 'k7' }).error, 'kpitest_done', 'one KPI test a month');
assert.ok(KT({ id: 'k6' }).duplicate, 'a repeated id answers the first result');
assert.strictEqual(kt.me('9001').kpiTest.done.pct, 71);
assert.strictEqual(kt.results.data.length, 1, 'the KPI test never touches «Результаты»');
/* the trainer checks the live items only: 4 + 5 + 3 = 12; the month: 25 + 12 = 37 of 50 = 74% */
const lv1 = kt.post({ action: 'assess', code: '9009', staff: '9001', checklist: 'barista', scores: [null, null, null, 4, 5, null, null, null, null, 3], comment: 'Хорошо', id: 'L1', ts: NOW - 30000 });
assert.ok(lv1.ok && lv1.pct === 80 && lv1.month.status === 'full' && lv1.month.pct === 74 && lv1.month.sum === 37 && lv1.month.max === 50, 'test + live = 37 of 50 = 74%');
assert.ok(kt.sent[kt.sent.length - 1].includes('Итог месяца: 74% (37 из 50)'));
const tm = kt.me('9009').assess.staff.filter(x => x.code === '9001')[0];
assert.ok(tm.month.status === 'full' && tm.month.pct === 74 && tm.month.test.pct === 71 && tm.month.live.pct === 80 && tm.last.pct === 74, 'the trainer sees both parts and the month');
assert.deepStrictEqual(tm.month.items, [5, 3.3, 5, 4, 5, 1.7, 5, 5, 0, 3]);
const mm = kt.me('9001').assessMine;
assert.ok(mm.pct === 74 && mm.status === 'full' && mm.comment === 'Хорошо' && mm.items.length === 10 && mm.items[3].src === 'live' && mm.items[8].score === 0 && mm.test.pct === 71, 'the employee sees the month');
const lv2 = kt.post({ action: 'assess', code: '9009', staff: '9002', checklist: 'barista', scores: [null, null, null, 5, 5, null, null, null, null, 5], id: 'L2', ts: NOW });
assert.ok(lv2.month.status === 'wait_test' && lv2.month.pct === 100 && kt.sent[kt.sent.length - 1].includes('Ждёт теста KPI'), 'the live part first: waits for the test');
assert.strictEqual(kt.me('9002').assessMine.status, 'wait_test');
assert.ok(kt.isLocked() === false);
/* the sources come from the sheet: a seasonal list and other topics */
const ckl = kt.sheets['Чек-листы'].data;
ckl[2][9] = 'seasonal: LotusLatte, pumpkinlatte'; ckl[6][9] = 'theory: CF-7, cf-6';
const k2 = kt.me('9003').kpiTest.items;
assert.deepStrictEqual([k2[1].ids, k2[3].topics], [['lotuslatte', 'pumpkinlatte'], ['CF-7', 'CF-6']]);
ckl[2][9] = 'nonsense'; assert.strictEqual(kt.me('9003').kpiTest.items.length, 6, 'an unknown source is checked live');
/* a v5.11 sheet nobody edited gets the sources once; an edited one keeps what the trainer wrote */
const mg = env({ notifyAll: false, now: NOW }); mg.api.assessSetup();
const mgs = mg.sheets['Чек-листы'].data, V511 = ['', '', 'allergens', '', '', '', '', '', '', ''];
mgs[0][9] = 'Авто'; V511.forEach((v, i) => { mgs[i + 1][9] = v; });
assert.strictEqual(mg.me('9009').assess.checklists[0].items.filter(i => i.src !== 'live').length, 7, 'the untouched v5.11 checklist gets the sources');
assert.ok(mgs[0][9] === 'Источник' && mgs[1][9] === 'drinks' && mgs[6][9] === 'theory:CF-7' && mgs[4][9] === 'live');
const mg2 = env({ notifyAll: false, now: NOW }); mg2.api.assessSetup();
const mgs2 = mg2.sheets['Чек-листы'].data;
mgs2[0][9] = 'Авто'; V511.forEach((v, i) => { mgs2[i + 1][9] = v; }); mgs2[1][6] = 'Своя формулировка';
assert.ok(mg2.me('9009').assess.checklists[0].items.filter(i => i.src !== 'live').length === 1 && mgs2[0][9] === 'Источник' && mgs2[1][9] === '', 'an edited checklist keeps its column (only allergens is a question item)');
/* a v5.11 result (no «Часть») is a full check by the trainer */
const o11 = env({ notifyAll: false, now: NOW }); o11.api.assessSetup();
const od = o11.sheets['Проверки KPI'].data; od[0].length = 17;
od.push([new Date(NOW - 1000), '2026-10', '9001', 'Тест-1', 'Central Park', 'Бариста', 'Аттестация навыков → Barista', 90, 45, 50, 0, '', '', '', 'Тренер', 'old1',
  JSON.stringify({ checklist: 'barista', scores: [5, 4, 5, 4, 5, 4, 5, 4, 5, 4] })]);
const om = o11.me('9001').assessMine;
assert.ok(om && om.status === 'full' && om.pct === 90 && om.live && !om.test, 'a v5.11 row counts as a full check');
assert.ok(o11.me('9001').kpiTest.done === null, 'and the employee can still take this month’s test');
}

// 9. menu flows
const t4 = env({ props: {}, promptText: FAKE_TOKEN, updates: [{ message: { chat: { id: 777, first_name: 'Nuran' } } }] });
t4.api.setupTelegram(); assert.strictEqual(t4.props.TELEGRAM_TOKEN, FAKE_TOKEN);
t4.api.findChat(); assert.strictEqual(t4.props.TELEGRAM_CHAT_ID, '777'); assert.ok(t4.alerts[1].includes('Nuran'));
t4.api.installTriggers(); assert.deepStrictEqual(t4.triggers, ['dailyDigest@21', 'weeklyReport@10']);
const t5 = env({ props: {}, promptText: 'not a token' }); t5.api.setupTelegram(); assert.ok(!t5.props.TELEGRAM_TOKEN);
console.log('\nALL CHECKS PASSED');
