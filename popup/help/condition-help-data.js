/**
 * condition-help-data.js — the bilingual ({ vi, en }) content of the Condition
 * help modal: one entry per condition type, rendered by buildConditionHelpHTML()
 * in help-modals.js. Data only.
 */

export const COND_DATA = [
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementExists — Element tồn tại', en: 'elementExists — Element exists' },
    desc: { vi: 'Kiểm tra element có xuất hiện trong DOM không (dù đang ẩn). Nếu KHÔNG tồn tại → skip N actions tiếp theo.', en: 'Check if the element exists in the DOM (even if hidden). If NOT found → skip the next N actions.' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#submit-btn', note: { vi: '→ Nếu nút #submit-btn không có trong trang, bỏ qua N action kế tiếp', en: '→ If #submit-btn is not on the page, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementNotExists — Element không tồn tại', en: 'elementNotExists — Element does not exist' },
    desc: { vi: 'Kiểm tra element KHÔNG có trong DOM. Dùng để chờ loading spinner biến mất trước khi thao tác tiếp.', en: 'Check that the element is NOT in the DOM. Useful to wait for a loading spinner to disappear before continuing.' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '.loading-spinner', note: { vi: '→ Nếu spinner vẫn còn, bỏ qua N action kế tiếp', en: '→ If spinner is still present, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementVisible — Element đang hiển thị', en: 'elementVisible — Element is visible' },
    desc: { vi: 'Kiểm tra element tồn tại VÀ thực sự nhìn thấy được (display≠none, visibility≠hidden, opacity≠0, kích thước &gt;0).', en: 'Check that the element exists AND is truly visible (display≠none, visibility≠hidden, opacity≠0, size&gt;0).' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#error-message', note: { vi: '→ Nếu thông báo lỗi đang ẩn, bỏ qua N action kế tiếp', en: '→ If the error message is hidden, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementHidden — Element đang ẩn', en: 'elementHidden — Element is hidden' },
    desc: { vi: 'Kiểm tra element ẩn hoặc không tồn tại. Ngược lại với elementVisible.', en: 'Check that the element is hidden or does not exist. Opposite of elementVisible.' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#modal-overlay', note: { vi: '→ Nếu modal vẫn đang hiển thị, bỏ qua N action kế tiếp', en: '→ If the modal is still visible, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-text', badgeLabel: { vi: 'Text', en: 'Text' },
    title: { vi: 'textContains — Text chứa chuỗi', en: 'textContains — Text contains string' },
    desc: { vi: 'Kiểm tra nội dung text của element có chứa chuỗi được chỉ định không (phân biệt hoa thường).', en: 'Check if the element\'s text content contains the specified string (case-sensitive).' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: 'h1.page-title', expected: 'Dashboard', note: { vi: '→ Nếu tiêu đề không chứa "Dashboard", bỏ qua N action kế tiếp', en: '→ If the title does not contain "Dashboard", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-text', badgeLabel: { vi: 'Text', en: 'Text' },
    title: { vi: 'textEquals — Text khớp chính xác', en: 'textEquals — Text matches exactly' },
    desc: { vi: 'Kiểm tra nội dung text của element bằng đúng với giá trị mong đợi (trim whitespace).', en: 'Check that the element\'s text content exactly equals the expected value (whitespace trimmed).' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#status-badge', expected: 'Active', note: { vi: '→ Nếu badge không hiển thị đúng "Active", bỏ qua N action kế tiếp', en: '→ If badge does not show exactly "Active", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-value', badgeLabel: { vi: 'Value', en: 'Value' },
    title: { vi: 'valueEquals — Giá trị input khớp chính xác', en: 'valueEquals — Input value matches exactly' },
    desc: { vi: 'Kiểm tra thuộc tính <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> của input/select/textarea bằng đúng giá trị mong đợi.', en: 'Check that the <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> of an input/select/textarea exactly equals the expected value.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#username', expected: 'john.doe', note: { vi: '→ Nếu input chưa điền đúng "john.doe", bỏ qua N action kế tiếp', en: '→ If input does not contain exactly "john.doe", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-value', badgeLabel: { vi: 'Value', en: 'Value' },
    title: { vi: 'valueContains — Giá trị input chứa chuỗi', en: 'valueContains — Input value contains string' },
    desc: { vi: 'Kiểm tra thuộc tính <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> của input có chứa chuỗi không.', en: 'Check that the <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> of an input contains the specified string.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#search-box', expected: 'product', note: { vi: '→ Nếu ô tìm kiếm không chứa "product", bỏ qua N action kế tiếp', en: '→ If the search box does not contain "product", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-url', badgeLabel: { vi: 'URL', en: 'URL' },
    title: { vi: 'urlContains — URL hiện tại chứa chuỗi', en: 'urlContains — Current URL contains string' },
    desc: { vi: 'Kiểm tra URL của tab hiện tại có chứa chuỗi không. <strong>Không cần Selector.</strong>', en: 'Check if the current tab\'s URL contains the specified string. <strong>No Selector needed.</strong>' },
    selectorReq: false, valueReq: true,
    selectorLabel: { vi: 'Selector — không cần', en: 'Selector — not needed' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, expected: '/dashboard', note: { vi: '→ Nếu URL không chứa "/dashboard", bỏ qua N action kế tiếp', en: '→ If URL does not contain "/dashboard", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-url', badgeLabel: { vi: 'URL', en: 'URL' },
    title: { vi: 'urlEquals — URL hiện tại khớp chính xác', en: 'urlEquals — Current URL matches exactly' },
    desc: { vi: 'Kiểm tra URL của tab hiện tại bằng đúng với chuỗi chỉ định. <strong>Không cần Selector.</strong>', en: 'Check that the current tab\'s URL exactly matches the specified string. <strong>No Selector needed.</strong>' },
    selectorReq: false, valueReq: true,
    selectorLabel: { vi: 'Selector — không cần', en: 'Selector — not needed' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, expected: 'https://app.example.com/home', note: { vi: '→ Nếu URL khác, bỏ qua N action kế tiếp', en: '→ If URL is different, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-attr', badgeLabel: { vi: 'Attribute', en: 'Attribute' },
    title: { vi: 'hasClass — Element có CSS class', en: 'hasClass — Element has CSS class' },
    desc: { vi: 'Kiểm tra element có chứa CSS class được chỉ định không.', en: 'Check if the element contains the specified CSS class.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓ (tên class)', en: 'Expected value ✓ (class name)' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#nav-home', expected: 'active', note: { vi: '→ Nếu #nav-home không có class "active", bỏ qua N action kế tiếp', en: '→ If #nav-home does not have class "active", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-attr', badgeLabel: { vi: 'Attribute', en: 'Attribute' },
    title: { vi: 'hasAttribute — Element có thuộc tính HTML', en: 'hasAttribute — Element has HTML attribute' },
    desc: { vi: 'Kiểm tra element có attribute HTML. Nếu Expected value có dạng <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">attr=value</code> thì kiểm tra cả giá trị; nếu chỉ là tên attribute thì kiểm tra sự tồn tại.', en: 'Check if the element has an HTML attribute. If Expected value is in <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">attr=value</code> format, both attribute and value are checked; if just an attribute name, only existence is checked.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓ (tên attr hoặc attr=value)', en: 'Expected value ✓ (attr name or attr=value)' },
    examples: [
      { label: { vi: 'Ví dụ 1 — chỉ kiểm tra sự tồn tại', en: 'Example 1 — check existence only' }, selector: '#submit-btn', expected: 'disabled', note: { vi: '→ Nếu nút không có attribute disabled, bỏ qua', en: '→ If button has no disabled attribute, skip' } },
      { label: { vi: 'Ví dụ 2 — kiểm tra giá trị', en: 'Example 2 — check value' }, selector: '#user-panel', expected: 'data-role=admin', note: { vi: '→ Nếu data-role khác "admin", bỏ qua', en: '→ If data-role is not "admin", skip' } }
    ]
  }
];
