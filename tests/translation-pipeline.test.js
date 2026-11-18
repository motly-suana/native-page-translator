/* Test thuần node cho translation-pipeline.js — chạy: node tests/translation-pipeline.test.js */
'use strict';

const assert = require('node:assert/strict');
const P = require('../translation-pipeline.js');

async function run() {
  // 1. isTranslatableText lọc rác kỹ thuật và URL/email/hex/username
  {
    assert.equal(P.isTranslatableText('Hello world'), true);
    assert.equal(P.isTranslatableText('Xin chào'), true);
    assert.equal(P.isTranslatableText('a'), false);
    assert.equal(P.isTranslatableText('12345'), false);
    assert.equal(P.isTranslatableText('https://example.com/docs'), false);
    assert.equal(P.isTranslatableText('user@example.com'), false);
    assert.equal(P.isTranslatableText('#ff00aa'), false);
    assert.equal(P.isTranslatableText('v1.2.3-beta'), false);
    assert.equal(P.isTranslatableText('16px'), false);
    assert.equal(P.isTranslatableText('sha256'), false);
    assert.equal(P.isTranslatableText('@username', { skipUsernames: true }), false);
    assert.equal(P.isTranslatableText('@username', { skipUsernames: false }), true);
    assert.equal(P.isTranslatableText('v1.2.3 release notes'), true);
  }

  // 2. Regression bug display:none {top:0, bottom:0, width:0, height:0}
  {
    const hiddenEl = {
      hidden: false,
      checkVisibility: () => false,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    };
    const zeroRectEl = {
      hidden: false,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    };
    const visibleEl = {
      hidden: false,
      checkVisibility: () => true,
      getBoundingClientRect: () => ({ top: 100, bottom: 140, left: 20, right: 400, width: 380, height: 40 }),
    };

    assert.equal(P.isElementVisiblyRendered(hiddenEl, hiddenEl.getBoundingClientRect()), false);
    assert.equal(P.isElementVisiblyRendered(zeroRectEl, zeroRectEl.getBoundingClientRect()), false);
    assert.equal(P.isElementVisiblyRendered(visibleEl, visibleEl.getBoundingClientRect()), true);
  }

  // 3. partitionTargetsByViewport đọc geometry ĐÚNG 1 lần mỗi parent, tách hero/near/offscreen/attrs
  {
    let heroCalls = 0;
    const sharedHeroParent = {
      hidden: false,
      checkVisibility: () => true,
      getBoundingClientRect: () => {
        heroCalls++;
        return { top: 80, bottom: 120, left: 10, right: 500, width: 490, height: 40 };
      },
    };
    const hiddenParent = {
      hidden: false,
      checkVisibility: () => false,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    };
    const nearParent = {
      hidden: false,
      checkVisibility: () => true,
      getBoundingClientRect: () => ({ top: 900, bottom: 940, left: 10, right: 500, width: 490, height: 40 }),
    };
    const farParent = {
      hidden: false,
      checkVisibility: () => true,
      getBoundingClientRect: () => ({ top: 3000, bottom: 3040, left: 10, right: 500, width: 490, height: 40 }),
    };

    const textNodes = [
      { id: 'h1', parentElement: sharedHeroParent },
      { id: 'h2', parentElement: sharedHeroParent },
      { id: 'hid', parentElement: hiddenParent },
      { id: 'n1', parentElement: nearParent },
      { id: 'f1', parentElement: farParent },
    ];
    const attrs = [
      { id: 'a-vp', element: sharedHeroParent, attribute: 'title' },
      { id: 'a-far', element: farParent, attribute: 'alt' },
      { id: 'a-hid', element: hiddenParent, attribute: 'aria-label' },
    ];

    const out = P.partitionTargetsByViewport(textNodes, attrs, { width: 1280, height: 800 });
    assert.equal(heroCalls, 1, 'chỉ được gọi getBoundingClientRect đúng 1 lần cho sharedHeroParent');
    assert.deepEqual(out.heroTextNodes.map(n => n.id), ['h1', 'h2']);
    assert.deepEqual(out.nearTextNodes.map(n => n.id), ['n1']);
    assert.deepEqual(out.offscreenTextNodes.map(n => n.id), ['hid', 'f1']);
    assert.deepEqual(out.viewportAttributes.map(a => a.id), ['a-vp']);
    assert.deepEqual(out.offscreenAttributes.map(a => a.id), ['a-far', 'a-hid']);
    assert.equal(out.skippedHiddenCount, 2);
  }

  // 4. buildProgressiveBatches: wave 0 nhỏ, tăng dần ở wave sau, tách theo script
  {
    const items = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      text: `Sentence number ${i} with normal length content here.`,
    }));
    const batches = P.buildProgressiveBatches(items, { mode: 'llm' });
    assert.ok(batches.length >= 3);
    assert.equal(batches[0].length, 8, 'Wave 0 LLM phải là 8 items để trả kết quả nhanh nhất');
    assert.equal(batches[1].length, 14, 'Wave 1 LLM phải là 14 items');
    assert.equal(batches[2].length, 18, 'Wave 2 LLM gom nốt phần còn lại (<=24)');

    const mixed = [
      { index: 0, text: 'Hello' },
      { index: 1, text: 'こんにちは' },
      { index: 2, text: '안녕하세요' },
      { index: 3, text: '你好世界' },
    ];
    const mixedBatches = P.buildProgressiveBatches(mixed, { mode: 'free' });
    assert.equal(mixedBatches.length, 4, 'phải tách các hệ chữ khác nhau');
  }

  // 5. runProgressiveWorkerPool: trả từng batch ngay khi xong + abort dừng worker
  {
    const batches = [[1, 2], [3, 4], [5, 6]];
    const resolvedOrder = [];
    await P.runProgressiveWorkerPool({
      batches,
      concurrency: 3,
      executeBatch: async (batch, idx) => {
        // Batch 2 xong trước Batch 0
        await new Promise(r => setTimeout(r, idx === 0 ? 45 : 5));
        return batch.map(x => x * 10);
      },
      onBatchResolved: (res, idx) => {
        resolvedOrder.push({ idx, res });
      },
    });
    assert.equal(resolvedOrder.length, 3);
    assert.notEqual(resolvedOrder[0].idx, 0, 'batch nhanh hơn phải gọi onBatchResolved trước');

    // Kiểm tra AbortController hủy giữa chừng
    const controller = new AbortController();
    const afterAbort = [];
    await P.runProgressiveWorkerPool({
      batches: [[1], [2], [3], [4]],
      concurrency: 1,
      signal: controller.signal,
      executeBatch: async (batch, idx) => {
        if (idx === 0) controller.abort();
        return batch;
      },
      onBatchResolved: (res, idx) => {
        afterAbort.push(idx);
      },
    });
    assert.equal(afterAbort.length, 0, 'khi đã abort thì không được gọi onBatchResolved');
  }

  // 6. translateWithSplitRecovery: tự chia đôi khi lệch length hoặc parse lỗi
  {
    const items = Array.from({ length: 8 }, (_, i) => `item-${i}`);
    let attempts = 0;
    const result = await P.translateWithSplitRecovery(
      items,
      async (sub) => {
        attempts++;
        if (sub.length > 4) return null; // giả lập batch 8 bị LLM trả sai độ dài
        return sub.map(s => `vi:${s}`);
      },
      { minSplitSize: 2 },
    );
    assert.equal(attempts, 3, '1 lần 8 + 2 lần 4');
    assert.deepEqual(result, items.map(s => `vi:${s}`));

    // Không tự chia đôi vô tận nếu nhỏ hơn 2 * minSplitSize
    await assert.rejects(
      P.translateWithSplitRecovery(['a', 'b', 'c'], async () => { throw new Error('hard error'); }, { minSplitSize: 3 }),
      /hard error/,
    );
  }

  // 7. yieldToMain: chỉ nhường khi quá budget
  {
    const futureDeadline = { value: performance.now() + 5000 };
    const t0 = performance.now();
    await P.yieldToMain(futureDeadline, 50);
    assert.ok(performance.now() - t0 < 15, 'chưa hết budget thì không được yield');

    const expiredDeadline = { value: performance.now() - 10 };
    await P.yieldToMain(expiredDeadline, 50);
    assert.ok(expiredDeadline.value > performance.now(), 'sau yield phải cập nhật deadline mới');
  }

  console.log('Tất cả test translation-pipeline.js đều PASS ✔');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
