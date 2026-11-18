/* ========================================================================
 * NPT OCR Panel — chọn vùng chụp màn hình, cắt/nén ảnh thông minh,
 * hiển thị kết quả & dịch nhanh trong Closed Shadow DOM (Liquid Glass).
 *
 * Tách khỏi content.js để cô lập hoàn toàn CSS/DOM khỏi trang web (không bị
 * MutationObserver dịch nhầm) và loại bỏ alert() chặn luồng.
 * ====================================================================== */
(function attachOcrPanel(global) {
  'use strict';

  const MAX_CROP_SIDE = 1800;

  let ocrHost = null;
  let ocrShadow = null;
  let ocrOverlay = null;
  let ocrPanel = null;
  let escapeInstalled = false;

  const handlers = {
    onTranslateText: null,
    getTargetLanguage: () => 'vi',
  };

  function configure(options = {}) {
    if (typeof options.onTranslateText === 'function') {
      handlers.onTranslateText = options.onTranslateText;
    }
    if (typeof options.getTargetLanguage === 'function') {
      handlers.getTargetLanguage = options.getTargetLanguage;
    }
  }

  /**
   * Tính tọa độ cắt theo tỷ lệ ảnh gốc và thu nhỏ nếu vượt maxSide (màn hình 4K/Retina).
   */
  function computeCropRect(rect, naturalWidth, naturalHeight, viewportWidth, viewportHeight, maxSide = MAX_CROP_SIDE) {
    const natW = Math.max(1, Number(naturalWidth) || 1);
    const natH = Math.max(1, Number(naturalHeight) || 1);
    const vW = Math.max(1, Number(viewportWidth) || 1);
    const vH = Math.max(1, Number(viewportHeight) || 1);

    const scaleX = natW / vW;
    const scaleY = natH / vH;

    const cropX = Math.max(0, Math.min(natW - 1, Math.round((Number(rect?.x) || 0) * scaleX)));
    const cropY = Math.max(0, Math.min(natH - 1, Math.round((Number(rect?.y) || 0) * scaleY)));
    const cropW = Math.max(1, Math.min(natW - cropX, Math.round((Number(rect?.width) || 1) * scaleX)));
    const cropH = Math.max(1, Math.min(natH - cropY, Math.round((Number(rect?.height) || 1) * scaleY)));

    const largest = Math.max(cropW, cropH);
    const downscale = largest > maxSide ? maxSide / largest : 1;
    const outW = Math.max(1, Math.round(cropW * downscale));
    const outH = Math.max(1, Math.round(cropH * downscale));

    return { cropX, cropY, cropW, cropH, outW, outH };
  }

  function cropImage(dataUrl, rect) {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined' || typeof document === 'undefined') {
        resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const vW = global.innerWidth || document.documentElement?.clientWidth || 1;
          const vH = global.innerHeight || document.documentElement?.clientHeight || 1;
          const { cropX, cropY, cropW, cropH, outW, outH } = computeCropRect(
            rect, img.naturalWidth, img.naturalHeight, vW, vH, MAX_CROP_SIDE,
          );

          const canvas = document.createElement('canvas');
          canvas.width = outW;
          canvas.height = outH;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
          resolve(canvas.toDataURL('image/png'));
        } catch (_) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function iconSvg(name, size) {
    return global.NPT_ICONS?.svg?.(name, { size }) || '';
  }

  function ensureOcrShadow() {
    if (ocrHost && ocrShadow) {
      if (!ocrHost.isConnected && document.documentElement) {
        document.documentElement.appendChild(ocrHost);
      }
      return ocrShadow;
    }

    ocrHost = document.createElement('div');
    ocrHost.id = 'tm-ocr-host';
    ocrHost.dataset.tmNoTranslate = 'true';
    (document.documentElement || document.body).appendChild(ocrHost);

    ocrShadow = ocrHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        --npt-surface: 255,255,255;
        --npt-surface-2: 244,245,249;
        --npt-ink: 23,24,28;
        font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --npt-surface: 52,56,66;
          --npt-surface-2: 30,32,39;
          --npt-ink: 236,238,243;
        }
      }
      [hidden] { display: none !important; }
      .ocr-overlay {
        position: fixed;
        inset: 0;
        pointer-events: auto;
        cursor: crosshair;
        background: rgba(15, 17, 23, 0.34);
        user-select: none;
      }
      .ocr-box {
        position: absolute;
        border: 2px dashed #ffffff;
        border-radius: 4px;
        background: rgba(99, 102, 241, 0.14);
        box-shadow: 0 0 0 9999px rgba(15, 17, 23, 0.18);
        pointer-events: none;
        display: none;
      }
      .ocr-guide {
        position: absolute;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.28);
        background: rgba(15, 17, 23, 0.82);
        color: #ffffff;
        backdrop-filter: blur(16px);
        font: 600 13px/1.3 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        pointer-events: none;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
      }
      .ocr-panel {
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: min(360px, calc(100vw - 32px));
        max-height: 70vh;
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(var(--npt-surface), .6);
        border-radius: 16px;
        background: linear-gradient(160deg, rgba(var(--npt-surface), .82), rgba(var(--npt-surface-2), .64));
        box-shadow: 0 18px 44px rgba(15,17,23,.26), inset 0 1px 0 rgba(var(--npt-surface), .95);
        color: rgb(var(--npt-ink));
        backdrop-filter: blur(24px) saturate(1.8);
        pointer-events: auto;
        overflow: hidden;
      }
      .ocr-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(15,17,23,.08);
        cursor: move;
        user-select: none;
        touch-action: none;
      }
      .ocr-title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font: 700 12.5px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        color: rgba(var(--npt-ink), .88);
      }
      .ocr-close {
        all: unset;
        box-sizing: border-box;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 7px;
        color: rgba(var(--npt-ink), .58);
      }
      .ocr-close:hover { background: rgba(var(--npt-surface), .55); color: rgb(var(--npt-ink)); }
      .ocr-body {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        overflow-y: auto;
      }
      .ocr-textarea {
        width: 100%;
        min-height: 120px;
        max-height: 220px;
        box-sizing: border-box;
        padding: 9px 10px;
        border-radius: 10px;
        border: 1px solid rgba(15,17,23,.12);
        background: rgba(var(--npt-surface), .56);
        color: rgb(var(--npt-ink));
        font: 500 12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
        resize: vertical;
      }
      .ocr-error {
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(220, 38, 38, 0.12);
        border: 1px solid rgba(220, 38, 38, 0.28);
        color: #b91c1c;
        font: 600 12px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        .ocr-error { color: #fca5a5; }
      }
      .ocr-translated {
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(99, 102, 241, 0.28);
        background: rgba(99, 102, 241, 0.08);
        color: rgb(var(--npt-ink));
        font: 500 12.5px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ocr-foot {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        padding: 0 12px 11px;
      }
      .ocr-btn {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        padding: 6px 11px;
        border-radius: 9px;
        border: 1px solid rgba(15,17,23,.1);
        background: rgba(var(--npt-surface), .55);
        color: rgb(var(--npt-ink));
        font: 620 11.5px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        transition: background .16s ease;
      }
      .ocr-btn:hover:not(:disabled) { background: rgba(var(--npt-surface), .82); }
      .ocr-btn:disabled { opacity: .6; cursor: progress; }
      .ocr-btn-primary {
        background: #4f46e5;
        border-color: #4f46e5;
        color: #ffffff;
      }
      .ocr-btn-primary:hover:not(:disabled) { background: #4338ca; }
    `;
    ocrShadow.appendChild(style);
    if (global.NPT_SHADOW_STYLE?.apply) {
      global.NPT_SHADOW_STYLE.apply(ocrShadow);
    }

    if (!escapeInstalled && typeof document !== 'undefined' && document.addEventListener) {
      escapeInstalled = true;
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        let closed = false;
        if (ocrOverlay) {
          closeOcrOverlay();
          closed = true;
        }
        if (ocrPanel) {
          closeOcrPanel();
          closed = true;
        }
        if (closed) event.stopPropagation();
      }, true);
    }

    return ocrShadow;
  }

  function closeOcrOverlay() {
    if (ocrOverlay) {
      try { ocrOverlay.remove(); } catch (_) {}
      ocrOverlay = null;
    }
  }

  function closeOcrPanel() {
    if (ocrPanel) {
      try { ocrPanel.remove(); } catch (_) {}
      ocrPanel = null;
    }
  }

  function showOcrResultPanel(text, options = {}) {
    closeOcrPanel();
    const shadow = ensureOcrShadow();
    const isError = Boolean(options.isError);

    const panel = document.createElement('div');
    panel.className = 'ocr-panel';
    panel.dataset.tmNoTranslate = 'true';
    ocrPanel = panel;

    const head = document.createElement('div');
    head.className = 'ocr-head';
    head.title = 'Kéo để di chuyển';

    const title = document.createElement('span');
    title.className = 'ocr-title';
    title.innerHTML = `${iconSvg('scan', 14)}<span>${isError ? 'Lỗi OCR' : 'Kết quả OCR'}</span>`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ocr-close';
    closeBtn.title = 'Đóng (Esc)';
    closeBtn.innerHTML = iconSvg('close', 12) || '✕';
    closeBtn.addEventListener('click', closeOcrPanel);

    head.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'ocr-body';

    const foot = document.createElement('div');
    foot.className = 'ocr-foot';

    if (isError) {
      const errBox = document.createElement('div');
      errBox.className = 'ocr-error';
      errBox.textContent = String(text || 'Không thể quét chữ từ màn hình');
      body.appendChild(errBox);
    } else {
      const textarea = document.createElement('textarea');
      textarea.className = 'ocr-textarea';
      textarea.value = String(text || '');
      body.appendChild(textarea);

      const translatedBox = document.createElement('div');
      translatedBox.className = 'ocr-translated';
      translatedBox.hidden = true;
      body.appendChild(translatedBox);

      if (typeof handlers.onTranslateText === 'function') {
        const translateBtn = document.createElement('button');
        translateBtn.type = 'button';
        translateBtn.className = 'ocr-btn';
        const translateLabel = `${iconSvg('translate', 12)}<span>Dịch ngay</span>`;
        translateBtn.innerHTML = translateLabel;
        translateBtn.addEventListener('click', async () => {
          const source = textarea.value.trim();
          if (!source) return;
          translateBtn.disabled = true;
          translateBtn.textContent = 'Đang dịch…';
          try {
            const target = handlers.getTargetLanguage?.() || 'vi';
            const out = await handlers.onTranslateText(source, target);
            translatedBox.textContent = String(out || '').trim();
            translatedBox.hidden = false;
          } catch (error) {
            translatedBox.textContent = `Lỗi dịch: ${error?.message || error}`;
            translatedBox.hidden = false;
          } finally {
            translateBtn.disabled = false;
            translateBtn.innerHTML = translateLabel;
          }
        });
        foot.appendChild(translateBtn);
      }

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ocr-btn ocr-btn-primary';
      const copyDefaultHtml = `${iconSvg('copy', 12)}<span>Sao chép</span>`;
      const copyDoneHtml = `${iconSvg('check', 12)}<span>Đã chép</span>`;
      copyBtn.innerHTML = copyDefaultHtml;
      copyBtn.addEventListener('click', async () => {
        const content = !translatedBox.hidden && translatedBox.textContent
          ? translatedBox.textContent
          : textarea.value;
        try {
          await navigator.clipboard.writeText(content);
          copyBtn.innerHTML = copyDoneHtml;
          setTimeout(() => {
            if (panel.isConnected) copyBtn.innerHTML = copyDefaultHtml;
          }, 1600);
        } catch (_) {
          copyBtn.innerHTML = `${iconSvg('alert', 12)}<span>Lỗi chép</span>`;
          setTimeout(() => {
            if (panel.isConnected) copyBtn.innerHTML = copyDefaultHtml;
          }, 1600);
        }
      });
      foot.appendChild(copyBtn);
    }

    panel.append(head, body, foot);

    // Kéo thả panel qua pointer events
    let dragState = null;
    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        baseLeft: rect.left,
        baseTop: rect.top,
      };
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${Math.round(rect.left)}px`;
      panel.style.top = `${Math.round(rect.top)}px`;
      try { head.setPointerCapture(event.pointerId); } catch (_) {}
    });
    head.addEventListener('pointermove', (event) => {
      if (!dragState) return;
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      const maxLeft = (global.innerWidth || 1200) - (panel.offsetWidth || 320) - 8;
      const maxTop = (global.innerHeight || 800) - (panel.offsetHeight || 200) - 8;
      panel.style.left = `${Math.round(Math.max(8, Math.min(dragState.baseLeft + dx, maxLeft)))}px`;
      panel.style.top = `${Math.round(Math.max(8, Math.min(dragState.baseTop + dy, maxTop)))}px`;
    });
    const endDrag = () => { dragState = null; };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    shadow.appendChild(panel);
    return panel;
  }

  function startOcrMode(options = {}) {
    if (typeof window !== 'undefined' && window !== window.top) return;
    configure(options);
    closeOcrOverlay();

    const shadow = ensureOcrShadow();
    const overlay = document.createElement('div');
    overlay.className = 'ocr-overlay';
    overlay.dataset.tmNoTranslate = 'true';
    ocrOverlay = overlay;

    const selectionBox = document.createElement('div');
    selectionBox.className = 'ocr-box';

    const guide = document.createElement('div');
    guide.className = 'ocr-guide';
    guide.innerHTML = `${iconSvg('scan', 14)}<span>Kéo chuột chọn vùng quét chữ (Esc để thoát)</span>`;

    overlay.append(selectionBox, guide);

    let isSelecting = false;
    let startX = 0;
    let startY = 0;

    overlay.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      isSelecting = true;
      startX = event.clientX;
      startY = event.clientY;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    });

    overlay.addEventListener('mousemove', (event) => {
      if (!isSelecting) return;
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const w = Math.abs(event.clientX - startX);
      const h = Math.abs(event.clientY - startY);
      selectionBox.style.left = `${x}px`;
      selectionBox.style.top = `${y}px`;
      selectionBox.style.width = `${w}px`;
      selectionBox.style.height = `${h}px`;
    });

    overlay.addEventListener('mouseup', async (event) => {
      if (!isSelecting) return;
      isSelecting = false;

      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const w = Math.abs(event.clientX - startX);
      const h = Math.abs(event.clientY - startY);

      if (w < 10 || h < 10) {
        selectionBox.style.display = 'none';
        return;
      }

      guide.textContent = 'Đang trích xuất chữ…';
      overlay.style.opacity = '0';

      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        const captureResponse = await chrome.runtime.sendMessage({ type: 'ocrTakeScreenshot' });
        if (!captureResponse || !captureResponse.ok) {
          throw new Error(captureResponse?.error || 'Lỗi chụp màn hình');
        }

        const croppedDataUrl = await cropImage(captureResponse.dataUrl, { x, y, width: w, height: h });
        const response = await chrome.runtime.sendMessage({
          type: 'ocrProcessScreenshot',
          payload: {
            dataUrl: croppedDataUrl,
            rect: { x, y, width: w, height: h },
          },
        });
        if (!response || !response.ok) {
          throw new Error(response?.error || 'Lỗi xử lý OCR');
        }

        const extractedText = (
          response.text
          || (response.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n')
          || ''
        ).trim();
        showOcrResultPanel(extractedText || 'Không nhận diện được văn bản trong vùng chọn.');
      } catch (err) {
        showOcrResultPanel(err?.message || String(err), { isError: true });
      } finally {
        closeOcrOverlay();
      }
    });

    shadow.appendChild(overlay);
  }

  const api = {
    MAX_CROP_SIDE,
    configure,
    computeCropRect,
    cropImage,
    startOcrMode,
    showOcrResultPanel,
    closeOcrOverlay,
    closeOcrPanel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_OCR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
