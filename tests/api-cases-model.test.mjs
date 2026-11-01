// API Tests page data (apicases/model.js): folders, cases, what a saved state
// is cleaned up to, and that no operation changes the state it was given.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../apicases/model.js');

/** Two folders, three cases: a1, a2 in A, b1 in B. */
function sample() {
  let s = M.emptyState();
  let r = M.addFolder(s, 'A'); s = r.state; const A = r.id;
  r = M.addFolder(s, 'B'); s = r.state; const B = r.id;
  s = M.select(s, { folderId: A });
  r = M.addCase(s, { name: 'a1' }); s = r.state; const a1 = r.id;
  r = M.addCase(s, { name: 'a2', method: 'POST', url: 'https://x.test/users' }); s = r.state; const a2 = r.id;
  s = M.select(s, { folderId: B });
  r = M.addCase(s, { name: 'b1' }); s = r.state; const b1 = r.id;
  return { s, A, B, a1, a2, b1 };
}

const names = (s, opts) => M.visibleCases(s, opts).map((c) => c.name);

test('a new case goes into the open folder and is opened', () => {
  const { s, A, a2 } = sample();
  assert.deepEqual(names(M.select(s, { folderId: A })), ['a1', 'a2']);
  assert.equal(M.findCase(s, a2).folderId, A);
  assert.equal(s.caseId, M.visibleCases(s).at(-1).id, 'the last added case is open');
});

test('under All requests: into the first folder, or a new default folder', () => {
  const { s, A } = sample();
  const { state, id } = M.addCase(M.select(s, { folderId: M.ALL }), { name: 'x' });
  assert.equal(M.findCase(state, id).folderId, A);
  assert.equal(state.folderId, M.ALL, 'the view stays on All requests');

  const fresh = M.addCase(M.emptyState(), { name: 'first' });
  assert.equal(fresh.state.folders.length, 1);
  assert.equal(fresh.state.folders[0].name, 'My API tests');
  assert.equal(M.findCase(fresh.state, fresh.id).folderId, fresh.state.folders[0].id);
  assert.equal(fresh.state.folderId, M.ALL);
});

test('filter by text (name or URL) and by method', () => {
  const { s } = sample();
  const all = M.select(s, { folderId: M.ALL });
  assert.deepEqual(names(all), ['a1', 'a2', 'b1']);
  assert.deepEqual(names(all, { query: 'USERS' }), ['a2']);
  assert.deepEqual(names(all, { query: 'b' }), ['b1']);
  assert.deepEqual(names(all, { method: 'POST' }), ['a2']);
  assert.deepEqual(names(all, { method: 'GET', query: 'a' }), ['a1']);
});

test('duplicate: right after the original, renamed, without its run result', () => {
  const { s, A, a1 } = sample();
  const withLast = M.updateCase(s, a1, { last: { status: 200 } });
  const { state, id } = M.duplicateCase(withLast, a1);
  assert.deepEqual(names(M.select(state, { folderId: A })), ['a1', 'a1 (copy)', 'a2']);
  assert.equal(M.findCase(state, id).last, undefined);
  assert.equal(state.caseId, id);
});

test('delete, move, reorder', () => {
  const { s, A, B, a1, a2, b1 } = sample();
  const del = M.deleteCases(M.select(s, { caseId: a2 }), [a2]);
  assert.deepEqual(names(M.select(del, { folderId: M.ALL })), ['a1', 'b1']);
  assert.equal(del.caseId, null, 'the open case was deleted');

  const moved = M.moveCases(s, [a1], B);
  assert.deepEqual(names(M.select(moved, { folderId: B })), ['b1', 'a1'], 'after the cases already there');
  assert.equal(M.moveCases(s, [a1], 'nope'), s, 'no such folder: unchanged');

  assert.deepEqual(names(M.select(M.reorderCase(s, a2, a1), { folderId: A })), ['a2', 'a1']);
  assert.deepEqual(names(M.select(M.reorderCase(s, a1, null), { folderId: M.ALL })), ['a2', 'b1', 'a1']);
  assert.equal(M.reorderCase(s, b1, b1), s);
});

test('rename and delete a folder (its cases go with it)', () => {
  const { s, A, B, a1 } = sample();
  assert.equal(M.findFolder(M.renameFolder(s, A, '  Users  '), A).name, 'Users');
  assert.equal(M.renameFolder(s, A, '   '), s, 'an empty name is refused');

  const opened = M.select(s, { folderId: A, caseId: a1 });
  const gone = M.deleteFolder(opened, A);
  assert.deepEqual(gone.folders.map((f) => f.id), [B]);
  assert.deepEqual(names(M.select(gone, { folderId: M.ALL })), ['b1']);
  assert.equal(gone.folderId, M.ALL);
  assert.equal(gone.caseId, null);
});

test('folder counts', () => {
  const { s, A, B } = sample();
  assert.deepEqual(M.folderCounts(s), { [A]: 2, [B]: 1 });
  const { state, id } = M.addFolder(s, 'empty');
  assert.equal(M.folderCounts(state)[id], 0);
});

test('no operation changes the state it is given', () => {
  const { s, A, B, a1, a2 } = sample();
  const before = structuredClone(s);
  M.addFolder(s, 'x'); M.renameFolder(s, A, 'y'); M.deleteFolder(s, A);
  M.addCase(s); M.updateCase(s, a1, { name: 'z' }); M.duplicateCase(s, a1);
  M.deleteCases(s, [a1]); M.moveCases(s, [a1], B); M.reorderCase(s, a2, a1);
  assert.deepEqual(s, before);
});

test('urlProblem / jsonProblem: what the editor says under the field', () => {
  assert.equal(M.urlProblem(''), 'Enter a URL');
  assert.equal(M.urlProblem('https://api.test/users?id=1'), '');
  assert.equal(M.urlProblem('http://localhost:8080/${path}'), '', 'a variable inside is fine');
  assert.equal(M.urlProblem('${baseUrl}/users'), '', 'starting with a variable: known only when sent');
  assert.match(M.urlProblem('api.test/users'), /^Not a valid URL/);
  assert.match(M.urlProblem('ftp://x.test/'), /^Only http/);

  assert.equal(M.jsonProblem(''), '');
  assert.equal(M.jsonProblem('{"a": 1, "b": [true, null]}'), '');
  assert.equal(M.jsonProblem('{"name": "${name}", "age": ${age}}'), '', 'variables stand for values');
  assert.match(M.jsonProblem('{"a": 1,}'), /^Not valid JSON: /);
});

test('normalizeState: a saved state made safe to render', () => {
  assert.deepEqual(M.normalizeState(null), M.emptyState());
  assert.deepEqual(M.normalizeState('junk'), M.emptyState());
  const s = M.normalizeState({
    folders: [{ id: 'f1', name: 'A' }, { name: 'no id' }, null],
    cases: [
      { id: 'c1', folderId: 'f1', name: 'ok', method: 'POST', url: 'u', timeoutMs: 999_999, checks: [{ on: 'status' }] },
      { id: 'c2', folderId: 'gone' },
      { id: 'c3', folderId: 'f1', method: 'FETCH', bodyType: 'xml', timeoutMs: -1, cookies: false },
      { folderId: 'f1' },
    ],
    folderId: 'gone',
    caseId: 'c2',
  });
  assert.deepEqual(s.folders, [{ id: 'f1', name: 'A', auth: { type: 'none' } }]);
  assert.deepEqual(s.cases.map((c) => c.id), ['c1', 'c3']);
  assert.equal(s.cases[0].timeoutMs, M.MAX_TIMEOUT_MS);
  assert.deepEqual(s.cases[0].checks, [{ on: 'status' }], 'fields of later versions are kept');
  assert.equal(s.cases[1].method, 'GET');
  assert.equal(s.cases[1].bodyType, 'none');
  assert.equal(s.cases[1].timeoutMs, M.DEFAULT_TIMEOUT_MS);
  assert.equal(s.cases[1].cookies, false);
  assert.equal(s.folderId, M.ALL);
  assert.equal(s.caseId, null);
});

test('auth: a case inherits its folder\'s, sets its own, or sends none', () => {
  let { s, A, a1, a2, b1 } = sample();
  assert.deepEqual(M.findCase(s, a1).auth, { type: 'inherit' });
  assert.deepEqual(M.findFolder(s, A).auth, { type: 'none' });
  s = M.setFolderAuth(s, A, { type: 'bearer', token: '${token}' });
  s = M.updateCase(s, a2, { auth: { type: 'none' } });
  assert.deepEqual(M.requestOf(s, M.findCase(s, a1)).auth, { type: 'bearer', token: '${token}' }, 'inherits the folder\'s');
  assert.deepEqual(M.requestOf(s, M.findCase(s, a2)).auth, { type: 'none' }, 'its own None wins');
  assert.deepEqual(M.requestOf(s, M.findCase(s, b1)).auth, { type: 'none' }, 'a folder with no auth');
  assert.equal(M.findCase(s, a1).auth.type, 'inherit', 'the case itself is unchanged');
});

test('normalizeAuth: a known type, string fields, header or query; a folder never inherits', () => {
  assert.deepEqual(M.normalizeAuth({ type: 'apikey', key: 'k', value: 1, in: 'cookie' }, 'inherit'), { type: 'apikey', key: 'k', in: 'header' });
  assert.deepEqual(M.normalizeAuth({ type: 'oauth2' }, 'inherit'), { type: 'inherit' });
  assert.deepEqual(M.normalizeAuth({ type: 'inherit' }, 'none'), { type: 'none' });
  assert.deepEqual(M.normalizeAuth(undefined, 'none'), { type: 'none' });
});
