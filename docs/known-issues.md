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

## Giới hạn của tính năng

- **Dropdown "Choose item #" với danh sách ảo hoá** (chỉ render các item đang thấy): item chưa được render thì không
  chọn được; action báo lỗi kèm số item đã thấy.
- **Switch Always chỉ nhắm tới scenario khác.** "Nhảy tới action #N trong scenario này" vẫn làm bằng case default ở
  chế độ theo biến.
