/**
 * Sensum & Bakery · приём результатов тестов из справочника бариста.
 *
 * Справочник отправляет результат теста (POST). Скрипт проверяет код сотрудника
 * по листу «Сотрудники», дописывает строку в «Результаты» и пишет в Telegram:
 * о каждом тесте, если на листе «Настройки» отмечено «Уведомлять о каждом тесте»,
 * иначе только о тестах ниже порога. По расписанию отправляет сводку за день и
 * недельный отчёт. Токен Telegram-бота хранится в свойствах скрипта, не в таблице.
 */

const SHEET_RESULTS = 'Результаты';
const SHEET_STAFF = 'Сотрудники';
const TZ = 'Asia/Baku';
const MAX_QUESTIONS = 50;
const RESULT_COLS = 13;
const SCRIPT_VERSION = 'v3';

/* ---------- меню в таблице ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Sensum')
    .addItem('1. Подключить Telegram-бота', 'setupTelegram')
    .addItem('2. Найти чат для уведомлений', 'findChat')
    .addItem('3. Включить сводки', 'installTriggers')
    .addSeparator()
    .addItem('Отправить тестовое уведомление', 'testNotify')
    .addItem('Отправить сводку за сутки сейчас', 'dailyDigest')
    .addToUi();
}

/* ---------- веб-приложение: справочник обращается сюда ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'whoami') {
    const s = findStaff_(p.code);
    return json_(s ? { ok: true, name: s.name, branch: s.branch } : { ok: false, error: 'unknown_code' });
  }
  if (p.action === 'status') return json_(status_());
  return json_({ ok: true, service: 'sensum-learn', version: SCRIPT_VERSION });
}

/* what can be checked from outside: never returns the bot token or the chat id */
function status_() {
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true, version: SCRIPT_VERSION,
    telegramToken: !!props.getProperty('TELEGRAM_TOKEN'), telegramChat: !!props.getProperty('TELEGRAM_CHAT_ID'),
    notifyAll: flag_('NotifyAll'), threshold: setting_('PassThreshold', 0.7),
    lastNotifyOk: props.getProperty('LAST_NOTIFY_OK') || '', lastNotifyError: props.getProperty('LAST_NOTIFY_ERROR') || ''
  };
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  const staff = findStaff_(d.code);
  if (!staff) return json_({ ok: false, error: 'unknown_code' });
  const score = Number(d.score), total = Number(d.total);
  if (!(Number.isInteger(score) && Number.isInteger(total) && total > 0 && total <= MAX_QUESTIONS && score >= 0 && score <= total)) {
    return json_({ ok: false, error: 'bad_score' });
  }
  const id = text_(d.id, 64);
  const scope = text_(d.scope, 80);
  const mistakes = (Array.isArray(d.mistakes) ? d.mistakes : []).slice(0, MAX_QUESTIONS)
    .map(m => `${text_(m && m.q, 200)} → ${text_(m && m.a, 100)} (верно: ${text_(m && m.c, 100)})`);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEET_RESULTS);
    if (id && isDuplicate_(sh, id)) return json_({ ok: true, duplicate: true });
    const row = sh.getLastRow() + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
    sh.getRange(row, 2).setNumberFormat('@');
    sh.getRange(row, 1, 1, RESULT_COLS).setValues([[
      takenAt_(d.ts), staff.code, staff.name, staff.branch, cell_(scope), score, total,
      `=IF(G${row}=0,0,F${row}/G${row})`, `=IF(H${row}>=PassThreshold,"да","нет")`,
      cell_(mistakes.join('\n')), text_(d.lang, 5), text_(d.ver, 12), cell_(id)
    ]]);
  } finally {
    lock.releaseLock();
  }

  const passed = score / total >= setting_('PassThreshold', 0.7);
  if (!passed || flag_('NotifyAll')) {
    const lines = [
      passed ? `✅ Тест сдан: ${pct_(score / total)}` : `⚠️ Тест не сдан: ${pct_(score / total)}`,
      `${staff.name} · ${staff.branch}`,
      `${scope}: ${score} из ${total}`
    ];
    if (mistakes.length) lines.push('', 'Ошибки:', ...mistakes.slice(0, 10).map(m => `• ${m}`));
    if (mistakes.length > 10) lines.push(`…и ещё ${mistakes.length - 10}`);
    notify_(lines.join('\n'));
  }
  return json_({ ok: true });
}

/* ---------- сводки по расписанию ---------- */

function dailyDigest(e) {
  /* the last 24 hours, so tests taken after the evening digest show up in the next one */
  const now = new Date(), from = new Date(now.getTime() - 864e5);
  const rows = results_().filter(r => r.date > from);
  if (!rows.length) {
    if (!e) SpreadsheetApp.getUi().alert('За последние сутки тестов не было, сводку отправлять не о чем.');
    return;
  }
  const thr = setting_('PassThreshold', 0.7);
  const lines = [
    `📊 Сводка за сутки, ${Utilities.formatDate(now, TZ, 'dd.MM.yyyy')}`,
    `${rows.length} ${plural_(rows.length, 'тест', 'теста', 'тестов')}, средний результат ${pct_(avg_(rows))}, ` +
      `сотрудников: ${new Set(rows.map(r => r.code)).size}`,
    '', 'По филиалам:'
  ];
  groupBy_(rows, r => r.branch).forEach((list, branch) =>
    lines.push(`• ${branch}: ${list.length} ${plural_(list.length, 'тест', 'теста', 'тестов')}, ${pct_(avg_(list))}`));
  const failed = rows.filter(r => r.ratio < thr);
  if (failed.length) {
    lines.push('', `Не сдали (ниже ${pct_(thr)}):`);
    failed.forEach(r => lines.push(`• ${r.name} (${r.branch}): ${r.scope}, ${r.score} из ${r.total}`));
  }
  const top = topMistakes_(rows, 3);
  if (top.length) {
    lines.push('', 'Частые ошибки:');
    top.forEach(([q, n]) => lines.push(`• ${q} (${n} ${plural_(n, 'раз', 'раза', 'раз')})`));
  }
  send_(lines.join('\n'));
  if (!e) SpreadsheetApp.getUi().alert('Сводка отправлена в Telegram.');
}

function weeklyReport() {
  const now = new Date(), from = new Date(now.getTime() - 7 * 864e5);
  const rows = results_().filter(r => r.date >= from);
  const staff = activeStaff_();
  const lines = [`📅 Итоги недели: ${Utilities.formatDate(from, TZ, 'dd.MM')}–${Utilities.formatDate(now, TZ, 'dd.MM.yyyy')}`];
  if (rows.length) {
    lines.push(`${rows.length} ${plural_(rows.length, 'тест', 'теста', 'тестов')}, средний результат ${pct_(avg_(rows))}`);
  } else {
    lines.push('За неделю тестов не было.');
  }
  lines.push('', 'По филиалам:');
  groupBy_(staff, s => s.branch).forEach((people, branch) => {
    const list = rows.filter(r => r.branch === branch);
    const tested = new Set(list.map(r => r.code));
    const took = people.filter(p => tested.has(p.code)).length;
    lines.push(`• ${branch}: прошли тест ${took} из ${people.length}` + (list.length ? `, средний ${pct_(avg_(list))}` : ''));
  });
  const tested = new Set(rows.map(r => r.code));
  const idle = staff.filter(s => !tested.has(s.code));
  if (idle.length) {
    lines.push('', 'Не проходили тест 7 дней:');
    groupBy_(idle, s => s.branch).forEach((people, branch) => lines.push(`• ${branch}: ${people.map(p => p.name).join(', ')}`));
  } else {
    lines.push('', 'Все сотрудники проходили тест на этой неделе.');
  }
  send_(lines.join('\n'));
}

/* ---------- настройка Telegram (пункты меню) ---------- */

function setupTelegram() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Telegram-бот', 'Вставьте токен, который прислал @BotFather:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const token = r.getResponseText().trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    ui.alert('Это не похоже на токен бота. Скопируйте его из сообщения @BotFather целиком.');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TELEGRAM_TOKEN', token);
  try {
    const me = tg_('getMe');
    ui.alert(`Бот @${me.username} подключён.\n\nОткройте его в Telegram и нажмите «Start» ` +
      '(или добавьте бота в группу и напишите там любое сообщение). Затем выберите в меню Sensum пункт 2.');
  } catch (err) {
    props.deleteProperty('TELEGRAM_TOKEN');
    ui.alert('Telegram не принял токен: ' + err.message);
  }
}

function findChat() {
  const ui = SpreadsheetApp.getUi();
  let updates;
  try { updates = tg_('getUpdates', { limit: 100 }); } catch (err) { ui.alert(err.message); return; }
  const chats = updates.map(u => (u.message || u.my_chat_member || u.channel_post || {}).chat).filter(Boolean);
  if (!chats.length) {
    ui.alert('Бот пока не получил ни одного сообщения. Откройте бота в Telegram, нажмите «Start» и выберите этот пункт ещё раз.');
    return;
  }
  const chat = chats[chats.length - 1];
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(chat.id));
  const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.id;
  try {
    send_('✅ Уведомления Sensum Обучение подключены. Сюда будут приходить результаты тестов и сводки.');
    ui.alert(`Чат «${name}» подключён. В Telegram пришло проверочное сообщение.`);
  } catch (err) {
    ui.alert(`Чат «${name}» сохранён, но сообщение не отправилось: ${safeError_(err)}`);
  }
}

function installTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyDigest', 'weeklyReport'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  const dh = hour_('DigestHour', 21), wh = hour_('WeeklyHour', 10);
  ScriptApp.newTrigger('dailyDigest').timeBased().everyDays(1).atHour(dh).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(wh).inTimezone(TZ).create();
  SpreadsheetApp.getUi().alert(`Сводки включены. За день: каждый вечер около ${dh}:00. ` +
    `Итоги недели: по понедельникам около ${wh}:00. Время Баку.`);
}

function testNotify() {
  const ui = SpreadsheetApp.getUi();
  try {
    send_('🔔 Проверка: уведомления Sensum Обучение работают.');
    ui.alert('Проверочное сообщение отправлено в Telegram.');
  } catch (err) {
    ui.alert('Не получилось отправить: ' + safeError_(err));
  }
}

/* ---------- данные ---------- */

function findStaff_(code) {
  const c = String(code == null ? '' : code).trim();
  if (!/^\d{4,8}$/.test(c)) return null;
  return activeStaff_().filter(s => s.code === c)[0] || null;
}

function activeStaff_() {
  const sh = sheet_(SHEET_STAFF), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 5).getValues()
    .filter(r => String(r[0]).trim() && r[4] === true)
    .map(r => ({ code: String(r[0]).trim(), name: String(r[1]), branch: String(r[2]), role: String(r[3]) }));
}

function results_() {
  const sh = sheet_(SHEET_RESULTS), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 10).getValues()
    .filter(r => r[0] instanceof Date && Number(r[6]) > 0)
    .map(r => ({ date: r[0], code: String(r[1]), name: String(r[2]), branch: String(r[3]), scope: String(r[4]),
      score: Number(r[5]), total: Number(r[6]), ratio: Number(r[5]) / Number(r[6]), mistakes: String(r[9] || '') }));
}

function isDuplicate_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return false;
  const n = Math.min(500, last - 1);
  return sh.getRange(last - n + 1, RESULT_COLS, n, 1).getValues().some(r => String(r[0]) === id);
}

function topMistakes_(rows, n) {
  const count = {};
  rows.forEach(r => r.mistakes.split('\n').filter(Boolean).forEach(line => {
    const q = line.split(' → ')[0];
    count[q] = (count[q] || 0) + 1;
  }));
  return Object.keys(count).map(q => [q, count[q]]).filter(x => x[1] > 1)
    .sort((a, b) => b[1] - a[1]).slice(0, n);
}

/* ---------- Telegram ---------- */

function tg_(method, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('Telegram-бот не подключён: меню Sensum, пункт 1.');
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true
  });
  let out;
  try { out = JSON.parse(res.getContentText()); } catch (err) { out = {}; }
  if (!out.ok) throw new Error('Telegram: ' + (out.description || 'ответ ' + res.getResponseCode()));
  return out.result;
}

function send_(text) {
  const chat = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
  if (!chat) throw new Error('Чат для уведомлений не выбран: меню Sensum, пункт 2.');
  for (let i = 0; i < text.length; i += 4000) {
    tg_('sendMessage', { chat_id: chat, text: text.slice(i, i + 4000), disable_web_page_preview: true });
  }
}

/* an unsent notification must never lose the test result, which is already saved;
   the outcome is kept so it can be read through ?action=status */
function notify_(text) {
  const props = PropertiesService.getScriptProperties();
  const at = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm');
  try {
    send_(text);
    props.setProperty('LAST_NOTIFY_OK', at);
    props.deleteProperty('LAST_NOTIFY_ERROR');
  } catch (err) {
    props.setProperty('LAST_NOTIFY_ERROR', `${at}: ${safeError_(err)}`);
    console.warn('notify failed: ' + safeError_(err));
  }
}

/* error text without the bot token (network errors can quote the request URL) */
function safeError_(err) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  let msg = String(err && err.message || err);
  if (token) msg = msg.split(token).join('***');
  return msg.replace(/bot\d+:[\w-]+/g, 'bot***').slice(0, 300);
}

/* ---------- мелочи ---------- */

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error(`Нет листа «${name}»`);
  return sh;
}

function setting_(name, def) {
  const r = SpreadsheetApp.getActive().getRangeByName(name);
  const raw = r ? r.getValue() : '';
  const v = raw === '' || raw === null ? NaN : Number(raw);
  if (!isFinite(v)) return def;
  return name === 'PassThreshold' && v > 1 ? v / 100 : v; /* 70 typed instead of 70% */
}

/* a checkbox setting; a missing named range means "off" */
function flag_(name) {
  const r = SpreadsheetApp.getActive().getRangeByName(name);
  return !!r && r.getValue() === true;
}

function hour_(name, def) {
  const h = Math.round(setting_(name, def));
  return h >= 0 && h <= 23 ? h : def;
}

/* results queued offline keep the time they were taken, within the last week */
function takenAt_(ts) {
  const now = Date.now(), t = Number(ts);
  return isFinite(t) && t > now - 7 * 864e5 && t < now + 5 * 6e4 ? new Date(t) : new Date(now);
}

function text_(s, n) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
}

/* text that starts like a formula is stored as plain text */
function cell_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function pct_(x) { return Math.round(x * 100) + '%'; }
function avg_(rows) { return rows.reduce((s, r) => s + r.ratio, 0) / rows.length; }

function groupBy_(list, key) {
  const m = new Map();
  list.forEach(x => { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
  return m;
}

function plural_(n, one, few, many) {
  const t = Math.abs(n) % 100, o = n % 10;
  if (t > 10 && t < 20) return many;
  if (o > 1 && o < 5) return few;
  return o === 1 ? one : many;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
