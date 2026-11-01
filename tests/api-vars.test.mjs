// The variables an API request is filled with (apicases/vars.js), and the
// environments of the page (apicases/model.js).
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveVars, envVarObject } = await import('../apicases/vars.js');
const M = await import('../apicases/model.js');

test('the environment wins on a name both have; the Data tab fills the rest', () => {
  const vars = resolveVars({ baseUrl: 'https://prod.test', user: 'an' }, { baseUrl: 'https://staging.test' });
  assert.deepEqual(vars, { baseUrl: 'https://staging.test', user: 'an' });
});

test('specs are resolved in both layers', () => {
  const vars = resolveVars({ code: '{random:numeric:6}', who: '{fallback:|b|c}' }, { color: '{pick:red|red}' });
  assert.match(vars.code, /^\d{6}$/);
  assert.equal(vars.who, 'b', 'fallback: the first value that is not blank');
  assert.equal(vars.color, 'red');
});

test('envVarObject: ${name} rows normalized, unusable names left out, a later row wins', () => {
  assert.deepEqual(envVarObject({ vars: [
    { name: '${token}', value: 't1' }, { name: '', value: 'x' }, { name: 'a}b', value: 'y' }, { name: 'token', value: 't2' },
  ] }), { token: 't2' });
  assert.deepEqual(envVarObject(null), {});
});

test('a new page has one environment, Default, in use', () => {
  const s = M.emptyState();
  assert.deepEqual(s.environments.map((e) => e.name), ['Default']);
  assert.equal(M.activeEnv(s).name, 'Default');
  assert.deepEqual(M.normalizeState(null), s, 'the same every time: the Default id is fixed');
});

test('add, rename, duplicate, use, delete', () => {
  let s = M.emptyState();
  let r = M.addEnvironment(s, 'Dev', [{ name: 'baseUrl', value: 'http://dev' }]); s = r.state; const dev = r.id;
  assert.equal(M.activeEnv(s).name, 'Default', 'a new environment is not put in use');
  s = M.useEnvironment(s, dev);
  assert.equal(M.activeEnv(s).name, 'Dev');
  s = M.renameEnvironment(s, dev, '  Develop ');
  assert.equal(M.findEnv(s, dev).name, 'Develop');
  assert.equal(M.renameEnvironment(s, dev, ' '), s, 'a blank name is refused');
  r = M.duplicateEnvironment(s, dev); s = r.state;
  assert.deepEqual(s.environments.map((e) => e.name), ['Default', 'Develop', 'Develop (copy)']);
  assert.deepEqual(M.findEnv(s, r.id).vars, [{ name: 'baseUrl', value: 'http://dev' }]);
  s = M.deleteEnvironment(s, dev);
  assert.deepEqual(s.environments.map((e) => e.name), ['Default', 'Develop (copy)']);
  assert.equal(M.activeEnv(s).name, 'Default', 'deleting the one in use falls back to the first');
  const one = M.deleteEnvironment(M.deleteEnvironment(s, r.id), 'default');
  assert.equal(one.environments.length, 1, 'the last one stays');
});

test('saveEnvValues writes into the environment in use, updating or adding', () => {
  let s = M.setEnvVars(M.emptyState(), 'default', [{ name: 'token', value: 'old' }, { name: 'base', value: 'b' }]);
  s = M.saveEnvValues(s, { token: 'new', userId: '7' });
  assert.deepEqual(M.activeEnv(s).vars, [{ name: 'token', value: 'new' }, { name: 'base', value: 'b' }, { name: 'userId', value: '7' }]);
  assert.equal(M.saveEnvValues(s, {}), s);
});

test('envVarProblems: blank, "}" and repeated names', () => {
  assert.deepEqual(M.envVarProblems([
    { name: 'a', value: '1' }, { name: '', value: '' }, { name: '', value: 'x' }, { name: 'x}y', value: '' }, { name: '${a}', value: '2' },
  ]), ['', '', 'Name this variable', 'A name cannot hold "}"', '"a" is already above']);
});

test('normalizeState keeps environments and falls back when the one in use is gone', () => {
  const s = M.normalizeState({
    folders: [], cases: [],
    environments: [{ id: 'e1', name: 'Dev', vars: [{ name: 'x', value: '1' }, null, { name: 2 }] }, { name: 'no id' }],
    envId: 'gone',
  });
  assert.deepEqual(s.environments, [{ id: 'e1', name: 'Dev', vars: [{ name: 'x', value: '1' }, { name: '', value: '' }] }]);
  assert.equal(s.envId, 'e1');
  assert.deepEqual(M.normalizeState({ environments: [] }).environments.map((e) => e.name), ['Default']);
});

test('deleting a folder keeps the environments', () => {
  let s = M.addFolder(M.emptyState(), 'A').state;
  s = M.addEnvironment(s, 'Dev').state;
  assert.equal(M.deleteFolder(s, s.folders[0].id).environments.length, 2);
});

test('varEntries: the environment first, then names cases save; secret-looking values hidden', async () => {
  const { varEntries } = await import('../apicases/ui/var-suggest.js');
  let s = M.setEnvVars(M.emptyState(), 'default', [{ name: 'baseUrl', value: 'https://a.test' }, { name: 'apiToken', value: 't' }, { name: '', value: 'x' }]);
  s = M.addCase(s, { name: 'Login', extracts: [{ varName: 'token', from: 'json', path: 'access_token' }, { from: 'body', path: 'id=${userId};' }] }).state;
  const entries = await varEntries(s);
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.name}:${e.detail.text}`), [
    'e:baseUrl:Default: https://a.test',
    'e:apiToken:Default: ••••',
    'w:token:saved by Login',
    'w:userId:saved by Login',
  ]);
});
