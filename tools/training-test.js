// Run production client functions in memory: no browser, network, or employee data.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const drain = () => new Promise(resolve => setImmediate(resolve));
const plain = x => JSON.parse(JSON.stringify(x));
function state(extra = {}) {
  return Object.assign({ me: { code: 'mock-1' }, box: {}, read: {}, stats: { progressProtocol: 2 }, progV: 2, progChanges: {}, progTs: 1000, progDirty: 0 }, extra);
}
function progressEnv(initial = state()) {
  let now = 2000, respond = async () => ({ ok: true, progress: { read: [], box: {}, ts: 3000 } });
  const calls = [], timers = new Map(); let seq = 0;
  const ctx = {
    LS: initial, RESULTS_URL: 'mock', Date: { now: () => now },
    saveLearn() {},
    setTimeout(fn, ms) { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout(id) { timers.delete(id); },
    api(_, data) { calls.push(plain(data)); return respond(data); }
  };
  vm.createContext(ctx);
  vm.runInContext(section('let progBusy=', 'const QUIZ_SEC=') + '\nthis.test={touchProgress,pushProgress,applyProgress,initProgressSync};', ctx);
  return { ctx, api: ctx.test, calls, timers, respond: fn => { respond = fn; }, clock: n => { now = n; } };
}
(async () => {
  const a = progressEnv(state({ box: { 'd:latte': 1, 'd:cappuccino': 1 } }));
  a.ctx.LS.box['d:latte'] = 2; a.api.touchProgress('d:latte');
  a.api.applyProgress({ read: ['cf-milk'], box: { 'd:latte': 1, 'd:cappuccino': 3 }, ts: 3000 });
  assert.deepStrictEqual(plain(a.ctx.LS.box), { 'd:latte': 2, 'd:cappuccino': 3 }, 'server changes merge around a pending local edit');
  a.respond(async () => ({ ok: true, progress: { read: ['cf-milk'], box: { 'd:latte': 2, 'd:cappuccino': 3 }, ts: 4000 } }));
  a.api.pushProgress(); await drain();
  assert.deepStrictEqual(a.calls[0].changes, { 'd:latte': { v: 2, ts: 2000 } });
  assert.ok(!('box' in a.calls[0]), 'a request never contains a stale whole-device snapshot');
  assert.strictEqual(a.ctx.LS.progDirty, 0); assert.deepStrictEqual(plain(a.ctx.LS.progChanges), {});
  a.api.applyProgress({ read: [], box: { 'd:latte': 1, 'd:cappuccino': 1 }, ts: 3500 });
  assert.strictEqual(a.ctx.LS.box['d:cappuccino'], 3, 'an old read response cannot roll back newer merged progress');

  const b = progressEnv(state({ box: { 'd:latte': 1 } }));
  let finish;
  b.respond(() => new Promise(resolve => { finish = resolve; }));
  b.ctx.LS.box['d:latte'] = 0; b.api.touchProgress('d:latte'); b.api.pushProgress();
  b.clock(2100); b.ctx.LS.box['d:latte'] = 2; b.api.touchProgress('d:latte');
  finish({ ok: true, progress: { read: [], box: { 'd:latte': 0 }, ts: 3000 } }); await drain();
  assert.strictEqual(b.calls[0].changes['d:latte'].v, 0, 'zero resets are sent explicitly');
  assert.strictEqual(b.ctx.LS.box['d:latte'], 2, 'an in-flight acknowledgement never overwrites a newer local answer');
  assert.strictEqual(b.ctx.LS.progChanges['d:latte'].v, 2); assert.strictEqual(b.ctx.LS.progDirty, 1);
  b.respond(async () => ({ ok: true, progress: { read: [], box: { 'd:latte': 2 }, ts: 4000 } }));
  b.api.pushProgress(); await drain(); assert.strictEqual(b.ctx.LS.progDirty, 0);

  const c = progressEnv(); let finishRead;
  c.respond(() => new Promise(resolve => { finishRead = resolve; }));
  c.ctx.LS.read.first = 1; c.api.touchProgress(); c.api.pushProgress();
  c.ctx.LS.read.second = 1; c.api.touchProgress();
  finishRead({ ok: true, progress: { read: ['first'], box: {}, ts: 5000 } }); await drain();
  assert.strictEqual(c.ctx.LS.progDirty, 1, 'a lesson read during a sync remains pending');
  assert.strictEqual(c.ctx.LS.read.second, 1);

  const legacy = progressEnv(state({ progV: 0, progDirty: 1, box: { 'd:latte': 2, 'd:cappuccino': 1 }, stats: { progressProtocol: 2, progress: { box: { 'd:latte': 1, 'd:cappuccino': 1 } } } }));
  legacy.api.initProgressSync();
  assert.deepStrictEqual(Object.keys(legacy.ctx.LS.progChanges), ['d:latte'], 'migration uses the known baseline to detect real edits');
  const unknown = progressEnv(state({ progV: 0, progDirty: 1, box: { 'd:latte': 4 } }));
  unknown.api.initProgressSync(); assert.strictEqual(unknown.ctx.LS.progChanges['d:latte'].ifAbsent, true);
  unknown.api.applyProgress({ read: [], box: { 'd:latte': 0 }, ts: 5000 });
  assert.strictEqual(unknown.ctx.LS.box['d:latte'], 0, 'unknown old state cannot resurrect a reset server card');
  const clean = progressEnv(state({ progV: 0, progTs: 0, stats: { progressProtocol: 2, progress: { box: { 'd:latte': 3 } } } }));
  clean.api.applyProgress({ read: ['cf-origin'], box: { 'd:latte': 3 }, ts: 5000 });
  assert.strictEqual(clean.ctx.LS.box['d:latte'], 3); assert.deepStrictEqual(plain(clean.ctx.LS.progChanges), {});

  const oldServer = progressEnv(state({ stats: {}, box: { 'd:latte': 1 } }));
  oldServer.ctx.LS.box['d:latte'] = 2; oldServer.api.touchProgress('d:latte'); oldServer.api.pushProgress(); await drain();
  assert.strictEqual(oldServer.calls.length, 0, 'never send a delta-only payload to an old server that would treat it as an empty snapshot');
  assert.strictEqual(oldServer.ctx.LS.progDirty, 1);
  const switched = progressEnv(); let finishOther;
  switched.respond(() => new Promise(resolve => { finishOther = resolve; }));
  switched.ctx.LS.box['d:latte'] = 2; switched.api.touchProgress('d:latte'); switched.api.pushProgress();
  switched.ctx.LS = state({ me: { code: 'mock-2' }, box: { 'd:cappuccino': 4 } });
  finishOther({ ok: true, progress: { read: [], box: { 'd:latte': 2 }, ts: 5000 } }); await drain();
  assert.deepStrictEqual(plain(switched.ctx.LS.box), { 'd:cappuccino': 4 }, 'an old request cannot apply to another employee');

  const ui = {
    LS: { stats: { passThreshold: 0.8 }, quiz: [{ score: 6, total: 10, scope: 'test' }] },
    L: { qz: { result: { score: 7, total: 10, mistakes: [], secs: 0, scope: 'test' } } }, RESULTS_URL: '',
    T: key => key, ic: () => '', mmss: () => '0:00', sendStatus: () => '', todayDone: () => ['test'],
    nextLesson: () => null, weakestDeck: () => null, dailyStreak: () => 0, dailyOpen: () => false,
    planTest: () => ({ scope: 'drinks' })
  };
  vm.createContext(ui);
  vm.runInContext(section('function testPassThreshold()', 'function examDone()') + section('function planItems()', '/* -- «Вопрос дня»') + section('function resultScreen()', 'function renderLearn()') + '\nthis.test={testPassed,planItems,resultScreen};', ui);
  assert.strictEqual(ui.test.testPassed({ score: 7, total: 10 }), false);
  assert.strictEqual(ui.test.planItems()[0].t, 'plan_test_review', 'a finished failed test is never labelled passed');
  assert.ok(ui.test.resultScreen().includes('r_bad'), 'the result screen uses the configured server threshold');
  ui.LS.quiz[0].score = 8; assert.strictEqual(ui.test.planItems()[0].t, 'plan_test_passed');
  ui.LS.stats = {}; assert.strictEqual(ui.test.testPassed({ score: 7, total: 10 }), true, 'old servers retain the 70% fallback');

  const timers = [], reply = [{ ok: false, error: 'reward_pending', saved: true }, { ok: true, duplicate: true, xp: 90, owls: [{ why: 'test', n: 1 }], over: false }];
  const delivery = {
    LS: { me: { code: 'mock-1' }, outbox: [{ id: 'mock-attempt', code: 'mock-1' }] }, L: { view: 'other' },
    RESULTS_URL: 'https://mock.invalid/', document: { hidden: false, getElementById: () => null },
    fetch: async () => ({ json: async () => reply.shift() }),
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {},
    saveLearn() {}, fetchStats() {}, pushProgress() {}
  };
  vm.createContext(delivery);
  vm.runInContext(section('const SEND={}', 'function login()') + '\nthis.test={flushOutbox,getSend:()=>SEND,getReward:()=>REWARD};', delivery);
  await delivery.test.flushOutbox();
  assert.strictEqual(delivery.LS.outbox.length, 1); assert.strictEqual(delivery.test.getSend()['mock-attempt'], 'rewardpending');
  assert.deepStrictEqual(timers, [15000]);
  await delivery.test.flushOutbox();
  assert.strictEqual(delivery.LS.outbox.length, 0); assert.strictEqual(delivery.test.getSend()['mock-attempt'], 'sent');
  assert.strictEqual(delivery.test.getReward()['mock-attempt'].owls[0].n, 1);
  console.log('TRAINING CLIENT CHECKS PASSED');
})().catch(e => { console.error(e); process.exitCode = 1; });
