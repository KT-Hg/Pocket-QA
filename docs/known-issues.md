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
- **`content.js` có 2.270 dòng** (`wc -l`; từ 3.343, còn 2.123 sau khi tách Highlight engine); mục tiêu dưới 2.000
  dòng dựa trên ước lượng cỡ của engine. Đợt sửa review thứ hai thêm khoảng 150 dòng: `MARK_ELEMENT` cho các bước CDP,
  phần kiểm "Click through" (`_blockedReason`), thứ tự input / click của recorder và các thông báo lỗi rõ hơn.
- **DB guard không bọc run resume.** `startPlayback`, `startSequence` và `startCsvPlayback` mở session DB trước
  run; `_resumeScenario` (Resume từ checkpoint) thì không. Chưa có tác động vì guard tắt khi `TABLE_COPIES = false`
  (`dbtools/features.js`); phải sửa trước khi bật lại.

## Giới hạn của tính năng

- **Recorder chỉ ghi tab bắt đầu ghi.** Link mở sang tab mới thì thao tác ở tab đó không được ghi. Trước đây ghi được
  nhưng phát lại chạy trên tab ban đầu, tức là sai tab.
- **Các bước đi qua CDP chỉ thấy frame trên cùng:** Upload File, mở Dropdown và đo phần tử khi chụp ảnh phần tử. Phần
  tử nằm trong iframe thì các bước này báo không tìm thấy.
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

## Giới hạn của Export Code

Chuẩn là phát lại: bản xuất làm khác phát lại là bug. Những chỗ dưới đây chưa làm giống được; tab Actions của cửa sổ
xuất đánh dấu ⚠ Verify hoặc — Skip cho từng bước liên quan, kèm lý do.

- **Bước ghi trong iframe:** Selenium và Playwright tìm element ở trang chính rồi trong từng frame. Bookmarklet chỉ tìm
  ở trang chính, nên bước đó báo không tìm thấy (⚠ Verify). Một Condition ghi trong frame vẫn được kiểm ở trang chính
  ở cả ba bản (⚠ Verify). Phát lại cũng chỉ thấy frame trên cùng với các bước đi qua CDP (xem mục trên).
- **Upload File vào drop zone** không được xuất ở định dạng nào (cần cầu nối DataTransfer của extension). Upload vào
  `<input type="file">` thì Selenium (`send_keys`) và Playwright (`setInputFiles`) làm được; bookmarklet không đọc
  được tệp trên máy nên bỏ qua mọi Upload File.
- **Switch** bị bỏ qua ở cả ba bản xuất code, Switch có khối bị bỏ qua cùng cả khối: chọn case và nhảy sang scenario
  khác là việc của extension.
- **Bookmarklet và Navigate:** Navigate đầu tiên cần bấm 2 lần (mở trang rồi dừng, bấm lại khi trang đã tải). Nếu
  trang đích chuyển hướng sang địa chỉ khác (ví dụ về trang đăng nhập), lần bấm sau vẫn không thấy mình ở đích nên lại
  mở trang và dừng, không bao giờ chạy tiếp. Navigate ở giữa scenario tải lại trang, các bước sau nó không chạy.
- **Child Condition "Text contains":** phát lại khớp cả chữ của riêng element (các text node con trực tiếp) lẫn
  `textContent`; các bản xuất chỉ khớp `textContent`. Chỉ khác khi chữ cần tìm bị một phần tử con chen ngang, ví dụ
  `Hello <b>x</b> world` với "Hello world".
- **Kéo thả trong Selenium** dùng ActionChains; mới kiểm chạy thật trên Edge (e2e `export-run`), chưa kiểm trên
  Firefox và Safari.
