/* Unit tests cho prompts.js (v5.0): chống prompt injection, pageContext outline,
 * systemOverride và tương thích hợp đồng với providers.test.js. */
'use strict';

const assert = require('node:assert/strict');
const PR = require('../prompts.js');

function run() {
  // 1. Giữ nguyên wording 6 style cũ + bổ sung technical & academic
  {
    assert.equal(PR.PAGE_STYLES.natural.label, 'Tự nhiên');
    assert.equal(PR.PAGE_STYLES.technical.label, 'Kỹ thuật & IT');
    assert.equal(PR.PAGE_STYLES.academic.label, 'Học thuật & Báo chí');
    assert.match(PR.buildBatchInstructions('auto', 'Vietnamese', { style: 'technical' }), /developer-grade/);
    assert.match(PR.buildBatchInstructions('auto', 'Vietnamese', { style: 'academic' }), /scholarly and journalistic/);
  }

  // 2. Bảo toàn invariants contract Test #37 và Test #41
  {
    const bare = PR.buildBatchInstructions('auto', 'Vietnamese', { keepProperNouns: false });
    assert.doesNotMatch(bare, /idiomatically/);
    assert.doesNotMatch(bare, /casual|British|American/);
    assert.match(bare, /untrusted web text data/);
    assert.match(bare, /avoid stiff calques/);
  }

  // 3. pageContext.outline chỉ xuất hiện khi có nội dung; normalizePageOptions giữ sạch khi không override
  {
    const baseCtx = PR.normalizePageContext({ host: 'example.com', title: 'Doc' });
    assert.deepEqual(Object.keys(baseCtx), ['host', 'title', 'siteName', 'description']);

    const withOutline = PR.normalizePageContext({ host: 'example.com', outline: '  Intro › Architecture  ' });
    assert.equal(withOutline.outline, 'Intro › Architecture');
    assert.match(
      PR.buildBatchInstructions('auto', 'Vietnamese', { pageContext: withOutline }),
      /section headings: "Intro › Architecture"/,
    );

    const cleanOpts = PR.normalizePageOptions({});
    assert.equal(Object.hasOwn(cleanOpts, 'systemOverride'), false);
    const overOpts = PR.normalizePageOptions({ systemOverride: '  Luôn dùng ngôi tôi  ' });
    assert.equal(overOpts.systemOverride, 'Luôn dùng ngôi tôi');
    assert.match(
      PR.buildBatchInstructions('auto', 'Vietnamese', overOpts),
      /System-level prompt studio rules:\nLuôn dùng ngôi tôi$/,
    );
  }

  // 4. Nút EN: hỗ trợ tone technical + security boundary + systemOverride
  {
    assert.ok(PR.TONES.includes('technical'));
    const tech = PR.buildNativeInstructions('technical', 'Prefer concise PR style.');
    assert.match(tech, /TECHNICAL ENGINEERING/);
    assert.match(tech, /Security boundary:/);
    assert.match(tech, /Prefer concise PR style\./);
  }

  // 5. Summary, QA, Vision & OCR đều có security boundary và nhận systemOverride
  {
    const sum = PR.buildSummaryInstructions('Vietnamese', 6, 'Nhấn mạnh số liệu');
    assert.match(sum, /Security boundary:/);
    assert.match(sum, /Nhấn mạnh số liệu/);

    const qa = PR.buildQaInstructions('Trình bày ngắn hơn');
    assert.match(qa, /BLIND SOLVING PROTOCOL/);
    assert.match(qa, /Security boundary:/);
    assert.match(qa, /Trình bày ngắn hơn/);

    const vis = PR.buildVisionInstructions('Vietnamese', 'Bỏ watermark');
    assert.match(vis, /Return ONLY a JSON array/);
    assert.match(vis, /Bỏ watermark/);

    const ocr = PR.buildOcrVisionInstructions('Giữ công thức LaTeX');
    assert.match(ocr, /exact Vietnamese diacritics/);
    assert.match(ocr, /Giữ công thức LaTeX/);
  }

  // 6. normalizeSystemPromptOverrides cắt độ dài an toàn
  {
    const norm = PR.normalizeSystemPromptOverrides({ batch: 'x'.repeat(2500), qa: 123, summary: '  ok  ' });
    assert.equal(norm.batch.length, 2000);
    assert.equal(norm.qa, '');
    assert.equal(norm.summary, 'ok');
  }

  console.log('Tất cả test prompts.js đều PASS ✔ (6 nhóm)');
}

run();
