/* Benchmark đo hiệu năng Trước / Sau cho native-page-translator.
 * Chạy trước tối ưu: node tests/perf-benchmark.js --baseline
 * Chạy sau tối ưu:   node tests/perf-benchmark.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const BASELINE_FILE = '/tmp/npt-perf-baseline.json';
const TIME_SCALE = 0.05; // 1ms thực = 20ms mạng LLM mô phỏng (180ms + 0.35ms/char)
const RUNS = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function simulatedLlmDelayMs(chars) {
  return (180 + chars * 0.35) * TIME_SCALE;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSyntheticPage() {
  const nodes = [];
  // 40 text nodes ngay trong hero viewport (top: 40..760)
  for (let i = 0; i < 40; i++) {
    nodes.push({
      id: `hero-${i}`,
      text: `Hero paragraph ${i}: Modern web translation should render visible text immediately without blocking.`,
      parent: {
        hidden: false,
        checkVisibility: () => true,
        getBoundingClientRect: () => ({ top: 40 + (i % 15) * 45, bottom: 75 + (i % 15) * 45, left: 20, right: 800, width: 780, height: 35 }),
      },
    });
  }
  // 120 text nodes sát viewport (top: 850..1150)
  for (let i = 0; i < 120; i++) {
    nodes.push({
      id: `near-${i}`,
      text: `Near fold content block ${i} discussing browser rendering pipelines and concurrency pools.`,
      parent: {
        hidden: false,
        checkVisibility: () => true,
        getBoundingClientRect: () => ({ top: 850 + (i % 10) * 30, bottom: 875 + (i % 10) * 30, left: 20, right: 800, width: 780, height: 25 }),
      },
    });
  }
  // 350 text nodes ẩn display:none -> rect {0,0,0,0} (bị bug v4.6.0 phân loại nhầm là inView!)
  for (let i = 0; i < 350; i++) {
    nodes.push({
      id: `hidden-${i}`,
      text: `Hidden mega-menu drawer item number ${i} inside collapsed dropdown panel.`,
      parent: {
        hidden: false,
        checkVisibility: () => false,
        getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      },
    });
  }
  // 240 text nodes ở xa phía dưới trang (top: 2500..7000)
  for (let i = 0; i < 240; i++) {
    nodes.push({
      id: `far-${i}`,
      text: `Below the fold article section ${i} with detailed technical commentary and examples.`,
      parent: {
        hidden: false,
        checkVisibility: () => true,
        getBoundingClientRect: () => ({ top: 2500 + i * 20, bottom: 2518 + i * 20, left: 20, right: 800, width: 780, height: 18 }),
      },
    });
  }
  // 300 attribute targets (20 trong viewport, 280 dưới đáy trang)
  const attrs = [];
  for (let i = 0; i < 300; i++) {
    const inVp = i < 20;
    const top = inVp ? 100 + i * 25 : 3200 + i * 20;
    attrs.push({
      id: `attr-${i}`,
      attribute: i % 2 === 0 ? 'title' : 'alt',
      text: `Image or button tooltip label ${i} describing navigation action`,
      element: {
        hidden: false,
        checkVisibility: () => true,
        getBoundingClientRect: () => ({ top, bottom: top + 20, left: 10, right: 200, width: 190, height: 20 }),
      },
    });
  }
  return { nodes, attrs, viewport: { width: 1280, height: 800 } };
}

function measureFancyText() {
  const fancyPath = require.resolve('../fancy-text.js');
  delete require.cache[fancyPath];
  const t0 = performance.now();
  const FANCY = require('../fancy-text.js');
  const coldLoadMs = performance.now() - t0;

  const samples = [
    'Welcome to the documentation for modern web APIs and service workers.',
    'Trình duyệt Chrome xử lý hàng nghìn nút văn bản mỗi giây trên trang tin tức.',
    'Click Save Settings to apply your custom Gemini API key rotation pool.',
    'Thông báo: cập nhật hệ thống sẽ diễn ra vào lúc 02:00 UTC ngày mai.',
  ];
  const t1 = performance.now();
  for (let i = 0; i < 20000; i++) {
    FANCY.normalizeStyledText(samples[i & 3]);
  }
  const normalize20kMs = performance.now() - t1;
  return { coldLoadMs, normalize20kMs };
}

async function measureBaselinePipeline() {
  const { nodes, attrs, viewport } = createSyntheticPage();
  const innerHeight = viewport.height;
  const innerWidth = viewport.width;

  const tCpuStart = performance.now();
  // Baseline splitByViewport (v4.6.0)
  const seen = new Map();
  const topBound = innerHeight * 1.5;
  const bottomBound = -innerHeight * 0.5;
  const inView = [];
  for (const node of nodes) {
    const parent = node.parent;
    let visible = seen.get(parent);
    if (visible === undefined) {
      const rect = parent.getBoundingClientRect();
      visible = rect.top < topBound && rect.bottom > bottomBound;
      seen.set(parent, visible);
    }
    if (visible) inView.push(node);
  }
  // Baseline đẩy toàn bộ attrs vào lượt đầu cùng inView
  const jobs = [
    ...inView.map(n => ({ kind: 'text', node: n, text: n.text })),
    ...attrs.map(a => ({ kind: 'attribute', element: a.element, text: a.text })),
  ];
  // Baseline sort gọi getBoundingClientRect không cache trong comparator
  const isJobInViewport = (job) => {
    const el = job.kind === 'attribute' ? job.element : job.node.parent;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return rect.bottom >= 0 && rect.top <= innerHeight && rect.right >= 0 && rect.left <= innerWidth;
  };
  jobs.sort((a, b) => (isJobInViewport(b) ? 1 : 0) - (isJobInViewport(a) ? 1 : 0));
  const cpuPrepMs = performance.now() - tCpuStart;

  const wastedHiddenOrOffscreen = jobs.filter(j =>
    (j.node && (j.node.id.startsWith('hidden-') || j.node.id.startsWith('far-')))
    || (j.kind === 'attribute' && j.element.getBoundingClientRect().top > innerHeight)
  ).length;

  // Baseline batching: 48 items / 15000 chars
  const batches = [];
  let current = [];
  let size = 0;
  for (const job of jobs) {
    const add = job.text.length + 50;
    if (current.length && (current.length >= 48 || size + add > 15000)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(job);
    size += add;
  }
  if (current.length) batches.push(current);

  const tStart = performance.now();
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const chars = batch.reduce((s, item) => s + item.text.length, 0);
      await sleep(simulatedLlmDelayMs(chars));
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));
  // Baseline chỉ ghi DOM sau khi ALL workers xong
  const allDoneMs = (performance.now() - tStart) / TIME_SCALE;

  return {
    cpuPrepMs,
    immediateJobCount: jobs.length,
    wastedHiddenOrOffscreen,
    batchCount: batches.length,
    ttftSimulatedMs: allDoneMs,
    viewportDoneSimulatedMs: allDoneMs,
  };
}

async function measureOptimizedPipeline() {
  const P = require('../translation-pipeline.js');
  const { nodes, attrs, viewport } = createSyntheticPage();

  const textInputs = nodes.map(n => ({ id: n.id, text: n.text, parentElement: n.parent }));
  const attrInputs = attrs.map(a => ({ id: a.id, text: a.text, element: a.element }));

  const tCpuStart = performance.now();
  const partitioned = P.partitionTargetsByViewport(textInputs, attrInputs, viewport);
  const immediateItems = [
    ...partitioned.heroTextNodes.map((n, idx) => ({ index: idx, text: n.text, isHero: true })),
    ...partitioned.nearTextNodes.map((n, idx) => ({ index: 1000 + idx, text: n.text, isHero: false })),
    ...partitioned.viewportAttributes.map((a, idx) => ({ index: 2000 + idx, text: a.text, isHero: false })),
  ];
  const batches = P.buildProgressiveBatches(immediateItems, { mode: 'llm' });
  const cpuPrepMs = performance.now() - tCpuStart;

  const wastedHiddenOrOffscreen = partitioned.heroTextNodes.filter(n => n.id.startsWith('hidden-') || n.id.startsWith('far-')).length
    + partitioned.nearTextNodes.filter(n => n.id.startsWith('hidden-') || n.id.startsWith('far-')).length
    + partitioned.viewportAttributes.filter(a => a.element.getBoundingClientRect().top > viewport.height).length;

  const tStart = performance.now();
  let ttftMs = null;
  let heroSeenCount = 0;
  const totalHero = partitioned.heroTextNodes.length;
  let heroDoneMs = null;

  await P.runProgressiveWorkerPool({
    batches,
    concurrency: 5,
    executeBatch: async (batch) => {
      const chars = batch.reduce((s, item) => s + item.text.length, 0);
      await sleep(simulatedLlmDelayMs(chars));
      return batch;
    },
    onBatchResolved: (batch) => {
      const elapsed = (performance.now() - tStart) / TIME_SCALE;
      if (ttftMs === null) ttftMs = elapsed;
      for (const item of batch) {
        if (item.isHero) heroSeenCount++;
      }
      if (heroDoneMs === null && heroSeenCount >= totalHero) {
        heroDoneMs = elapsed;
      }
    },
  });
  const viewportDoneMs = (performance.now() - tStart) / TIME_SCALE;

  return {
    cpuPrepMs,
    immediateJobCount: immediateItems.length,
    wastedHiddenOrOffscreen,
    batchCount: batches.length,
    ttftSimulatedMs: ttftMs ?? viewportDoneMs,
    heroDoneSimulatedMs: heroDoneMs ?? viewportDoneMs,
    viewportDoneSimulatedMs: viewportDoneMs,
  };
}

async function runSuite(fn) {
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    results.push(await fn());
  }
  const keys = Object.keys(results[0]);
  const summary = {};
  for (const key of keys) {
    summary[key] = Number(median(results.map(r => r[key])).toFixed(2));
  }
  return summary;
}

async function main() {
  const isBaselineMode = process.argv.includes('--baseline');
  const fancy = await runSuite(async () => measureFancyText());

  if (isBaselineMode) {
    const pipeline = await runSuite(measureBaselinePipeline);
    const report = { mode: 'baseline-v4.6.0', fancy, pipeline };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(report, null, 2));
    console.log('=== BASELINE v4.6.0 (median of 5 runs) ===');
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pipeline = await runSuite(measureOptimizedPipeline);
  const current = { mode: 'optimized-v4.7.0', fancy, pipeline };
  console.log('=== OPTIMIZED v4.7.0 (median of 5 runs) ===');
  console.log(JSON.stringify(current, null, 2));

  if (fs.existsSync(BASELINE_FILE)) {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    console.log('\n=== SO SÁNH TRƯỚC -> SAU ===');
    console.log(`fancy coldLoadMs:        ${base.fancy.coldLoadMs}ms -> ${current.fancy.coldLoadMs}ms`);
    console.log(`fancy normalize 20k:     ${base.fancy.normalize20kMs}ms -> ${current.fancy.normalize20kMs}ms`);
    console.log(`DOM prep + sort CPU:     ${base.pipeline.cpuPrepMs}ms -> ${current.pipeline.cpuPrepMs}ms`);
    console.log(`Immediate items sent:    ${base.pipeline.immediateJobCount} -> ${current.pipeline.immediateJobCount}`);
    console.log(`Wasted hidden/offscreen: ${base.pipeline.wastedHiddenOrOffscreen} -> ${current.pipeline.wastedHiddenOrOffscreen}`);
    console.log(`TTFT (simulated LLM):    ${base.pipeline.ttftSimulatedMs}ms -> ${current.pipeline.ttftSimulatedMs}ms`);
    console.log(`Viewport done (LLM):     ${base.pipeline.viewportDoneSimulatedMs}ms -> ${current.pipeline.viewportDoneSimulatedMs}ms`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
