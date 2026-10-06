// A deterministic, in-memory stand-in for the parts of `chrome` the service
// worker uses, for characterization tests that drive background.js in Node.
//
// - storage.local / sync / session hold real data and fire storage.onChanged;
// - every chrome.* call is appended to `log` (path + arguments), so a test can
//   compare what a message made the worker do, not only what it answered;
// - callbacks run as separate tasks (like Chrome), never synchronously;
// - time is virtual: Date, setTimeout and setInterval are replaced, and
//   `settle()` runs pending callbacks and due timers in a fixed order;
// - crypto.randomUUID and Math.random are seeded; fetch never reaches a network.
//
// Install before importing any extension module: `const fake = installChromeFake()`.

const realSetImmediate = globalThis.setImmediate;
const RealDate = globalThis.Date;

function describe(v, depth = 0) {
  if (typeof v === 'function') return 'ƒ';
  if (v === undefined) return '‹undefined›';
  if (v === null || typeof v !== 'object') return v;
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.map((x) => describe(x, depth + 1));
  if (v instanceof Uint8Array) return `‹bytes ${v.length}›`;
  const o = {};
  for (const k of Object.keys(v)) o[k] = describe(v[k], depth + 1);
  return o;
}

export function installChromeFake({ startTime = RealDate.UTC(2026, 0, 15, 9, 0, 0), tabs = null } = {}) {
  const log = [];
  let pending = 0;          // callbacks queued through `later`
  let now = startTime;
  const timers = [];        // { id, due, fn, interval }
  let timerSeq = 1;
  let uuidSeq = 1;
  let seed = 12345;

  const later = (fn) => {
    pending++;
    realSetImmediate(() => { pending--; fn(); });
  };
  const record = (path, args) => log.push(`${path} ${JSON.stringify(describe(args))}`);

  // ── time ────────────────────────────────────────────────────────────────
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  globalThis.Date = FakeDate;
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = timerSeq++;
    timers.push({ id, due: now + Math.max(0, Number(ms) || 0), fn: () => fn(...args), interval: null });
    return id;
  };
  globalThis.setInterval = (fn, ms = 0, ...args) => {
    const id = timerSeq++;
    const step = Math.max(1, Number(ms) || 0);
    timers.push({ id, due: now + step, fn: () => fn(...args), interval: step });
    return id;
  };
  globalThis.clearTimeout = globalThis.clearInterval = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: () => `00000000-0000-4000-8000-${String(uuidSeq++).padStart(12, '0')}`,
  });
  globalThis.fetch = async (url) => {
    record('fetch', [String(url)]);
    throw new Error('network disabled in tests');
  };

  // ── events ──────────────────────────────────────────────────────────────
  const events = {};
  const event = (path) => {
    const listeners = [];
    events[path] = listeners;
    return {
      addListener: (fn) => { record(`${path}.addListener`, []); listeners.push(fn); },
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      hasListener: (fn) => listeners.includes(fn),
      hasListeners: () => listeners.length > 0,
    };
  };

  // ── storage ─────────────────────────────────────────────────────────────
  const data = { local: {}, sync: {}, session: {} };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const onChanged = event('storage.onChanged');
  const area = (name) => {
    const pick = (keys) => {
      const all = data[name];
      if (keys == null) return clone(all);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) {
        const o = {};
        for (const k of keys) if (k in all) o[k] = clone(all[k]);
        return o;
      }
      const o = {};
      for (const [k, def] of Object.entries(keys)) o[k] = k in all ? clone(all[k]) : def;
      return o;
    };
    const fire = (changes) => {
      if (!Object.keys(changes).length) return;
      for (const fn of [...events['storage.onChanged']]) later(() => fn(clone(changes), name));
    };
    const op = (fnName, body) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      record(`storage.${name}.${fnName}`, fnName === 'get' ? args : args);
      const result = body(...args);
      if (cb) { later(() => cb(result)); return undefined; }
      return new Promise((res) => later(() => res(result)));
    };
    return {
      get: op('get', (keys) => pick(keys)),
      set: op('set', (items) => {
        const changes = {};
        for (const [k, v] of Object.entries(items || {})) {
          changes[k] = { oldValue: clone(data[name][k]), newValue: clone(v) };
          data[name][k] = clone(v);
        }
        fire(changes);
      }),
      remove: op('remove', (keys) => {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (k in data[name]) { changes[k] = { oldValue: clone(data[name][k]) }; delete data[name][k]; }
        }
        fire(changes);
      }),
      clear: op('clear', () => { data[name] = {}; }),
      getBytesInUse: op('getBytesInUse', () => JSON.stringify(data[name]).length),
      QUOTA_BYTES: name === 'sync' ? 102400 : 10485760,
    };
  };

  // ── tabs ────────────────────────────────────────────────────────────────
  const tabList = tabs || [
    { id: 1, windowId: 1, active: true, url: 'https://example.com/page', title: 'Example' },
    { id: 2, windowId: 1, active: false, url: 'chrome://extensions/', title: 'Extensions' },
  ];
  const zoom = { 1: 1.25 };
  let tabSeq = 100;
  // Answers content scripts would give, by message type; default {}.
  const tabReplies = {};

  const cbOrPromise = (path, args, value) => {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    record(path, cb ? args.slice(0, -1) : args);
    if (cb) { later(() => cb(typeof value === 'function' ? value() : value)); return undefined; }
    return new Promise((res) => later(() => res(typeof value === 'function' ? value() : value)));
  };

  // Anything not modelled: record, call a trailing callback with undefined, resolve undefined.
  const generic = (path) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return generic(`${path}.${String(prop)}`);
    },
    apply(_t, _this, args) { return cbOrPromise(path, args, undefined); },
  });

  const lastErrorState = { value: undefined };
  const chrome = {
    runtime: {
      id: 'testextensionid',
      get lastError() { return lastErrorState.value; },
      onMessage: event('runtime.onMessage'),
      onInstalled: event('runtime.onInstalled'),
      onStartup: event('runtime.onStartup'),
      onUpdateAvailable: event('runtime.onUpdateAvailable'),
      onMessageExternal: event('runtime.onMessageExternal'),
      getURL: (p) => `chrome-extension://testextensionid/${String(p).replace(/^\//, '')}`,
      getManifest: () => ({ version: '1.0.20', name: 'Pocket QA', manifest_version: 3 }),
      sendMessage: (...args) => cbOrPromise('runtime.sendMessage', args, undefined),
      requestUpdateCheck: (...args) => cbOrPromise('runtime.requestUpdateCheck', args, { status: 'no_update' }),
      getPlatformInfo: (...args) => cbOrPromise('runtime.getPlatformInfo', args, { os: 'win' }),
      reload: (...args) => record('runtime.reload', args),
    },
    storage: { local: area('local'), sync: area('sync'), session: area('session'), onChanged },
    tabs: {
      query: (...args) => cbOrPromise('tabs.query', args, () => {
        const q = args[0] || {};
        return clone(tabList.filter((t) => (q.active == null || t.active === q.active)
          && (q.url == null || String(t.url).startsWith(String(q.url).replace(/\*$/, '')))));
      }),
      get: (...args) => cbOrPromise('tabs.get', args, () => clone(tabList.find((t) => t.id === args[0]))),
      sendMessage: (...args) => cbOrPromise('tabs.sendMessage', args, () => {
        const msg = args[1];
        const r = tabReplies[msg?.type];
        return typeof r === 'function' ? r(msg, args[0]) : clone(r ?? {});
      }),
      create: (...args) => cbOrPromise('tabs.create', args, () => ({ id: tabSeq++, windowId: 1, ...clone(args[0]) })),
      update: (...args) => cbOrPromise('tabs.update', args, () => ({ id: args[0], ...clone(args[1]) })),
      remove: (...args) => cbOrPromise('tabs.remove', args, undefined),
      getZoom: (...args) => cbOrPromise('tabs.getZoom', args, () => zoom[args[0]] ?? 1),
      setZoom: (...args) => cbOrPromise('tabs.setZoom', args, () => { zoom[args[0]] = args[1]; }),
      onUpdated: event('tabs.onUpdated'),
      onRemoved: event('tabs.onRemoved'),
      onActivated: event('tabs.onActivated'),
    },
    alarms: {
      create: (...args) => record('alarms.create', args),
      clear: (...args) => cbOrPromise('alarms.clear', args, true),
      get: (...args) => cbOrPromise('alarms.get', args, undefined),
      getAll: (...args) => cbOrPromise('alarms.getAll', args, []),
      onAlarm: event('alarms.onAlarm'),
    },
    action: {
      setBadgeText: (...args) => cbOrPromise('action.setBadgeText', args, undefined),
      setBadgeBackgroundColor: (...args) => cbOrPromise('action.setBadgeBackgroundColor', args, undefined),
      setTitle: (...args) => cbOrPromise('action.setTitle', args, undefined),
      openPopup: (...args) => { record('action.openPopup', args); return Promise.reject(new Error('no user gesture')); },
    },
    downloads: {
      download: (...args) => cbOrPromise('downloads.download', args, 7),
      search: (...args) => cbOrPromise('downloads.search', args, [{ id: 7, state: 'complete' }]),
      onChanged: event('downloads.onChanged'),
      onDeterminingFilename: event('downloads.onDeterminingFilename'),
    },
    notifications: {
      create: (...args) => cbOrPromise('notifications.create', args, typeof args[0] === 'string' ? args[0] : 'n'),
      clear: (...args) => cbOrPromise('notifications.clear', args, true),
      onClicked: event('notifications.onClicked'),
      onClosed: event('notifications.onClosed'),
      onButtonClicked: event('notifications.onButtonClicked'),
    },
    debugger: {
      attach: (...args) => cbOrPromise('debugger.attach', args, undefined),
      detach: (...args) => cbOrPromise('debugger.detach', args, undefined),
      sendCommand: (...args) => cbOrPromise('debugger.sendCommand', args, {}),
      onDetach: event('debugger.onDetach'),
      onEvent: event('debugger.onEvent'),
    },
    scripting: {
      executeScript: (...args) => cbOrPromise('scripting.executeScript', args, [{ result: undefined }]),
    },
    windows: {
      create: (...args) => cbOrPromise('windows.create', args, { id: 9, tabs: [{ id: 90 }] }),
      update: (...args) => cbOrPromise('windows.update', args, {}),
      remove: (...args) => cbOrPromise('windows.remove', args, undefined),
      get: (...args) => cbOrPromise('windows.get', args, { id: args[0], state: 'normal' }),
      getCurrent: (...args) => cbOrPromise('windows.getCurrent', args, { id: 1 }),
      getLastFocused: (...args) => cbOrPromise('windows.getLastFocused', args, { id: 1 }),
      onRemoved: event('windows.onRemoved'),
    },
  };
  globalThis.chrome = new Proxy(chrome, {
    get(target, prop) { return prop in target ? target[prop] : generic(String(prop)); },
  });
  for (const ns of Object.keys(chrome)) {
    if (ns === 'runtime' || ns === 'storage') continue;
    chrome[ns] = new Proxy(chrome[ns], { get(t, p) { return p in t ? t[p] : generic(`${ns}.${String(p)}`); } });
  }

  const consoleLog = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug']) {
    console[level] = (...args) => consoleLog.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(describe(a)))).join(' ')}`);
  }

  /** Run queued callbacks and due timers until idle, or until `budgetMs` of virtual time passes. */
  async function settle(budgetMs = 120_000) {
    const until = now + budgetMs;
    for (let guard = 0; guard < 100_000; guard++) {
      await new Promise((r) => realSetImmediate(r));
      if (pending > 0) continue;
      timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const next = timers[0];
      if (!next || next.due > until) return;
      now = Math.max(now, next.due);
      if (next.interval) next.due = now + next.interval; else timers.shift();
      next.fn();
    }
    throw new Error('settle: did not become idle');
  }

  return {
    log, consoleLog, data, events, tabReplies, zoom,
    settle,
    get now() { return now; },
    advance(ms) { now += ms; },
    pendingTimers: () => timers.length,
    setLastError(v) { lastErrorState.value = v; },
  };
}
