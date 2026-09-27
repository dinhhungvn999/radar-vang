# Radar Vàng — chạy 24/7

Kho này gồm 3 phần:

| Tệp | Việc làm |
|---|---|
| `radar-engine.mjs` | Bộ máy tính 2 loại tín hiệu [TUẦN] và [NGÀY], theo dõi TP1/TP2/SL, gửi Telegram |
| `.github/workflows/radar.yml` | Lịch để GitHub tự chạy bộ máy **mỗi 15 phút, 24/7** (miễn phí) |
| `index.html` | Dashboard Radar Vàng (xem trên GitHub Pages hoặc mở trực tiếp) |
| `data/signals.json` | Nhật ký mọi tín hiệu + kết quả, bộ máy tự cập nhật |

## Cài đặt (khoảng 15 phút, làm một lần)

### Bước 1 — Tạo bot Telegram
1. Trên Telegram, tìm **@BotFather** → gõ `/newbot` → đặt tên (ví dụ `Radar Vang Hung`) và tên đăng nhập kết thúc bằng `bot`.
2. BotFather gửi lại **token** dạng `123456789:AAH...`. Giữ kín token này.
3. Mở bot vừa tạo, bấm **Start** (bắt buộc, nếu không bot không nhắn được cho anh).
4. Tìm **@userinfobot** → bấm Start → nó trả về **Id** (một dãy số). Đó là `TELEGRAM_CHAT_ID`.

### Bước 2 — Tạo kho GitHub
1. Đăng ký/đăng nhập https://github.com.
2. Bấm **New repository** → tên `radar-vang` → chọn **Public** (để chạy miễn phí không giới hạn và dashboard đọc được nhật ký; token Telegram vẫn được giấu an toàn) → **Create**.
3. Bấm **uploading an existing file** → kéo thả các tệp `index.html`, `radar-engine.mjs`, `README.md` và thư mục `data` → **Commit changes**.
4. Tạo tệp lịch chạy: **Add file → Create new file** → gõ tên `.github/workflows/radar.yml` → dán toàn bộ nội dung tệp `radar.yml` → **Commit changes**.
   (Thư mục bắt đầu bằng dấu chấm thường bị bỏ sót khi kéo thả, nên tạo tay như trên cho chắc.)

### Bước 3 — Cất token vào két an toàn của GitHub
**Settings → Secrets and variables → Actions → New repository secret**, tạo 2 mục:
- `TELEGRAM_TOKEN` = token ở Bước 1
- `TELEGRAM_CHAT_ID` = dãy số Id ở Bước 1

### Bước 4 — Cho phép bộ máy lưu nhật ký
**Settings → Actions → General → Workflow permissions** → chọn **Read and write permissions** → Save.

### Bước 5 — Chạy thử
**Actions** → chọn **Radar Vang 24-7** → **Run workflow**. Khoảng 1 phút sau Telegram nhận tin “✅ Radar Vàng đã chạy 24/7”. Từ đó GitHub tự chạy mỗi 15 phút.

### Bước 6 — Mở dashboard trên điện thoại (tuỳ chọn)
**Settings → Pages → Branch: main / (root) → Save**. Sau 1–2 phút dashboard có ở
`https://<tên-github>.github.io/radar-vang/` và tự đọc nhật ký 24/7.

## Hai loại tín hiệu
- **[TUẦN]** MACD H1 cắt + giá H1 cùng phía EMA200 + xu hướng H4 (giá so EMA200 và MACD H4). Cắt lỗ 1,5×ATR H1. Khoảng 1–2 lệnh/tuần. Kiểm chứng 4,5 năm: +0,14R/lệnh, 5/5 năm có lãi.
- **[NGÀY]** RSI(2) trên M15 hồi sâu (<15 khi H4 tăng, >85 khi H4 giảm) trong khi giá M15 vẫn cùng phía EMA50. Cắt lỗ 1×ATR H1. Khoảng 1 lệnh/ngày. Kiểm chứng 4,5 năm: +0,11R/lệnh; 2022–2023 gần hoà vốn, lãi chủ yếu 2024–2026.
- Cả hai: TP1 = 1R (chốt 0.01 lot, dời SL về điểm vào), TP2 = 2R, tối đa 24 giờ. Mỗi loại chỉ mở 1 lệnh một lúc.

## Anh sẽ nhận gì trên Telegram
- 🟢/🔴 Tín hiệu mới (ghi rõ [TUẦN] hoặc [NGÀY]): giá vào, SL, TP1, TP2, số tiền lời/lỗ với 0.02 lot, cảnh báo tin Mỹ.
- 🎯 Chạm TP1 → nhắc chốt 0.01 lot và dời SL về điểm vào.
- 🏆 TP2 / 🤝 hoà vốn / ❌ cắt lỗ / ⌛ hết 24 giờ → kết quả và số dư demo.
- 📅 Chủ nhật 9:00: tổng kết tuần, tỷ lệ thắng/thua từ khi bắt đầu.

## Đổi thông số
Trong `.github/workflows/radar.yml`: `MODES` (`week,day` = cả hai; `week` = chỉ TUẦN), `LOT`, `PARTIAL`, `MAX_RISK_USD` (lệnh có rủi ro lớn hơn sẽ được khuyên bỏ qua), `START_BALANCE`.

## Lưu ý
- GitHub có thể chạy trễ vài phút lúc cao điểm; tín hiệu dựa trên nến H1 đã đóng nên độ chính xác không đổi, chỉ báo chậm hơn chút.
- Giá lấy từ PAXG (token vàng bám sát XAU), đã cộng chênh lệch; giá sàn của anh có thể lệch vài giá.
- Đây là công cụ hỗ trợ, không phải lời khuyên đầu tư. Chạy demo đủ lâu (ít nhất 30–50 lệnh) trước khi dùng tiền thật.
