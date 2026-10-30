// Runs Code.gs against in-memory mocks of the Apps Script services: node tools/apps-script/test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(__dirname + '/Code.gs', 'utf8');

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
        getValue() { return this.getValues()[0][0]; }
      };
    }
  };
  return sh;
}

function env(opts = {}) {
  const staff = makeSheet([['Код', 'Имя', 'Филиал', 'Должность', 'Активен'],
    ['4976', 'Jale', 'Central Park', 'Бариста', true], ['4814', 'Milena', 'White City', 'Бариста', true],
    ['1111', 'Ушёл', 'White City', 'Бариста', false], ['4303', 'Yusif', 'Port II', 'Бариста', true]]);
  const results = makeSheet([['Дата и время', 'Код', 'Сотрудник', 'Филиал', 'Раздел', 'Правильных', 'Вопросов', 'Результат', 'Сдан', 'Ошибки', 'Язык', 'Версия', 'ID']]);
  const named = { PassThreshold: opts.threshold ?? 0.7, DigestHour: 21, WeeklyHour: 10 };
  const props = Object.assign({}, opts.props || { TELEGRAM_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' });
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
      if (method === 'sendMessage') sent.push(body.text);
      const result = method === 'getMe' ? { username: 'sensum_bot' } : method === 'getUpdates'
        ? (opts.updates || []) : { message_id: 1 };
      return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Utilities: { formatDate(d, tz, f) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(d).map(x => [x.type, x.value]));
      return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day);
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
assert.deepStrictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '4976' } }).text), { ok: true, name: 'Jale', branch: 'Central Park' });
assert.strictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '1111' } }).text).ok, false, 'inactive staff rejected');
assert.strictEqual(JSON.parse(t.api.doGet({ parameter: { action: 'whoami', code: '12' } }).text).ok, false);

// 2. passing result: row written, no instant notification
let r = t.post({ id: 'a1', code: '4814', scope: 'Напитки', score: 9, total: 10, mistakes: [], lang: 'az', ver: '1.78' });
assert.deepStrictEqual(r, { ok: true });
const row2 = t.results.data[1];
assert.strictEqual(row2[1], '4814'); assert.strictEqual(row2[2], 'Milena'); assert.strictEqual(row2[7], '=IF(G2=0,0,F2/G2)');
assert.strictEqual(row2[8], '=IF(H2>=PassThreshold,"да","нет")'); assert.strictEqual(t.results.formats['2:2'], '@');
assert.strictEqual(t.sent.length, 0);

// 3. failing result: notification with mistakes; duplicate id ignored
r = t.post({ id: 'a2', code: '4976', scope: 'Напитки · Эспрессо-бар', score: 6, total: 10, mistakes: M, lang: 'ru', ver: '1.78' });
assert.deepStrictEqual(r, { ok: true });
assert.strictEqual(t.sent.length, 1);
console.log('--- fail notification ---\n' + t.sent[0]);
assert.ok(t.sent[0].includes('60%') && t.sent[0].includes('Jale · Central Park') && t.sent[0].includes('180 мл (верно: 220 мл)'));
assert.deepStrictEqual(t.post({ id: 'a2', code: '4976', scope: 'x', score: 6, total: 10 }), { ok: true, duplicate: true });
assert.strictEqual(t.results.getLastRow(), 3, 'duplicate not appended');

// 4. bad input
assert.strictEqual(t.post({ code: '9999', score: 1, total: 10 }).error, 'unknown_code');
assert.strictEqual(t.post({ code: '4976', score: 11, total: 10 }).error, 'bad_score');
assert.strictEqual(t.post({ code: '4976', score: 1.5, total: 10 }).error, 'bad_score');
assert.strictEqual(JSON.parse(t.api.doPost({ postData: { contents: 'not json' } }).text).error, 'bad_json');

// 5. formula injection is neutralised; offline timestamp kept; old timestamp ignored
const ts = Date.now() - 3 * 3600e3;
t.post({ id: 'a3', code: '4303', scope: '=IMPORTXML("x")', score: 8, total: 10, mistakes: [{ q: '=HYPERLINK("x")', a: 'a', c: 'b' }], ts });
const row4 = t.results.data[3];
assert.strictEqual(row4[4], '\'=IMPORTXML("x")'); assert.ok(row4[9].startsWith("'="));
assert.strictEqual(row4[0].getTime(), ts);
t.post({ id: 'a4', code: '4303', scope: 'Заготовки', score: 5, total: 10, ts: Date.now() - 30 * 864e5 });
assert.ok(Date.now() - t.results.data[4][0].getTime() < 5000, 'stale ts replaced by now');

// 6. Telegram down: result still saved, response ok
const t2 = env({ tgDown: true });
assert.deepStrictEqual(t2.post({ id: 'b1', code: '4976', scope: 'Напитки', score: 2, total: 10 }), { ok: true });
assert.strictEqual(t2.results.getLastRow(), 2);

// 7. threshold typed as 70 instead of 70%
const t3 = env({ threshold: 70 });
t3.post({ id: 'c1', code: '4976', scope: 'Напитки', score: 8, total: 10 });
assert.strictEqual(t3.sent.length, 0, '80% passes with threshold 70');

// 8. daily digest + weekly report
t.post({ id: 'a5', code: '4976', scope: 'Напитки', score: 5, total: 10, mistakes: M });
t.api.dailyDigest({ triggerUid: 1 });
console.log('--- daily digest ---\n' + t.sent[t.sent.length - 1]);
assert.ok(t.sent[t.sent.length - 1].includes('Частые ошибки') && t.sent[t.sent.length - 1].includes('(2 раза)'));
t.api.weeklyReport();
console.log('--- weekly report ---\n' + t.sent[t.sent.length - 1]);
const empty = env(); empty.api.dailyDigest(); assert.ok(empty.alerts[0].includes('тестов не было'));

// 9. menu flows
const t4 = env({ props: {}, promptText: '123456:AAEabcdefghijklmnopqrstuvwxyz012345', updates: [{ message: { chat: { id: 777, first_name: 'Nuran' } } }] });
t4.api.setupTelegram(); assert.strictEqual(t4.props.TELEGRAM_TOKEN, '123456:AAEabcdefghijklmnopqrstuvwxyz012345');
t4.api.findChat(); assert.strictEqual(t4.props.TELEGRAM_CHAT_ID, '777'); assert.ok(t4.alerts[1].includes('Nuran'));
t4.api.installTriggers(); assert.deepStrictEqual(t4.triggers, ['dailyDigest@21', 'weeklyReport@10']);
const t5 = env({ props: {}, promptText: 'not a token' }); t5.api.setupTelegram(); assert.ok(!t5.props.TELEGRAM_TOKEN);
console.log('\nALL CHECKS PASSED');
