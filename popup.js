/* Popup — tác vụ nhanh: dịch trang, chọn chế độ, xem trạng thái provider. */
'use strict';

const { CONFIG_STORAGE_KEY, PAGE_STYLES, normalizeConfig } = globalThis.NPT_PROVIDERS;

const KEYS = {
  defaultMode: 'tm-native-en-default-mode',
  fallbackQuick: 'tm-native-en-fallback-quick',
  pageUseProvider: 'tm-page-use-provider',
  inputHelper: 'tm-input-helper-enabled',
  pageDisplayMode: 'tm-page-display-mode',
  pageStyle: 'tm-page-style',
  pageDialect: 'tm-page-dialect',
  pageTranslateMode: 'tm-page-translate-mode',
  pageGrammarFix: 'tm-page-grammar-fix',
};

const BLACKLIST_KEY = 'tm-site-blacklist';
const THEME_KEY = 'tm-ui-theme';

// Giá trị hợp lệ của văn phong trang — sai thì về 'natural' theo contract.
const PAGE_STYLE_VALUES = Object.keys(PAGE_STYLES || {
  natural: 1,
  casual: 1,
  'work-email': 1,
  'game-chat': 1,
  genz: 1,
  formal: 1,
  technical: 1,
  academic: 1,
});

// Contract chung: danh sách template + template đang dùng (quản lý đầy đủ ở trang Cài đặt).
const TEMPLATE_KEYS = { templates: 'tm-prompt-templates', active: 'tm-active-template' };

// Đúng thứ tự content_scripts trong manifest — reinjection thiếu file nào thì
// tính năng của file đó chết lặng lẽ sau khi khôi phục.
const CONTENT_SCRIPT_FILES = ['icons.js', 'fancy-text.js', 'glossary.js', 'doc-detect.js', 'tts.js', 'translation-pipeline.js', 'ocr-panel.js', 'content.js', 'qa-solver.js'];

// Trang hiện tại: đọc từ content script chứ không đoán theo lần bấm gần nhất.
let activeTab = null;
let pageHostname = '';
let pageLanguage = 'original';
let lastTranslateTarget = 'vi';
let progressTimer = null;

const $ = selector => document.querySelector(selector);
const statusElement = $('#status');

// Icon theo sắc thái: xong / lỗi / đang chạy — nhìn là biết ngay, khỏi đọc chữ.
const STATUS_ICONS = { ok: 'success', error: 'alert', busy: 'spinner' };

function setStatus(text, tone = 'ok') {
  statusElement.textContent = '';
  if (!text) {
    delete statusElement.dataset.tone;
    return;
  }
  statusElement.dataset.tone = tone;
  statusElement.insertAdjacentHTML('afterbegin', globalThis.NPT_ICONS.svg(
    STATUS_ICONS[tone] || 'info',
    { size: 14, className: tone === 'busy' ? 'status-ico status-spin' : 'status-ico' },
  ));
  statusElement.appendChild(document.createTextNode(text));
}

function setError(error) {
  setStatus(typeof error === 'string' ? error : (error?.message || String(error)), 'error');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return true;
  } catch (_) {
    try {
      // Tiêm ĐỦ dependency theo đúng thứ tự manifest: thiếu glossary/doc-detect/tts
      // thì glossary, chế độ tài liệu và nút đọc chết sau khi reinject.
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_SCRIPT_FILES });
    } catch (_) {
      return false;
    }
    // executeScript xong ≠ content script sẵn sàng (listener đăng ký sau await storage)
    // → ping chờ readiness có retry hữu hạn trước khi broadcast lệnh.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'ping' });
        return true;
      } catch (_) { /* chưa sẵn sàng, thử lại */ }
    }
    return false;
  }
}

/* ------------------------- Trạng thái trang hiện tại ------------------------- */

function renderPageState(state) {
  pageLanguage = state?.language || 'original';
  if (state?.hostname) pageHostname = state.hostname;

  for (const button of document.querySelectorAll('[data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === pageLanguage));
  }

  const badge = $('#siteState');
  if (state?.blacklisted) {
    badge.textContent = 'Bị chặn';
    badge.className = 'pill pill-muted';
  } else if (pageLanguage === 'original') {
    badge.textContent = 'Bản gốc';
    badge.className = 'pill pill-muted';
  } else {
    badge.textContent = pageLanguage === 'vi' ? 'Đang dịch VI' : 'Đang dịch EN';
    badge.className = 'pill';
  }

  const wrap = $('#progressWrap');
  const bar = $('#progressBar');
  if (state?.busy) {
    wrap.hidden = false;
    if (state.total > 0) {
      bar.classList.remove('indeterminate');
      bar.style.width = `${Math.min(100, Math.round((state.done / state.total) * 100))}%`;
    } else {
      bar.classList.add('indeterminate');
      bar.style.width = '';
    }
    if (state.status) setStatus(state.status, 'busy');
  } else {
    wrap.hidden = true;
    bar.classList.remove('indeterminate');
    bar.style.width = '0%';
  }
  return Boolean(state?.busy);
}

async function readPageState() {
  if (!activeTab?.id) return null;
  try {
    // frameId 0: chỉ hỏi top frame, iframe không có toolbar/trạng thái riêng.
    return await chrome.tabs.sendMessage(activeTab.id, { type: 'getPageState' }, { frameId: 0 });
  } catch (_) {
    return null;
  }
}

async function refreshPageState() {
  const state = await readPageState();
  if (!state) return false;
  return renderPageState(state);
}

// Đang dịch thì cập nhật thanh tiến trình cho tới khi xong (popup mở bao lâu thì
// theo bấy lâu — đóng popup là timer chết theo).
function watchProgress() {
  clearInterval(progressTimer);
  progressTimer = setInterval(async () => {
    const busy = await refreshPageState();
    if (!busy) clearInterval(progressTimer);
  }, 400);
}

async function setPageLanguage(language) {
  if (!activeTab?.id) return setError('Không tìm thấy tab hiện tại');
  const injected = await ensureInjected(activeTab.id);
  if (!injected) return setError('Trang này không cho extension chạy');

  // Site nằm trong blacklist thì content script từ chối lệnh — báo đúng lý do
  // thay vì "Đã gửi lệnh dịch" trong khi không có gì xảy ra.
  if (language !== 'original' && $('#siteBlocked').checked) {
    return setError('Site này đang trong danh sách "không bao giờ dịch"');
  }

  const result = await chrome.runtime.sendMessage({
    type: 'broadcastPageLanguage',
    tabId: activeTab.id,
    language,
  });
  if (!result?.ok) return setError('Không thể điều khiển trang này');

  setStatus(language === 'original' ? 'Đang khôi phục bản gốc…' : 'Đang dịch trang…', 'busy');
  await refreshPageState();
  watchProgress();
}

/* ------------------------- Cài đặt theo site ------------------------- */

async function readBlacklist() {
  const values = await chrome.storage.local.get([BLACKLIST_KEY]);
  return Array.isArray(values[BLACKLIST_KEY]) ? values[BLACKLIST_KEY] : [];
}

function siteLanguageKey() {
  return `tm-page-translator-language:${pageHostname}`;
}

async function loadSiteControls() {
  const autoBox = $('#siteAuto');
  const blockBox = $('#siteBlocked');
  if (!pageHostname) {
    autoBox.disabled = true;
    blockBox.disabled = true;
    return;
  }
  const [blacklist, values] = await Promise.all([
    readBlacklist(),
    chrome.storage.local.get([siteLanguageKey()]),
  ]);
  const saved = values[siteLanguageKey()];
  autoBox.checked = saved === 'vi' || saved === 'en';
  blockBox.checked = blacklist.some(entry => {
    const domain = String(entry || '').trim().toLowerCase();
    return domain && (pageHostname === domain || pageHostname.endsWith(`.${domain}`));
  });
}

async function onSiteAutoChange() {
  if (!pageHostname) return;
  if ($('#siteAuto').checked) {
    const target = ['vi', 'en'].includes(pageLanguage) ? pageLanguage : lastTranslateTarget;
    await chrome.storage.local.set({ [siteLanguageKey()]: target });
    setStatus(`Sẽ tự dịch ${pageHostname} sang ${target.toUpperCase()} mỗi lần mở`);
    return;
  }
  await chrome.storage.local.remove(siteLanguageKey());
  setStatus(`Đã tắt tự dịch cho ${pageHostname}`);
}

async function onSiteBlockChange() {
  if (!pageHostname) return;
  const blacklist = await readBlacklist();
  const blocked = $('#siteBlocked').checked;
  const next = blacklist.filter(entry => String(entry || '').trim().toLowerCase() !== pageHostname);
  if (blocked) next.push(pageHostname);
  await chrome.storage.local.set({ [BLACKLIST_KEY]: next });
  setStatus(blocked ? `Sẽ không dịch ${pageHostname} nữa` : `Đã bỏ chặn ${pageHostname}`);
  await refreshPageState();
}

/* ------------------------- Settings ------------------------- */

async function loadSettings() {
  const values = await chrome.storage.local.get([...Object.values(KEYS), CONFIG_STORAGE_KEY, THEME_KEY]);
  $('#defaultMode').value = values[KEYS.defaultMode] === 'quick' ? 'quick' : 'native';
  $('#fallbackQuick').checked = values[KEYS.fallbackQuick] !== false;
  $('#pageUseProvider').checked = values[KEYS.pageUseProvider] !== false;
  $('#inputHelper').checked = values[KEYS.inputHelper] !== false;
  $('#tone').value = normalizeConfig(values[CONFIG_STORAGE_KEY]).tone;
  // Dịch trang nâng cao — default khớp contract khi storage chưa có key.
  $('#pageDisplayMode').value = values[KEYS.pageDisplayMode] === 'bilingual' ? 'bilingual' : 'replace';
  $('#pageStyle').value = PAGE_STYLE_VALUES.includes(values[KEYS.pageStyle]) ? values[KEYS.pageStyle] : 'natural';
  $('#pageDialect').value = values[KEYS.pageDialect] === 'uk' ? 'uk' : 'us';
  $('#pageTranslateMode').value = values[KEYS.pageTranslateMode] === 'literal' ? 'literal' : 'natural';
  $('#pageGrammarFix').checked = values[KEYS.pageGrammarFix] === true;
  $('#uiTheme').value = ['dark', 'light'].includes(values[THEME_KEY]) ? values[THEME_KEY] : 'auto';
}

async function saveSettings() {
  await chrome.storage.local.set({
    [KEYS.defaultMode]: $('#defaultMode').value,
    [KEYS.fallbackQuick]: $('#fallbackQuick').checked,
    [KEYS.pageUseProvider]: $('#pageUseProvider').checked,
    [KEYS.inputHelper]: $('#inputHelper').checked,
    [KEYS.pageDisplayMode]: $('#pageDisplayMode').value,
    [KEYS.pageStyle]: $('#pageStyle').value,
    [KEYS.pageDialect]: $('#pageDialect').value,
    [KEYS.pageTranslateMode]: $('#pageTranslateMode').value,
    [KEYS.pageGrammarFix]: $('#pageGrammarFix').checked,
  });
  setStatus('Đã lưu');
}

async function saveTone() {
  const values = await chrome.storage.local.get([CONFIG_STORAGE_KEY]);
  const config = normalizeConfig(values[CONFIG_STORAGE_KEY]);
  config.tone = $('#tone').value;
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: config });
  setStatus('Đã lưu');
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

async function saveTheme() {
  const theme = $('#uiTheme').value;
  applyTheme(theme);
  await chrome.storage.local.set({ [THEME_KEY]: theme });
}

function renderProviderStatusSummary(result) {
  const element = $('#providerStatus');
  if (!result) {
    element.textContent = 'Không liên lạc được service worker — mở lại popup để thử lại.';
    return;
  }

  const prefSelect = $('#quickPreferred');
  const stratSelect = $('#quickStrategy');
  if (prefSelect && result.providers) {
    prefSelect.textContent = '';
    for (const [id, info] of Object.entries(result.providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${info.label || id}${info.keyCount ? ` (${info.activeKeyCount ?? info.keyCount})` : ''}`;
      prefSelect.appendChild(opt);
    }
    if (result.preferred) prefSelect.value = result.preferred;
  }
  if (stratSelect && result.routingStrategy) {
    stratSelect.value = result.routingStrategy;
  }

  if (!result.ok || !result.configured) {
    element.textContent = 'Chưa cấu hình provider nào — bấm "Command Center" để thêm API key.';
    return;
  }

  const parts = result.active.map(id => {
    const provider = result.providers[id];
    const activeCnt = provider?.activeKeyCount ?? provider?.keyCount ?? 0;
    return `${provider?.label || id} (${activeCnt} key)`;
  });
  const healthyInfo = Number.isInteger(result.totalHealthyKeys)
    ? ` · ${result.totalHealthyKeys}/${result.totalActiveKeys} sẵn sàng`
    : '';
  element.textContent = `Đang dùng: ${parts.join(' → ')}${healthyInfo}`;
}

async function loadProviderStatus() {
  const result = await chrome.runtime.sendMessage({ type: 'getProviderStatus' }).catch(() => null);
  renderProviderStatusSummary(result);
  if (result?.ok && result?.configured) loadQuota().catch(() => {});
}

async function onQuickSwitchEngine() {
  const preferred = $('#quickPreferred')?.value;
  const routingStrategy = $('#quickStrategy')?.value;
  const res = await chrome.runtime.sendMessage({
    type: 'quickSwitchEngine',
    payload: { preferred, routingStrategy },
  });
  if (!res?.ok) throw new Error(res?.error || 'Không đổi được engine');
  renderProviderStatusSummary(res);
  setStatus('Đã cập nhật Engine / Điều phối');
}

// Quota DeepL ngay trong popup: trước đây phải mở trang Cài đặt mới thấy.
async function loadQuota() {
  const box = $('#quotaBox');
  const result = await chrome.runtime.sendMessage({ type: 'deeplUsage' }).catch(() => null);
  const usages = Array.isArray(result?.usages) ? result.usages : [];
  const usable = usages.filter(usage => !usage.error && usage.limit > 0);
  if (!usable.length) return;

  box.textContent = '';
  for (const usage of usable) {
    const percent = Math.min(100, Math.round((usage.count / usage.limit) * 100));
    const row = document.createElement('div');
    row.className = 'quota-row';

    const label = document.createElement('div');
    label.className = 'quota-label';
    const left = document.createElement('span');
    left.innerHTML = globalThis.NPT_ICONS.svg('gauge', { size: 12 });
    left.appendChild(document.createTextNode(` DeepL ${usage.keyMasked}`));
    const right = document.createElement('span');
    right.textContent = `${percent}% · còn ${(usage.limit - usage.count).toLocaleString('vi-VN')} ký tự`;
    label.append(left, right);

    const track = document.createElement('div');
    track.className = 'quota-track';
    const fill = document.createElement('div');
    fill.className = 'quota-fill';
    fill.style.width = `${percent}%`;
    if (percent >= 95) fill.dataset.level = 'full';
    else if (percent >= 80) fill.dataset.level = 'warn';
    track.appendChild(fill);

    row.append(label, track);
    box.appendChild(row);
  }
  box.hidden = false;
}

let testApiBusy = false;

async function testApi() {
  if (testApiBusy) return;
  testApiBusy = true;
  const button = $('#testApi');
  button.disabled = true;
  setStatus('Đang test API…', 'busy');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'nativeTranslate',
      payload: {
        source: 'Câu này chỉ để kiểm tra API dịch có hoạt động không.',
        context: 'This is a connection test. Return only the English translation.',
      },
    });
    if (!result?.ok) {
      throw new Error(result?.error === 'NO_API_KEY'
        ? 'Chưa có provider nào được bật kèm API key'
        : (result?.error || 'API test thất bại'));
    }
    setStatus(`API hoạt động (${result.providerLabel}):\n${result.text}`);
  } finally {
    testApiBusy = false;
    button.disabled = false;
  }
}

/* ------------------------- Tabs ------------------------- */

function selectTab(name, { focusTab = false } = {}) {
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus();
  }
  for (const panel of document.querySelectorAll('.tabpanel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
}

/* ------------------ Prompt template / Tóm tắt / PDF ------------------ */

async function loadTemplates() {
  const values = await chrome.storage.local.get([TEMPLATE_KEYS.templates, TEMPLATE_KEYS.active]);
  const templates = Array.isArray(values[TEMPLATE_KEYS.templates]) ? values[TEMPLATE_KEYS.templates] : [];
  const select = $('#templateSwitch');
  // Giữ option "Mặc định" (value '') đầu tiên, thay toàn bộ option template phía sau.
  select.querySelectorAll('option[data-tpl]').forEach(option => option.remove());
  for (const tpl of templates) {
    const option = document.createElement('option');
    option.value = tpl.id;
    option.dataset.tpl = '1';
    option.textContent = tpl.name;
    select.appendChild(option);
  }
  const active = values[TEMPLATE_KEYS.active];
  select.value = typeof active === 'string' && templates.some(tpl => tpl.id === active) ? active : '';
}

async function onTemplateSwitch() {
  const id = $('#templateSwitch').value;
  await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: id });
  // Trang đang ở trạng thái dịch → dịch lại theo template mới.
  if (pageLanguage === 'vi' || pageLanguage === 'en') {
    await setPageLanguage(pageLanguage);
    return;
  }
  setStatus(id ? 'Đã chọn template — áp dụng cho lần dịch sau' : 'Đã về template mặc định');
}

async function summarizePage() {
  if (!activeTab?.id) return setError('Không tìm thấy tab hiện tại');
  const injected = await ensureInjected(activeTab.id);
  if (!injected) return setError('Trang này không cho extension chạy');
  const language = ['vi', 'en'].includes(pageLanguage) ? pageLanguage : lastTranslateTarget;
  await chrome.tabs.sendMessage(activeTab.id, { type: 'summarizePageStart', language });
  setStatus('Đang tóm tắt & dịch — kết quả hiện ngay trên trang');
}

// Nhận diện tab PDF (hiện nút "Dịch PDF này") và khoá nút tóm tắt trên trang không inject được.
function initTabContext() {
  const url = activeTab?.url || '';
  const isPdf = /\.pdf(\?|#|$)/i.test(url);
  const button = $('#btnTranslatePdf');
  if (isPdf) {
    button.hidden = false;
    button.addEventListener('click', () => {
      chrome.tabs.create({ url: `${chrome.runtime.getURL('pdf-viewer.html')}?src=${encodeURIComponent(url)}` });
    });
  }

  const ocrButton = $('#btnOcr');
  if (ocrButton) {
    ocrButton.addEventListener('click', async () => {
      if (activeTab?.id) {
        try {
          await ensureInjected(activeTab.id);
          await chrome.tabs.sendMessage(activeTab.id, { type: 'startOcrMode' });
        } catch (_) {}
      }
      window.close();
    });
  }
  if (!/^https?:\/\//i.test(url)) {
    for (const control of [$('#btnSummarize'), $('#btnOcr'), $('#siteAuto'), $('#siteBlocked'),
      ...document.querySelectorAll('[data-lang]')]) {
      if (control) {
        control.disabled = true;
        control.title = 'Extension không chạy được trên trang này';
      }
    }
    $('#siteHost').textContent = 'Trang hệ thống — không dịch được';
    $('#siteState').textContent = '—';
    return;
  }
  try {
    pageHostname = new URL(url).hostname.toLowerCase();
    $('#siteHost').textContent = pageHostname;
  } catch (_) {
    $('#siteHost').textContent = 'Trang hiện tại';
  }
}

/* ------------------------- Wiring ------------------------- */

document.querySelectorAll('[data-lang]').forEach(button => {
  button.addEventListener('click', () => {
    const language = button.dataset.lang;
    if (language === 'vi' || language === 'en') lastTranslateTarget = language;
    setPageLanguage(language).catch(setError);
  });
});

for (const id of ['#defaultMode', '#fallbackQuick', '#pageUseProvider', '#inputHelper',
  '#pageDisplayMode', '#pageStyle', '#pageDialect', '#pageTranslateMode', '#pageGrammarFix']) {
  $(id).addEventListener('change', () => saveSettings().catch(setError));
}
$('#tone').addEventListener('change', () => saveTone().catch(setError));
$('#uiTheme').addEventListener('change', () => saveTheme().catch(setError));
$('#siteAuto').addEventListener('change', () => onSiteAutoChange().catch(setError));
$('#siteBlocked').addEventListener('change', () => onSiteBlockChange().catch(setError));
$('#testApi').addEventListener('click', () => testApi().catch(setError));
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#openDashboard')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#quickPreferred')?.addEventListener('change', () => onQuickSwitchEngine().catch(setError));
$('#quickStrategy')?.addEventListener('change', () => onQuickSwitchEngine().catch(setError));
$('#templateSwitch').addEventListener('change', () => onTemplateSwitch().catch(setError));
$('#btnSummarize').addEventListener('click', () => summarizePage().catch(setError));

const popupTabs = [...document.querySelectorAll('.tabs .tab')];
popupTabs.forEach((tab, idx) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    let nextIdx = -1;
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % popupTabs.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + popupTabs.length) % popupTabs.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = popupTabs.length - 1;
    if (nextIdx >= 0) {
      event.preventDefault();
      selectTab(popupTabs[nextIdx].dataset.tab, { focusTab: true });
    }
  });
});

async function boot() {
  // Theme trước tiên, rồi mới hiện thân trang: đọc storage xong mới render tránh
  // cảnh mọi toggle nhấp nháy từ off sang on ngay khi popup mở.
  const themeValue = await chrome.storage.local.get([THEME_KEY]);
  applyTheme(themeValue[THEME_KEY]);

  $('#versionPill').textContent = `v${chrome.runtime.getManifest().version}`;
  $('#brandLogo').innerHTML = globalThis.NPT_ICONS.logo(32);
  globalThis.NPT_ICONS.hydrate();

  activeTab = await getActiveTab();
  initTabContext();

  await Promise.all([
    loadSettings().catch(setError),
    loadTemplates().catch(setError),
  ]);
  document.body.dataset.ready = 'true';

  await loadSiteControls().catch(() => {});
  const busy = await refreshPageState();
  if (busy) watchProgress();
  loadProviderStatus();
}

boot().catch(setError);
