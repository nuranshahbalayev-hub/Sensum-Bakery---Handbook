// Runs Code.gs against in-memory mocks of the Apps Script services: node tools/apps-script/test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
/* built at runtime so no token-shaped literal sits in the repo; it only has to pass setupTelegram's format check */
const FAKE_TOKEN = '1:' + 'x'.repeat(36);

function makeSheet(rows, maxRows) {
  const data = rows.map(r => r.slice());
  const sh = {
    data, maxRows: maxRows || 1000, formats: {},
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
    ['9009', 'Тренер', 'Тест', 'Тренинг-менеджер', true]]);
  const results = makeSheet([['Дата и время', 'Код', 'Сотрудник', 'Филиал', 'Раздел', 'Правильных', 'Вопросов', 'Результат', 'Сдан', 'Ошибки', 'Язык', 'Версия', 'ID']]);
  const sheets = { 'Результаты': results, 'Сотрудники': staff };
  const named = { PassThreshold: opts.threshold ?? 0.7, DigestHour: 21, WeeklyHour: 10 };
  if ('notifyAll' in opts) named.NotifyAll = opts.notifyAll;
  const props = Object.assign({}, opts.props || { TELEGRAM_TOKEN: 'mock-token', TELEGRAM_CHAT_ID: '42' });
  const sent = [], alerts = [], triggers = [];
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
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
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
  vm.runInContext(SRC + '\n;this.__api={doGet,doPost,dailyDigest,weeklyReport,monthlyReport_,setupTelegram,findChat,installTriggers,testNotify,hardQuestions};', ctx);
  const api = ctx.__api;
  const post = d => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(d) } }).text);
  const me = code => JSON.parse(api.doGet({ parameter: { action: 'me', code } }).text);
  return { api, post, me, results, staff, sheets, props, sent, alerts, triggers };
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
assert.deepStrictEqual(t.post({ id: 'a2', code: '9001', scope: 'x', score: 6, total: 10 }), { ok: true, duplicate: true });
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
assert.strictEqual(s1.version, 'v5.6'); assert.strictEqual(s1.telegramToken, true); assert.strictEqual(s1.telegramChat, true);
assert.ok(s1.lastNotifyError.includes('chat not found')); assert.ok(!JSON.stringify(s1).includes('mock-token') && !JSON.stringify(s1).includes('"42"'));
assert.strictEqual(JSON.parse(st.api.doGet({}).text).version, 'v5.6');
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
/* rows of earlier weeks written straight into the sheet (a POST only accepts the last 7 days) */
const put = (code, name, branch, days, score, total, kind, aborted) => g.results.data.push([new Date(at(days)), code, name, branch, kind, score, total,
  '', '', '', 'ru', '1.87', 'old' + g.results.data.length, '', '', '', aborted ? 'да' : '', kind]);
['9001', '9002'].forEach(c => { for (const d of [9, 10, 11, 16, 17, 18]) put(c, c === '9001' ? 'Тест-1' : 'Тест-2', c === '9001' ? 'Central Park' : 'White City', d, 8, 10, 'drinks'); });
let gr = g.post({ id: 'g1', code: '9001', scope: 'Напитки', kind: 'drinks', score: 9, total: 10, ts: at(0, 8) });
assert.strictEqual(gr.xp, 90); assert.deepStrictEqual(gr.owls, [{ why: 'Тест на 90%+', n: 1 }]);
gr = g.post({ id: 'g2', code: '9001', scope: 'Напитки', kind: 'drinks', score: 10, total: 10, ts: at(0, 9) });
assert.strictEqual(gr.xp, 150, 'flawless: +50'); assert.deepStrictEqual(gr.owls, [], 'one «90%+» owl a day');
gr = g.post({ id: 'g3', code: '9001', scope: 'Заготовки', kind: 'preps', score: 7, total: 10, ts: at(1, 9) });
assert.deepStrictEqual(gr.owls, [{ why: 'Учебная неделя', n: 2 }], 'third test of the week at 70%+');
assert.strictEqual(g.results.data[g.results.data.length - 1][17], 'preps', 'type column R');
gr = g.post({ id: 'g4', code: '9001', scope: 'Экзамен месяца', kind: 'exam', score: 20, total: 20, ts: at(0, 10) });
assert.strictEqual(gr.xp, 350, 'exam: 15 per answer + 50'); assert.deepStrictEqual(gr.owls, [{ why: 'Экзамен месяца 100%', n: 15 }]);
assert.deepStrictEqual(g.post({ id: 'g5', code: '9001', scope: 'Экзамен месяца', kind: 'exam', score: 5, total: 20, ts: at(0, 11) }), { ok: false, error: 'exam_done' });
assert.ok(!g.results.data.some(x => x[12] === 'g5'), 'a second exam in a month is not saved');
gr = g.post({ id: 'g6', code: '9001', scope: 'Напитки', kind: 'drinks', score: 10, total: 10, ts: at(0, 12), aborted: true });
assert.strictEqual(gr.xp, 0); assert.deepStrictEqual(gr.owls, [], 'aborted: nothing');
gr = g.post({ id: 'g7', code: '9002', scope: 'Напитки', kind: 'drinks', score: 10, total: 10, ts: at(0, 12), away: 1 });
assert.deepStrictEqual(gr.owls, [], 'left the app: no «90%+» owl');
/* retries («mix») are not limited, so the daily cap of 5 is still reachable: recipe tests stop at 3 a week */
for (let i = 0; i < 4; i++) g.post({ id: 'g8' + i, code: '9002', scope: 'Напитки', kind: 'mix', score: 5, total: 10, ts: at(0, 13 + i) });
gr = g.post({ id: 'g9', code: '9002', scope: 'Напитки', kind: 'mix', score: 9, total: 10, ts: at(0, 18) });
assert.strictEqual(gr.xp, 0, 'only the first 5 tests of a day give XP');
assert.deepStrictEqual(gr.owls, [{ why: 'Тест на 90%+', n: 1 }], 'but the first clean 90%+ test of the day still earns its owl');
const ledger = g.sheets['Совы'];
assert.deepStrictEqual(ledger.data[0], ['Дата', 'Код', 'Сотрудник', 'Филиал', 'За что', 'Совы', 'Внесено в Sensum OS', 'Ключ']);
assert.strictEqual(ledger.data.length, 1 + 4, 'four owl rows so far');
assert.deepStrictEqual(ledger.checkboxes, ['2:7', '3:7', '4:7', '5:7'], 'a checkbox in each owl row');
assert.strictEqual(ledger.formats['2:2'], '@', 'code kept as text');
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
// weekly limit (v5.4, 4 since v5.5): 4 recipe tests (drinks, preps and the vitrina together) and 2 theory tests a week
const lim = env({ notifyAll: true, now: NOW });
const lp = (id, kind, h, o) => lim.post(Object.assign({ id, code: '9002', scope: 'Тест', kind, score: 10, total: 10, ts: at(0, h) }, o));
const r1 = lp('l1', 'drinks', 7), r2 = lp('l2', 'preps', 8), r3 = lp('l3', 'vitrina', 9), r3b = lp('l3b', 'drinks', 10);
assert.ok([r1, r2, r3, r3b].every(r => r.xp > 0 && r.over === false), 'the first four recipe tests of the week count (drinks, preps and the vitrina together)');
assert.strictEqual(lim.results.data.find(x => x[12] === 'l3')[17], 'vitrina', 'the vitrina test type is stored');
const r4 = lp('l4', 'drinks', 11);
assert.deepStrictEqual([r4.ok, r4.xp, r4.over, r4.owls], [true, 0, true, []], 'the fifth is saved, but without XP and owls');
assert.ok(lim.results.data.some(x => x[12] === 'l4'), 'the result over the limit is not lost');
assert.ok(lim.sent[lim.sent.length - 1].includes('Сверх недельного лимита'), 'the trainer\u2019s message says it was over the limit');
/* another day, so the daily cap of 5 does not get in the way */
const tq1 = lp('t1', 'theory', 11, { ts: at(1, 11) }), tq2 = lp('t2', 'theory', 12, { ts: at(1, 12) }), tq3 = lp('t3', 'theory', 13, { ts: at(1, 13) });
assert.ok(tq1.xp > 0 && tq2.xp > 0 && tq1.over === false && tq2.over === false && tq3.over === true && tq3.xp === 0, 'theory has its own limit of 2');
assert.ok(lp('m1', 'mix', 14, { ts: at(2, 14) }).over === false && lp('m2', 'exam', 15, { total: 20, score: 20, ts: at(2, 15) }).over === false, 'retries and the monthly exam are not attempts');
const lme = lim.me('9002');
assert.deepStrictEqual([lme.week, lme.limits], [{ recipes: 5, theory: 3 }, { recipes: 4, theory: 2 }], '?action=me reports the attempts and the limits');
// an aborted test is an attempt
const ab = env({ notifyAll: false, now: NOW });
['a1', 'a2'].forEach((id, i) => ab.post({ id, code: '9002', scope: 'x', kind: 'drinks', score: 10, total: 10, ts: at(0, 7 + i) }));
ab.post({ id: 'a3', code: '9002', scope: 'x', kind: 'drinks', score: 2, total: 10, ts: at(0, 9), aborted: true });
['a3b'].forEach(id => ab.post({ id, code: '9002', scope: 'x', kind: 'drinks', score: 10, total: 10, ts: at(0, 9, 30) }));
assert.strictEqual(ab.post({ id: 'a4', code: '9002', scope: 'x', kind: 'drinks', score: 10, total: 10, ts: at(0, 10) }).over, true, 'three tests and an aborted one use the four attempts');
// last week's attempts do not count
const wk = env({ notifyAll: false, now: NOW });
for (const d of [8, 9, 10, 11]) wk.results.data.push([new Date(at(d)), '9002', 'Тест-2', 'White City', 'x', 10, 10, '', '', '', 'ru', '1.9', 'w' + d, '', '', '', '', 'drinks']);
assert.strictEqual(wk.me('9002').week.recipes, 0, 'attempts of the previous week are not counted');
const wr1 = wk.post({ id: 'w1', code: '9002', scope: 'x', kind: 'drinks', score: 10, total: 10, ts: at(0, 8) });
assert.ok(wr1.over === false && wr1.xp > 0 && wk.me('9002').week.recipes === 1, 'a new week starts from zero');
// progress (v5.5): read lessons and card boxes live on the sheet «Прогресс», per code
const pg = env({ notifyAll: false, now: NOW });
assert.deepStrictEqual(pg.me('9001').progress, { read: [], box: {}, ts: 0 }, 'nothing stored yet: an empty progress, no sheet needed');
let pr = pg.post({ action: 'progress', code: '9001', read: ['cf-origin', 'cf-farm'], box: { 'd:latte': 2, 'v:minituna': 1, 't:CF-01': 3 }, ts: 1000 });
assert.deepStrictEqual([pr.ok, pr.progress.read, pr.progress.box, pr.progress.ts], [true, ['cf-origin', 'cf-farm'], { 'd:latte': 2, 'v:minituna': 1, 't:CF-01': 3 }, 1000], 'first write is stored');
assert.deepStrictEqual(pg.sheets['Прогресс'].data[0], ['Код', 'Сотрудник', 'Обновлено (мс)', 'Прочитанные уроки', 'Ящики карточек'], 'the sheet is created with its header');
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
const m = g.me('9001');
console.log('--- me ---\n' + JSON.stringify(m));
assert.strictEqual(m.ok, true); assert.strictEqual(m.name, 'Тест-1');
assert.strictEqual(m.owlsMonth, 18); assert.strictEqual(m.owlsCap, 50); assert.strictEqual(m.streak, 3, 'two earlier study weeks + this one');
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
assert.ok(wr.includes('🏆 Рейтинг недели:') && wr.includes('🦉 Начислить в Sensum OS:') && wr.includes('Тест-1 (Central Park): +18') && !wr.includes('Тренер'));
g.api.monthlyReport_(new Date('2026-11-01T17:00:00Z'));
const mr = g.sent[g.sent.length - 1];
console.log('--- monthly ---\n' + mr);
assert.ok(mr.startsWith('📝 Экзамен месяца, 10.2026') && mr.includes('Тест-1: 20 из 20, 100%') && mr.includes('Тест-2: не сдавал') && mr.includes('Тест-1: 18'));

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
assert.deepStrictEqual(dm.week, { recipes: 0, theory: 0 }, 'not a weekly attempt');
assert.strictEqual(dm.weekTests, 0, 'not a test of the study week'); assert.strictEqual(dm.streak, 0);
assert.ok(!dm.badges.includes('first'), '«Вопрос дня» is not a first test');
assert.strictEqual(dm.board.people[0].xp, 110, 'its XP counts on the weekly board');
assert.deepStrictEqual(dq.me('9002').daily, { done: false, streak: 0 });
for (let i = 1; i <= 7; i++) dq.post({ id: 'w' + i, code: '9002', kind: 'daily', score: 3, total: 3, ts: at(i - 1, 8) });
const d7 = dq.me('9002');
assert.strictEqual(d7.daily.streak, 7); assert.ok(d7.badges.includes('days7'), 'seven days in a row: the badge');
// tests count six attempts a day for XP; «Вопрос дня» does not take one of the five XP tests of a day
for (let i = 1; i <= 5; i++) dq.post({ id: 'x' + i, code: '9003', scope: 'Напитки', kind: i < 5 ? 'drinks' : 'theory', score: 10, total: 10, ts: at(0, 11) });
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

// 9. menu flows
const t4 = env({ props: {}, promptText: FAKE_TOKEN, updates: [{ message: { chat: { id: 777, first_name: 'Nuran' } } }] });
t4.api.setupTelegram(); assert.strictEqual(t4.props.TELEGRAM_TOKEN, FAKE_TOKEN);
t4.api.findChat(); assert.strictEqual(t4.props.TELEGRAM_CHAT_ID, '777'); assert.ok(t4.alerts[1].includes('Nuran'));
t4.api.installTriggers(); assert.deepStrictEqual(t4.triggers, ['dailyDigest@21', 'weeklyReport@10']);
const t5 = env({ props: {}, promptText: 'not a token' }); t5.api.setupTelegram(); assert.ok(!t5.props.TELEGRAM_TOKEN);
console.log('\nALL CHECKS PASSED');
