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
 *
 * С v5.2 справочник присылает и тесты раздела «Теория» (тип «theory»): направление и тема
 * теста стоят в столбце «область», тип в столбце R.
 *
 * С v5.3 скрипт отдаёт уровень сотрудника (trainee / barista / senior) из столбца D листа
 * «Сотрудники»: справочник показывает вопросы «Теории» до этого уровня включительно.
 *
 * С v5.4 попыток в неделю (WEEK_LIMITS). Сверх лимита результат сохраняется, но без XP и сов;
 * ?action=me отдаёт использованное (week) и лимиты (limits).
 *
 * С v5.5 лимит 4 рецептурных теста (напитки, заготовки, витрина) и 2 по теории; тренировки из «Материалов»
 * в таблицу не приходят вовсе. Прогресс сотрудника (прочитанные уроки и ящики карточек) хранится на листе
 * «Прогресс»: приложение отправляет его действием progress, ?action=me отдаёт обратно (progress).
 *
 * С v5.8 ритм недели: 5 зачётных тестов (напитки, заготовки, витрина — по одному, теория — 2), не больше одного зачётного
 * теста в день (Баку); тест ниже 70% раздел не закрывает, но занимает день; полная неделя = 5 тестов от 70% + 2 урока
 * (даты уроков приходят в readAt). Совы: полная неделя, тест 90%+ (до 2 в неделю), «Вопрос дня» 7 дней подряд, все уроки категории.
 *
 * С v5.10 один общий тест вместо тестов по разделам: 10 вопросов (3 напитка, 2 заготовки, 2 витрина, 3 теория), вид mixed.
 * Зачётных тестов в неделю 3, а у стажёра (роль в столбце D листа «Сотрудники») 5; не больше одного в день. Тест от 70% (или
 * прерванный) закрывает один слот недели, завершённый ниже 70% слот не закрывает. Прежние виды (drinks, preps, vitrina, theory)
 * делят ту же квоту, поэтому старые приложения продолжают работать. Полная неделя = квота тестов + 2 урока.
 *
 * С v5.9 KPI обучения: процент выполнения плана за месяц (недели 60%, экзамен 20%, качество 10%, регулярность 10%) и
 * предложение «минус % KPI обучения» на листе «Списания KPI» (80% и выше без потерь, ниже — 1 к 1, не больше KPI_CAP).
 * Отпуск и больничный тренер вносит на лист «Отсутствия», льготу новичка даёт колонка «Начало работы» листа «Сотрудники».
 * Пока KPI_START пуст, всё считается «в тени»: показывается сотрудникам и тренеру, но ничего не предлагается к списанию.
 * Скрипт ничего не списывает сам: решение принимает тренер (колонка «Решение тренера»).
 *
 * С v5.6 «Вопрос дня»: 3 вопроса раз в день (тип daily). Они пишутся на свой лист «Вопрос дня», а не в «Результаты»,
 * поэтому не попадают в «Сводку», KPI, лимиты и мгновенные уведомления; XP (10 за верный, +20 за все верные) только
 * за первый за день, сов не дают; ?action=me отдаёт daily: {done, streak}. Каждый понедельник (и из меню) скрипт
 * пересобирает лист «Сложные вопросы»: на чём чаще всего ошибались за 7 дней.
 *
 * С v5.13 итоги недели уходят и в KPI-систему: в понедельник, сразу после отчёта в Telegram, скрипт отправляет на вебхук
 * (адрес и ключ в свойствах скрипта, меню Sensum, пункт 4) один JSON за прошедшую неделю пн–вс: по каждому сотруднику тесты,
 * уроки, полная неделя, «Вопрос дня», XP, совы и KPI месяца, плюс текст отчёта. Каждая отправка записывается на лист
 * «Отправки в KPI»; если KPI-система не ответила 2xx, тренер получает сообщение в Telegram, а вечерняя сводка повторяет
 * отправку, пока неделя не дойдёт. Формат описан в docs/KPI_WEBHOOK.md. Без адреса вебхука ничего не отправляется.
 *
 * С v5.14 и выполненный «План на сегодня»: когда сотрудник закрыл все пункты плана, приложение присылает отметку (действие
 * dayplan, один раз в день). Скрипт записывает её на лист «План дня», добавляет из таблицы тесты, «Вопрос дня» и уроки этого
 * дня и сразу отправляет на тот же вебхук (событие training.day). Не дошло — вечерняя сводка повторяет (последние 7 дней).
 * Приложение шлёт отметки, только когда ?action=me отвечает dayplan: true, поэтому старые версии скрипта их не получают.
 *
 * С v5.15 и каждый тест: сразу после записи результата на лист «Результаты» скрипт отправляет его на тот же вебхук
 * (событие training.test: баллы, сдан ли, засчитан ли в неделю, ошибки, время, XP). Попытка пишется на лист «Отправки в KPI»;
 * не дошло — вечерняя сводка досылает (последние 7 дней). «Вопрос дня» сюда не входит: он есть в событии training.day.
 */

const SHEET_RESULTS = 'Результаты';
const SHEET_STAFF = 'Сотрудники';
const TZ = 'Asia/Baku';
const MAX_QUESTIONS = 50;
const SHEET_OWLS = 'Совы';
const SHEET_PROGRESS = 'Прогресс';
const SHEET_DAILY = 'Вопрос дня';
const SHEET_HARD = 'Сложные вопросы';
const DAILY_MAX = 5;                         // questions in one «Вопрос дня» (the app sends 3)
const DAILY_XP = { right: 10, all: 20 };     // per right answer, and for all of them right; only the first one of a day
const HARD_TOP = 20;                         // rows of «Сложные вопросы»
const PROGRESS_MAX = { read: 300, box: 800 };  // ids of lessons and of cards kept per employee
const RESULT_COLS = 18;  // A–R
const ID_COL = 13;        // M: attempt id, used to drop repeats
const CHECK_HEADERS = ['Время теста', 'Время вышло', 'Выходы из приложения', 'Прерван', 'Тип'];  // N–R
const KINDS = ['drinks', 'preps', 'vitrina', 'exam', 'mix', 'theory', 'mixed'];  // R: what the test was about; exam = «Экзамен месяца», theory = вопросы раздела «Теория»
const OWLS_MONTH_CAP = 50;
// Уровень сотрудника: столбец D листа «Сотрудники». Приложение получает его кодом и показывает вопросы «Теории» до этого уровня включительно.
const LEVELS = { 'стажёр': 'trainee', 'стажер': 'trainee', 'бариста': 'barista', 'старший': 'senior' };
// Ритм недели (пн–вс, время Баку). Зачётный тест один общий (kind mixed; прежние виды по разделам считаются так же); в неделю
// TESTS_WEEK.trainee тестов, пока в столбце D листа «Сотрудники» стоит «стажёр», иначе TESTS_WEEK.other.
// Тест от 70% (или прерванный) закрывает один слот недели; завершённый тест ниже 70% слот не закрывает, но занимает день.
// Не больше DAY_LIMIT зачётных тестов в календарный день. «Экзамен месяца», «Повторить ошибки» (mix) и «Вопрос дня» не считаются.
// Тест сверх квоты недели или дня сохраняется, но без XP, сов и зачёта в неделю. Приложение читает квоту отсюда (?action=me).
const TESTS_WEEK = { trainee: 5, other: 3 };
const TEST_KINDS = ['mixed', 'drinks', 'preps', 'vitrina', 'theory'];
const DAY_LIMIT = 1;
const LESSONS_WEEK = 2;                      // lessons (counted by the app's check) that make a full week together with the tests
const LESSON_TOTALS = { cf: 17, sv: 12, sn: 3, br: 14 };   // lessons per category = id prefix; audit.py checks it against lessons.json
const CAT_OWLS = { cf: 3, sv: 2, sn: 1, br: 3 };           // once, for all the lessons of a category
const CAT_NAMES = { cf: 'Кофе', sv: 'Сервис и продажи', sn: 'Санитария', br: 'Бренд' };
const PLAN_OWLS = 3, GOOD_OWLS_WEEK = 2, DAILY7_OWLS = 1, DAILY_STREAK_OWL = 7;
// KPI обучения. Процент выполнения плана за календарный месяц (Баку) и «минус KPI» за невыполнение; решает тренер.
const SHEET_ABSENCE = 'Отсутствия';          // code, from, to, reason, comment: leave and sick days, ends included
const SHEET_KPI = 'Списания KPI';            // one row per person and month
const KPI_START = '';                        // 'YYYY-MM-DD' of the real start; empty = every month is a trial (shown, nothing proposed)
const KPI_SHADOW_MONTHS = 1;                 // full months after KPI_START that stay a trial
const KPI_THRESHOLD = 80;                    // % of the plan from which nothing is lost
const KPI_CAP = 30;                          // the most lost in a month, % of the part of the KPI that is for training
const KPI_GRACE_DAYS = 14;                   // a newcomer's days without deductions, counted from «Начало работы»
const KPI_WEIGHTS = { weeks: 0.6, exam: 0.2, quality: 0.1, regularity: 0.1 };
const KPI_IDLE_RUN = 7;                      // days in a row with no activity that count against regularity
const KPI_HEADERS = ['Месяц', 'Код', 'Сотрудник', 'Филиал', '% выполнения', 'Недели %', 'Экзамен %', 'Качество %', 'Регулярность %',
  'Отсутствовал дней', 'Минус % KPI', 'Статус', 'Решение тренера', 'Комментарий', 'Внесено в Sensum OS', 'Ключ'];
const PASS_RATIO = 0.7;                      // a test of this share closes its section (the pass threshold of the sheet is for notices only)
const TEST_BRANCH = 'Тест';  // the trainer's own test account: no rating, no owls to credit
// Вебхук KPI-системы (v5.13): адрес и ключ лежат в свойствах скрипта KPI_WEBHOOK_URL / KPI_WEBHOOK_SECRET, не в коде (репозиторий публичный).
const SHEET_KPI_LOG = 'Отправки в KPI';
const KPI_LOG_HEADERS = ['Дата и время', 'Неделя', 'Событие', 'Сотрудников', 'Ответ', 'Статус', 'Комментарий', 'Ключ'];
const KPI_HOOK = { event: 'training.week', version: 1, source: 'sensum-learn' };
const KPI_ID_HEADER = 'ID в KPI-системе';
// «План на сегодня» выполнен (v5.14): одна строка на сотрудника и день, отправляется на тот же вебхук событием training.day
const SHEET_DAYPLAN = 'План дня';
const DAYPLAN_HEADERS = ['День', 'Код', 'Сотрудник', 'Филиал', 'План', 'Сделано', 'Уроки', 'Получено', 'KPI-система', 'Ответ', 'Ключ'];
const DAYPLAN_STEPS = ['daily', 'study', 'test'];  // «Вопрос дня», урок или карточки, тест (так же называются в приложении)
const DAYPLAN_DAYS = 7;                            // how old a day may be when it arrives, and how far back the evening retries
const KPI_DAY = { event: 'training.day', version: 1 };
const KPI_TEST = { event: 'training.test', version: 1 };  // one test of the sheet «Результаты», sent right after it is saved (v5.15)  // optional column G of «Сотрудники»: the employee's id in the KPI system, sent as kpiId
const SCRIPT_VERSION = 'v5.15';

/* ---------- меню в таблице ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Sensum')
    .addItem('1. Подключить Telegram-бота', 'setupTelegram')
    .addItem('2. Найти чат для уведомлений', 'findChat')
    .addItem('3. Включить сводки', 'installTriggers')
    .addSeparator()
    .addItem('Отправить тестовое уведомление', 'testNotify')
    .addItem('Отправить сводку за сутки сейчас', 'dailyDigest')
    .addItem('Обновить «Сложные вопросы»', 'hardQuestions')
    .addItem('KPI обучения: подготовить листы и пересчитать прошлый месяц', 'kpiMonths')
    .addSeparator()
    .addItem('4. Подключить вебхук KPI-системы', 'setupKpiWebhook')
    .addItem('Отправить итоги прошлой недели в KPI-систему сейчас', 'sendKpiWeek')
    .addToUi();
}

/* ---------- веб-приложение: справочник обращается сюда ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'whoami') {
    const s = findStaff_(p.code);
    return json_(s ? { ok: true, name: s.name, branch: s.branch, level: levelOf_(s.role) } : { ok: false, error: 'unknown_code' });
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
    lastNotifyOk: props.getProperty('LAST_NOTIFY_OK') || '', lastNotifyError: props.getProperty('LAST_NOTIFY_ERROR') || '',
    kpiWebhook: !!props.getProperty('KPI_WEBHOOK_URL'),  // never the address or the key: this answer is public
    lastKpiOk: props.getProperty('LAST_KPI_OK') || '', lastKpiError: props.getProperty('LAST_KPI_ERROR') || ''
  };
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  const staff = findStaff_(d.code);
  if (!staff) return json_({ ok: false, error: 'unknown_code' });
  if (d.action === 'dayplan') return json_(saveDayPlan_(staff, d));
  if (d.action === 'progress') {
    const r = saveProgress_(staff, d);
    if (r.ok && r.lessonsAdded) {
      try { r.owls = underLock_(() => awardProgressOwls_(staff)); } catch (err) { console.warn('progress owls: ' + err.message); }
    }
    delete r.lessonsAdded;
    return json_(r);
  }
  if (d.kind === 'daily') return json_(saveDaily_(staff, d));
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

  let duplicate = false;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEET_RESULTS);
    duplicate = !!(id && isDuplicate_(sh, id));
    if (!duplicate && kind === 'exam' && results_().some(r => r.code === staff.code && r.kind === 'exam' && monthKey_(r.date) === monthKey_(takenAt_(d.ts)))) {
      return json_({ ok: false, error: 'exam_done' });
    }
    if (!duplicate) {
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
    }
  } finally {
    lock.releaseLock();
  }

  /* the game: XP of this test and owls it earned; a failure here never loses the saved result */
  let xp = 0, owls = [], over = false, rewardPending = false;
  // Read eligibility, dedupe keys and month cap under the same lock as the award writes.
  const gameLock = LockService.getScriptLock();
  let gameLocked = false;
  try {
    gameLock.waitLock(20000); gameLocked = true;
    const all = withXp_(results_()), mine = all.filter(r => r.code === staff.code);
    const self = mine.filter(r => id ? r.id === id : true).pop();  // a result sent late (offline) is not the newest row
    xp = self ? self.xp : 0;
    over = !!(self && self.over);
    owls = awardOwls_(staff, self, mine);
  } catch (err) {
    rewardPending = true;
    console.warn('game: ' + err.message);
  } finally {
    if (gameLocked) gameLock.releaseLock();
  }

  const passed = !aborted && score / total >= setting_('PassThreshold', 0.7);
  if (!duplicate && (!passed || away || flag_('NotifyAll'))) {
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
    if (over) lines.push('⚠️ Сверх лимита (квота тестов недели закрыта или это второй тест за день): XP и совы не начислены');
    if (mistakes.length) lines.push('', 'Ошибки:', ...mistakes.slice(0, 10).map(m => `• ${m}`));
    if (mistakes.length > 10) lines.push(`…и ещё ${mistakes.length - 10}`);
    notify_(lines.join('\n'));
  }
  /* v5.15: the result goes to the KPI system right away; a failure never touches the answer to the phone (the evening retries) */
  if (!duplicate && id) { try { kpiTestAuto_(id); } catch (err) { console.warn('kpi test: ' + safeError_(err)); } }
  // Keep the attempt in the phone's outbox until reward processing has completed.
  if (rewardPending) return json_({ ok: false, error: 'reward_pending', saved: true });
  return json_(Object.assign({ ok: true, xp, owls, over }, duplicate ? { duplicate: true } : {}));
}

/* ---------- сводки по расписанию ---------- */

function dailyDigest(e) {
  /* the last 24 hours, so tests taken after the evening digest show up in the next one */
  const now = new Date(), from = new Date(now.getTime() - 864e5);
  if (e) { try { kpiWeekRetry_(now); } catch (err) { console.warn('kpi retry: ' + safeError_(err)); } }  // never blocks the digest
  if (e) { try { kpiDayRetry_(now); } catch (err) { console.warn('kpi day retry: ' + safeError_(err)); } }
  if (e) { try { kpiTestRetry_(now); } catch (err) { console.warn('kpi test retry: ' + safeError_(err)); } }
  if (e && Utilities.formatDate(now, TZ, 'dd') === '01') {
    monthlyReport_(now);
    try { kpiMonthly_(now); } catch (err) { console.warn('kpi: ' + err.message); }  // never blocks the digest
  }
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

/* Monday: the report to Telegram, then the same week to the KPI system's webhook (if one is set). One failing never stops the other;
   a Telegram failure is still thrown at the end, as before, so the trigger shows it. */
function weeklyReport() {
  const now = new Date(), text = weeklyText_(now);
  let tgErr = null;
  try { send_(text); } catch (err) { tgErr = err; }
  try { kpiWeekAuto_(now, text); } catch (err) { console.warn('kpi webhook: ' + safeError_(err)); }
  if (tgErr) throw tgErr;
}

/* the text of the Monday report: the last 7 days, and the full weeks of the calendar week that ended */
function weeklyText_(now) {
  const from = new Date(now.getTime() - 7 * 864e5);
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
  const daily = dailies_(), dWeek = daily.filter(r => r.date >= from && r.branch !== TEST_BRANCH);
  if (dWeek.length) {
    lines.push('', `📅 Вопрос дня: ${dWeek.length} ${plural_(dWeek.length, 'ответ', 'ответа', 'ответов')}, ` +
      `сотрудников: ${new Set(dWeek.map(r => r.code)).size}`);
  }
  const lastWeek = weekKey_(new Date(now.getTime() - 864e5)), allAt = readAtMap_(), allTests = withXp_(results_());
  const real = staff.filter(s => s.branch !== TEST_BRANCH);
  const fullN = real.filter(s => weekPlan_(allTests.filter(r => r.code === s.code), allAt[s.code] || {}, lastWeek, quotaOf_(s.role)).full).length;
  if (real.length) lines.push('', `🏅 Полная неделя (тесты и ${LESSONS_WEEK} урока): ${fullN} из ${real.length}`);
  try {
    const risk = kpiRisk_(now);
    if (risk.length) {
      lines.push('', `⚠️ Риск минуса KPI обучения в этом месяце (по прошедшим неделям${risk.shadow ? ', пробный месяц: ничего не списывается' : ''}):`);
      risk.forEach(x => lines.push(`• ${x.name} (${x.branch}): ${x.pct}% → −${x.loss}%`));
    }
  } catch (err) { console.warn('kpi risk: ' + err.message); }
  const hard = rebuildHard_(now).filter(h => h.n > 1).slice(0, 5);
  if (hard.length) {
    lines.push('', '❓ Сложные вопросы недели (лист «Сложные вопросы»):');
    hard.forEach(h => lines.push(`• ${h.q} — ошибок: ${h.n}, сотрудников: ${h.people}`));
  }
  const xpRows = withXp_(results_()).concat(dailyXp_(daily)).filter(r => r.date >= from && r.branch !== TEST_BRANCH);
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
  return lines.join('\n');
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

function levelOf_(role) {
  return LEVELS[String(role == null ? '' : role).trim().toLowerCase()] || '';
}

function activeStaff_() {
  const sh = sheet_(SHEET_STAFF), last = sh.getLastRow();
  if (last < 2) return [];
  const cols = Math.min(7, sh.getMaxColumns ? sh.getMaxColumns() : 5);  // F «Начало работы» and G «ID в KPI-системе» are optional
  return sh.getRange(2, 1, last - 1, cols).getValues()
    .filter(r => String(r[0]).trim() && r[4] === true)
    .map(r => ({ code: String(r[0]).trim(), name: String(r[1]), branch: String(r[2]), role: String(r[3]), start: cols > 5 ? dayStr_(r[5]) : '',
      kpiId: cols > 6 ? String(r[6] == null ? '' : r[6]).trim() : '' }));
}

function results_() {
  const sh = sheet_(SHEET_RESULTS), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, RESULT_COLS).getValues()
    .filter(r => r[0] instanceof Date && Number(r[6]) > 0)
    .map(r => ({ date: r[0], code: String(r[1]), name: String(r[2]), branch: String(r[3]), scope: String(r[4]),
      score: Number(r[5]), total: Number(r[6]), ratio: Number(r[5]) / Number(r[6]), mistakes: String(r[9] || ''),
      id: String(r[12] || ''), away: Number(r[15]) || 0, aborted: r[16] === 'да', kind: String(r[17] || ''),
      lang: String(r[10] || ''), ver: String(r[11] || ''), time: String(r[13] || ''), timeouts: Number(r[14]) || 0 }));
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
function limitGroup_(kind) { return TEST_KINDS.indexOf(kind) >= 0 ? 'test' : ''; }

/* tests a week: a trainee (column D of «Сотрудники») takes more, everyone else the usual number */
function quotaOf_(role) { return levelOf_(role) === 'trainee' ? TESTS_WEEK.trainee : TESTS_WEEK.other; }

/* {code: tests a week} of everyone on «Сотрудники» (an unknown code has the usual quota) */
function quotaMap_() {
  const sh = sheet_(SHEET_STAFF), last = sh.getLastRow(), out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 4).getValues().forEach(r => { const c = String(r[0]).trim(); if (c) out[c] = quotaOf_(r[3]); });
  return out;
}

/* Walks the tests of everyone oldest first. A test of the counted group is `over` when the week's quota of this person is already
   used up or it is not the first one of its day; a test that is not over uses a slot of the week when it is aborted or reaches
   PASS_RATIO (`burns`), otherwise it is `tried`: finished below the line, no slot is used, the person can take another one on another day. */
function withXp_(rows) {
  const quota = quotaMap_(), perDay = {}, closed = {}, slot = {};
  return rows.slice().sort((a, b) => a.date - b.date).map(r => {
    const k = r.code + ' ' + dayKey_(r.date);
    perDay[k] = (perDay[k] || 0) + 1;
    const g = limitGroup_(r.kind);
    let over = false, burns = false, tried = false;
    if (g) {
      const wk = r.code + ' ' + weekKey_(r.date);
      slot[k] = (slot[k] || 0) + 1;
      over = (closed[wk] || 0) >= (quota[r.code] || TESTS_WEEK.other) || slot[k] > DAY_LIMIT;
      burns = !over && (r.aborted || r.ratio >= PASS_RATIO);
      tried = !over && !burns;
      if (burns) closed[wk] = (closed[wk] || 0) + 1;
    }
    const xp = r.aborted || over || perDay[k] > 5 ? 0
      : r.score * (r.kind === 'exam' ? 15 : 10) + (r.total >= 10 && r.score === r.total ? 50 : 0);
    return Object.assign({}, r, { xp, over, group: g, burns, tried });
  });
}

/* a test that counts for the week: finished, 10+ questions, 70% or more, not over */
function counts_(r) { return !r.aborted && !r.over && r.total >= 10 && r.ratio >= PASS_RATIO; }

function underLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* Writes the owls of the candidates `build(ledger)` returns ([{key, why, n}]), each key once ever, within OWLS_MONTH_CAP a month.
   Call under the script lock. Returns the owls of this attempt, new ones and those an earlier try of it already wrote
   (a lost response or a partial write is retried without crediting twice). */
function grantOwls_(staff, date, attemptId, build) {
  const month = monthKey_(date), ledger = owls_().filter(o => o.code === staff.code);
  let left = OWLS_MONTH_CAP - ledger.filter(o => monthKey_(o.date) === month).reduce((s, o) => s + o.n, 0);
  const out = [];
  build(ledger).forEach(c => {
    if (left <= 0 || !(c.n > 0) || ledger.some(o => o.key === c.key)) return;
    const n = Math.min(c.n, left); left -= n; out.push({ key: c.key, why: c.why, n });
  });
  if (out.length) {
    const sh = owlsSheet_();
    let row = nextRow_(sh);
    out.forEach(o => {
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
      sh.getRange(row, 2).setNumberFormat('@');
      sh.getRange(row, 9).setNumberFormat('@');
      sh.getRange(row, 1, 1, 9).setValues([[date, staff.code, staff.name, staff.branch, o.why, o.n, false, o.key, attemptId || '']]);
      sh.getRange(row, 7).insertCheckboxes();
      row++;
    });
  }
  return ledger.filter(o => attemptId && o.attemptId === attemptId).concat(out).map(o => ({ why: o.why, n: o.n }));
}

/* the owl of a full week, once a week: asked after every test and after a lesson is counted, because either can be the last step */
function planCandidate_(staff, week, mineTests) {
  return weekPlan_(mineTests, readAtOf_(staff.code), week, quotaOf_(staff.role)).full ? [{ key: 'plan:' + week, why: 'Полная учебная неделя', n: PLAN_OWLS }] : [];
}

/* owls for the test just saved (`self`, one of `mine`): a test of 90%+ (two a week at most), a full week, the exam */
function awardOwls_(staff, self, mine) {
  if (!self || self.aborted || self.over || self.total < 10) return [];
  const month = monthKey_(self.date), week = weekKey_(self.date);
  return grantOwls_(staff, self.date, self.id, ledger => {
    const c = [];
    if (self.kind === 'exam') {
      c.push({ key: 'exam:' + month, why: `Экзамен месяца ${pct_(self.ratio)}`, n: self.ratio === 1 ? 15 : self.ratio >= 0.9 ? 10 : self.ratio >= 0.8 ? 5 : 0 });
    } else if (self.group && !self.away && self.ratio >= 0.9 && ledger.filter(o => o.key.indexOf('good:' + week + ':') === 0).length < GOOD_OWLS_WEEK) {
      c.push({ key: 'good:' + week + ':' + dayKey_(self.date), why: 'Тест на 90%+', n: 1 });
    }
    return c.concat(planCandidate_(staff, week, mine));
  });
}

/* after a lesson is counted: a full week, or every lesson of a category */
function awardProgressOwls_(staff) {
  const now = new Date(), week = weekKey_(now), mine = withXp_(results_().filter(r => r.code === staff.code));
  const read = progressOf_(staff.code).read;
  return grantOwls_(staff, now, '', () => {
    const c = planCandidate_(staff, week, mine);
    Object.keys(LESSON_TOTALS).forEach(cat => {
      if (read.filter(id => id.indexOf(cat + '-') === 0).length >= LESSON_TOTALS[cat]) {
        c.push({ key: 'cat:' + cat.toUpperCase(), why: `Все уроки: ${CAT_NAMES[cat]}`, n: CAT_OWLS[cat] });
      }
    });
    return c;
  });
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
    sh.getRange(1, 1, 1, 9).setValues([['Дата', 'Код', 'Сотрудник', 'Филиал', 'За что', 'Совы', 'Внесено в Sensum OS', 'Ключ', 'ID попытки']]);
    sh.setFrozenRows(1);
  } else {
    sh.getRange(1, 9).setValues([['ID попытки']]);
  }
  return sh;
}

function owls_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_OWLS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues()
    .filter(r => r[0] instanceof Date && Number(r[5]) > 0)
    .map(r => ({ date: r[0], code: String(r[1]), name: String(r[2]), branch: String(r[3]), why: String(r[4]),
      n: Number(r[5]), done: r[6] === true, key: String(r[7]), attemptId: String(r[8] || '') }));
}

/* full weeks (5 tests and 2 lessons) in a row up to now; the current week counts once it is full, until then the streak runs to last week */
function streaks_(weeks, now) {
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

function badges_(mine, best, dayBest) {
  const done = mine.filter(r => !r.aborted);
  const goodN = done.filter(r => r.group && !r.over && r.ratio >= 0.9).length;
  return [
    done.length > 0 && 'first',
    done.some(r => r.total >= 10 && r.score === r.total) && 'perfect',
    goodN >= 10 && 'tests10',
    goodN >= 30 && 'tests30',
    best >= 4 && 'streak4',
    done.some(r => r.kind === 'exam' && r.score === r.total) && 'exam100',
    dayBest >= 7 && 'days7'
  ].filter(Boolean);
}

/* everything the app shows in the game card: own progress plus this week's board */
function me_(code) {
  const s = findStaff_(code);
  if (!s) return { ok: false, error: 'unknown_code' };
  const now = new Date(), week = weekKey_(now), month = monthKey_(now);
  const tests = withXp_(results_()), daily = dailyXp_(dailies_());
  const all = tests.concat(daily), mine = all.filter(r => r.code === s.code), myTests = tests.filter(r => r.code === s.code);
  const myDaily = daily.filter(r => r.code === s.code), ds = dayStreak_(myDaily, now);
  const ledger = owls_().filter(o => o.code === s.code);
  const prog = progressOf_(s.code), readAt = prog.readAt || {};
  const quota = quotaOf_(s.role), st = streaks_(fullWeeks_(myTests, readAt, quota), now);
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
    ok: true, name: s.name, branch: s.branch, level: levelOf_(s.role),
    xp: sum(mine, r => r.xp), weekXp: sum(mine.filter(r => weekKey_(r.date) === week), r => r.xp),
    weekTests: mine.filter(r => weekKey_(r.date) === week && counts_(r)).length,
    streak: st.cur, owlsMonth: sum(ledger.filter(o => monthKey_(o.date) === month), o => o.n),
    owlsTotal: sum(ledger, o => o.n), owlsCap: OWLS_MONTH_CAP, badges: badges_(myTests, st.best, ds.best),
    daily: { done: myDaily.some(r => dayKey_(r.date) === dayKey_(now)), streak: ds.cur },
    exam: exam ? { score: exam.score, total: exam.total, aborted: exam.aborted, month } : null,
    week: weekAttempts_(myTests, week), limits: { test: quota }, perDay: DAY_LIMIT, todayUsed: todayUsed_(myTests, now),
    plan: weekPlan_(myTests, readAt, week, quota), kpi: kpiPublic_(kpiMonth_(s, month, { tests, dailies: daily, readAt: { [s.code]: readAt }, absence: absenceMap_() }, now)),
    passThreshold: setting_('PassThreshold', 0.7),
    progressProtocol: 2, progress: prog,
    dayplan: true,  // v5.14: the app may send «План на сегодня выполнен» (action dayplan); older scripts never say it, so they never get one
    board: {
      people: people.slice(0, 10).map(p => ({ name: p.name, branch: p.branch, xp: p.xp, me: p.code === s.code })),
      rank: people.findIndex(p => p.code === s.code) + 1, branches
    }
  };
}

/* ---------- «Вопрос дня» ---------- */

function dailySheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_DAILY);
  if (!sh) {
    sh = ss.insertSheet(SHEET_DAILY);
    sh.getRange(1, 1, 1, 9).setValues([['Дата', 'Код', 'Сотрудник', 'Филиал', 'Верных', 'Вопросов', 'Ошибки', 'ID', 'Прерван']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function dailies_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DAILY);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues()
    .filter(r => r[0] instanceof Date && Number(r[5]) > 0)
    .map(r => ({ date: r[0], code: String(r[1]), name: String(r[2]), branch: String(r[3]), scope: SHEET_DAILY,
      score: Number(r[4]), total: Number(r[5]), ratio: Number(r[4]) / Number(r[5]), mistakes: String(r[6] || ''),
      id: String(r[7] || ''), away: 0, aborted: r[8] === 'да', kind: 'daily' }));
}

/* XP only for the first «Вопрос дня» of a person's day, and none for an aborted one */
function dailyXp_(rows) {
  const seen = {};
  return rows.slice().sort((a, b) => a.date - b.date).map(r => {
    const k = r.code + ' ' + dayKey_(r.date), first = !seen[k];
    seen[k] = true;
    const xp = !first || r.aborted ? 0 : r.score * DAILY_XP.right + (r.total >= 3 && r.score === r.total ? DAILY_XP.all : 0);
    return Object.assign({}, r, { xp, over: false });
  });
}

/* days in a row with a «Вопрос дня» up to today (today counts once it is done, until then the run ends yesterday), and the best run */
function dayStreak_(mine, now) {
  const days = new Set(mine.filter(r => !r.aborted).map(r => dayKey_(r.date)));
  const step = (k, n) => new Date(Date.parse(k + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  let k = dayKey_(now);
  if (!days.has(k)) k = step(k, -1);
  let cur = 0;
  while (days.has(k)) { cur++; k = step(k, -1); }
  let best = 0;
  days.forEach(d => {
    if (days.has(step(d, -1))) return;
    let n = 0, x = d;
    while (days.has(x)) { n++; x = step(x, 1); }
    best = Math.max(best, n);
  });
  return { cur, best };
}

function saveDaily_(staff, d) {
  const score = Number(d.score), total = Number(d.total);
  if (!(Number.isInteger(score) && Number.isInteger(total) && total > 0 && total <= DAILY_MAX && score >= 0 && score <= total)) {
    return { ok: false, error: 'bad_score' };
  }
  const id = text_(d.id, 64), when = takenAt_(d.ts);
  const mistakes = (Array.isArray(d.mistakes) ? d.mistakes : []).slice(0, DAILY_MAX)
    .map(m => `${text_(m && m.q, 200)} → ${text_(m && m.a, 100)} (верно: ${text_(m && m.c, 100)})`);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = dailySheet_();
    if (id && dailies_().some(r => r.id === id)) return { ok: true, duplicate: true };
    const row = Math.max(2, sh.getLastRow() + 1);
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
    sh.getRange(row, 2).setNumberFormat('@');
    sh.getRange(row, 1, 1, 9).setValues([[when, staff.code, staff.name, staff.branch, score, total,
      cell_(mistakes.join('\n')), cell_(id), d.aborted === true ? 'да' : '']]);
  } finally {
    lock.releaseLock();
  }
  const mine = dailyXp_(dailies_().filter(r => r.code === staff.code));
  const self = mine.filter(r => id ? r.id === id : true).pop();
  const ds = dayStreak_(mine, new Date());
  let owls = [];
  if (self && !self.aborted && ds.cur > 0 && ds.cur % DAILY_STREAK_OWL === 0) {
    try {
      owls = underLock_(() => grantOwls_(staff, when, id, () => [{ key: 'daily7:' + dayKey_(when), why: `«Вопрос дня» ${ds.cur} дней подряд`, n: DAILY7_OWLS }]));
    } catch (err) { console.warn('daily owl: ' + err.message); }
  }
  return { ok: true, xp: self ? self.xp : 0, owls, daily: { done: true, streak: ds.cur } };
}

/* ---------- «Сложные вопросы»: на чём ошибались за 7 дней ---------- */

/* mistakes of the tests and of «Вопрос дня» in the 7 days before `now`, by question text (RU and AZ count apart) */
function hardList_(now) {
  const from = new Date(now.getTime() - 7 * 864e5);
  const rows = results_().concat(dailies_()).filter(r => r.date >= from && r.date <= now && r.branch !== TEST_BRANCH);
  const m = new Map();
  rows.forEach(r => r.mistakes.split('\n').filter(Boolean).forEach(line => {
    const i = line.indexOf(' → '), q = i > 0 ? line.slice(0, i) : line;
    const c = (line.match(/\(верно: (.*)\)$/) || [])[1] || '';
    if (!m.has(q)) m.set(q, { q, n: 0, codes: new Set(), branches: new Set(), scopes: new Set(), c });
    const h = m.get(q);
    h.n++; h.codes.add(r.code); h.branches.add(r.branch); h.scopes.add(r.scope.split(' · ')[0]);
  }));
  return [...m.values()].map(h => ({ q: h.q, n: h.n, people: h.codes.size, branches: [...h.branches].join(', '),
    scope: [...h.scopes].join(', '), c: h.c }))
    .sort((a, b) => b.n - a.n || b.people - a.people).slice(0, HARD_TOP);
}

function rebuildHard_(now) {
  const list = hardList_(now);
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_HARD) || ss.insertSheet(SHEET_HARD);
  const last = sh.getLastRow();
  if (last > 0) sh.getRange(1, 1, last, 6).clearContent();
  sh.getRange(1, 1, 1, 6).setValues([[`Вопрос (7 дней до ${Utilities.formatDate(now, TZ, 'dd.MM.yyyy')})`, 'Ошибок', 'Сотрудников', 'Филиалы', 'Раздел', 'Верный ответ']]);
  sh.setFrozenRows(1);
  if (list.length) sh.getRange(2, 1, list.length, 6).setValues(list.map(h => [cell_(h.q), h.n, h.people, h.branches, cell_(h.scope), cell_(h.c)]));
  return list;
}

/* menu item: rebuild the sheet now */
function hardQuestions() {
  const n = rebuildHard_(new Date()).length;
  SpreadsheetApp.getUi().alert(n ? `Лист «${SHEET_HARD}» обновлён: ${n} ${plural_(n, 'вопрос', 'вопроса', 'вопросов')}.` : 'За 7 дней ошибок не было.');
}

/* ---------- KPI обучения: процент выполнения плана за месяц и «минус KPI» ---------- */

function addDays_(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }

/* a date cell (a Date) or text «YYYY-MM-DD» / «DD.MM.YYYY» → 'YYYY-MM-DD', '' when it is none of them */
function dayStr_(v) {
  if (v instanceof Date) return dayKey_(v);
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}

function monthDays_(mk) {
  const out = [];
  for (let d = mk + '-01'; d.slice(0, 7) === mk; d = addDays_(d, 1)) out.push(d);
  return out;
}

/* the weeks (Mondays) that belong to a month: those whose Sunday falls in it, so a week is over when its month is */
function weeksOfMonth_(mk) {
  return monthDays_(mk).filter(d => new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay() === 0).map(d => addDays_(d, -6));
}

function absenceSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_ABSENCE);
  if (!sh) {
    sh = ss.insertSheet(SHEET_ABSENCE);
    sh.getRange(1, 1, 1, 5).setValues([['Код', 'С', 'По', 'Причина (отпуск / больничный / другое)', 'Комментарий']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* {code: Set of days} the trainer marked as leave or sick days; both ends included */
function absenceMap_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ABSENCE), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
    const code = String(r[0]).trim(), a = dayStr_(r[1]), b = dayStr_(r[2]) || a;
    if (!code || !a || b < a) return;
    const set = out[code] || (out[code] = new Set());
    for (let d = a, i = 0; d <= b && i < 366; d = addDays_(d, 1), i++) set.add(d);
  });
  return out;
}

function kpiCtx_() {
  return { tests: withXp_(results_()), dailies: dailies_(), readAt: readAtMap_(), absence: absenceMap_() };
}

/* 'trial' (shown, nothing proposed) or 'live' (a loss is proposed): live from KPI_SHADOW_MONTHS full months after the first full month at or after KPI_START */
function kpiState_(mk) {
  if (!KPI_START) return 'trial';
  const s = dayStr_(KPI_START), first = s.slice(8) === '01' ? s.slice(0, 7) : addDays_(s.slice(0, 7) + '-28', 4).slice(0, 7);
  const idx = k => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7));
  return idx(mk) >= idx(first) + KPI_SHADOW_MONTHS ? 'live' : 'trial';
}

function kpiLoss_(pct) { return pct == null ? 0 : Math.min(KPI_CAP, Math.max(0, Math.floor(KPI_THRESHOLD - pct + 1e-9))); }

function kpiPct_(parts) {
  let w = 0, s = 0;
  Object.keys(KPI_WEIGHTS).forEach(k => { if (parts[k] != null) { w += KPI_WEIGHTS[k]; s += KPI_WEIGHTS[k] * parts[k]; } });
  return w ? s / w * 100 : null;
}

/* One person, one month (Baku). The weeks that are over count (all of them in a finished month); the exam counts once taken
   (until then `examPending`, and `lossIfExamMissed` says what missing it would cost); days of leave and a newcomer's grace days
   are excused: they shorten the week's required steps, an excused week is skipped, they break no run of idle days.
   parts: weeks = average of done/required steps (5 counted tests + 2 lessons = 7), exam = score/70% at most 1, quality = average of the
   counted tests' scores (an aborted one is 0) / 70% at most 1, regularity = 1 − days in runs of 7+ idle days / days so far. */
function kpiMonth_(staff, mk, ctx, now) {
  const today = dayKey_(now), cur = monthKey_(now) === mk, days = monthDays_(mk), weeks = weeksOfMonth_(mk);
  const mine = ctx.tests.filter(r => r.code === staff.code), readAt = ctx.readAt[staff.code] || {};
  const away = ctx.absence[staff.code] || new Set(), graceEnd = staff.start ? addDays_(staff.start, KPI_GRACE_DAYS) : '';
  const excused = { has: d => away.has(d) || (!!graceEnd && d < graceEnd) };  // leave, and for a newcomer the days before the start and the grace days
  const monthAbsent = days.every(d => excused.has(d));
  const quota = quotaOf_(staff.role), req = quota + LESSONS_WEEK;  // steps of a full week
  let sum = 0, n = 0, weeksDone = 0;
  weeks.forEach(w => {
    if (addDays_(w, 6) >= today) return;
    weeksDone++;
    let off = 0;
    for (let i = 0; i < 7; i++) if (excused.has(addDays_(w, i))) off++;
    if (off >= 7 || req - off <= 0) return;
    const p = weekPlan_(mine, readAt, w, quota), done = p.testsDone + Math.min(p.lessons, LESSONS_WEEK);
    sum += Math.min(done, req - off) / (req - off); n++;
  });
  const exam = mine.filter(r => r.kind === 'exam' && monthKey_(r.date) === mk)[0];
  const examPending = cur && !exam && !monthAbsent;
  const qt = mine.filter(r => r.group && !r.over && monthKey_(r.date) === mk);
  const act = new Set(mine.filter(r => monthKey_(r.date) === mk).map(r => dayKey_(r.date)));
  ctx.dailies.filter(r => r.code === staff.code).forEach(r => act.add(dayKey_(r.date)));
  Object.keys(readAt).forEach(id => act.add(readAt[id]));
  const past = days.filter(d => d < today);
  let idle = 0, run = 0;
  past.forEach(d => { if (act.has(d) || excused.has(d)) { if (run >= KPI_IDLE_RUN) idle += run; run = 0; } else run++; });
  if (run >= KPI_IDLE_RUN) idle += run;
  const parts = {
    weeks: n ? sum / n : null,
    exam: monthAbsent || examPending ? null : exam && !exam.aborted ? Math.min(1, exam.ratio / PASS_RATIO) : 0,
    quality: monthAbsent ? null : qt.length ? Math.min(1, qt.reduce((s, r) => s + (r.aborted ? 0 : r.ratio), 0) / qt.length / PASS_RATIO) : (cur && !weeksDone ? null : 0),
    regularity: monthAbsent || !past.length ? null : Math.max(0, 1 - idle / past.length)
  };
  const pct = kpiPct_(parts), state = kpiState_(mk);
  const loss = kpiLoss_(pct), missed = examPending ? kpiLoss_(kpiPct_(Object.assign({}, parts, { exam: 0 }))) : loss;
  return { month: mk, state, pct, parts, weeksDone, weeksTotal: weeks.length, absentDays: days.filter(d => excused.has(d)).length,
    graceUntil: staff.start ? addDays_(staff.start, KPI_GRACE_DAYS - 1) : '', examPending, loss, lossIfExamMissed: missed };
}

/* what the app gets: whole percents, nothing about other people */
function kpiPublic_(k) {
  const r = x => x == null ? null : Math.round(x * 100);
  return { month: k.month, state: k.state, pct: k.pct == null ? null : Math.round(k.pct),
    parts: { weeks: r(k.parts.weeks), exam: r(k.parts.exam), quality: r(k.parts.quality), regularity: r(k.parts.regularity) },
    weeksDone: k.weeksDone, weeksTotal: k.weeksTotal, absentDays: k.absentDays, graceUntil: k.graceUntil, examPending: k.examPending,
    loss: k.loss, lossIfExamMissed: k.lossIfExamMissed, threshold: KPI_THRESHOLD, cap: KPI_CAP };
}

function kpiSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_KPI);
  if (!sh) {
    sh = ss.insertSheet(SHEET_KPI);
    sh.getRange(1, 1, 1, KPI_HEADERS.length).setValues([KPI_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* column F «Начало работы» of «Сотрудники»: made once, so the trainer can type a newcomer's first day there */
function ensureStaffStartColumn_() {
  const sh = sheet_(SHEET_STAFF);
  if (sh.getMaxColumns() < 6) sh.insertColumnAfter(sh.getMaxColumns());
  if (!String(sh.getRange(1, 6).getValue()).trim()) sh.getRange(1, 6).setValues([['Начало работы']]);
}

/* The rows of a finished month on «Списания KPI». A row the trainer has decided on (column M) or marked as entered (O) is never touched again;
   the others are recomputed. Returns [{staff, kpi}] of everyone who was scored. */
function kpiRebuild_(mk, now) {
  const staff = activeStaff_().filter(s => s.branch !== TEST_BRANCH), ctx = kpiCtx_(), scored = [];
  staff.forEach(s => { const k = kpiMonth_(s, mk, ctx, now); if (k.pct != null) scored.push({ staff: s, kpi: k }); });
  underLock_(() => {
    const sh = kpiSheet_(), last = sh.getLastRow();
    const have = last < 2 ? [] : sh.getRange(2, 1, last - 1, KPI_HEADERS.length).getValues();
    scored.forEach(({ staff: s, kpi: k }) => {
      const key = mk + ':' + s.code, i = have.findIndex(r => String(r[15]) === key), pc = x => x == null ? '' : Math.round(x * 100);
      const status = k.state === 'trial' ? 'Пробный месяц' : k.loss > 0 ? 'Предложено' : 'Без списания';
      const vals = [mk, s.code, s.name, s.branch, Math.round(k.pct), pc(k.parts.weeks), pc(k.parts.exam), pc(k.parts.quality), pc(k.parts.regularity), k.absentDays, k.loss, status];
      if (i >= 0) {
        if (String(have[i][12]).trim() || have[i][14] === true) return;
        sh.getRange(i + 2, 1, 1, vals.length).setValues([vals]);
        return;
      }
      let row = nextRow_(sh);
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
      sh.getRange(row, 2).setNumberFormat('@');
      sh.getRange(row, 1, 1, vals.length).setValues([vals]);
      sh.getRange(row, 15).insertCheckboxes();
      sh.getRange(row, 16).setValues([[key]]);
    });
  });
  return scored;
}

/* the 1st of the month: the rows of the month that ended, and a message to the trainer */
function kpiMonthly_(now) {
  const mk = monthKey_(new Date(now.getTime() - 2 * 864e5)), scored = kpiRebuild_(mk, now);
  if (!scored.length) return;
  const trial = scored[0].kpi.state === 'trial', hit = scored.filter(x => x.kpi.loss > 0).sort((a, b) => b.kpi.loss - a.kpi.loss);
  const lines = [`📉 KPI обучения за ${mk.slice(5)}.${mk.slice(0, 4)}: ` + (trial ? 'пробный месяц, ничего не списывается' : `предложения по списанию, подтвердите на листе «${SHEET_KPI}»`),
    `План выполнен на ${KPI_THRESHOLD}% и больше: ${scored.length - hit.length} из ${scored.length}`];
  if (hit.length) {
    lines.push('', trial ? 'Ниже порога (так бы выглядело списание):' : 'Предложено к списанию:');
    hit.slice(0, 30).forEach(x => lines.push(`• ${x.staff.name} (${x.staff.branch}): ${Math.round(x.kpi.pct)}% → −${x.kpi.loss}%`));
    if (hit.length > 30) lines.push(`…и ещё ${hit.length - 30}`);
  }
  send_(lines.join('\n'));
}

/* the people below the threshold in the current month by the weeks that are over (the Monday report), best-effort: nothing is proposed from it */
function kpiRisk_(now) {
  const mk = monthKey_(now), ctx = kpiCtx_(), out = [];
  activeStaff_().filter(s => s.branch !== TEST_BRANCH).forEach(s => {
    const k = kpiMonth_(s, mk, ctx, now);
    if (k.weeksDone >= 1 && k.pct != null && k.loss > 0) out.push({ name: s.name, branch: s.branch, pct: Math.round(k.pct), loss: k.loss });
  });
  out.sort((a, b) => b.loss - a.loss);
  out.shadow = kpiState_(mk) === 'trial';
  return out;
}

/* menu item: make the sheets and column, and (re)build the last finished month */
function kpiMonths() {
  const ui = SpreadsheetApp.getUi(), now = new Date();
  absenceSheet_(); kpiSheet_(); ensureStaffStartColumn_();
  const mk = monthKey_(new Date(Date.parse(monthKey_(now) + '-01T12:00:00Z') - 864e5)), scored = kpiRebuild_(mk, now);
  ui.alert(`Листы «${SHEET_ABSENCE}» и «${SHEET_KPI}» готовы, в «Сотрудники» есть колонка F «Начало работы». ` +
    `За ${mk.slice(5)}.${mk.slice(0, 4)} посчитано сотрудников: ${scored.length}` + (scored.length && scored[0].kpi.state === 'trial' ? ' (пробный месяц: ничего не списывается).' : '.'));
}

/* ---------- прогресс сотрудника: прочитанные уроки и ящики карточек ---------- */

function progressSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_PROGRESS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_PROGRESS);
    sh.getRange(1, 1, 1, 6).setValues([['Код', 'Сотрудник', 'Обновлено (мс)', 'Прочитанные уроки', 'Ящики карточек', 'Версии карточек']]);
    sh.setFrozenRows(1);
  } else {
    sh.getRange(1, 6).setValues([['Версии карточек']]);
  }
  return sh;
}

/* the stored progress of one code and the row it lives in (0 = none yet) */
function progressRow_(sh, code) {
  const last = sh.getLastRow();
  if (last < 2) return { row: 0, read: [], box: {}, ts: 0, clocks: {}, readAt: {}, protocol: 0 };
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  const i = rows.findIndex(r => String(r[0]).trim() === code);
  if (i < 0) return { row: 0, read: [], box: {}, ts: 0, clocks: {}, readAt: {}, protocol: 0 };
  const parse = (v, def) => { try { const x = JSON.parse(String(v || '')); return x && typeof x === 'object' ? x : def; } catch (err) { return def; } };
  const read = parse(rows[i][3], []), box = parse(rows[i][4], {}), meta = parse(rows[i][5], {});
  return { row: i + 2, read: Array.isArray(read) ? read : [], box: Array.isArray(box) ? {} : box,
    ts: Number(rows[i][2]) || 0, protocol: meta.v === 2 ? 2 : 0,
    clocks: meta.clocks && typeof meta.clocks === 'object' && !Array.isArray(meta.clocks) ? meta.clocks : {},
    readAt: meta.readAt && typeof meta.readAt === 'object' && !Array.isArray(meta.readAt) ? meta.readAt : {} };
}

/* the days (Baku) the lessons were counted: {lesson id: 'YYYY-MM-DD'}; a lesson without a day is counted but dated to no week */
function readAtOf_(code) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROGRESS);
  return sh ? progressRow_(sh, code).readAt : {};
}

function progressOf_(code) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROGRESS);
  if (!sh) return { read: [], box: {}, ts: 0, readAt: {} };
  const p = progressRow_(sh, code);
  return { read: p.read, box: p.box, ts: p.ts, readAt: p.readAt };
}

/* Lessons grow by union. Protocol 2 sends only changed cards, including explicit zero resets.
   Old full snapshots remain supported until this employee migrates; afterwards they cannot
   overwrite per-card changes. The old phone keeps its pending local state until updated. */
function saveProgress_(staff, d) {
  const read = (Array.isArray(d.read) ? d.read : []).map(x => String(x)).filter(x => /^[a-z0-9-]{1,40}$/.test(x)).slice(0, PROGRESS_MAX.read);
  const box = {};
  let n = 0;
  Object.keys(d.box && typeof d.box === 'object' && !Array.isArray(d.box) ? d.box : {}).forEach(k => {
    const v = Number(d.box[k]);
    if (n < PROGRESS_MAX.box && /^[dpvt]:[A-Za-z0-9_-]{1,60}$/.test(k) && Number.isInteger(v) && v >= 1 && v <= 5) { box[k] = v; n++; }
  });
  const now = Date.now(), t = Number(d.ts);
  const ts = isFinite(t) && t > 0 && t <= now + 5 * 6e4 ? Math.round(t) : now;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = progressSheet_();
    const old = progressRow_(sh, staff.code);
    const modern = d.protocol === 2;
    if (old.protocol === 2 && !modern) return { ok: false, error: 'progress_update_required' };
    const mergedRead = Array.from(new Set(old.read.concat(read))).slice(0, PROGRESS_MAX.read);
    /* the day of each lesson: only for lessons that are read, earlier day wins, never later than today in Baku */
    const today = dayKey_(new Date(now)), readAt = Object.assign({}, old.readAt);
    const sent = d.readAt && typeof d.readAt === 'object' && !Array.isArray(d.readAt) ? d.readAt : {};
    Object.keys(sent).forEach(id => {
      const day = String(sent[id]);
      if (mergedRead.indexOf(id) < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return;
      if (!readAt[id] || day < readAt[id]) readAt[id] = day;
    });
    const lessonsAdded = mergedRead.length > old.read.length || Object.keys(readAt).some(id => readAt[id] !== old.readAt[id]);
    const newer = ts >= old.ts;
    const out = { read: mergedRead, box: newer ? box : old.box, ts: newer ? ts : old.ts };
    let meta = '';
    const metaOf = clocks => JSON.stringify({ v: 2, clocks, readAt });
    if (modern) {
      out.ts = Math.max(now, old.ts + 1, out.ts);
      out.box = Object.assign({}, old.box);
      const clocks = Object.assign({}, old.clocks);
      Object.keys(old.box).forEach(k => { if (!(k in clocks)) clocks[k] = old.ts; });
      const changes = d.changes && typeof d.changes === 'object' && !Array.isArray(d.changes) ? d.changes : {};
      Object.keys(changes).slice(0, PROGRESS_MAX.box).forEach(k => {
        const c = changes[k], v = Number(c && c.v), at = Number(c && c.ts);
        if (!/^[dpvt]:[A-Za-z0-9_-]{1,60}$/.test(k) || !c || !Number.isInteger(v) || v < 0 || v > 5 ||
            !Number.isInteger(at) || at <= 0 || at > now + 5 * 6e4) return;
        if (c.ifAbsent && (k in clocks || k in old.box)) return;
        if (!(k in clocks) && Object.keys(clocks).length >= PROGRESS_MAX.box) return;
        // A reset wins equal timestamps; replaying the same update is harmless.
        if (at > (clocks[k] || 0) || (at === clocks[k] && v < out.box[k])) {
          out.box[k] = v; clocks[k] = at;
        }
        out.ts = Math.max(out.ts, at);
      });
      meta = metaOf(clocks);
    } else if (Object.keys(readAt).length) {
      meta = JSON.stringify({ readAt });  // a snapshot client: no protocol mark, so it can still be told to update
    }
    const row = old.row || Math.max(2, sh.getLastRow() + 1);
    sh.getRange(row, 1).setNumberFormat('@');
    sh.getRange(row, 1, 1, 6).setValues([[staff.code, staff.name, out.ts, JSON.stringify(out.read), JSON.stringify(out.box), meta]]);
    out.readAt = readAt;
    return { ok: true, progress: out, lessonsAdded };
  } finally {
    lock.releaseLock();
  }
}

/* the slots of the week used so far (a test from 70% or an aborted one): the app blocks the test when the quota is used up */
function weekAttempts_(mine, week) {
  let n = 0;
  mine.forEach(r => { if (r.burns && weekKey_(r.date) === week) n++; });
  return { test: n };
}

/* tests of a counted group taken today (any result, aborted too): the app blocks the next one at DAY_LIMIT */
function todayUsed_(mine, now) {
  const day = dayKey_(now);
  return mine.filter(r => r.group && dayKey_(r.date) === day).length;
}

/* Monday of the week a day string 'YYYY-MM-DD' falls in */
function weekOfDay_(day) {
  const t = Date.parse(day + 'T00:00:00Z'), dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 864e5).toISOString().slice(0, 10);
}

/* The week of one person: counted tests (at most the quota), those finished below the line, lessons counted that week.
   `full` = the quota of tests (3, a trainee 5) and LESSONS_WEEK lessons. */
function weekPlan_(mine, readAt, week, quota) {
  const need = quota || TESTS_WEEK.other;
  let got = 0, low = 0;
  mine.forEach(r => {
    if (!r.group || weekKey_(r.date) !== week) return;
    if (counts_(r)) got++; else if (r.tried) low++;
  });
  const done = Math.min(got, need), tests = { test: done }, tried = { test: low };
  const lessons = Object.keys(readAt || {}).filter(id => weekOfDay_(readAt[id]) === week).length;
  return { tests, tried, testsDone: done, testsNeed: need, lessons, lessonsNeed: LESSONS_WEEK, full: done >= need && lessons >= LESSONS_WEEK };
}

/* the weeks of a person in which the plan was complete */
function fullWeeks_(mine, readAt, quota) {
  const weeks = new Set(mine.filter(r => r.group).map(r => weekKey_(r.date)).concat(Object.keys(readAt || {}).map(id => weekOfDay_(readAt[id]))));
  return new Set([...weeks].filter(w => weekPlan_(mine, readAt, w, quota).full));
}

/* {code: readAt} of everyone, one pass over the sheet «Прогресс» */
function readAtMap_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROGRESS), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(r => {
    try { const m = JSON.parse(String(r[5] || '')); if (m && m.readAt && typeof m.readAt === 'object') out[String(r[0]).trim()] = m.readAt; } catch (err) { /* no dates yet */ }
  });
  return out;
}

function dayKey_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function monthKey_(d) { return dayKey_(d).slice(0, 7); }
/* Monday of the week, Baku time */
function weekKey_(d) {
  const t = Date.parse(dayKey_(d) + 'T00:00:00Z'), dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 864e5).toISOString().slice(0, 10);
}

/* ---------- вебхук KPI-системы (v5.13) ---------- */

/* the week that ended last: Monday of the previous calendar week (Baku) */
function lastWeek_(now) { return addDays_(weekKey_(now), -7); }

/* One JSON for one week (Mon–Sun, Baku) and everyone active except the trainer's test account. The format is in docs/KPI_WEBHOOK.md:
   change it only together with that file and KPI_HOOK.version. */
function kpiWeekPayload_(week, now, text) {
  const sun = addDays_(week, 6), mk = sun.slice(0, 7);  // a week belongs to the month of its Sunday, as in the KPI of the month
  const ctx = kpiCtx_(), owls = owls_(), plans = dayPlans_(), dXp = dailyXp_(ctx.dailies), inWeek = d => weekKey_(d) === week;
  const pc = x => x == null ? null : Math.round(x * 100), scores = {};
  const people = activeStaff_().filter(s => s.branch !== TEST_BRANCH)
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name)).map(s => {
      const mine = ctx.tests.filter(r => r.code === s.code), quota = quotaOf_(s.role), plan = weekPlan_(mine, ctx.readAt[s.code] || {}, week, quota);
      const wk = mine.filter(r => r.group && inWeek(r.date)), scored = wk.filter(r => !r.over);
      scores[s.code] = scored.map(r => r.aborted ? 0 : r.ratio);  // as the quality of the KPI: an aborted test is 0, one over the limit is left out
      const exam = mine.filter(r => r.kind === 'exam' && inWeek(r.date))[0];
      const myOwls = owls.filter(o => o.code === s.code && inWeek(o.date)), away = ctx.absence[s.code] || new Set();
      const planDays = plans.filter(x => x.code === s.code && weekOfDay_(x.day) === week).length;
      let absent = 0;
      for (let i = 0; i < 7; i++) if (away.has(addDays_(week, i))) absent++;
      return {
        code: s.code, kpiId: s.kpiId || null, name: s.name, branch: s.branch, role: s.role, level: levelOf_(s.role) || null,
        tests: { done: plan.testsDone, need: plan.testsNeed, taken: wk.length, belowLine: plan.tried.test || 0, overLimit: wk.filter(r => r.over).length,
          aborted: wk.filter(r => r.aborted).length, away: wk.reduce((n, r) => n + (r.away || 0), 0),
          avgScore: scores[s.code].length ? pc(scores[s.code].reduce((a, x) => a + x, 0) / scores[s.code].length) : null },
        lessons: { done: plan.lessons, need: plan.lessonsNeed },
        fullWeek: plan.full,
        exam: exam ? { score: exam.score, total: exam.total, percent: exam.aborted ? 0 : pc(exam.ratio), aborted: exam.aborted } : null,
        dailyQuestion: { days: new Set(ctx.dailies.filter(r => r.code === s.code && !r.aborted && inWeek(r.date)).map(r => dayKey_(r.date))).size },
        dayPlans: planDays,
        xp: mine.filter(r => inWeek(r.date)).reduce((n, r) => n + r.xp, 0) + dXp.filter(r => r.code === s.code && inWeek(r.date)).reduce((n, r) => n + r.xp, 0),
        owls: { earned: myOwls.reduce((n, o) => n + o.n, 0), items: myOwls.map(o => ({ why: o.why, n: o.n, credited: o.done })) },
        absentDays: absent,
        startedOn: s.start || null,
        kpiMonth: kpiPublic_(kpiMonth_(s, mk, ctx, now))
      };
    });
  const group = list => {
    const all = [].concat(...list.map(p => scores[p.code]));
    return { staff: list.length, tested: list.filter(p => p.tests.taken > 0).length, fullWeek: list.filter(p => p.fullWeek).length,
      tests: list.reduce((n, p) => n + p.tests.taken, 0), avgScore: all.length ? pc(all.reduce((a, x) => a + x, 0) / all.length) : null,
      owls: list.reduce((n, p) => n + p.owls.earned, 0) };
  };
  return {
    event: KPI_HOOK.event, version: KPI_HOOK.version, id: KPI_HOOK.source + ':week:' + week, source: KPI_HOOK.source, scriptVersion: SCRIPT_VERSION,
    sentAt: new Date().toISOString(), week: { from: week, to: sun, month: mk }, trial: kpiState_(mk) === 'trial',
    rules: { testsPerWeek: TESTS_WEEK, lessonsPerWeek: LESSONS_WEEK, passPercent: Math.round(PASS_RATIO * 100), kpiThreshold: KPI_THRESHOLD, kpiCap: KPI_CAP },
    summary: group(people),
    branches: [...groupBy_(people, p => p.branch)].map(([branch, list]) => Object.assign({ branch }, group(list))),
    employees: people,
    text: text || null
  };
}

function kpiHook_() {
  const p = PropertiesService.getScriptProperties();
  return { url: p.getProperty('KPI_WEBHOOK_URL') || '', secret: p.getProperty('KPI_WEBHOOK_SECRET') || '' };
}

/* POST the JSON; with a key: Authorization: Bearer <key> and X-Sensum-Signature: sha256=<HMAC-SHA256 of the body, hex> */
function kpiPost_(payload) {
  const h = kpiHook_();
  if (!h.url) throw new Error('Вебхук KPI-системы не подключён: меню Sensum, пункт 4.');
  const body = JSON.stringify(payload), headers = { 'X-Sensum-Event': payload.event, 'X-Sensum-Delivery': payload.id };
  if (h.secret) {
    headers.Authorization = 'Bearer ' + h.secret;
    headers['X-Sensum-Signature'] = 'sha256=' + Utilities.computeHmacSha256Signature(body, h.secret, Utilities.Charset.UTF_8).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  }
  const res = UrlFetchApp.fetch(h.url, { method: 'post', contentType: 'application/json', payload: body, headers, muteHttpExceptions: true });
  const code = res.getResponseCode();
  return { ok: code >= 200 && code < 300, code };
}

function kpiLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_KPI_LOG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_KPI_LOG);
    sh.getRange(1, 1, 1, KPI_LOG_HEADERS.length).setValues([KPI_LOG_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* the attempts for one delivery id, from the sheet: {sent, failed} */
function kpiLogOf_(id) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_KPI_LOG);
  if (!sh || sh.getLastRow() < 2) return { sent: 0, failed: 0 };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, KPI_LOG_HEADERS.length).getValues().filter(r => String(r[7]) === id);
  return { sent: rows.filter(r => r[5] === 'доставлено').length, failed: rows.filter(r => r[5] === 'ошибка').length };
}

/* Sends one week and writes the attempt to «Отправки в KPI». Never throws for a refusal or a network error: returns {ok, code, error}. */
function kpiPushWeek_(week, now, text, how) {
  const payload = kpiWeekPayload_(week, now, text);
  let out;
  try { out = kpiPost_(payload); out.error = out.ok ? '' : 'HTTP ' + out.code; } catch (err) { out = { ok: false, code: '', error: safeError_(err) }; }
  const at = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm'), props = PropertiesService.getScriptProperties();
  kpiLogSheet_().appendRow([new Date(), week, payload.event, payload.employees.length, out.code, out.ok ? 'доставлено' : 'ошибка',
    cell_(text_((how || '') + (out.error ? (how ? ': ' : '') + out.error : ''), 300)), payload.id]);
  if (out.ok) { props.setProperty('LAST_KPI_OK', `${at}: ${week}`); props.deleteProperty('LAST_KPI_ERROR'); }
  else props.setProperty('LAST_KPI_ERROR', `${at}: ${week}: ${out.error}`);
  out.week = week; out.id = payload.id; out.count = payload.employees.length;
  return out;
}

function weekRange_(week) { const f = d => d.slice(8) + '.' + d.slice(5, 7); return `${f(week)}–${f(addDays_(week, 6))}`; }

/* Monday, right after the Telegram report */
function kpiWeekAuto_(now, text) {
  if (!kpiHook_().url) return;
  const r = kpiPushWeek_(lastWeek_(now), now, text, 'по расписанию');
  if (!r.ok) notify_(`⚠️ Итоги недели ${weekRange_(r.week)} не дошли до KPI-системы: ${r.error}. Скрипт повторит отправку вечером; ` +
    `подробности на листе «${SHEET_KPI_LOG}».`);
}

/* the evening digest: the week that ended last, again, until it is delivered; only the last finished week is retried */
function kpiWeekRetry_(now) {
  if (!kpiHook_().url) return;
  const week = lastWeek_(now), was = kpiLogOf_(KPI_HOOK.source + ':week:' + week);
  if (was.sent) return;
  const r = kpiPushWeek_(week, now, weeklyText_(now), was.failed ? 'повтор' : 'догоняющая отправка');
  if (r.ok && was.failed) notify_(`✅ Итоги недели ${weekRange_(week)} дошли до KPI-системы (с ${was.failed + 1}-й попытки).`);
  if (!r.ok && !was.failed) notify_(`⚠️ Итоги недели ${weekRange_(week)} не дошли до KPI-системы: ${r.error}. Скрипт повторит отправку завтра вечером.`);
}

/* column G «ID в KPI-системе» of «Сотрудники» (after F «Начало работы») */
function ensureStaffKpiIdColumn_() {
  ensureStaffStartColumn_();
  const sh = sheet_(SHEET_STAFF);
  if (sh.getMaxColumns() < 7) sh.insertColumnAfter(sh.getMaxColumns());
  if (!String(sh.getRange(1, 7).getValue()).trim()) sh.getRange(1, 7).setValues([[KPI_ID_HEADER]]);
}

/* menu item 4: the address and the key of the webhook, then a test call (event ping); an empty address switches sending off */
function setupKpiWebhook() {
  const ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  const a = ui.prompt('Вебхук KPI-системы', 'Вставьте адрес для приёма данных (https://…). Оставьте пустым, чтобы отключить отправку.', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const url = a.getResponseText().trim();
  if (!url) {
    props.deleteProperty('KPI_WEBHOOK_URL'); props.deleteProperty('KPI_WEBHOOK_SECRET');
    ui.alert('Отправка в KPI-систему отключена.');
    return;
  }
  if (!/^https:\/\/[^\s\/]+\.[^\s\/]+(\/\S*)?$/.test(url)) {
    ui.alert('Это не похоже на адрес вебхука. Нужен полный адрес, который начинается с https://');
    return;
  }
  const k = ui.prompt('Вебхук KPI-системы', 'Вставьте ключ доступа, если KPI-система его выдала. Если ключа нет, оставьте пустым.', ui.ButtonSet.OK_CANCEL);
  if (k.getSelectedButton() !== ui.Button.OK) return;
  const secret = k.getResponseText().trim();
  props.setProperty('KPI_WEBHOOK_URL', url);
  if (secret) props.setProperty('KPI_WEBHOOK_SECRET', secret); else props.deleteProperty('KPI_WEBHOOK_SECRET');
  try { ensureStaffKpiIdColumn_(); } catch (err) { console.warn('kpi id column: ' + err.message); }
  let r;
  try {
    r = kpiPost_({ event: 'ping', version: KPI_HOOK.version, id: KPI_HOOK.source + ':ping:' + Date.now(), source: KPI_HOOK.source,
      scriptVersion: SCRIPT_VERSION, sentAt: new Date().toISOString(), text: 'Проверка связи из «Sensum Обучение»' });
  } catch (err) { r = { ok: false, error: safeError_(err) }; }
  ui.alert(r.ok
    ? `Вебхук сохранён, KPI-система ответила на проверку (HTTP ${r.code}). Итоги недели будут уходить по понедельникам вместе с отчётом в Telegram.\n\n` +
      `Если в KPI-системе у сотрудников свои ID, впишите их в столбец «${KPI_ID_HEADER}» листа «${SHEET_STAFF}».`
    : `Вебхук сохранён, но проверка не прошла: ${r.error || 'HTTP ' + r.code}. Проверьте адрес и ключ (меню Sensum, пункт 4).`);
}

/* menu item: the week that ended last, now (the KPI system gets the same id again and should overwrite that week) */
function sendKpiWeek() {
  const ui = SpreadsheetApp.getUi();
  if (!kpiHook_().url) { ui.alert('Вебхук KPI-системы не подключён: меню Sensum, пункт 4.'); return; }
  const now = new Date(), r = kpiPushWeek_(lastWeek_(now), now, weeklyText_(now), 'вручную');
  ui.alert(r.ok ? `Итоги недели ${weekRange_(r.week)} отправлены (${r.count} сотр., HTTP ${r.code}).`
    : `Не отправилось: ${r.error}. Подробности на листе «${SHEET_KPI_LOG}».`);
}

/* ---------- «План на сегодня» выполнен → KPI-система (v5.14) ---------- */

function dayPlanSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_DAYPLAN);
  if (!sh) {
    sh = ss.insertSheet(SHEET_DAYPLAN);
    sh.getRange(1, 1, 1, DAYPLAN_HEADERS.length).setValues([DAYPLAN_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function dayPlans_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DAYPLAN);
  if (!sh || sh.getLastRow() < 2) return [];
  const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  return sh.getRange(2, 1, sh.getLastRow() - 1, DAYPLAN_HEADERS.length).getValues()
    .map((r, i) => ({ row: i + 2, day: dayStr_(r[0]), code: String(r[1]).trim(), name: String(r[2]), branch: String(r[3]),
      steps: list(r[4]), done: list(r[5]), lessons: list(String(r[6]).replace(/^'/, '')), at: r[7] instanceof Date ? r[7] : null,
      status: String(r[8] || ''), key: String(r[10] || '') }))
    .filter(p => p.day && p.code);
}

/* The app says: today's plan is complete. One row per person and day (a repeat of a delivered one is only acknowledged),
   then straight on to the KPI system. Never fails the app for the KPI system's sake: the row is kept and retried in the evening. */
function saveDayPlan_(staff, d) {
  const now = new Date(), today = dayKey_(now), day = dayStr_(d.day);
  if (!day || day > today || day < addDays_(today, -DAYPLAN_DAYS)) return { ok: false, error: 'bad_day' };
  const pick = v => DAYPLAN_STEPS.filter(k => Array.isArray(v) && v.indexOf(k) >= 0);
  const steps = pick(d.steps), done = pick(d.done);
  if (!steps.length || steps.some(k => done.indexOf(k) < 0)) return { ok: false, error: 'bad_plan' };  // only a complete plan is sent
  const lessons = (Array.isArray(d.lessons) ? d.lessons : []).map(x => text_(x, 40)).filter(x => /^[\w-]+$/.test(x)).slice(0, 20);
  const key = KPI_HOOK.source + ':day:' + day + ':' + staff.code;
  let rec;
  underLock_(() => {
    rec = dayPlans_().filter(p => p.key === key)[0];
    if (rec) return;
    const sh = dayPlanSheet_(), row = nextRow_(sh);
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
    sh.getRange(row, 1, 1, 2).setNumberFormat('@');
    sh.getRange(row, 1, 1, DAYPLAN_HEADERS.length).setValues([[day, staff.code, staff.name, staff.branch, steps.join(', '), done.join(', '),
      cell_(lessons.join(', ')), now, '', '', key]]);
    rec = { row, day, code: staff.code, name: staff.name, branch: staff.branch, steps, done, lessons, at: now, status: '', key };
  });
  if (rec.status === 'доставлено') return { ok: true, duplicate: true, kpi: 'sent' };
  return { ok: true, kpi: kpiPushDay_(rec).status };
}

/* one day plan as JSON: who, the plan, and what the sheet knows of that day (tests, «Вопрос дня», lessons) */
function kpiDayPayload_(rec) {
  const s = activeStaff_().filter(x => x.code === rec.code)[0] || { code: rec.code, name: rec.name, branch: rec.branch, role: '', kpiId: '', start: '' };
  const pc = x => Math.round(x * 100), onDay = r => r.code === rec.code && dayKey_(r.date) === rec.day;
  const tests = withXp_(results_()).filter(onDay), daily = dailyXp_(dailies_().filter(r => r.code === rec.code)).filter(onDay);
  const readAt = readAtOf_(rec.code) || {};
  const lessons = [...new Set(rec.lessons.concat(Object.keys(readAt).filter(id => readAt[id] === rec.day)))];
  const month = rec.day.slice(0, 7), dq = daily[0];
  return {
    event: KPI_DAY.event, version: KPI_DAY.version, id: rec.key, source: KPI_HOOK.source, scriptVersion: SCRIPT_VERSION,
    sentAt: new Date().toISOString(), day: rec.day, week: weekOfDay_(rec.day), month, trial: kpiState_(month) === 'trial',
    employee: { code: s.code, kpiId: s.kpiId || null, name: s.name, branch: s.branch, role: s.role || null, level: levelOf_(s.role) || null },
    plan: { complete: true, steps: rec.steps, done: rec.done, completedAt: rec.at ? rec.at.toISOString() : null },
    facts: {
      tests: tests.map(r => ({ kind: r.kind || null, score: r.score, total: r.total, percent: r.aborted ? 0 : pc(r.ratio), counted: !!r.group && counts_(r), aborted: r.aborted })),
      dailyQuestion: dq ? { score: dq.score, total: dq.total, aborted: dq.aborted } : null,
      lessons,
      xp: tests.concat(daily).reduce((n, r) => n + r.xp, 0)
    }
  };
}

/* sends one row and writes the outcome into it (columns I–J); {status: 'sent' | 'failed' | 'off'} */
function kpiPushDay_(rec) {
  const sh = dayPlanSheet_(), props = PropertiesService.getScriptProperties();
  if (!kpiHook_().url) { sh.getRange(rec.row, 9, 1, 2).setValues([['не подключено', '']]); return { status: 'off' }; }
  let out;
  try { out = kpiPost_(kpiDayPayload_(rec)); out.error = out.ok ? '' : 'HTTP ' + out.code; } catch (err) { out = { ok: false, code: '', error: safeError_(err) }; }
  const at = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm');
  sh.getRange(rec.row, 9, 1, 2).setValues([[out.ok ? 'доставлено' : 'ошибка', cell_(text_(out.ok ? String(out.code) : out.error, 300))]]);
  rec.status = out.ok ? 'доставлено' : 'ошибка';
  /* the status answer is public: never the employee's code (it is their login) */
  if (out.ok) { props.setProperty('LAST_KPI_OK', `${at}: план дня ${rec.day}`); props.deleteProperty('LAST_KPI_ERROR'); }
  else props.setProperty('LAST_KPI_ERROR', `${at}: план дня ${rec.day}: ${out.error}`);
  return { status: out.ok ? 'sent' : 'failed', error: out.error };
}

/* the evening digest: every day plan of the last DAYPLAN_DAYS days that has not reached the KPI system yet; one message if some still did not */
function kpiDayRetry_(now) {
  if (!kpiHook_().url) return;
  const from = addDays_(dayKey_(now), -DAYPLAN_DAYS);
  const todo = dayPlans_().filter(p => p.status !== 'доставлено' && p.day >= from);
  const failed = todo.filter(p => kpiPushDay_(p).status !== 'sent');
  if (failed.length) notify_(`⚠️ Отметки «План дня» не дошли до KPI-системы: ${failed.length} из ${todo.length}. ` +
    `Скрипт повторит отправку завтра вечером; подробности на листе «${SHEET_DAYPLAN}».`);
}

/* ---------- каждый тест → KPI-система (v5.15) ---------- */

/* one row of «Результаты» as JSON: who, and the test with what the sheet makes of it (passed, counted for the week, over the limit, XP) */
function kpiTestPayload_(r) {
  const s = activeStaff_().filter(x => x.code === r.code)[0] || { code: r.code, name: r.name, branch: r.branch, role: '', kpiId: '' };
  const day = dayKey_(r.date), month = day.slice(0, 7);
  return {
    event: KPI_TEST.event, version: KPI_TEST.version, id: KPI_HOOK.source + ':test:' + r.id, source: KPI_HOOK.source, scriptVersion: SCRIPT_VERSION,
    sentAt: new Date().toISOString(), day, week: weekOfDay_(day), month, trial: kpiState_(month) === 'trial',
    employee: { code: s.code, kpiId: s.kpiId || null, name: s.name, branch: s.branch, role: s.role || null, level: levelOf_(s.role) || null },
    test: {
      attemptId: r.id, kind: r.kind || null, scope: r.scope, score: r.score, total: r.total, percent: r.aborted ? 0 : Math.round(r.ratio * 100),
      passed: !r.aborted && r.ratio >= setting_('PassThreshold', 0.7), counted: !!r.group && counts_(r), overLimit: !!r.over, aborted: r.aborted,  // counted: for the week (the weekly test, not the exam or a retry)
      time: r.time || null, timeouts: r.timeouts || 0, away: r.away || 0, lang: r.lang || null, appVersion: r.ver || null,
      takenAt: r.date.toISOString(), xp: r.xp, mistakes: String(r.mistakes || '').split('\n').filter(Boolean)
    }
  };
}

/* sends the test with this attempt id and writes the attempt to «Отправки в KPI»; null when there is no such result */
function kpiPushTest_(id, how) {
  const r = withXp_(results_()).filter(x => x.id === id)[0];
  if (!r) return null;
  const payload = kpiTestPayload_(r);
  let out;
  try { out = kpiPost_(payload); out.error = out.ok ? '' : 'HTTP ' + out.code; } catch (err) { out = { ok: false, code: '', error: safeError_(err) }; }
  const at = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm'), props = PropertiesService.getScriptProperties();
  kpiLogSheet_().appendRow([new Date(), payload.week, payload.event, 1, out.code, out.ok ? 'доставлено' : 'ошибка',
    cell_(text_(how + (out.error ? ': ' + out.error : ''), 300)), payload.id]);
  /* the status answer is public: the day only, never the employee's code */
  if (out.ok) { props.setProperty('LAST_KPI_OK', `${at}: тест ${payload.day}`); props.deleteProperty('LAST_KPI_ERROR'); }
  else props.setProperty('LAST_KPI_ERROR', `${at}: тест ${payload.day}: ${out.error}`);
  return out;
}

/* right after a new result is saved (doPost); no message on a failure, the evening retry tells the trainer once */
function kpiTestAuto_(id) {
  if (!kpiHook_().url) return;
  kpiPushTest_(id, 'сразу');
}

/* the evening digest: every test of the last DAYPLAN_DAYS days that failed and was never delivered, once more; one message if some still fail */
function kpiTestRetry_(now) {
  if (!kpiHook_().url) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_KPI_LOG);
  if (!sh || sh.getLastRow() < 2) return;
  const from = now.getTime() - DAYPLAN_DAYS * 864e5, prefix = KPI_HOOK.source + ':test:', seen = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, KPI_LOG_HEADERS.length).getValues().forEach(r => {
    if (r[2] !== KPI_TEST.event) return;
    const k = String(r[7]), o = seen[k] || (seen[k] = { sent: false, failed: false, at: 0 });
    if (r[5] === 'доставлено') o.sent = true; else o.failed = true;
    if (r[0] instanceof Date) o.at = Math.max(o.at, r[0].getTime());
  });
  const todo = Object.keys(seen).filter(k => !seen[k].sent && seen[k].failed && seen[k].at >= from && k.indexOf(prefix) === 0);
  const left = todo.filter(k => { const out = kpiPushTest_(k.slice(prefix.length), 'повтор'); return out && !out.ok; });
  if (left.length) notify_(`⚠️ Результаты тестов не дошли до KPI-системы: ${left.length} из ${todo.length}. ` +
    `Скрипт повторит отправку завтра вечером; подробности на листе «${SHEET_KPI_LOG}».`);
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
  const props = PropertiesService.getScriptProperties();
  let msg = String(err && err.message || err);
  ['TELEGRAM_TOKEN', 'KPI_WEBHOOK_URL', 'KPI_WEBHOOK_SECRET'].forEach(k => { const v = props.getProperty(k); if (v) msg = msg.split(v).join('***'); });
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
