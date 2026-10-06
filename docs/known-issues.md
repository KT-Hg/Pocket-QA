# Vấn đề đã biết

Bug và giới hạn đã thấy nhưng chưa sửa. Mỗi mục nên sửa ở một commit hoặc PR riêng, kèm test.

## Bug có từ trước (thấy trong đợt refactor)

Đã sửa hết.

## Giới hạn của tính năng

- **Dropdown "Choose item #" với danh sách ảo hoá** (chỉ render các item đang thấy): item chưa được render thì không
  chọn được; action báo lỗi kèm số item đã thấy.
- **Switch Always chỉ nhắm tới scenario khác.** "Nhảy tới action #N trong scenario này" vẫn làm bằng case default ở
  chế độ theo biến.
