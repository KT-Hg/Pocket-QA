# Kết luận chạy cho Pocket QA

Phiên idea-refine ngày 2026-10-17. Người dùng đích: người ngoài cài từ Chrome Web Store. Ràng buộc: chỉ chạy local
(không server, không build step, không gọi dịch vụ ngoài), `minimum_chrome_version` 109.

> **Trạng thái (2026-10-18):** **A1 đã làm** — plan 10 (`tasks/plan-10.md`, `tasks/todo-10.md`), nhánh `run-verdict`
> từ `21c5c13` (T1) tới `cd524ef` (merge Assert trong 5 bản xuất) cùng commit tài liệu sau đó. Đã có: action Assert
> (soft, chờ 5 s), kết luận 4 trạng thái (thông báo, badge, thẻ Last run, cột Run Result của CSV), bằng chứng ở lỗi đầu
> tiên, bug report Markdown kèm ảnh, Assert trong cả 5 bản xuất. Câu hỏi mở bên dưới đã chốt theo đề xuất: lỗi JS
> của bên thứ ba chưa làm (thuộc A2); ảnh chỉ của lần chạy gần nhất (`lastRunShot`); lỗi trong scenario khác được kể
> trên bước Switch; chưa port sang Scenario Recorder & Playback. Việc tiếp theo: A2 (ghi assert bằng chuột, người gác).

## Problem Statement

Làm sao để mỗi lần chạy scenario **tự kết thúc bằng một kết luận đáng tin** (đúng, app lỗi, hay test hỏng) kèm bằng
chứng gửi được ngay, cho người dùng Web Store không viết code, mà vẫn chạy hoàn toàn local?

## Recommended Direction

Hiện Pocket QA *làm* được rất nhiều nhưng không *kết luận* được gì: một lần chạy "pass" chỉ có nghĩa là không có action
nào ném lỗi. Hướng A thêm phần còn thiếu đó. Cụ thể là action **Assert** (dùng lại 12 loại kiểm tra của Condition), một
**kết luận 3 trạng thái** cho mỗi lần chạy và mỗi dòng CSV (✓ Pass / ✗ App lỗi / ⚠ Test hỏng), và **bug report
Markdown sinh từ dữ liệu `failedActions` đã có** (`bg/playback/failure-prompt.js`, `onActionFailed`).

Tách "test hỏng" khỏi "app lỗi" là điểm khác biệt thật sự. Các công cụ cùng loại có assert, nhưng gộp chung "không tìm
thấy phần tử" với bug thật, nên người dùng phải tự mở ra xem lỗi nào là lỗi nào. Assert sai thì **ghi fail và chạy
tiếp**, không mở prompt, để lần chạy CSV và theo lịch không bị treo.

Hai hướng sau cùng dựa trên nền này. B (locator tự lành) lấy trạng thái ⚠ để biết lúc nào cần đề xuất sửa selector.
Smoke scan (7) dùng lại bộ nghe lỗi JS/5xx. Vì vậy thứ tự là **A → B → 7**.

## Key Assumptions to Validate

- [ ] **Phân loại ⚠ / ✗ đúng.** Cách kiểm: chạy bộ 36 scenario trong `test/` trên `test-page.html`, lần lượt xoá
  id/class (phải ra ⚠) và đổi chữ hoặc giá trị (phải ra ✗). Lệch một trường hợp là sửa trước khi phát hành.
- [ ] **Assert không báo sai vì timing.** Assert phải *chờ tới khi đúng hoặc hết giờ* (như `findElementWithFallback`),
  không kiểm một lần. Cách kiểm: một case e2e trong `tools/e2e.mjs` với nội dung tải trễ 2 giây.
- [ ] **Soft assert không làm người dùng bỏ sót lỗi.** Kết luận ✗ phải dễ thấy: badge đỏ, thông báo, cột Kết quả trong
  file xuất CSV. Không có telemetry (chỉ local), nên phải kiểm định tính: tự dùng 1–2 tuần, đọc review và issue trên
  Web Store.
- [ ] **Người dùng sẽ thêm assert.** Đây là giả định yếu nhất, và cũng là lý do A2 (ghi assert bằng chuột, người gác) đi
  ngay sau MVP.
- [ ] **Chrome 109 cho phép đăng ký script MAIN world** (`scripting.registerContentScripts` với `world: 'MAIN'`), điều
  kiện của A2. Tra tài liệu trước khi bắt đầu A2.

## MVP Scope

**A1 (MVP), có:**

- Action `assert`: 12 loại kiểm tra của Condition, có thời gian chờ. Sai thì ghi vào `failedActions` với loại `assert`,
  không mở prompt.
- Kết luận 3 trạng thái: hiện trong popup sau lần chạy, trong thông báo, badge, và một cột của kết quả CSV
  (XLSX/HTML/ZIP).
- Nút **Tạo bug report** trên kết quả lần chạy: Markdown chép vào clipboard, gồm các bước bằng lời, bước lỗi và lý do,
  URL, trình duyệt/OS, phiên bản Pocket QA, biến đã dùng (**giá trị bị che mặc định**), và ảnh chụp lúc lỗi tải về
  riêng.
- Export: assert sang cả 5 định dạng, dùng lại phần dịch của Condition và đổi "bỏ qua" thành "ném lỗi". Đây là phần tốn
  công nhất, cần golden test.

**A2 (ngay sau), chưa có trong MVP:**

- Ghi assert bằng chuột: giữ phím + click khi đang ghi.
- Người gác: uncaught error và response 5xx **cùng origin**, hook trong MAIN world, không dùng CDP.

**Sau đó:** B (thêm locator role/aria-label/placeholder/label vào `getAllSelectors`, đề xuất sửa selector cần người
dùng duyệt), rồi 7 (smoke scan có giới hạn số trang, độ sâu, loại trừ `logout`).

## Not Doing (and Why)

- **Checklist thủ công:** là một sản phẩm thứ hai (test case, lịch sử chạy), cạnh tranh với TestRail và Excel, và thêm
  tab thứ 6 vào popup vốn đã dày.
- **Ảnh chuẩn / visual baseline (lúc này):** so pixel khi chưa có vùng che sẽ báo sai, phá đúng niềm tin mà A đang xây.
  Quay lại sau như một loại assert.
- **Người gác qua CDP:** thanh vàng "đang debug trình duyệt" ở mọi lần chạy, chính lý do `closeOpenSessions`
  (`bg/cdp/session.js`) tồn tại.
- **Tích hợp API Jira/GitHub:** cần token, OAuth hoặc server, trái nguyên tắc chỉ chạy local. Markdown dán tay là đủ.
- **AI sinh test hoặc assert:** trái nguyên tắc chỉ chạy local.
- **Dashboard lịch sử nhiều lần chạy:** chưa ai cần trước khi từng lần chạy có kết luận.
- **Hard assert làm mặc định:** dừng hoặc treo các lần chạy tự động.
- **Tự sửa selector mà không hỏi:** locator dự phòng có thể khớp nhầm phần tử, khiến test pass trên sai chỗ.

## Open Questions

- Lỗi JS từ script bên thứ ba (quảng cáo, analytics) tính là ✗ hay chỉ cảnh báo? Đề xuất: chỉ cảnh báo; ✗ chỉ cho lỗi
  cùng origin.
- Ảnh lúc lỗi: chụp tự động mỗi lần fail (tốn IndexedDB khi chạy CSV 1.000 dòng) hay chỉ giữ ảnh của lần chạy gần nhất?
- Kết luận của Switch sang scenario khác: gộp vào scenario cha hay tách riêng?
- Có port sang **Scenario Recorder & Playback** không? Bản đó chậm hơn khá nhiều tính năng.
