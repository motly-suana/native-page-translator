# Báo cáo hiệu năng Native Page Translator v4.7.0

## Phương pháp đo

- Script benchmark: [`tests/perf-benchmark.js`](tests/perf-benchmark.js)
- Giá trị đo là **trung vị (median) qua 5 lần chạy**, trên trang tổng hợp gồm 40 text node trong hero viewport, 120 text node sát màn hình (near-fold), 350 phần tử ẩn `display: none` (`rect` `0×0`), 240 text node xa bên dưới, và 300 attribute target (20 trong khung nhìn, 280 ở xa bên dưới).
- Mô phỏng độ trễ mạng LLM theo công thức `180ms + 0.35ms / ký tự` (scale `0.05×` trong script rồi quy đổi ngược về mili-giây thực tế) nhằm tách biệt tác động của phân tầng viewport, kích thước batch, worker pool streaming và concurrency.

## Kết quả Trước (`v4.6.0`) → Sau (`v4.7.0`)

| Chỉ số | v4.6.0 (Baseline) | v4.7.0 (Tối ưu) | Thay đổi |
| :--- | ---: | ---: | :--- |
| Khởi tạo `fancy-text.js` (`coldLoadMs`) | `2.03 ms` | `2.51 ms` | Tương đương (~2ms; bảng Unicode chuyển sang lazy-init) |
| Chuẩn hoá 20.000 chuỗi text thường (`normalize20kMs`) | `137.97 ms` | `13.28 ms` | **Nhanh hơn 10.4×** (`HAS_FANCY_CANDIDATE_RE` fast-path) |
| Chuẩn bị DOM & gom batch CPU (`cpuPrepMs`) | `1.72 ms` | `3.45 ms` | Vẫn dưới 4ms; bổ sung `checkVisibility` + `buildProgressiveBatches` |
| Số mục gửi dịch ngay ở lượt đầu (`immediateJobCount`) | `810` | `156` | **Giảm 80.7%** |
| Phần tử ẩn `display:none` / ngoài khung nhìn bị dịch thừa | `630` | `0` | **Loại bỏ 100%** |
| Số batch ở lượt đầu (`batchCount`) | `17` | `8` | Chia Wave 0 nhỏ để trả chữ đầu siêu nhanh |
| Thời gian hiện bản dịch đầu tiên — TTFT (LLM mô phỏng) | `8161.57 ms` | `459.71 ms` | **Nhanh hơn 17.8×** |
| Hoàn tất toàn bộ vùng nhìn Hero (LLM mô phỏng) | `8161.57 ms` | `1003.83 ms` | **Nhanh hơn 8.1×** |
| Hoàn tất toàn bộ phần hiển thị (LLM mô phỏng) | `8161.57 ms` | `1525.47 ms` | **Nhanh hơn 5.35×** |

## Tóm tắt kiến trúc tối ưu v4.7.0

1. **Streaming Worker Pool & Progressive Wave Batching ([`translation-pipeline.js`](translation-pipeline.js))**: Wave 0 gửi tối đa 8 đoạn / 1200 ký tự (LLM) hoặc 12 đoạn / 1400 ký tự (Free), bơm bản dịch ra DOM ngay khi từng batch xong thay vì chặn toàn trang đến khi mọi worker kết thúc. Kết hợp binary-split recovery khi batch lỗi hoặc lệch độ dài JSON.
2. **Loại bỏ phần tử `display: none` & defer attribute ngoài khung nhìn ([`content.js`](content.js), [`translation-pipeline.js`](translation-pipeline.js))**: Kiểm tra `isElementVisiblyRendered()` (`hidden`, `checkVisibility()`, `rect` `0×0`) trong một lượt đọc geometry duy nhất thay cho `sort()` gọi `getBoundingClientRect()` `O(N log N)` lần; đồng thời đẩy attribute (`title`, `placeholder`, `aria-label`, `alt`) ngoài khung nhìn sang `IntersectionObserver` (`rootMargin: 650px 0px`, gộp theo `scrollend`).
3. **Cache đồng bộ 0ms & Singleflight tại Background ([`content.js`](content.js), [`background.js`](background.js))**: Áp cache bộ nhớ trước khi dispatch bất đồng bộ, coalescing các request trùng giữa các tab/frame (trừ tab ẩn danh), nâng concurrency thích ứng (DeepL 6, LLM 4–8 theo số key hoạt động, hạ xuống 2 khi cooldown 429) và hỗ trợ `AbortController` / `cancelProviderTranslate` theo mảng `requestIds`.
4. **Chống giật khung hình & 0% tải nền khi chưa dịch**: Áp bản dịch theo 2 pha Read (`getComputedStyle`) → Write kèm `yieldToMain(50ms)` sử dụng `scheduler.yield()` + fallback `setTimeout(0)`; gắn `contain: layout style` cho span song ngữ và `content-visibility: auto` trên [`pdf-viewer.html`](pdf-viewer.html); chỉ bật `MutationObserver` khi trang thực sự chuyển sang ngôn ngữ dịch.
5. **Tối ưu phụ trợ & OCR Shadow DOM ([`fancy-text.js`](fancy-text.js), [`providers.js`](providers.js), [`ocr-panel.js`](ocr-panel.js))**: Fast-path regex cho `fancy-text.js`, Structured JSON `responseMimeType: 'application/json'` cho Gemini batch/vision, và tách OCR sang Closed Shadow DOM + downscale ảnh crop tối đa 1800px.
