/**
 * Sensum & Bakery · приём результатов тестов из справочника бариста.
 *
 * Справочник отправляет результат теста (POST). Скрипт проверяет код сотрудника
 * по листу «Сотрудники», дописывает строку в «Результаты» и пишет в Telegram:
 * о каждом тесте, если на листе «Настройки» отмечено «Уведомлять о каждом тесте»,
 * иначе только о тестах ниже порога. По расписанию отправляет сводку за день и
 * недельный отчёт. Токен Telegram-бота хранится в свойствах скрипта, не в таблице.
 *
 * С v4 справочник присылает и признаки честности теста: время прохождения,
 * сколько раз вышло время на ответ, сколько раз сотрудник выходил из приложения
 * и прерван ли тест. Прерванный тест не считается сданным.
 *
 * С v5 обучение — игра: опыт (XP) за тесты, совы 🦉 за хорошие результаты
 * (до 50 в месяц, журнал на листе «Совы», начисляет тренинг-менеджер в Sensum OS
 * по списку из недельного отчёта), «Экзамен месяца» (одна попытка в месяц,
 * итоги 1-го числа) и рейтинг недели в справочнике (?action=me).
 */

const SHEET_RESULTS = 'Результаты';
const SHEET_STAFF = 'Сотрудники';
const TZ = 'Asia/Baku';
const MAX_QUESTIONS = 50;
const SHEET_OWLS = 'Совы';
const RESULT_COLS = 18;  // A–R
const ID_COL = 13;        // M: attempt id, used to drop repeats
const CHECK_HEADERS = ['Время теста', 'Время вышло', 'Выходы из приложения', 'Прерван', 'Тип'];  // N–R
const KINDS = ['drinks', 'preps', 'exam', 'mix'];  // R: what the test was about; exam = «Экзамен месяца»
const OWLS_MONTH_CAP = 50;
const TEST_BRANCH = 'Тест';  // the trainer's own test account: no rating, no owls to credit
const SCRIPT_VERSION = 'v5.1';

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
  if (p.action === 'me') return json_(me_(p.code));
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
  /* honesty checks; blank when an older app version sends the result */
  const secs = count_(d.secs, 24 * 3600), timeouts = count_(d.timeouts, MAX_QUESTIONS), away = count_(d.away, 1000);
  const aborted = d.aborted === true;
  const kind = KINDS.indexOf(d.kind) >= 0 ? d.kind : '';

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEET_RESULTS);
    if (id && isDuplicate_(sh, id)) return json_({ ok: true, duplicate: true });
    if (kind === 'exam' && results_().some(r => r.code === staff.code && r.kind === 'exam' && monthKey_(r.date) === monthKey_(takenAt_(d.ts)))) {
      return json_({ ok: false, error: 'exam_done' });
    }
    ensureHeaders_(sh);
    const row = sh.getLastRow() + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
    sh.getRange(row, 2).setNumberFormat('@');
    sh.getRange(row, 12).setNumberFormat('@');  // app version «1.80» stays text, not the number 1.8
    sh.getRange(row, 14).setNumberFormat('@');  // «2:10» stays text, not a time of day
    sh.getRange(row, 1, 1, RESULT_COLS).setValues([[
      takenAt_(d.ts), staff.code, staff.name, staff.branch, cell_(scope), score, total,
      `=IF(G${row}=0,0,F${row}/G${row})`, `=IF(Q${row}="да","нет",IF(H${row}>=PassThreshold,"да","нет"))`,
      cell_(mistakes.join('\n')), text_(d.lang, 5), text_(d.ver, 12), cell_(id),
      secs === '' ? '' : mmss_(secs), timeouts, away, aborted ? 'да' : '', kind
    ]]);
  } finally {
    lock.releaseLock();
  }

  /* the game: XP of this test and owls it earned; a failure here never loses the saved result */
  let xp = 0, owls = [];
  try {
    const all = withXp_(results_()), mine = all.filter(r => r.code === staff.code);
    const self = mine.filter(r => id ? r.id === id : true).pop();  // a result sent late (offline) is not the newest row
    xp = self ? self.xp : 0;
    owls = awardOwls_(staff, self, mine);
  } catch (err) {
    console.warn('game: ' + err.message);
  }

  const passed = !aborted && score / total >= setting_('PassThreshold', 0.7);
  if (!passed || away || flag_('NotifyAll')) {
    const lines = [
      aborted ? `⛔ Тест прерван: ${pct_(score / total)}`
        : passed ? `✅ Тест сдан: ${pct_(score / total)}` : `⚠️ Тест не сдан: ${pct_(score / total)}`,
      `${staff.name} · ${staff.branch}`,
      `${scope}: ${score} из ${total}`
    ];
    const checks = [];
    if (secs !== '') checks.push(`⏱ ${mmss_(secs)}`);
    if (timeouts) checks.push(`время вышло: ${timeouts}`);
    if (away) checks.push(`📵 выходы из приложения: ${away}`);
    if (checks.length) lines.push(checks.join(' · '));
    if (owls.length) lines.push(`🦉 +${owls.reduce((s, o) => s + o.n, 0)}: ${owls.map(o => o.why).join(', ')}`);
    if (mistakes.length) lines.push('', 'Ошибки:', ...mistakes.slice(0, 10).map(m => `• ${m}`));
    if (mistakes.length > 10) lines.push(`…и ещё ${mistakes.length - 10}`);
    notify_(lines.join('\n'));
  }
  return json_({ ok: true, xp, owls });
}

/* ---------- сводки по расписанию ---------- */

function dailyDigest(e) {
  /* the last 24 hours, so tests taken after the evening digest show up in the next one */
  const now = new Date(), from = new Date(now.getTime() - 864e5);
  if (e && Utilities.formatDate(now, TZ, 'dd') === '01') monthlyReport_(now);
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
  const failed = rows.filter(r => r.ratio < thr || r.aborted);
  if (failed.length) {
    lines.push('', `Не сдали (ниже ${pct_(thr)} или прервали):`);
    failed.forEach(r => lines.push(`• ${r.name} (${r.branch}): ${r.scope}, ${r.score} из ${r.total}${r.aborted ? ', прерван' : ''}`));
  }
  const away = rows.filter(r => r.away > 0);
  if (away.length) {
    lines.push('', 'Выходили из приложения во время теста:');
    away.forEach(r => lines.push(`• ${r.name} (${r.branch}): ${r.away} ${plural_(r.away, 'раз', 'раза', 'раз')}`));
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
  const xpRows = withXp_(results_()).filter(r => r.date >= from && r.branch !== TEST_BRANCH);
  const top = [...groupBy_(xpRows, r => r.code).values()]
    .map(list => ({ name: list[0].name, branch: list[0].branch, xp: list.reduce((s, r) => s + r.xp, 0) }))
    .filter(p => p.xp > 0).sort((a, b) => b.xp - a.xp).slice(0, 5);
  if (top.length) {
    lines.push('', '🏆 Рейтинг недели:');
    top.forEach((p, i) => lines.push(`${i + 1}. ${p.name} (${p.branch}): ${p.xp} XP`));
  }
  const owed = owls_().filter(o => o.date >= from && o.branch !== TEST_BRANCH && !o.done);
  if (owed.length) {
    lines.push('', '🦉 Начислить в Sensum OS:');
    groupBy_(owed, o => o.code).forEach(list => lines.push(
      `• ${list[0].name} (${list[0].branch}): +${list.reduce((s, o) => s + o.n, 0)} — ${list.map(o => o.why).join(', ')}`));
    lines.push('После начисления отметьте строки галочкой на листе «Совы».');
  }
  send_(lines.join('\n'));
}

/* the 1st of the month: «Экзамен месяца» results for the KPI and the owls of the month that just ended */
function monthlyReport_(now) {
  const prev = monthKey_(new Date(now.getTime() - 2 * 864e5));
  const staff = activeStaff_().filter(s => s.branch !== TEST_BRANCH);
  const exams = results_().filter(r => r.kind === 'exam' && monthKey_(r.date) === prev);
  const lines = [`📝 Экзамен месяца, ${prev.slice(5)}.${prev.slice(0, 4)}: итоги для KPI`];
  groupBy_(staff, s => s.branch).forEach((people, branch) => {
    lines.push('', `${branch}:`);
    people.forEach(p => {
      const x = exams.filter(r => r.code === p.code)[0];
      lines.push(`• ${p.name}: ` + (!x ? 'не сдавал' : `${x.score} из ${x.total}, ${pct_(x.ratio)}${x.aborted ? ', прерван' : ''}`));
    });
  });
  const owls = owls_().filter(o => monthKey_(o.date) === prev && o.branch !== TEST_BRANCH);
  if (owls.length) {
    lines.push('', `🦉 Совы за месяц (максимум ${OWLS_MONTH_CAP}):`);
    groupBy_(owls, o => o.code).forEach(list => lines.push(`• ${list[0].name}: ${list.reduce((s, o) => s + o.n, 0)}`));
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
  return sh.getRange(2, 1, last - 1, RESULT_COLS).getValues()
    .filter(r => r[0] instanceof Date && Number(r[6]) > 0)
    .map(r => ({ date: r[0], code: String(r[1]), name: String(r[2]), branch: String(r[3]), scope: String(r[4]),
      score: Number(r[5]), total: Number(r[6]), ratio: Number(r[5]) / Number(r[6]), mistakes: String(r[9] || ''),
      id: String(r[12] || ''), away: Number(r[15]) || 0, aborted: r[16] === 'да', kind: String(r[17] || '') }));
}

function isDuplicate_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return false;
  const n = Math.min(500, last - 1);
  return sh.getRange(last - n + 1, ID_COL, n, 1).getValues().some(r => String(r[0]) === id);
}

/* the check columns arrived with v4, the type with v5: a sheet made earlier gets their headers on the first result */
function ensureHeaders_(sh) {
  if (String(sh.getRange(1, ID_COL + CHECK_HEADERS.length).getValue()).trim()) return;
  sh.getRange(1, ID_COL + 1, 1, CHECK_HEADERS.length).setValues([CHECK_HEADERS]);
  sh.getRange(1, ID_COL).copyFormatToRange(sh, ID_COL + 1, ID_COL + CHECK_HEADERS.length, 1, 1);
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

/* ---------- игра: опыт, совы, рейтинг ---------- */

/* XP per test: 10 per right answer (15 in the exam), +50 for a flawless test of 10+ questions,
   nothing for an aborted one; only the first 5 tests of a day count, so grinding doesn't win the board */
function withXp_(rows) {
  const perDay = {};
  return rows.slice().sort((a, b) => a.date - b.date).map(r => {
    const k = r.code + ' ' + dayKey_(r.date);
    perDay[k] = (perDay[k] || 0) + 1;
    const xp = r.aborted || perDay[k] > 5 ? 0
      : r.score * (r.kind === 'exam' ? 15 : 10) + (r.total >= 10 && r.score === r.total ? 50 : 0);
    return Object.assign({}, r, { xp });
  });
}

/* a test that counts for the study week: finished, 10+ questions, 70% or more */
function counts_(r) { return !r.aborted && r.total >= 10 && r.ratio >= 0.7; }

/* owls for the test just saved (`self`, one of `mine`), at most OWLS_MONTH_CAP a month; each rule once per its period */
function awardOwls_(staff, self, mine) {
  if (!self || self.aborted || self.total < 10) return [];
  const month = monthKey_(self.date), ledger = owls_().filter(o => o.code === staff.code);
  let left = OWLS_MONTH_CAP - ledger.filter(o => monthKey_(o.date) === month).reduce((s, o) => s + o.n, 0);
  const out = [];
  const give = (key, why, n) => {
    if (left <= 0 || n <= 0 || ledger.some(o => o.key === key)) return;
    n = Math.min(n, left); left -= n; out.push({ key, why, n });
  };
  if (self.kind === 'exam') {
    give('exam:' + month, `Экзамен месяца ${pct_(self.ratio)}`, self.ratio === 1 ? 15 : self.ratio >= 0.9 ? 10 : self.ratio >= 0.8 ? 5 : 0);
  } else if (!self.away && self.ratio >= 0.9) {
    give('day:' + dayKey_(self.date), 'Тест на 90%+', 1);
  }
  const week = weekKey_(self.date);
  if (counts_(self) && mine.filter(r => weekKey_(r.date) === week && counts_(r)).length >= 3) {
    give('week:' + week, 'Учебная неделя', 2);
  }
  if (out.length) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sh = owlsSheet_();
      let row = nextRow_(sh);
      out.forEach(o => {
        if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
        sh.getRange(row, 2).setNumberFormat('@');
        sh.getRange(row, 1, 1, 8).setValues([[self.date, staff.code, staff.name, staff.branch, o.why, o.n, false, o.key]]);
        sh.getRange(row, 7).insertCheckboxes();
        row++;
      });
    } finally {
      lock.releaseLock();
    }
  }
  return out.map(o => ({ why: o.why, n: o.n }));
}

/* the row under the last filled date: unticked checkboxes further down count as content for getLastRow() */
function nextRow_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 2;
  const a = sh.getRange(1, 1, last, 1).getValues();
  let n = last;
  while (n > 1 && String(a[n - 1][0]).trim() === '') n--;
  return n + 1;
}

function owlsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_OWLS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_OWLS);
    sh.getRange(1, 1, 1, 8).setValues([['Дата', 'Код', 'Сотрудник', 'Филиал', 'За что', 'Совы', 'Внесено в Sensum OS', 'Ключ']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function owls_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_OWLS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues()
    .filter(r => r[0] instanceof Date && Number(r[5]) > 0)
    .map(r => ({ date: r[0], code: String(r[1]), name: String(r[2]), branch: String(r[3]), why: String(r[4]),
      n: Number(r[5]), done: r[6] === true, key: String(r[7]) }));
}

/* study weeks in a row up to now; the current week counts once it has 3 tests, until then the streak runs to last week */
function streaks_(mine, now) {
  const weeks = new Set(mine.filter(counts_).map(r => weekKey_(r.date)));
  const back = k => new Date(Date.parse(k + 'T00:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);
  let k = weekKey_(now);
  if (!weeks.has(k)) k = back(k);
  let cur = 0;
  while (weeks.has(k)) { cur++; k = back(k); }
  let best = 0;
  weeks.forEach(w => {
    if (weeks.has(back(w))) return;  // start of a run
    let n = 0, x = w;
    while (weeks.has(x)) { n++; x = new Date(Date.parse(x + 'T00:00:00Z') + 7 * 864e5).toISOString().slice(0, 10); }
    best = Math.max(best, n);
  });
  return { cur, best };
}

function badges_(mine, best) {
  const done = mine.filter(r => !r.aborted);
  const good = kind => done.filter(r => r.kind === kind && r.ratio >= 0.9).length >= 10;
  return [
    done.length > 0 && 'first',
    done.some(r => r.total >= 10 && r.score === r.total) && 'perfect',
    good('drinks') && 'drinks',
    good('preps') && 'preps',
    best >= 4 && 'streak4',
    done.some(r => r.kind === 'exam' && r.score === r.total) && 'exam100'
  ].filter(Boolean);
}

/* everything the app shows in the game card: own progress plus this week's board */
function me_(code) {
  const s = findStaff_(code);
  if (!s) return { ok: false, error: 'unknown_code' };
  const now = new Date(), week = weekKey_(now), month = monthKey_(now);
  const all = withXp_(results_()), mine = all.filter(r => r.code === s.code);
  const ledger = owls_().filter(o => o.code === s.code);
  const st = streaks_(mine, now);
  const exam = mine.filter(r => r.kind === 'exam' && monthKey_(r.date) === month)[0];
  const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
  const thisWeek = all.filter(r => weekKey_(r.date) === week && r.branch !== TEST_BRANCH);
  const people = [...groupBy_(thisWeek, r => r.code).values()]
    .map(list => ({ code: list[0].code, name: list[0].name, branch: list[0].branch, xp: sum(list, r => r.xp) }))
    .filter(p => p.xp > 0).sort((a, b) => b.xp - a.xp);
  const branches = [...groupBy_(activeStaff_().filter(x => x.branch !== TEST_BRANCH), x => x.branch)]
    .map(([branch, list]) => {
      const xp = sum(thisWeek.filter(r => r.branch === branch), r => r.xp);
      return { branch, xp: Math.round(xp / list.length), staff: list.length };
    }).sort((a, b) => b.xp - a.xp);
  return {
    ok: true, name: s.name, branch: s.branch,
    xp: sum(mine, r => r.xp), weekXp: sum(mine.filter(r => weekKey_(r.date) === week), r => r.xp),
    weekTests: mine.filter(r => weekKey_(r.date) === week && counts_(r)).length,
    streak: st.cur, owlsMonth: sum(ledger.filter(o => monthKey_(o.date) === month), o => o.n),
    owlsTotal: sum(ledger, o => o.n), owlsCap: OWLS_MONTH_CAP, badges: badges_(mine, st.best),
    exam: exam ? { score: exam.score, total: exam.total, aborted: exam.aborted, month } : null,
    board: {
      people: people.slice(0, 10).map(p => ({ name: p.name, branch: p.branch, xp: p.xp, me: p.code === s.code })),
      rank: people.findIndex(p => p.code === s.code) + 1, branches
    }
  };
}

function dayKey_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function monthKey_(d) { return dayKey_(d).slice(0, 7); }
/* Monday of the week, Baku time */
function weekKey_(d) {
  const t = Date.parse(dayKey_(d) + 'T00:00:00Z'), dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 864e5).toISOString().slice(0, 10);
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
function mmss_(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
/* a whole number 0..max, or '' for anything else (missing, negative, text) */
function count_(v, max) { const n = Number(v); return v !== '' && v != null && Number.isInteger(n) && n >= 0 && n <= max ? n : ''; }
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
