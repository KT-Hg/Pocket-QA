# Vấn đề đã biết

Bug và giới hạn đã thấy nhưng chưa sửa. Mỗi mục nên sửa ở một commit hoặc PR riêng, kèm test.

## Bug có từ trước (thấy trong đợt refactor)

Đã sửa hết.

## Còn lại sau đợt sửa review (2026-10)

- **`content.js` có 2.167 dòng** (`wc -l`; từ 3.343). Đợt plan 9 chuyển countdown, prompt khi action lỗi và thanh
  segment sang `content-overlays.js`, worker chỉ nạp khi cần (2.278 → 2.040), rồi thêm khoảng 100 dòng cho
  "Choose item #" trong danh sách ảo hoá, rồi khoảng 25 dòng cho Assert (plan 10: `CHECK_CONDITION` trả thêm `found` /
  `actual`). Xuống dưới 2.000 phải chuyển cả Element picker: popup gửi `START_PICK_MODE`
  thẳng vào tab ở ba chỗ, và recorder dùng chung `pickerMode` / `_extIsOurChrome` với nó.

- **`verify --eslint` đếm cả worktree lồng trong repo.** Session chạy trong `.claude/worktrees/…` để lại một bản code
  ngay trong thư mục repo, và `tools/eslint.config.mjs` không bỏ qua `.claude/`, nên số cảnh báo nhân lên (97 → 229).
  Tạm thời so baseline bằng `npx eslint@9.39.5 -c tools/eslint.config.mjs --ignore-pattern ".claude/**" .`; sửa hẳn là
  thêm `.claude/**` vào `ignores` của file cấu hình.

## Giới hạn của tính năng

- **Assert `elementExists` / `elementVisible` với selector đã hỏng ra ✗ Failed, không ra ⚠ Test broken.** Với loại kiểm
  sự có mặt, "không thấy phần tử" chính là câu trả lời, nên không phân biệt được app không hiện phần tử với selector
  hết khớp. Loại kiểm chữ / giá trị / class / thuộc tính thì phân biệt được: không thấy phần tử → ⚠.
- **Assert chờ cố định 5 s** (bằng thời gian chờ phần tử của action), chưa chỉnh được cho từng Assert; trang chậm hơn thì
  đặt một Wait trước nó.
- **Bug report chỉ có cho Play và Resume.** Sequence và CSV run có kết luận (thông báo, cột Run Result) nhưng không có
  `lastRun`, thẻ Last run hay bug report.
- **Ảnh lúc lỗi chỉ chụp được khi tab chạy là tab đang hiện trong cửa sổ của nó** (`captureVisibleTab` chỉ chụp tab
  đó). Run ở tab nền thì báo cáo ghi "No screenshot".
- **Bug report lấy giá trị biến đã lưu, không phải giá trị lúc chạy** — `lastRun` không giữ chúng (biến Random, CSV,
  Read DOM có thể khác); báo cáo ghi rõ điều này.
- **Lỗi nằm trong scenario khác (Switch chạy vào):** bấm dòng lỗi trên thẻ Last run nhảy theo số bước trong scenario
  gốc, có thể trỏ nhầm hàng; trace và bug report thì kể lỗi trên bước Switch đó.

- **Recorder chỉ ghi tab bắt đầu ghi.** Link mở sang tab mới thì thao tác ở tab đó không được ghi. Trước đây ghi được
  nhưng phát lại chạy trên tab ban đầu, tức là sai tab.
- **Các bước đi qua CDP chỉ với tới frame cùng origin với trang:** Upload File, mở Dropdown và đo phần tử khi chụp ảnh
  phần tử. Frame khác origin chạy ở tiến trình khác; `chrome.debugger` chỉ gửi lệnh tới đó được từ Chrome 125, còn
  `minimum_chrome_version` là 109. Ở frame đó Upload File và chụp phần tử báo lỗi nói rõ lý do; Dropdown được mở bằng
  click của chính trang (không phải click trusted), như trước.
- **Dropdown "Choose item #" với danh sách ảo hoá** (chỉ render các item đang thấy): list được nhận ra khi phần tử
  cuộn của nó cao hơn tổng các item đang render cộng thêm một màn của nó. Hàng cao bằng nhau thì cuộn thẳng tới item;
  hàng cao khác nhau thì cuộn từ đầu từng trang và dừng sau 5 giây, nên list rất dài loại này báo lỗi kèm số item đã
  thấy. `random` với hàng cao bằng nhau thử tối đa 10 lần nếu trúng item bị tắt hoặc rỗng.
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

## Cố ý giữ (không coi là bug)

- **Wait 0 ms chờ 500 ms.** `waitMs` (`shared/wait-ms.js`) đọc `delay || value || 500`, nên `delay: 0` (0 là
  falsy) rơi về mặc định 500 ms — cả phát lại lẫn bản xuất đều vậy. Giữ nguyên để một Wait cũ không đặt thời gian
  vẫn chờ 500 ms như trước; muốn "chờ 0 ms" thật thì phải phân biệt 0 với "không đặt" ở mọi nơi đọc trường này.
- **Listener snapshot của dbtools nhận message từ mọi trang có content script dbtools.** `serveSnapshots`
  (`dbtools/snapstore.js`) phục vụ put / get / remove vào kho snapshot riêng của dbtools (IndexedDB), không kiểm
  người gửi. Cố ý: content script dbtools (trên trang Adminer) cần gọi nó, và kho này là của dbtools — không phải
  dữ liệu scenario của extension, cũng không chạm tới nó.
- **`popup/record` còn một nhóm import vòng 11 module:** `action-form`, `draft`, `form-state`, `preview`,
  `switch-case-builder`, `undo-redo`, `value-memory`, `run/playback-controls`, `scenarios/folders`,
  `scenarios/scenario-actions`, `scenarios/scenario-list`. Đó là các phần UI thật sự gọi lẫn nhau (lưu form → vẽ lại
  preview → cập nhật danh sách scenario); phá tiếp phải đảo thành callback, chỉ chuyển độ phức tạp sang chỗ khác. Các
  nhóm vòng ở `dbtools/`, `sqlcases/ui/` và `run/schedule` ↔ `run/time-picker` có từ trước.

## Giới hạn của Export Code

Chuẩn là phát lại: bản xuất làm khác phát lại là bug. Những chỗ dưới đây chưa làm giống được; tab Actions của cửa sổ
xuất đánh dấu ⚠ Verify hoặc — Skip cho từng bước liên quan, kèm lý do.

- **Bước ghi trong iframe:** Selenium, Playwright, Robot và Java tìm element (cả của Condition) ở trang chính rồi trong
  từng frame, và kiểm Condition trong frame giữ element đó. Bookmarklet chỉ với tới frame cùng origin với trang (bằng
  CSS hoặc XPath, không lồng frame trong frame); frame khác origin thì không (⚠ Verify). Condition kiểu URL ghi trong
  frame: bản xuất kiểm URL của trang chính, phát lại kiểm URL của frame (⚠ Verify). Phát lại với tới frame cùng origin
  với các bước đi qua CDP (xem mục trên).
- **"Choose item #" với danh sách ảo hoá:** bản xuất chỉ chọn trong các item đang hiện, chưa cuộn list như phát lại.
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
- **Robot với Data file cần hai file:** DataDriver chỉ đọc cột có tiêu đề dạng `${tên}`, nên Download lưu thêm
  `pqa_csv_reader.py` (reader đọc CSV như CSV run) và file đó phải nằm cạnh file `.robot`. Copy Code chỉ chép file
  `.robot`. Trình duyệt có thể hỏi giữ lại file `.py`, như với bản xuất Selenium.
