# Thiết kế Kiến trúc Native Page Translator v5.0.0

## Mục tiêu nâng cấp lõi
1. **Multi-Provider Ecosystem (16+ Nhà cung cấp & Custom không giới hạn)**:
   - Bổ sung Native Engine cho **Anthropic Claude** (`POST /v1/messages`, hỗ trợ cả Vision đọc ảnh Base64 và Extended reasoning/solver).
   - Bổ sung 11 Preset OpenAI-compatible 1-click cấu hình sẵn endpoint & danh sách model tối ưu (**Groq**, **OpenRouter**, **Cerebras**, **DeepSeek Official**, **xAI Grok**, **Mistral AI**, **Together AI**, **Fireworks AI**, **Perplexity**, **SiliconFlow**, **Cohere**) bên cạnh **DeepL**, **Gemini**, **Deploy.com**, **OpenAI** và tối đa 20 slot Custom.
   - Smart Key Router (`detectPresetForKey` + `detectProviderForKey`): tự động tách & phân loại các key trộn lẫn theo tiền tố không mơ hồ (`AIza`, `:fx`, `sk-ant-`, `sk-or-`, `gsk_`, `csk-`, `xai-`, `pplx-`, `fw_`, `tgp_`, `base64==`).
   - Hợp nhất `BUILTIN_ORIGINS` một nguồn duy nhất từ `providers.js`.

2. **Health-Scored Multi-Key Striping Engine**:
   - Hỗ trợ 3 chiến lược điều phối lõi trong `config.routingStrategy`:
     - `smart-stripe`: chấm điểm `(providerId, key)` theo độ trễ EMA (`emaLatencyMs`), số request đang chạy (`inflight`), chuỗi lỗi (`errorStreak`) và ưu tiên cấu hình, tự động phân tải song song từng micro-batch sang toàn bộ dàn key đang rảnh của mọi provider bật sẵn.
     - `round-robin`: xoay đều trên toàn bộ key Pool đa nhà cung cấp.
     - `failover`: ưu tiên tuần tự theo thứ tự provider trước, giữ nguyên tương thích ngược.
   - Per-key `disabled` flag & Batch Health Check (`pingProviderKeys`), lưu trạng thái sức khỏe & cooldown (chỉ theo hash FNV-1a, tuyệt đối không lưu key thô) vào `chrome.storage.session` sống qua chu kỳ idle 30s của MV3 Service Worker.

3. **Prompt Engine tách rời (`prompts.js`) & Ngữ cảnh Cấu trúc trang**:
   - Tách riêng module `prompts.js` nạp trước `providers.js`.
   - Thêm chỉ thị **Anti-Injection** cho cả 5 luồng (Dịch batch trang, Dịch bản địa VI→EN, Tóm tắt, Giải bài QA, OCR/Vision), chống "văn dịch máy" tiếng Việt, thêm văn phong `technical` & `academic`.
   - Thu thập tiêu đề cấu trúc (`h1, h2` → `pageContext.outline`) trong `content.js` để mọi micro-batch chia sẻ mạch ngữ nghĩa toàn trang.
   - Hỗ trợ `tm-system-prompt-overrides` (Prompt Studio) cho phép kiểm tra và tùy biến trực tiếp System Prompt từng tác vụ.

4. **Giao diện Command Center v5.0 (`options.html` + `dashboard.css`, `popup.html`, `pdf-viewer.html`, Floating Shadow UI)**:
   - Dashboard full-screen 2 cột (`Sidebar` + `Container-aware Workspace` dùng `@container` queries, `<dialog>` xác nhận chuẩn HTML5, WCAG `tablist` với arrow-key navigation & `::after` border indicator, `light-dark()` + fallback theme tokens).
   - KPI Pool Overview, Universal Smart Key Dropzone, thanh lọc Provider, trạng thái từng Key theo thời gian thực, Live Preview chế độ hiển thị, Prompt Studio và Quick Engine Switch ngay từ Popup.
