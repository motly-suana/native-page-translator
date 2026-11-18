/* ========================================================================
 * NPT Translation Pipeline — lọc node hiển thị, phân tầng viewport,
 * gom progressive micro-batches, worker pool streaming không chặn UI,
 * binary-split recovery và chia nhỏ long tasks theo scheduler.yield().
 *
 * JS thuần (không dùng chrome.*): chạy được trong content script,
 * background service worker (importScripts) và Node.js (unit tests).
 * ====================================================================== */
(function attachPipeline(global) {
  'use strict';

  const URL_ONLY_RE = /^(?:https?:\/\/|www\.)\S+$/i;
  const EMAIL_ONLY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
  const TECH_TOKEN_RE = /^(?:v?\d+(?:\.\d+)+(?:-[a-z0-9.]+)?|\d+(?:\.\d+)?\s*(?:px|rem|em|vh|vw|vmin|vmax|ms|kb|mb|gb|tb|fps|hz|khz|mhz|ghz)|sha(?:1|256|512)|md5)$/i;
  const USERNAME_HANDLE_PATTERNS = [
    /^@[\w.\-]{1,32}$/u,
    /^(?:u|user)\/[\w\-]{2,20}$/i,
  ];

  /**
   * Kiểm tra chuỗi có phải văn bản tự nhiên đáng dịch hay không.
   */
  function isTranslatableText(value, options = {}) {
    const minLength = Number.isFinite(options.minLength) ? options.minLength : 2;
    const skipUsernames = options.skipUsernames !== false;
    const skipCode = options.skipCode !== false;

    const text = String(value ?? '').trim();
    if (text.length < minLength) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (URL_ONLY_RE.test(text)) return false;
    if (EMAIL_ONLY_RE.test(text)) return false;
    if (HEX_COLOR_RE.test(text)) return false;
    if (skipCode && TECH_TOKEN_RE.test(text)) return false;
    if (skipUsernames && USERNAME_HANDLE_PATTERNS.some(pattern => pattern.test(text))) return false;
    return true;
  }

  /**
   * Kiểm tra phần tử có đang thực sự hiển thị (loại bỏ display:none, hidden,
   * visibility:hidden và các phần tử rect 0x0).
   */
  function isElementVisiblyRendered(element, rect) {
    if (!element) return false;
    if (element.hidden === true) return false;
    if (typeof element.checkVisibility === 'function') {
      try {
        if (!element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
          return false;
        }
      } catch (_) {
        // Bỏ qua nếu element giả lập hoặc detached làm checkVisibility throw.
      }
    }
    if (!rect || (rect.width <= 0 && rect.height <= 0)) return false;
    return true;
  }

  function resolveViewport(viewport) {
    if (viewport && Number.isFinite(viewport.height) && Number.isFinite(viewport.width)) {
      return viewport;
    }
    const vp = typeof global.visualViewport !== 'undefined' ? global.visualViewport : null;
    const docEl = typeof global.document !== 'undefined' ? global.document.documentElement : null;
    const height = vp?.height || global.innerHeight || docEl?.clientHeight || 800;
    const width = vp?.width || global.innerWidth || docEl?.clientWidth || 1280;
    return { width, height };
  }

  /**
   * Phân vùng textNodes và attributeTargets theo khung nhìn trong ĐÚNG 1 lượt đọc
   * geometry cho mỗi Element (tránh Layout Thrashing O(N log N) khi sort).
   */
  function partitionTargetsByViewport(textNodes, attributeTargets, viewport) {
    const { width, height } = resolveViewport(viewport);
    const heroBottomBound = height * 0.95;
    const nearTopBound = -height * 0.25;
    const nearBottomBound = height * 1.35;
    const horizLeftBound = -width * 0.25;
    const horizRightBound = width * 1.5;

    const elementCache = new Map();
    let skippedHiddenCount = 0;

    function inspectElement(element) {
      if (!element) return { visible: false, inHero: false, inNear: false };
      const cached = elementCache.get(element);
      if (cached) return cached;

      let rect = null;
      try {
        rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
      } catch (_) {
        rect = null;
      }

      const visible = isElementVisiblyRendered(element, rect);
      let inHero = false;
      let inNear = false;
      if (visible && rect) {
        const horizVisible = rect.right > 0 && rect.left < width;
        const horizNear = rect.right > horizLeftBound && rect.left < horizRightBound;
        if (horizVisible && rect.bottom > 0 && rect.top < heroBottomBound) {
          inHero = true;
        } else if (horizNear && rect.bottom > nearTopBound && rect.top < nearBottomBound) {
          inNear = true;
        }
      }

      const result = { visible, inHero, inNear };
      elementCache.set(element, result);
      return result;
    }

    const heroTextNodes = [];
    const nearTextNodes = [];
    const offscreenTextNodes = [];

    for (const node of textNodes || []) {
      const parent = node?.parentElement || null;
      const info = inspectElement(parent);
      if (!info.visible) {
        skippedHiddenCount++;
        offscreenTextNodes.push(node);
      } else if (info.inHero) {
        heroTextNodes.push(node);
      } else if (info.inNear) {
        nearTextNodes.push(node);
      } else {
        offscreenTextNodes.push(node);
      }
    }

    const viewportAttributes = [];
    const offscreenAttributes = [];

    for (const target of attributeTargets || []) {
      const info = inspectElement(target?.element || null);
      if (!info.visible) {
        skippedHiddenCount++;
        offscreenAttributes.push(target);
      } else if (info.inHero || info.inNear) {
        viewportAttributes.push(target);
      } else {
        offscreenAttributes.push(target);
      }
    }

    return {
      heroTextNodes,
      nearTextNodes,
      viewportAttributes,
      offscreenTextNodes,
      offscreenAttributes,
      skippedHiddenCount,
    };
  }

  /**
   * Phân nhóm chữ viết để Google Free nhận diện đúng ngôn ngữ nguồn theo từng batch.
   */
  function detectScriptClass(text) {
    if (/[\u3040-\u30FF]/.test(text)) return 'ja';
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
    return 'other';
  }

  const WAVE_PROFILES = {
    llm: [
      { maxItems: 8, maxChars: 1200 },
      { maxItems: 14, maxChars: 2400 },
      { maxItems: 24, maxChars: 4500 },
    ],
    deepl: [
      { maxItems: 15, maxChars: 3000 },
      { maxItems: 48, maxChars: 14000 },
    ],
    free: [
      { maxItems: 12, maxChars: 1400 },
      { maxItems: 28, maxChars: 2800 },
    ],
  };

  /**
   * Gom batch thích ứng 2-3 tầng: batch đầu tiên nhỏ để trả kết quả siêu nhanh
   * (Fast First Paint), các batch sau tăng dần kích thước tối ưu thông lượng.
   */
  function buildProgressiveBatches(items, options = {}) {
    if (!Array.isArray(items) || !items.length) return [];
    const mode = WAVE_PROFILES[options.mode] ? options.mode : 'llm';
    const profile = WAVE_PROFILES[mode];

    const byScript = new Map();
    for (const item of items) {
      const cls = detectScriptClass(String(item?.text ?? ''));
      if (!byScript.has(cls)) byScript.set(cls, []);
      byScript.get(cls).push(item);
    }

    const batches = [];
    for (const group of byScript.values()) {
      let current = [];
      let chars = 0;
      let waveIdx = batches.length;

      for (const item of group) {
        const textLen = String(item?.text ?? '').length;
        const limits = profile[Math.min(waveIdx, profile.length - 1)];
        if (current.length && (current.length >= limits.maxItems || chars + textLen > limits.maxChars)) {
          batches.push(current);
          current = [];
          chars = 0;
          waveIdx = batches.length;
        }
        current.push(item);
        chars += textLen;
      }
      if (current.length) batches.push(current);
    }

    return batches;
  }

  /**
   * Worker pool streaming: mỗi batch xong là gọi onBatchResolved ngay lập tức,
   * không chờ toàn bộ các batch khác hoàn thành.
   */
  async function runProgressiveWorkerPool({ batches, concurrency = 4, signal, executeBatch, onBatchResolved, onBatchError }) {
    if (!Array.isArray(batches) || !batches.length) return;
    const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), batches.length);
    let cursor = 0;

    async function worker() {
      while (cursor < batches.length) {
        if (signal?.aborted) return;
        const batchIndex = cursor++;
        const batch = batches[batchIndex];
        try {
          const result = await executeBatch(batch, batchIndex);
          if (signal?.aborted) return;
          if (typeof onBatchResolved === 'function') {
            await onBatchResolved(result, batchIndex, batch);
          }
        } catch (error) {
          if (signal?.aborted) return;
          if (typeof onBatchError === 'function') {
            await onBatchError(error, batch, batchIndex);
          } else {
            throw error;
          }
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  function createAbortError() {
    const error = new Error('Translation aborted');
    error.name = 'AbortError';
    return error;
  }

  /**
   * Thử dịch batch; nếu thất bại (hoặc trả null/lệch độ dài) và batch đủ lớn,
   * tự động chia đôi (binary split) để cô lập phần tử lỗi thay vì mất cả batch.
   */
  async function translateWithSplitRecovery(batch, translateFn, options = {}) {
    const minSplitSize = Math.max(1, Number(options.minSplitSize) || 3);
    const signal = options.signal;
    if (signal?.aborted) throw createAbortError();
    if (!Array.isArray(batch) || !batch.length) return [];

    let caughtError = null;
    try {
      const result = await translateFn(batch);
      if (Array.isArray(result) && result.length === batch.length) {
        return result;
      }
      caughtError = new Error('Batch result length mismatch');
    } catch (error) {
      if (error?.name === 'AbortError' || error?.noSplit || signal?.aborted) throw error;
      caughtError = error;
    }

    if (batch.length >= minSplitSize * 2) {
      const mid = Math.ceil(batch.length / 2);
      const [left, right] = await Promise.all([
        translateWithSplitRecovery(batch.slice(0, mid), translateFn, options),
        translateWithSplitRecovery(batch.slice(mid), translateFn, options),
      ]);
      return left.concat(right);
    }

    throw caughtError || new Error('Batch translation failed');
  }

  /**
   * Nhường main thread khi vòng lặp xử lý DOM vượt quá ngân sách 50ms để giữ INP mượt.
   */
  async function yieldToMain(deadlineRef, budgetMs = 50) {
    const nowFn = typeof global.performance?.now === 'function'
      ? () => global.performance.now()
      : () => Date.now();
    if (!deadlineRef || nowFn() < deadlineRef.value) return;

    if (typeof global.scheduler?.yield === 'function') {
      await global.scheduler.yield();
    } else {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    deadlineRef.value = nowFn() + budgetMs;
  }

  const api = {
    WAVE_PROFILES,
    isTranslatableText,
    isElementVisiblyRendered,
    partitionTargetsByViewport,
    detectScriptClass,
    buildProgressiveBatches,
    runProgressiveWorkerPool,
    translateWithSplitRecovery,
    yieldToMain,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_PIPELINE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
