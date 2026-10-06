# Vấn đề đã biết

Bug và giới hạn đã thấy nhưng chưa sửa. Mỗi mục nên sửa ở một commit hoặc PR riêng, kèm test.

## Bug có từ trước (thấy trong đợt refactor)

- **Health check kết nối 2 giây của popup không bao giờ chạy.** `checkContentScriptConnection`
  (`popup/connection.js`) đọc `state.currentTabId` / `state.activatedTabs` của `popup/state.js`, nhưng không ai gán
  hai giá trị đó; interval của nó cũng không bao giờ bị xoá (dù callback không làm gì). Cần quyết định: bật health
  check (tab có thể bị đánh dấu "Lost") hay xoá hẳn.

## Giới hạn của tính năng

- **Dropdown "Choose item #" với danh sách ảo hoá** (chỉ render các item đang thấy): item chưa được render thì không
  chọn được; action báo lỗi kèm số item đã thấy.
- **Switch Always chỉ nhắm tới scenario khác.** "Nhảy tới action #N trong scenario này" vẫn làm bằng case default ở
  chế độ theo biến.
