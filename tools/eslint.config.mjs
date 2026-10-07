// ESLint config for development only — the extension itself has no dependencies
// and no package.json. Run (the version is pinned so the baseline stays comparable):
//   npx --yes eslint@9.39.5 -c tools/eslint.config.mjs .
// `no-undef` is left out so no `globals` package is needed.
// tools/verify.mjs compares the warning count with tools/eslint-baseline.json:
// a change may not add warnings, and is not required to remove any.

export default [
  { ignores: ['sqlcases/i18n/**', '**/selftest.mjs', 'dbtools/e2e/**', 'tests/**', 'tools/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-shadow': 'warn',
      'no-nested-ternary': 'warn',
      'max-depth': ['warn', 5],
      'max-params': ['warn', 5],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      'complexity': ['warn', 20],
    },
  },
  { files: ['content.js', 'content-highlight.js', 'editor.js', 'dbtools/boot.js'], languageOptions: { sourceType: 'script' } },
  // Parsers: the complexity is the nature of the code (state machines, case analysis),
  // and splitting a lexer or a recursive-descent method only scatters it.
  { files: ['sqlcases/tokenizer.js', 'sqlcases/parser.js'], rules: { complexity: 'off', 'max-depth': 'off', 'max-lines-per-function': 'off' } },
  // Elsewhere an accepted case analysis carries an eslint-disable-next-line comment
  // that says why (sqlcases/hints.js resolve, ep-bva.js partitionsFor,
  // shared/switch-blocks.js planDrop).
];
