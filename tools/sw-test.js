// Offline files are cached; results API and other applications always use the network.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(__dirname + '/../sw.js', 'utf8');
const shell = source.match(/const CACHE = '([^']+)'/)[1];
const scope = 'https://sensum.test/handbook/';
const handlers = {}, stores = new Map();
let calls = 0, offline = false, status = 200, body = 'first', hang = null;
const timers = [];  /* the worker's timers are run by hand, so a slow network takes no real time */
const key = req => new URL(typeof req === 'string' ? req : req.url, scope).href;
const network = async () => { calls++; if (offline) throw new Error('offline'); if (hang) await hang; return new Response(body, { status }); };
const caches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async put(req, res) { store.set(key(req), res.clone()); },
      async keys() { return [...store.keys()].map(url => ({ url })); },
      async delete(req) { return store.delete(key(req)); },
      async add(req) { await this.put(req, await network()); },
      async addAll(reqs) { for (const req of reqs) await this.add(req); }
    };
  },
  async match(req) { for (const store of stores.values()) { const r = store.get(key(req)); if (r) return r.clone(); } },
  async keys() { return [...stores.keys()]; },
  async delete(name) { return stores.delete(name); }
};
vm.runInNewContext(source, {
  URL, caches, fetch: network,
  setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: id => { timers[id - 1] = null; },
  self: { registration: { scope }, addEventListener: (name, fn) => { handlers[name] = fn; }, clients: { claim: async () => {} }, skipWaiting: async () => {} }
});
async function get(path, options = {}) {
  const waits = [];
  let response;
  const request = { url: new URL(path, scope).href, method: options.method || 'GET', mode: options.doc ? 'navigate' : 'cors', headers: new Headers() };
  handlers.fetch({ request, respondWith(p) { response = p; }, waitUntil(p) { waits.push(p); } });
  const result = await (response || network());
  await Promise.all(waits);
  return result;
}
(async () => {
  const api = 'https://script.google.com/macros/s/mock/exec?action=me&code=mock';
  body = '100'; assert.strictEqual(await (await get(api)).text(), '100');
  body = '250'; assert.strictEqual(await (await get(api)).text(), '250');
  assert.strictEqual(calls, 2, 'API replies never become stale cache hits');
  const before = calls;
  for (const path of ['api?action=me', 'api', '../other-app/index.html', 'index.html?debug=1']) {
    await get(path); await get(path);
  }
  assert.strictEqual(calls - before, 8, 'only explicit app assets are cacheable');
  body = 'photo'; const photoBefore = calls;
  await get('images/latte.12345678.webp'); await get('images/latte.12345678.webp');
  assert.strictEqual(calls - photoBefore, 1, 'hashed recipe photos remain available offline');
  body = 'old document'; await get('index.html', { doc: true });
  body = 'fresh document'; await get('index.html', { doc: true });
  status = 500; body = 'server error';
  assert.strictEqual((await get('index.html', { doc: true })).status, 500);
  offline = true;
  assert.strictEqual(await (await get('index.html', { doc: true })).text(), 'fresh document', 'an error response never replaces the offline app');
  assert.strictEqual(await (await get('images/latte.12345678.webp')).text(), 'photo');
  offline = false; status = 200;
  assert.ok(timers.length > 0 && timers.every(t => t === null), 'an answer from the network cancels the wait for the saved page');

  /* weak Wi-Fi: the network does not answer, so after DOC_WAIT the saved page opens; the fresh one lands in the cache later */
  let release; hang = new Promise(r => { release = r; });
  const slowWaits = []; let slow;
  handlers.fetch({ request: { url: new URL('./', scope).href, method: 'GET', mode: 'navigate', headers: new Headers() }, respondWith(p) { slow = p; }, waitUntil(p) { slowWaits.push(p); } });
  let settled = false; slow.then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(settled, false, 'a slow network is waited for at first');
  const wait = timers[timers.length - 1];
  assert.strictEqual(wait.ms, 3000, 'the saved page opens after three seconds');
  wait.fn();
  assert.strictEqual(await (await slow).text(), 'fresh document', 'a slow network opens the saved page');
  body = 'newer document'; hang = null; release(); await Promise.all(slowWaits);
  offline = true;
  assert.strictEqual(await (await get('index.html', { doc: true })).text(), 'newer document', 'the page that arrived late is saved for the next start');
  offline = false;

  let told;
  handlers.message({ data: { type: 'version' }, ports: [{ postMessage: m => { told = m; } }] });
  assert.strictEqual('sensum-v' + told.version, shell, 'the worker tells an open page its version');

  body = 'installed'; const inst = [];
  handlers.install({ waitUntil(p) { inst.push(p); } }); await Promise.all(inst);
  offline = true;
  assert.strictEqual(await (await get('./', { doc: true })).text(), 'installed', 'installation saves the current page');
  offline = false;

  const old = await caches.open('sensum-v0.001'); await old.put(api, new Response('stale API'));
  const waits = [];
  handlers.activate({ waitUntil(p) { waits.push(p); } }); await Promise.all(waits);
  assert.ok(!stores.has('sensum-v0.001'), 'activation removes the old shell and its cached API replies');
  assert.ok(stores.has(shell) && stores.has('sensum-img'), 'current app and photo caches survive');
  body = 'live'; assert.strictEqual(await (await get(api)).text(), 'live');
  console.log('SERVICE WORKER CHECKS PASSED');
})().catch(e => { console.error(e); process.exitCode = 1; });
