// Hand-built scenarios for the golden tests: every action type, Switch blocks
// (nested, empty case, default, jump to another scenario), Conditions with
// skipCount, disabled actions, child conditions, Read DOM patterns, uploads and
// variables of every kind, including non-ASCII names.

const sel = (css, extra = {}) => ({ selector: css, selectors: { css, xpath: `//*[@id="${css.replace(/^#/, '')}"]`, ...extra } });
const blk = (value, startAt, endAt, extra = {}) => ({ value, scenarioId: '__self__', startAt, endAt, ...extra });

export const SYNTHETIC_SCENARIOS = [
  {
    name: 'Every action type',
    actions: [
      { type: 'navigate', url: 'https://example.com/login?next=${page}', label: 'Open login' },
      { type: 'wait', value: '250', label: 'Settle' },
      { type: 'click', ...sel('#start'), label: 'Start', delay: 0 },
      { type: 'input', ...sel('#user'), value: '${user}', label: 'User' },
      { type: 'input', ...sel('#pass'), value: 'p@ss "quoted" \\ back`tick`' },
      { type: 'hover', ...sel('#menu') },
      { type: 'dropdown', ...sel('#country') },
      { type: 'dragdrop', ...sel('#card-1'), targetSelector: '#lane-2', targetSelectors: { css: '#lane-2' } },
      { type: 'script', code: "const n = '${user}';\nconsole.log(n, ${tên});\nreturn 1;", label: 'Inline script' },
      { type: 'readdom', ...sel('#greeting'), varName: '${greeting}', readFrom: 'visible' },
      { type: 'readdom', ...sel('#order'), varName: 'order', readFrom: 'text', pattern: 'Order #${orderId} for ${customer}', matchCase: true },
      { type: 'readdom', ...sel('#link'), varName: 'href', readFrom: 'attr', attrName: 'data-${attr}' },
      { type: 'screenshot', label: 'Visible' },
      { type: 'screenshot_full' },
      { type: 'screenshot_element', ...sel('#chart') },
      { type: 'screenshot_tovar', varName: 'shot', captureMode: 'visible' },
      { type: 'uploadFile', ...sel('#file'), folderPath: 'C:\\data', fileName: '${fileName}', fileNames: ['a.png', '${fileName}'] },
      { type: 'click', ...sel('#row'), conditions: { matchMode: 'any', textContains: '${tên}', classContains: '{fallback:a|b}' } },
      { type: 'click', ...sel('#disabled'), disabled: true },
    ],
  },
  {
    name: 'Conditions',
    actions: [
      { type: 'condition', conditionType: 'elementExists', ...sel('#banner'), skipCount: 2, label: 'Banner shown' },
      { type: 'click', ...sel('#close-banner') },
      { type: 'wait', value: '100' },
      { type: 'condition', conditionType: 'textContains', ...sel('#status'), expectedValue: '${expected}', skipCount: 1 },
      { type: 'input', ...sel('#note'), value: 'ok' },
      { type: 'condition', conditionType: 'urlContains', expectedValue: '/done' },
      { type: 'condition', conditionType: 'valueEquals', ...sel('#qty'), expectedValue: '3', skipCount: 1 },
      { type: 'click', ...sel('#nested') },
      { type: 'condition', conditionType: 'hasAttribute', ...sel('#x'), expectedValue: 'data-x=1', empty: true },
      { type: 'condition', conditionType: 'unknownKind', ...sel('#y') },
      { type: 'click', ...sel('#after') },
      { type: 'condition', conditionType: 'elementHidden', ...sel('#z'), skipCount: 'abc' },
      { type: 'click', ...sel('#z1') },
      { type: 'condition', conditionType: 'valueContains', ...sel('#legacy'), expectedValue: 'v', conditionSkipCount: 2 },
      { type: 'click', ...sel('#l1') },
      { type: 'click', ...sel('#l2'), sourceSelector: '#legacy-src', actionValue: 'old' },
      { type: 'uploadFile', ...sel('#up'), folderPath: '/tmp', uploadFileName: 'legacy.txt' },
    ],
  },
  {
    name: 'Switch blocks',
    actions: [
      { type: 'switch', switchVar: '${role}', label: 'By role', cases: [blk('admin', 2, 3), blk('user', 4, 6), { value: 'guest', scenarioId: '__self__', empty: true }, { value: '__default__', scenarioId: 'other-scn', startAt: 2 }] },
      { type: 'click', ...sel('#admin-1') },
      { type: 'click', ...sel('#admin-2') },
      { type: 'switch', switchVar: 'lang', cases: [blk('vi', 5, 5), blk('en', 6, 6)] },
      { type: 'input', ...sel('#vi'), value: 'Xin chào' },
      { type: 'input', ...sel('#en'), value: 'Hello' },
      { type: 'condition', conditionType: 'elementVisible', ...sel('#tail'), skipCount: 1 },
      { type: 'click', ...sel('#tail') },
      { type: 'switch', switchVar: '${jump}', cases: [{ value: 'a', scenarioId: '__self__', startAt: 10 }] },
      { type: 'wait', value: '50' },
      { type: 'switch', switchVar: '${broken}', cases: [blk('x', 9, 9)] },
      { type: 'click', ...sel('#end') },
    ],
  },
  {
    name: 'Tên có dấu & "quotes"',
    actions: [
      { type: 'input', ...sel('#ten'), value: '${tên} — ${họ_tên}' },
      { type: 'script', value: 'document.title = "${tên}";' },
      { type: 'readdom', ...sel('#ma'), varName: 'mã', pattern: '${a} - ${b}' },
    ],
  },
];

export const VARIABLE_SETS = {
  none: {},
  strings: { user: 'alice', page: '/home', tên: 'Đức', 'họ_tên': 'Nguyễn Văn A', expected: 'Ready', role: 'admin', lang: 'vi', attr: 'href', fileName: 'x.png' },
  configs: {
    user: { activeType: 's', s: 'bob', r: { type: 'alpha', length: '6' }, p: ['', ''], f: ['', ''] },
    token: { activeType: 'r', s: '', r: { type: 'alphanumeric', length: '12' }, p: ['', ''], f: ['', ''] },
    pin: { activeType: 'r', s: '', r: { type: 'numeric', length: '4' } },
    stamp: { activeType: 'r', s: '', r: { type: 'datetime', length: '0' } },
    word: { activeType: 'r', s: '', r: { type: 'alpha', length: '5' } },
    role: { activeType: 'p', p: ['admin', 'user', null] },
    lang: { activeType: 'f', f: ['vi', '', 'en'] },
    tên: { activeType: 's', s: 'Đức "the" \\ `bold`' },
    empty: { activeType: 'p', p: [] },
  },
  legacy: { token: '{random:alpha:8}', role: '{pick:admin|user|}', lang: '{fallback:vi|en}', n: 42, z: null },
};
