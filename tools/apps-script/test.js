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
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((data[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
        setValues(v) { v.forEach((row, i) => { while (data.length < r + i) data.push([]); row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; }); }); },
        setNumberFormat(f) { sh.formats[r + ':' + c] = f; return this; },
        copyFormatToRange() {},
        getValue() { return this.getValues()[0][0]; }
      };
    }
  };
  return sh;
}

function env(opts = {}) {
  const staff = makeSheet([['Код', 'Имя', 'Филиал', 'Должность', 'Активен'],
    ['9001', 'Тест-1', 'Central Park', 'Бариста', true], ['9002', 'Тест-2', 'White City', 'Бариста', true],
    ['1111', 'Ушёл', 'White City', 'Бариста', false], ['9003', 'Тест-3', 'Port II', 'Бариста', true]]);
  const results = makeSheet([['Дата и время', 'Код', 'Сотрудник', 'Филиал', 'Раздел', 'Правильных', 'Вопросов', 'Результат', 'Сдан', 'Ошибки', 'Язык', 'Версия', 'ID']]);
  const named = { PassThreshold: opts.threshold ?? 0.7, DigestHour: 21, WeeklyHour: 10 };
  if ('notifyAll' in opts) named.NotifyAll = opts.notifyAll;
  const props = Object.assign({}, opts.props || { TELEGRAM_TOKEN: 'mock-token', TELEGRAM_CHAT_ID: '42' });
  const sent = [], alerts = [], triggers = [];
  const ui = { alerts, ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' }, alert: m => alerts.push(m),
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => opts.promptText || '' }),
    createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } };
  const ctx = {
    console, Date, JSON, Math, Number, String, Map, Set, Array, Object, isFinite,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => ({ 'Результаты': results, 'Сотрудники': staff })[n],
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
  vm.runInContext(SRC + '\n;this.__api={doGet,doPost,dailyDigest,weeklyReport,setupTelegram,findChat,installTriggers,testNotify};', ctx);
  const api = ctx.__api;
  const post = d => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(d) } }).text);
  return { api, post, results, staff, props, sent, alerts, triggers };
}

const M = [{ q: 'Café Latte: сколько «Молоко»?', a: '180 мл', c: '220 мл' }];
let t;

// 1. whoami
t = env();
assert.deepStrictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '9001' } }).text), { ok: true, name: 'Тест-1', branch: 'Central Park' });
assert.strictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '1111' } }).text).ok, false, 'inactive staff rejected');
assert.strictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '12' } }).text).ok, false);

// 2. passing result: row written, no instant notification
let r = t.post({ id: 'a1', code: '9002', scope: 'Напитки', score: 9, total: 10, mistakes: [], lang: 'az', ver: '1.78' });
assert.deepStrictEqual(r, { ok: true });
const row2 = t.results.data[1];
assert.strictEqual(row2[1], '9002'); assert.strictEqual(row2[2], 'Тест-2'); assert.strictEqual(row2[7], '=IF(G2=0,0,F2/G2)');
assert.strictEqual(row2[8], '=IF(Q2="да","нет",IF(H2>=PassThreshold,"да","нет"))');
assert.deepStrictEqual(row2.slice(13), ['', '', '', ''], 'older app: check columns stay blank');
assert.deepStrictEqual(t.results.data[0].slice(13), ['Время теста', 'Время вышло', 'Выходы из приложения', 'Прерван'], 'headers added once'); assert.strictEqual(t.results.formats['2:2'], '@');
assert.strictEqual(t.sent.length, 0);

// 3. failing result: notification with mistakes; duplicate id ignored
r = t.post({ id: 'a2', code: '9001', scope: 'Напитки · Эспрессо-бар', score: 6, total: 10, mistakes: M, lang: 'ru', ver: '1.78' });
assert.deepStrictEqual(r, { ok: true });
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
assert.deepStrictEqual(t2.post({ id: 'b1', code: '9001', scope: 'Напитки', score: 2, total: 10 }), { ok: true });
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
assert.strictEqual(s1.version, 'v4'); assert.strictEqual(s1.telegramToken, true); assert.strictEqual(s1.telegramChat, true);
assert.ok(s1.lastNotifyError.includes('chat not found')); assert.ok(!JSON.stringify(s1).includes('mock-token') && !JSON.stringify(s1).includes('"42"'));
assert.strictEqual(JSON.parse(st.api.doGet({}).text).version, 'v4');
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
assert.deepStrictEqual(h.results.data[1].slice(13), ['2:10', 1, 0, '']); assert.strictEqual(h.results.formats['2:14'], '@');
assert.strictEqual(h.sent.length, 0, 'clean pass stays quiet when only fails are notified');
h.post({ id: 'h2', code: '9002', scope: 'Напитки', score: 9, total: 10, secs: 95, timeouts: 0, away: 2, aborted: false });
assert.strictEqual(h.sent.length, 1, 'leaving the app is always reported');
assert.ok(h.sent[0].startsWith('✅ Тест сдан: 90%') && h.sent[0].includes('⏱ 1:35 · 📵 выходы из приложения: 2'));
h.post({ id: 'h3', code: '9003', scope: 'Заготовки', score: 8, total: 10, secs: 61, timeouts: 2, away: 1, aborted: true });
console.log('--- aborted test ---\n' + h.sent[1]);
assert.ok(h.sent[1].startsWith('⛔ Тест прерван: 80%') && h.sent[1].includes('⏱ 1:01 · время вышло: 2 · 📵 выходы из приложения: 1'));
assert.deepStrictEqual(h.results.data[3].slice(13), ['1:01', 2, 1, 'да']);
assert.strictEqual(h.results.data[3][8], '=IF(Q4="да","нет",IF(H4>=PassThreshold,"да","нет"))', 'aborted never passes');
h.post({ id: 'h4', code: '9001', scope: 'Напитки', score: 5, total: 10, secs: -3, timeouts: 'x', away: 1.5 });
assert.deepStrictEqual(h.results.data[4].slice(13), ['', '', '', ''], 'junk check values are dropped');
h.api.dailyDigest({ triggerUid: 1 });
const dg = h.sent[h.sent.length - 1];
console.log('--- digest with checks ---\n' + dg);
assert.ok(dg.includes('Тест-3 (Port II): Заготовки, 8 из 10, прерван') && dg.includes('Выходили из приложения во время теста:') && dg.includes('Тест-2 (White City): 2 раза'));

// 9. menu flows
const t4 = env({ props: {}, promptText: FAKE_TOKEN, updates: [{ message: { chat: { id: 777, first_name: 'Nuran' } } }] });
t4.api.setupTelegram(); assert.strictEqual(t4.props.TELEGRAM_TOKEN, FAKE_TOKEN);
t4.api.findChat(); assert.strictEqual(t4.props.TELEGRAM_CHAT_ID, '777'); assert.ok(t4.alerts[1].includes('Nuran'));
t4.api.installTriggers(); assert.deepStrictEqual(t4.triggers, ['dailyDigest@21', 'weeklyReport@10']);
const t5 = env({ props: {}, promptText: 'not a token' }); t5.api.setupTelegram(); assert.ok(!t5.props.TELEGRAM_TOKEN);
console.log('\nALL CHECKS PASSED');
