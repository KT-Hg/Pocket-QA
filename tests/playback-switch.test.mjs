// Runs bg/playback.js against a stubbed `chrome` and records which actions
// reach the page, to check the order Switch blocks play in.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const played = [];
let scenarios = {};

// Any chrome.* call: invoke a trailing callback with {} and return a resolved
// promise, so both callback- and promise-style call sites carry on.
function stub(path = []) {
  const fn = () => {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'lastError') return undefined;
      return stub([...path, String(prop)]);
    },
    apply(_t, _this, args) {
      const name = path.join('.');
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (name === 'tabs.sendMessage') {
        const msg = args[1];
        if (msg?.type === 'PLAY_ACTION') played.push(msg.action.label);
        const res = msg?.action?.type === 'readdom' ? { value: 'read' } : {};
        if (cb) setTimeout(() => cb(res), 0);
        return;
      }
      if (name === 'storage.local.get' && cb) { setTimeout(() => cb({ scenarios }), 0); return; }
      if (cb) setTimeout(() => cb({}), 0);
      return Promise.resolve({});
    },
  });
}
globalThis.chrome = stub();

const { playActionsOnTab, startPlaybackFromCheckpoint } = await import('../bg/playback.js');
const { state } = await import('../bg/state.js');

const act = (label) => ({ type: 'hover', selector: `#${label}`, label });
const blk = (value, startAt, endAt) => ({ value, scenarioId: '__self__', startAt, endAt });
const sample = () => [
  { type: 'switch', switchVar: '${a}', label: 'S', cases: [blk('1', 2, 3), blk('2', 4, 5)] },
  act('A'), act('B'), act('C'), act('D'), act('E'),
];

async function run(actions, vars) {
  played.length = 0;
  state.playback = { active: true, tabId: 1, scenarioId: null, actionIndex: 0, totalActions: actions.length };
  await playActionsOnTab(1, actions, { vars });
  return [...played];
}

test('sample: a = 1 / 2 / other', async () => {
  assert.deepEqual(await run(sample(), { a: '1' }), ['A', 'B', 'E']);
  assert.deepEqual(await run(sample(), { a: '2' }), ['C', 'D', 'E']);
  assert.deepEqual(await run(sample(), { a: 'x' }), ['E']);
});

test('old-style jump switch is unchanged', async () => {
  const acts = [
    { type: 'switch', switchVar: '${a}', cases: [{ value: '1', scenarioId: '__self__', startAt: 3 }] },
    act('A'), act('B'), act('C'),
  ];
  assert.deepEqual(await run(acts, { a: '1' }), ['B', 'C']);
});

test('disabled block switch skips its block; disabled old switch runs on', async () => {
  const acts = sample();
  acts[0].disabled = true;
  assert.deepEqual(await run(acts, { a: '1' }), ['E']);
  const old = [
    { type: 'switch', disabled: true, switchVar: '${a}', cases: [{ value: '1', scenarioId: '__self__', startAt: 3 }] },
    act('A'), act('B'),
  ];
  assert.deepEqual(await run(old, { a: '1' }), ['A', 'B']);
});

test('nested switch and explicit continueAt', async () => {
  const acts = [
    { type: 'switch', switchVar: '${a}', cases: [blk('1', 2, 5)] },          // #1
    act('A'),                                                                // #2
    { type: 'switch', switchVar: '${b}', cases: [blk('p', 4, 4), blk('q', 5, 5)] }, // #3
    act('P'),                                                                // #4
    act('Q'),                                                                // #5
    act('X'),                                                                // #6
    act('Y'),                                                                // #7
  ];
  assert.deepEqual(await run(acts, { a: '1', b: 'q' }), ['A', 'Q', 'X', 'Y']);
  acts[0].continueAt = 7;
  assert.deepEqual(await run(acts, { a: '1', b: 'p' }), ['A', 'P', 'Y']);
});

test('condition skip counts the switch and its block as one action', async () => {
  const acts = [
    { type: 'condition', conditionType: 'elementExists', selector: '#none', skipCount: 1 },
    { type: 'switch', switchVar: '${a}', cases: [blk('1', 3, 3)] },
    act('A'),
    act('E'),
  ];
  // The stubbed CHECK_CONDITION answers {} → condition false → skip 1.
  assert.deepEqual(await run(acts, { a: '1' }), ['E']);
});

test('case into another scenario limited by endAt', async () => {
  scenarios = { other: { name: 'Other', actions: [act('o1'), act('o2'), act('o3')] } };
  const acts = [
    { type: 'switch', switchVar: '${a}', cases: [{ value: '1', scenarioId: 'other', startAt: 2, endAt: 2 }] },
    act('A'),
  ];
  assert.deepEqual(await run(acts, { a: '1' }), ['o2', 'A']);
});

test('resume inside a case finishes the case, then continueAt', async () => {
  scenarios = { s1: { name: 'S1', actions: sample() } };
  played.length = 0;
  state.playback = { active: false };
  state.sequencePlayback = { active: false };
  state.csvPlayback = { active: false };
  state.recording = false;
  await startPlaybackFromCheckpoint('s1', 1, 1);
  assert.deepEqual(played, ['A', 'B', 'E']);
});

test('bare switch variable name reads as ${name}', async () => {
  const bare = () => [{ ...sample()[0], switchVar: 'a' }, ...sample().slice(1)];
  assert.deepEqual(await run(bare(), { a: '1' }), ['A', 'B', 'E']);
  assert.deepEqual(await run(bare(), { a: '2' }), ['C', 'D', 'E']);
  // No variables at all: still `${a}`, never the literal "a".
  const lit = [{ type: 'switch', switchVar: 'a', cases: [blk('a', 2, 2)] }, act('A'), act('B')];
  assert.deepEqual(await run(lit, {}), ['B']);
});

test('a false Condition skips its actions; an emptied one skips nothing', async () => {
  // The stub answers CHECK_CONDITION with {}, i.e. false.
  const c = (extra) => ({ type: 'condition', conditionType: 'elementExists', selector: '#x', skipCount: 1, ...extra });
  assert.deepEqual(await run([c(), act('A'), act('B')], {}), ['B']);
  assert.deepEqual(await run([c({ empty: true }), act('A'), act('B')], {}), ['A', 'B']);
});
