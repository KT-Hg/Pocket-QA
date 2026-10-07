# Vấn đề đã biết

Bug và giới hạn đã thấy nhưng chưa sửa. Mỗi mục nên sửa ở một commit hoặc PR riêng, kèm test.

## Bug có từ trước (thấy trong đợt refactor)

Đã sửa hết.

## Còn lại sau đợt sửa review (2026-10)

- **Highlight: hai đường ghi chưa đi qua hàng đợi.** `HL_SAVE_PAGE` xếp hàng các lần lưu, nên hai *trang khác nhau*
  lưu cùng lúc không còn mất dữ liệu. Còn hai trường hợp:
  - Hai tab cùng một trang: mỗi tab gửi cả danh sách của trang đó. Hai tab tạo highlight cùng lúc thì danh sách gửi
    sau đè danh sách gửi trước.
  - Tab Highlight của popup: đọc `hl_v1` khi mở rồi ghi lại cả kho khi đổi màu, note, ẩn hay xoá. Nếu một trang
    lưu highlight trong lúc đó, lần ghi của popup đè mất.

  Cách sửa là gửi thay đổi (thêm / sửa / xoá một highlight) cho worker thay vì cả danh sách.
- **`popup/record` còn một nhóm import vòng 11 module:** `action-form`, `draft`, `form-state`, `preview`,
  `switch-case-builder`, `undo-redo`, `value-memory`, `run/playback-controls`, `scenarios/folders`,
  `scenarios/scenario-actions`, `scenarios/scenario-list`. Ban đầu là 12; các helper và hằng số dùng chung đã chuyển
  xuống module lá. Phần còn lại là các phần UI thật sự gọi lẫn nhau (lưu form → vẽ lại preview → cập nhật danh sách
  scenario). Phá tiếp phải đảo thành callback, chỉ chuyển độ phức tạp sang chỗ khác. Các nhóm vòng ở `dbtools/`,
  `sqlcases/ui/` và `run/schedule` ↔ `run/time-picker` có từ trước và nằm ngoài đợt này.
- **`content.js` còn 2.105 dòng** (từ 3.343) sau khi tách Highlight engine; mục tiêu dưới 2.000 dòng dựa trên ước
  lượng cỡ của engine.

## Giới hạn của tính năng

- **Dropdown "Choose item #" với danh sách ảo hoá** (chỉ render các item đang thấy): item chưa được render thì không
  chọn được; action báo lỗi kèm số item đã thấy.
- **Switch Always chỉ nhắm tới scenario khác.** "Nhảy tới action #N trong scenario này" vẫn làm bằng case default ở
  chế độ theo biến.
- **Trang web dò được Pocket QA đã được cài.** Các file dbtools trong `web_accessible_resources` có URL cố định
  (`chrome-extension://<id>/dbtools/…`), nên trang nào cũng `fetch` được chúng. `"use_dynamic_url": true` chặn được
  việc này, nhưng làm hỏng dbtools: Chrome từ chối các `import` tĩnh giữa các module dbtools, và panel không còn được
  gắn vào trang Adminer (đã thử trên Edge, 2026-10-07). Chỉ sửa được khi dbtools được gộp thành một classic content
  script, tức là cần bundler — trái với quy tắc "không có build step".
- **Chrome 109–110 không có `color-mix()`.** `minimum_chrome_version` giữ 109 (bản cuối trên Windows 7/8.1). Khoảng
  100 khai báo CSS của popup, editor và SQL cases dùng `color-mix()` cho nền nhạt, viền, bóng và vòng focus. Trên
  109–110, khai báo đó thành `unset`: nền trong suốt, viền và bóng mất; chữ, layout và thông tin vẫn đủ. Hai tín
  hiệu trạng thái chỉ hiện bằng màu đó có màu thay thế trong `@supports not (color: color-mix(…))`: case header
  đang là chỗ thả khi kéo action (`02-action-list.css`) và vòng focus của công tắc Highlight (`11-highlight.css`).
  Màu dự phòng phải đặt trong `@supports`: viết ngay phía trên thì không có tác dụng, vì khai báo dùng `var()` không
  bị bỏ qua lúc parse.
