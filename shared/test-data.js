/**
 * test-data.js — the Random variable kinds that make test data: an email, a phone
 * number, a full name, a number between two, a date a number of days from today,
 * a UUID. A run draws a new value for each (bg/interpolate.js resolveRandomVars);
 * the five code exports draw theirs by the same rules, from these lists.
 *
 * Spelled as specs like the character kinds (`{random:alpha:8}`):
 *   {random:email:example.test}   qa_k3x9m2@example.test
 *   {random:phone:vn}             0912345678 — 03 / 05 / 07 / 08 / 09 + 8 digits
 *   {random:name:vi}              Nguyễn Văn An (vi), Olivia Brown (en)
 *   {random:int:100:500}          a whole number from 100 to 500
 *   {random:date:+1:dd/MM/yyyy}   tomorrow, in the machine's time zone
 *   {random:uuid}                 a version 4 UUID
 *
 * Pure — no chrome.*.
 */

export const DATA_KINDS = Object.freeze(['email', 'phone', 'name', 'int', 'date', 'uuid']);

/** Date formats a Date variable may have: only dd, MM and yyyy are tokens. */
export const DATE_FORMATS = Object.freeze(['dd/MM/yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'dd-MM-yyyy', 'dd.MM.yyyy']);

export const PHONE_PREFIXES = Object.freeze(['03', '05', '07', '08', '09']);
export const EMAIL_LOCAL = 'qa_';
export const EMAIL_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const EMAIL_LENGTH = 6;

export const NAMES = Object.freeze({
  vi: Object.freeze({
    last: ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương'],
    middle: ['Văn', 'Thị', 'Minh', 'Thu', 'Quốc', 'Ngọc', 'Hữu', 'Gia', 'Thanh', 'Đức'],
    first: ['An', 'Bình', 'Chi', 'Dũng', 'Giang', 'Hà', 'Hải', 'Hùng', 'Khánh', 'Lan', 'Linh', 'Mai', 'Nam', 'Phúc', 'Quân', 'Sơn', 'Thảo', 'Trang', 'Tuấn', 'Vy'],
  }),
  en: Object.freeze({
    first: ['James', 'Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Sophia', 'Mason', 'Isabella'],
    last: ['Smith', 'Johnson', 'Brown', 'Taylor', 'Lee', 'Walker', 'Clark', 'Young', 'King', 'Wright', 'Hall', 'Allen'],
  }),
});

/** The name parts of `lang`, in the order they are joined. */
export const nameParts = (lang) => (lang === 'en' ? [NAMES.en.first, NAMES.en.last] : [NAMES.vi.last, NAMES.vi.middle, NAMES.vi.first]);

const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const INT_MAX = 1e12;

/**
 * The spec of a test-data kind from its parts after `{random:` — `kind` and the
 * `args` the colons split — as { type, … }, or null when they do not make one.
 */
export function parseDataSpec(kind, args = []) {
  const [n, parse] = PARSERS[kind] || [];
  return parse && args.length === n ? parse(...args) : null;
}

/** Per kind: how many parts after `{random:<kind>`, and what they make (null: nothing). */
const PARSERS = {
  email: [1, (domain) => (DOMAIN_RE.test(domain) && domain.length <= 100 ? { type: 'email', domain } : null)],
  phone: [1, (country) => (country === 'vn' ? { type: 'phone', country } : null)],
  name: [1, (lang) => (lang === 'vi' || lang === 'en' ? { type: 'name', lang } : null)],
  int: [2, (a, b) => {
    if (!/^-?\d{1,13}$/.test(a) || !/^-?\d{1,13}$/.test(b)) return null;
    const min = Number(a), max = Number(b);
    return min <= max && Math.abs(min) <= INT_MAX && Math.abs(max) <= INT_MAX ? { type: 'int', min, max } : null;
  }],
  date: [2, (days, format) => (/^[+-]?\d{1,5}$/.test(days) && DATE_FORMATS.includes(format) ? { type: 'date', days: Number(days), format } : null)],
  uuid: [0, () => ({ type: 'uuid' })],
};

/** A test-data spec as its string: `{random:date:+1:dd/MM/yyyy}`. */
export function dataSpecString(spec) {
  switch (spec?.type) {
    case 'email': return `{random:email:${spec.domain}}`;
    case 'phone': return '{random:phone:vn}';
    case 'name': return `{random:name:${spec.lang === 'en' ? 'en' : 'vi'}}`;
    case 'int': return `{random:int:${spec.min}:${spec.max}}`;
    case 'date': return `{random:date:${spec.days < 0 ? '' : '+'}${spec.days}:${spec.format}}`;
    case 'uuid': return '{random:uuid}';
    default: return '';
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `date` written in `format` (DATE_FORMATS). */
export function formatDate(date, format) {
  const parts = { dd: pad2(date.getDate()), MM: pad2(date.getMonth() + 1), yyyy: String(date.getFullYear()) };
  return format.replace(/yyyy|MM|dd/g, (t) => parts[t]);
}

/**
 * A value of a test-data spec. `now` is the run's clock, `rnd` its random numbers
 * in [0, 1) (Math.random): a test passes its own.
 */
export function dataValue(spec, { now = new Date(), rnd = Math.random } = {}) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const chars = (set, n) => Array.from({ length: n }, () => pick(set)).join('');
  switch (spec?.type) {
    case 'email': return `${EMAIL_LOCAL}${chars(EMAIL_CHARS, EMAIL_LENGTH)}@${spec.domain}`;
    case 'phone': return pick(PHONE_PREFIXES) + chars('0123456789', 8);
    case 'name': return nameParts(spec.lang).map(pick).join(' ');
    case 'int': return String(spec.min + Math.floor(rnd() * (spec.max - spec.min + 1)));
    case 'date': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + spec.days);
      return formatDate(d, spec.format);
    }
    case 'uuid': {
      const hex = chars('0123456789abcdef', 32).split('');
      hex[12] = '4';
      hex[16] = '89ab'[Math.floor(rnd() * 4)];
      const h = hex.join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    default: return '';
  }
}

/** What a test-data variable makes, in a few words: "Date · today +1 · dd/MM/yyyy". */
export function dataDescription(spec) {
  switch (spec?.type) {
    case 'email': return `Email · @${spec.domain}`;
    case 'phone': return 'Phone · Vietnam';
    case 'name': return `Full name · ${spec.lang === 'en' ? 'English' : 'Vietnamese'}`;
    case 'int': return `Number ${spec.min}–${spec.max}`;
    case 'date': {
      const when = spec.days === 0 ? 'today' : `today ${spec.days > 0 ? '+' : '−'}${Math.abs(spec.days)}`;
      return `Date · ${when} · ${spec.format}`;
    }
    case 'uuid': return 'UUID';
    default: return '';
  }
}
