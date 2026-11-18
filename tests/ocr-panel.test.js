/* Test thuần node cho ocr-panel.js — chạy: node tests/ocr-panel.test.js */
'use strict';

const assert = require('node:assert/strict');
const OCR = require('../ocr-panel.js');

function run() {
  // 1. Exports đầy đủ
  assert.equal(typeof OCR.computeCropRect, 'function');
  assert.equal(typeof OCR.cropImage, 'function');
  assert.equal(typeof OCR.startOcrMode, 'function');
  assert.equal(typeof OCR.showOcrResultPanel, 'function');
  assert.equal(typeof OCR.closeOcrOverlay, 'function');
  assert.equal(typeof OCR.closeOcrPanel, 'function');
  assert.equal(typeof OCR.configure, 'function');

  // 2. computeCropRect: scale DPI 2x (Retina) mà vẫn giữ nguyên kích thước khi <= 1800
  {
    const res = OCR.computeCropRect(
      { x: 100, y: 50, width: 400, height: 200 },
      2560, 1600,
      1280, 800,
      1800,
    );
    assert.deepEqual(res, {
      cropX: 200,
      cropY: 100,
      cropW: 800,
      cropH: 400,
      outW: 800,
      outH: 400,
    });
  }

  // 3. computeCropRect: downscale khi vùng chọn quá 1800px trên màn hình 4K
  {
    const res = OCR.computeCropRect(
      { x: 0, y: 0, width: 1200, height: 600 },
      3600, 1800,
      1200, 600,
      1800,
    );
    assert.equal(res.cropW, 3600);
    assert.equal(res.cropH, 1800);
    assert.equal(res.outW, 1800);
    assert.equal(res.outH, 900);
  }

  // 4. computeCropRect: clamp tọa độ âm / tràn mép ảnh
  {
    const res = OCR.computeCropRect(
      { x: -50, y: -20, width: 2000, height: 2000 },
      1000, 800,
      1000, 800,
      1800,
    );
    assert.equal(res.cropX, 0);
    assert.equal(res.cropY, 0);
    assert.equal(res.cropW, 1000);
    assert.equal(res.cropH, 800);
  }

  // 5. Đóng overlay/panel khi chưa mở không ném lỗi
  OCR.closeOcrOverlay();
  OCR.closeOcrPanel();

  console.log('Tất cả test ocr-panel.js đều PASS ✔');
}

run();
