/**
 * tools/e2e/changed.mjs — e2e --changed: the suites the files being edited can break.
 *
 * The files are those `git diff HEAD` names plus the untracked ones. Each goes through
 * RULES (the first that matches wins); a file no rule knows runs every suite, and so
 * does anything of playback, the content scripts or the manifest. Docs and tests run
 * none. The full run (no option, or `verify --all`) stays the check before a push.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = 'all';
// The suites that open the popup.
const POPUP = ['editor', 'vars', 'record', 'run', 'export', 'csv'];
// ${ suggestions: the popup's, the CSV card's ZIP folder name and the API Tests page.
const SUGGEST = ['vars', 'csv', 'api'];

// [paths, suites]: a path ending in "/" is a folder, a RegExp a pattern, anything else one file.
const RULES = [
  // Not loaded by the extension, or checked elsewhere (dbtools/e2e, the unit tests).
  [['docs/', 'tasks/', 'tests/', 'test/', 'graphify-out/', 'icons/', '.claude/', 'dbtools/', /\.md$/, '.gitignore',
    'tools/check-imports.mjs', 'tools/eslint.config.mjs', 'tools/eslint-baseline.json', 'tools/pack.mjs',
    'tools/smoke.mjs', 'tools/smoke-cdp.mjs', 'tools/verify.mjs', 'tools/lib/js-tokens.mjs', 'tools/lib/modules.mjs',
    'tools/lib/smoke-pages.mjs', 'tools/e2e/changed.mjs'], []],
  // The runner and what every suite stands on.
  [['tools/e2e.mjs', 'tools/e2e/harness.mjs', 'tools/e2e/test-pages.mjs', 'tools/lib/'], ALL],
  [['apicases/', 'apitest.html', 'css/apicases.css', 'shared/api-request.js', 'shared/api-response.js'], ['api']],
  [['sqlcases/', 'sqltest.html', 'css/sqlcases.css'], ['pages']],
  [['content-highlight.js', 'popup/highlight.js', 'bg/handlers/highlight.js', 'shared/highlight-store.js',
    'css/popup/11-highlight.css', 'popup/scenarios/import-export.js'], ['pages']],
  // A capture and what follows it: the clipboard, Recent captures, Image Diff, the editor.
  [['bg/screenshot/', 'bg/screenshot.js', 'bg/handlers/capture.js', 'popup/capture/', 'popup/screenshots.js',
    'shared/recent-captures.js', 'shared/pixel-diff.js', 'editor.js', 'editor.html', 'css/editor.css',
    'capture-window.js', 'capture-window.html', 'css/popup/08-capture.css'], ['locate', 'capture']],
  [['popup/csv/', 'bg/handlers/csv.js', 'popup/lib/zip-writer.js'], ['csv', 'run']],
  [['popup/export/', 'popup/export-modal.js', 'popup/export-bookmarklet.js', 'popup/export-selenium.js',
    'popup/export-playwright.js', 'popup/export-robot.js', 'popup/export-java.js'], ['export', 'export-run']],
  [['css/popup/10-motion-export-lock.css'], ['export']],
  [['shared/file-export.js'], ['export', 'csv', 'api']],
  [['shared/var-suggest.js', 'popup/ui/var-suggest.js', 'popup/record/var-suggestions.js', 'css/var-suggest.css'], SUGGEST],
  [['popup/variables.js', 'css/popup/03-variables.css'], ['vars']],
  [['popup/record/recorder.js', 'bg/handlers/recording.js'], ['record']],
  [['popup/record/picker.js', 'bg/handlers/picker.js'], ['editor', 'record']],
  // 📱 Run as under Loop: played and checked by the run suite (run-as).
  [['popup/scenarios/run-as.js'], ['run']],
  [['popup/record/', 'popup/scenarios/', 'bg/handlers/folders.js', 'css/popup/02-action-list.css',
    'css/popup/04-lists-cards-forms.css', 'css/popup/12-switch-blocks.css'], ['editor', 'vars']],
  [['css/popup/07-switch-loop-csv.css'], ['editor', 'csv']],
  [['popup/run/', 'bg/schedule-alarms.js', 'bg/handlers/schedules.js', 'shared/run-history.js'], ['run', 'record']],
  [['popup/theme.js'], [...POPUP, 'pages']],
  [['popup.html', 'popup/main.js', 'popup/init.js', 'popup/dom.js', 'popup/utils.js', 'popup/connection.js',
    'popup/ui-state.js', 'popup/settings.js', 'popup/tab-activation.js', 'popup/notices.js', 'popup/update-banner.js',
    'popup/ui/', 'popup/help/', 'popup/lib/', 'css/popup/'], POPUP],
];

const matches = (rule, path) => (rule instanceof RegExp ? rule.test(path)
  : rule.endsWith('/') ? path.startsWith(rule) : path === rule);

/** What one file runs: an array of suites (maybe empty) or "all". */
function suitesOf(path, suiteNames) {
  const own = path.match(/^tools\/e2e\/([a-z-]+)\.mjs$/);
  if (own && suiteNames.includes(own[1])) return [own[1]];
  const hit = RULES.find(([rules]) => rules.some((r) => matches(r, path)));
  return hit ? hit[1] : ALL;
}

/**
 * The suites `paths` can break, in `suiteNames` order, and why: [[path, suites | "all"]].
 * Paths are relative to the repo, with "/" (as git prints them).
 */
export function suitesFor(paths, suiteNames) {
  const why = paths.map((p) => [p, suitesOf(p, suiteNames)]);
  const all = why.some(([, s]) => s === ALL);
  const picked = new Set(all ? suiteNames : why.flatMap(([, s]) => s));
  return { suites: suiteNames.filter((s) => picked.has(s)), why };
}

/** The files being edited: changed since HEAD (staged or not), and untracked ones. */
export function changedFiles() {
  // stderr dropped: git warns there about line endings, which says nothing about what changed.
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set([...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')])];
}
