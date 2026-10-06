# Vấn đề đã biết

Bug và giới hạn đã thấy nhưng chưa sửa. Mỗi mục nên sửa ở một commit hoặc PR riêng, kèm test.

## Bug có từ trước (thấy trong đợt refactor)

- **Segment capture reset hai kiểu khác nhau.** `CANCEL_SEGMENT_CAPTURE` và `CAPTURE_SEGMENT` đặt lại
  `state.segmentCapture` thành hai shape khác nhau (`{active,tabId,dir}` và `{active,tabId,dir,crop,fromHotkey}`).
  Hiện vô hại vì lần bắt đầu kế tiếp ghi đè toàn bộ object, nhưng nên thống nhất.
- **Giá trị đang dùng của biến được tính theo nhiều cách hơi khác nhau.** `activeValue` (exporter, trả `''` cho
  giá trị không phải chuỗi / config) và `activeValueText` (service worker, trả `String(v || '')`) trong
  `shared/var-spec.js`; `resolveRandomVars` chặn độ dài random ở 512 còn `previewRandom` thì không. Khác biệt có thể
  là cố ý hoặc lệch dần theo thời gian — nên chọn một hành vi chuẩn.
- **Health check kết nối 2 giây của popup không bao giờ chạy.** `checkContentScriptConnection`
  (`popup/connection.js`) đọc `state.currentTabId` / `state.activatedTabs` của `popup/state.js`, nhưng không ai gán
  hai giá trị đó; interval của nó cũng không bao giờ bị xoá (dù callback không làm gì). Cần quyết định: bật health
  check (tab có thể bị đánh dấu "Lost") hay xoá hẳn.
- **`captureTab` không thử lại khi chạm giới hạn tần suất.** `bg/screenshot/capture-tab.js` chỉ thử lại khi lỗi có
  chữ "rate", nhưng lỗi thật của Chrome là "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
  quota." — hai lần chụp visible trong cùng một giây làm lần sau báo "Capture failed".
- **Service worker không có `CSS`.** Dropdown hoặc Upload File chỉ có `selectors.id` (không có `selectors.css`,
  không có `selector`) gọi `CSS.escape` trong service worker và lỗi "CSS is not defined"
  (`bg/playback/steps/dropdown.js`, `upload.js`).
- **Dropdown "chỉ mở" với selector XPath không mở được.** CDP chỉ nhận CSS selector (`openDropdownViaCdp`), nên
  action Dropdown không chọn item mà selector là XPath thì không làm gì. Chế độ **Choose item #** đã tránh được:
  trigger XPath (hoặc nằm trong iframe) được trang tự click.
- **Switch theo biến: ô Scenario trống khi mở lại popup trên bản nháp.** Nếu bản nháp được khôi phục trước khi
  danh sách scenario nạp xong, danh sách Scenario trong trình soạn case trống cho tới khi đổi loại action. Chế độ
  **Always** đã xử lý (`loadScenarios` điền lại danh sách khi form đang ở Always).

## Giới hạn của tính năng

- **Dropdown "Choose item #" với danh sách ảo hoá** (chỉ render các item đang thấy): item chưa được render thì không
  chọn được; action báo lỗi kèm số item đã thấy.
- **Switch Always chỉ nhắm tới scenario khác.** "Nhảy tới action #N trong scenario này" vẫn làm bằng case default ở
  chế độ theo biến.
