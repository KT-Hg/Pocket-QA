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

- **Bước ghi trong iframe:** Selenium, Playwright, Robot và Java tìm element ở trang chính rồi trong từng frame. Bookmarklet chỉ với
  tới frame cùng origin với trang (bằng CSS hoặc XPath, không lồng frame trong frame); frame khác origin thì không
  (⚠ Verify). Một Condition ghi trong frame vẫn được kiểm ở trang chính ở mọi bản (⚠ Verify). Phát lại cũng chỉ thấy
  frame trên cùng với các bước đi qua CDP (xem mục trên).
- **Upload File:** bookmarklet không đọc được tệp trên máy nên bỏ qua mọi Upload File, vào `<input type="file">` cũng như
  vào drop zone. Selenium, Playwright, Robot và Java làm được cả hai (drop zone qua một input ẩn làm cầu nối, như phát lại).
- **Switch:** Switch có khối theo biến, mọi case là một dải action của chính scenario (hoặc rỗng), không có "Continue
  at" riêng và không lỗi, được xuất thành `if / elif / else` trên giá trị biến lúc chạy. Các Switch khác — case nhảy
  sang scenario khác, nhảy tới action #N, "Always", có "Continue at" — vẫn bị bỏ qua (cùng cả khối nếu có khối): việc
  đó cần extension.
- **Bookmarklet và Navigate:** mỗi trang cần một lần bấm. Navigate sang trang cùng site (cùng origin) lưu chỗ chạy tiếp
  vào `sessionStorage`, nên lần bấm sau chạy tiếp dù trang đích đã chuyển hướng. Navigate sang site khác thì dừng ở đó
  (`sessionStorage` của site này không sang được site kia). Navigate nằm trong Condition hoặc trong case của Switch vẫn
  tải lại trang và các bước sau nó không chạy. Scenario chỉ có Navigate ở bước đầu giữ cách cũ: bấm lại khi đã ở đúng
  trang; nếu trang đó chuyển hướng sang trang khác của cùng site thì lại mở trang và dừng.
- **Kéo thả trong Selenium, Robot và Java** dùng chuỗi thao tác chuột của WebDriver (ActionChains, `Drag And Drop` của
  SeleniumLibrary, `Actions`); mới kiểm chạy thật trên Edge (e2e `export-run`), chưa kiểm trên Firefox và Safari.
- **Robot và Java chưa có Data file (CSV):** pytest và Playwright chạy một test cho mỗi dòng của tệp CSV; Robot (cần
  DataDriver hoặc test template) và Java (cần `@DataProvider`) thì chưa.
