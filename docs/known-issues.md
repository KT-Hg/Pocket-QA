# Vấn đề đã biết

Bug và giới hạn đã thấy nhưng chưa sửa. Mỗi mục nên sửa ở một commit hoặc PR riêng, kèm test.

## Bug có từ trước (thấy trong đợt refactor)

Đã sửa hết.

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
