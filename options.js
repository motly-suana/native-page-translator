/* Trang Command Center (v5.0) — quản lý Multi-Key Striping, 16+ Provider & Prompt Studio. */
'use strict';

const {
  CONFIG_STORAGE_KEY,
  SYSTEM_PROMPT_OVERRIDE_KEY,
  PROVIDER_DEFS,
  PRESET_ORDER,
  PROVIDER_PRESETS,
  ROUTING_STRATEGIES,
  BUILTIN_ORIGINS: PROVIDER_BUILTIN_ORIGINS,
  PAGE_STYLES,
  normalizeConfig,
  parseKeysInput,
  detectPresetForKey,
  keyFormatWarning,
  emptyProviderConfig,
  isPresetProvider,
  isCustomProvider,
  providerKind,
  providerDefOf,
  providerLabelOf,
  providerIdsOf,
  activeKeysOf,
  supportsVision,
  nextCustomProviderId,
  MAX_CUSTOM_PROVIDERS,
  DEPLOY_REASONING_EFFORTS,
  DEPLOY_DEFAULT_REASONING,
  DEPLOY_TRANSLATE_REASONING,
  maskKey,
  keyHashId,
  normalizeSystemPromptOverrides,
  buildBatchInstructions,
  buildNativeInstructions,
  buildSummaryInstructions,
  buildQaInstructions,
  buildVisionInstructions,
  buildOcrVisionInstructions,
} = globalThis.NPT_PROVIDERS;

const PREFS_KEYS = {
  context: 'tm-native-en-use-context',
  defaultMode: 'tm-native-en-default-mode',
  fallbackQuick: 'tm-native-en-fallback-quick',
  pageUseProvider: 'tm-page-use-provider',
  pageFreeFallback: 'tm-page-free-fallback',
  selectionTranslate: 'tm-selection-translate',
  inputHelper: 'tm-input-helper-enabled',
  siteBlacklist: 'tm-site-blacklist',
  pageDisplayMode: 'tm-page-display-mode',
  pageStyle: 'tm-page-style',
  pageDialect: 'tm-page-dialect',
  pageTranslateMode: 'tm-page-translate-mode',
  pageGrammarFix: 'tm-page-grammar-fix',
  pageSkipCode: 'tm-page-skip-code',
  pageSkipUsernames: 'tm-page-skip-usernames',
  pageKeepProperNouns: 'tm-page-keep-proper-nouns',
  pageDynamicTranslate: 'tm-page-dynamic-translate',
  pageLazyTranslate: 'tm-page-lazy-translate',
  docMode: 'tm-doc-mode',
  ttsEnabled: 'tm-tts-enabled',
  ttsRate: 'tm-tts-rate',
  translationCache: 'tm-translation-cache',
  uiTheme: 'tm-ui-theme',
};

const TEMPLATE_KEYS = { templates: 'tm-prompt-templates', active: 'tm-active-template' };
const GLOSSARY_KEY = 'tm-glossary';

const DEFAULT_TEMPLATES = [
  { id: 'van-hoc', name: 'Văn học', prompt: 'Dịch theo phong cách văn học, giàu hình ảnh, giữ nhịp câu tự nhiên như văn xuôi.' },
  { id: 'ky-thuat', name: 'Kỹ thuật', prompt: 'Giữ nguyên thuật ngữ kỹ thuật tiếng Anh (không dịch tên hàm, lệnh, API, framework); chỉ dịch phần giải thích.' },
  { id: 'gen-z', name: 'Giọng Gen Z', prompt: 'Dịch theo giọng Gen Z Việt Nam: tự nhiên, hài hước vừa phải, dùng từ lóng phổ biến nhưng vẫn rõ nghĩa.' },
];

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

const STRATEGY_LABELS = {
  'smart-stripe': 'Smart Stripe',
  'round-robin': 'Round-Robin',
  failover: 'Failover',
};

const TAB_META = {
  api: {
    title: 'API & Điều phối Multi-Key',
    sub: 'Quản lý 16+ nhà cung cấp AI, cân bằng tải theo độ trễ và giám sát sức khỏe từng API key',
  },
  page: {
    title: 'Dịch trang web & Văn phong',
    sub: 'Kiểm soát hiển thị song ngữ, chế độ docs, hiệu năng lazy-scroll và xem trước văn phong',
  },
  terms: {
    title: 'Prompt Studio & Thuật ngữ',
    sub: 'Tùy biến System Prompt lõi theo từng tác vụ AI, quản lý template và từ điển glossary',
  },
  input: {
    title: 'Viết câu ✨ EN bản địa',
    sub: 'Cấu hình nút trợ lý viết câu tiếng Anh ngay trong ô nhập liệu',
  },
  misc: {
    title: 'Giao diện, Cache & Sao lưu',
    sub: 'Chủ đề Sáng/Tối, giọng đọc TTS, bộ nhớ đệm dùng chung và sao lưu cấu hình',
  },
};

const $ = selector => document.querySelector(selector);
const statusElement = $('#status');
const { svg: icon, brand: brandMark, logo: brandLogo } = globalThis.NPT_ICONS;
const KEY_ICON = icon('key', { size: 13, className: 'key-ico' });
const BUILTIN_ORIGINS = new Set(PROVIDER_BUILTIN_ORIGINS);

let config = null;
let dirty = false;
let providerFilter = 'all';
let providerQuery = '';
let glossaryQuery = '';
let healthSnapshot = null;
const healthByKey = new Map();

const KEY_PREVIEW_LIMIT = 8;
const expandedKeyLists = new Set();
const keyDrafts = new Map();
let pendingKeyFocus = '';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(className, iconName, text, options = {}) {
  const button = el('button', className);
  button.type = 'button';
  button.innerHTML = icon(iconName, { size: options.size || 14 });
  if (text) button.appendChild(document.createTextNode(text));
  return button;
}

function setStatus(text, error = false) {
  statusElement.textContent = '';
  if (!text) {
    delete statusElement.dataset.tone;
    return;
  }
  statusElement.dataset.tone = error ? 'error' : 'ok';
  statusElement.insertAdjacentHTML('afterbegin', icon(error ? 'alert' : 'success', { size: 14, className: 'status-ico' }));
  statusElement.appendChild(document.createTextNode(text));
}

function markDirty() {
  dirty = true;
  const pill = $('#dirtyPill');
  if (pill) pill.hidden = false;
}

function markClean() {
  dirty = false;
  const pill = $('#dirtyPill');
  if (pill) pill.hidden = true;
}

/* ------------------------- Native <dialog> Confirmation ------------------------- */

function confirmAction({ title = 'Xác nhận thao tác', message = '', confirmText = 'Xác nhận', danger = true }) {
  const dialog = $('#confirmDialog');
  if (!dialog?.showModal || dialog.open) {
    return Promise.resolve(false);
  }
  const titleSpan = $('#confirmTitle span');
  const desc = $('#confirmDesc');
  const okBtn = $('#confirmOkBtn');
  if (titleSpan) titleSpan.textContent = title;
  if (desc) desc.textContent = message;
  if (okBtn) {
    okBtn.textContent = confirmText;
    okBtn.className = danger ? 'danger-button' : 'primary';
  }

  return new Promise((resolve) => {
    const onClose = () => {
      const confirmed = dialog.returnValue === 'confirm';
      dialog.returnValue = '';
      resolve(confirmed);
    };
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
  });
}

/* ------------------------- Load / Persist Config ------------------------- */

async function loadConfig() {
  await chrome.runtime.sendMessage({ type: 'getProviderStatus' }).catch(() => null);
  const values = await chrome.storage.local.get([CONFIG_STORAGE_KEY]);
  config = normalizeConfig(values[CONFIG_STORAGE_KEY]);
}

async function persistConfig() {
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: config });
}

/* ------------------------- KPI & Pool Health Telemetry ------------------------- */

function formatDurationShort(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}

function formatHealthBadge(live, disabled = false) {
  if (disabled || live?.disabled) {
    return { tone: 'off', label: 'Đang tắt', title: 'Key đang bị tắt thủ công' };
  }
  if (!live) {
    return { tone: 'idle', label: 'Chưa test', title: 'Chưa có thống kê trong phiên này' };
  }
  if (live.coolingDown) {
    return {
      tone: 'warn',
      label: `Cooldown ${formatDurationShort(live.cooldownRemainingMs)}`,
      title: live.lastStatus || 'Đang tạm nghỉ sau lỗi HTTP/rate limit',
    };
  }
  if (live.errorStreak > 0) {
    return {
      tone: 'err',
      label: live.lastStatus ? String(live.lastStatus).slice(0, 26) : `Lỗi (${live.errorStreak})`,
      title: live.lastStatus || 'Gặp lỗi ở lần kiểm tra gần nhất',
    };
  }
  if (live.emaLatencyMs > 0) {
    return {
      tone: 'ok',
      label: `OK · ${live.emaLatencyMs}ms`,
      title: `Thành công ${live.successCount} · Lỗi ${live.errorCount}`,
    };
  }
  if (live.successCount > 0) {
    return { tone: 'ok', label: 'Sẵn sàng', title: `Thành công ${live.successCount}` };
  }
  return { tone: 'idle', label: 'Chưa test', title: 'Chưa dùng trong phiên này' };
}

function resolveKeyHealth(providerId, keyIndex, entry) {
  const live = healthByKey.get(keyHashId(providerId, entry?.key || ''))
    || healthByKey.get(`${providerId}:${keyIndex}`);
  return formatHealthBadge(live, Boolean(entry?.disabled));
}

function updateKpiDisplay() {
  if (!config) return;
  let totalKeys = 0;
  let activeKeys = 0;
  let disabledKeys = 0;
  for (const id of providerIdsOf(config)) {
    const provider = config.providers[id];
    for (const entry of provider.keys || []) {
      totalKeys++;
      if (entry.disabled) disabledKeys++;
      else if (provider.enabled) activeKeys++;
    }
  }

  const summary = healthSnapshot?.summary;
  const coolingCount = summary?.coolingDownKeys || 0;
  const readyCount = summary ? summary.healthyKeys : Math.max(0, activeKeys - coolingCount);
  const avgLat = summary?.avgLatencyMs ? `${summary.avgLatencyMs}ms` : '—';
  const stratLabel = STRATEGY_LABELS[config.routingStrategy] || 'Smart Stripe';

  $('#kpiTotalKeys').textContent = String(totalKeys);
  $('#kpiTotalSub').textContent = `${activeKeys} đang bật · ${disabledKeys} đã tắt`;
  $('#kpiHealthKeys').textContent = String(readyCount);
  $('#kpiHealthSub').textContent = coolingCount ? `${coolingCount} đang cooldown` : 'Không có key cooldown';
  $('#kpiAvgLatency').textContent = avgLat;
  $('#kpiThroughputSub').textContent = summary
    ? `${summary.totalSuccess} OK · ${summary.totalError} lỗi`
    : 'Chưa đo độ trễ';
  $('#kpiStrategy').textContent = stratLabel;
  if (healthSnapshot) {
    $('#kpiCacheSub').textContent = healthSnapshot.cacheEnabled
      ? `${Number(healthSnapshot.cacheEntries || 0).toLocaleString('vi-VN')} mục cache`
      : 'Cache đang tắt';
  }

  $('#sidebarStrategy').textContent = stratLabel;
  $('#sidebarKeyCount').textContent = `${activeKeys}/${totalKeys}`;
  $('#sidebarHealth').textContent = coolingCount > 0
    ? `${readyCount} OK / ${coolingCount} nghỉ`
    : (activeKeys > 0 ? 'Ổn định' : 'Chưa có key');
}

async function refreshKeyPoolHealth() {
  const result = await chrome.runtime.sendMessage({ type: 'getKeyPoolHealth' }).catch(() => null);
  if (!result?.ok) {
    updateKpiDisplay();
    return;
  }
  healthSnapshot = result;
  healthByKey.clear();
  for (const provider of result.providers || []) {
    for (const keyItem of provider.keys || []) {
      healthByKey.set(keyItem.hashId || `${provider.id}:${keyItem.index}`, keyItem);
    }
  }
  updateKpiDisplay();

  const providersEl = $('#providers');
  if (providersEl?.contains(document.activeElement)) {
    for (const pill of providersEl.querySelectorAll('.health-pill[data-key-hash]')) {
      const live = healthByKey.get(pill.dataset.keyHash);
      if (!live) continue;
      const badge = formatHealthBadge(live);
      pill.dataset.health = badge.tone;
      pill.textContent = badge.label;
      pill.title = badge.title;
    }
    return;
  }
  renderProviders();
}

async function pingKeys({ providerId, keyIndex, triggerBtn } = {}) {
  if (dirty) await saveSettings(false);
  if (triggerBtn) triggerBtn.disabled = true;
  setStatus(providerId ? `Đang kiểm tra key (${providerLabelOf(providerId, config.providers[providerId])})…` : 'Đang test toàn bộ pool API key…');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'pingProviderKeys',
      payload: { ...(providerId ? { providerId } : {}), ...(Number.isInteger(keyIndex) ? { keyIndex } : {}) },
    });
    if (!res?.ok) throw new Error(res?.error || 'Không test được API key');
    const list = res.results || [];
    if (!list.length) {
      setStatus('Không có key nào đang bật để kiểm tra', true);
      return;
    }
    const okCount = list.filter(item => item.ok).length;
    const failCount = list.length - okCount;
    await refreshKeyPoolHealth();
    setStatus(
      failCount === 0
        ? `Hoàn tất: ${okCount}/${list.length} key hoạt động bình thường`
        : `Kết quả: ${okCount} OK · ${failCount} key gặp lỗi (${list.find(i => !i.ok)?.error || ''})`,
      failCount > 0,
    );
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

/* ------------------------- Routing & Preferred ------------------------- */

function renderRoutingStrategy() {
  const strategy = ROUTING_STRATEGIES.includes(config.routingStrategy) ? config.routingStrategy : 'failover';
  for (const radio of document.querySelectorAll('input[name="routingStrategy"]')) {
    radio.checked = radio.value === strategy;
  }
  updateKpiDisplay();
}

function renderPreferredSelect() {
  const select = $('#preferred');
  select.textContent = '';
  for (const id of providerIdsOf(config)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = providerLabelOf(id, config.providers[id]);
    select.appendChild(option);
  }
  select.value = config.preferred;
}

/* ------------------------- Key Routing & Universal Dropzone ------------------------- */

function routeKeyTo(key, currentId) {
  const detected = detectPresetForKey(key);
  if (!detected) return currentId;
  if (currentId && providerKind(currentId) === detected && (detected !== 'openai' || currentId !== 'openai')) {
    return currentId;
  }
  return detected;
}

function ensureProviderExists(providerId) {
  if (!config.providers[providerId] && isPresetProvider(providerId)) {
    config.providers[providerId] = emptyProviderConfig(providerId);
  }
  return config.providers[providerId];
}

function collectGroupedKeys(rawText, fallbackProviderId = null) {
  const parsed = parseKeysInput(rawText, { existing: [] });
  const groups = new Map();
  let duplicates = parsed.duplicates;

  for (const entry of parsed.entries) {
    const targetId = fallbackProviderId
      ? routeKeyTo(entry.key, fallbackProviderId)
      : (detectPresetForKey(entry.key) || 'openai');
    const existingProvider = config.providers[targetId];
    const inProvider = existingProvider?.keys?.some(item => item.key === entry.key);
    const inGroup = groups.get(targetId)?.some(item => item.key === entry.key);
    if (inProvider || inGroup) {
      duplicates++;
      continue;
    }
    if (!groups.has(targetId)) groups.set(targetId, []);
    groups.get(targetId).push(entry);
  }

  const total = [...groups.values()].reduce((sum, arr) => sum + arr.length, 0);
  return { groups, total, duplicates, invalid: parsed.invalid };
}

function updateUniversalDropzonePreview() {
  const input = $('#universalKeyInput');
  const hint = $('#universalKeyHint');
  const button = $('#universalAddBtn');
  if (!input || !hint || !button) return;

  const raw = input.value;
  if (!raw.trim()) {
    hint.textContent = 'Chưa có key nào trong ô dán nhanh.';
    delete hint.dataset.tone;
    button.lastChild.nodeValue = 'Tự nhận diện & Nạp vào Pool';
    return;
  }

  const { groups, total, duplicates, invalid } = collectGroupedKeys(raw);
  button.lastChild.nodeValue = total > 0 ? `Nạp ${total} key vào Pool` : 'Tự nhận diện & Nạp vào Pool';
  const summary = [...groups].map(([id, list]) => {
    const label = PROVIDER_PRESETS[id]?.label || providerLabelOf(id, config.providers[id]);
    return `${list.length} → ${label}`;
  });
  const parts = total ? [`Phát hiện ${total} key (${summary.join(' · ')})`] : ['Không có key mới'];
  if (duplicates) parts.push(`${duplicates} trùng`);
  if (invalid.length) parts.push(`${invalid.length} mẩu bỏ qua`);
  hint.textContent = parts.join(' · ');
  hint.dataset.tone = total ? 'ok' : 'warn';
}

function commitUniversalDropzone() {
  const input = $('#universalKeyInput');
  const { groups, total, duplicates, invalid } = collectGroupedKeys(input.value);
  if (!total) {
    setStatus(duplicates ? `Tất cả ${duplicates} key đã tồn tại trong Pool` : 'Không nhận diện được key hợp lệ nào', true);
    return;
  }

  const addedSummary = [];
  let firstTarget = '';
  for (const [targetId, entries] of groups) {
    const target = ensureProviderExists(targetId);
    if (!target) continue;
    if (!firstTarget) firstTarget = targetId;
    const hadKeys = target.keys.length > 0;
    target.keys.push(...entries);
    if (!hadKeys && !target.enabled) target.enabled = true;
    if (target.keys.length > KEY_PREVIEW_LIMIT) expandedKeyLists.add(targetId);
    addedSummary.push(`${entries.length} → ${providerLabelOf(targetId, target)}`);
  }

  input.value = '';
  updateUniversalDropzonePreview();
  renderPresetBar();
  renderPreferredSelect();
  renderProviders();
  updateKpiDisplay();
  markDirty();

  const extra = [];
  if (duplicates) extra.push(`bỏ ${duplicates} trùng`);
  if (invalid.length) extra.push(`bỏ qua ${invalid.length} mẩu rác`);
  setStatus(`Đã nạp ${addedSummary.join(' · ')}${extra.length ? ` (${extra.join(', ')})` : ''} — nhớ bấm Lưu cài đặt`, invalid.length > 0);
  if (firstTarget) {
    document.querySelector(`.provider-card[data-provider="${firstTarget}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ------------------------- 1-Click Preset Bar ------------------------- */

function renderPresetBar() {
  const bar = $('#presetBar');
  if (!bar) return;
  bar.textContent = '';

  for (const presetId of PRESET_ORDER) {
    const preset = PROVIDER_PRESETS[presetId];
    if (!preset) continue;
    const exists = Boolean(config.providers[presetId]);
    const chip = el('button', `preset-chip${exists ? ' is-added' : ''}`);
    chip.type = 'button';
    chip.innerHTML = brandMark(presetId, { size: 17 });
    chip.appendChild(document.createTextNode(exists ? `${preset.label} ✓` : `+ ${preset.label}`));
    chip.title = preset.badgeTag ? `${preset.label} (${preset.badgeTag})` : preset.label;
    chip.addEventListener('click', () => {
      if (!config.providers[presetId]) {
        config.providers[presetId] = emptyProviderConfig(presetId);
        pendingKeyFocus = presetId;
        renderPresetBar();
        renderPreferredSelect();
        renderProviders();
        updateKpiDisplay();
        markDirty();
        setStatus(`Đã thêm ${preset.label} — hãy dán key vào thẻ vừa tạo`);
      } else {
        providerFilter = 'all';
        providerQuery = '';
        $('#providerSearch').value = '';
        for (const pill of document.querySelectorAll('.filter-pill')) {
          pill.setAttribute('aria-pressed', String(pill.dataset.filter === 'all'));
        }
        pendingKeyFocus = presetId;
        renderProviders();
      }
      document.querySelector(`.provider-card[data-provider="${presetId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    bar.appendChild(chip);
  }
}

/* ------------------------- Per-Key Rows & Provider Cards ------------------------- */

function splitPastedKeys(providerId) {
  const provider = config.providers[providerId];
  const before = provider.keys.length;
  const rebuilt = [];
  for (const entry of provider.keys) {
    const parsed = parseKeysInput(entry.key, { existing: rebuilt });
    if (!parsed.entries.length) {
      if (!rebuilt.some(item => item.key === entry.key)) rebuilt.push(entry);
      continue;
    }
    for (const item of parsed.entries) {
      rebuilt.push({ key: item.key, label: item.label || entry.label, ...(entry.disabled ? { disabled: true } : {}) });
    }
  }
  provider.keys = rebuilt;
  expandedKeyLists.add(providerId);
  renderProviders();
  updateKpiDisplay();
  markDirty();
  setStatus(`Đã tách ${before} mục thành ${rebuilt.length} key — nhớ bấm Lưu cài đặt`);
}

function renderKeyList(card, providerId) {
  const provider = config.providers[providerId];
  const def = providerDefOf(providerId);
  const label = providerLabelOf(providerId, provider);
  const list = el('div', 'key-list');

  if (!provider.keys.length) {
    list.appendChild(el('div', 'key-empty', providerKind(providerId) === 'openai' && !isPresetProvider(providerId)
      ? 'Không bắt buộc key nếu API của bạn là free.'
      : 'Chưa có key nào.'));
  }

  const expanded = expandedKeyLists.has(providerId);
  const visibleCount = expanded ? provider.keys.length : Math.min(provider.keys.length, KEY_PREVIEW_LIMIT);

  provider.keys.slice(0, visibleCount).forEach((entry, index) => {
    const row = el('div', 'key-row key-row-v5');

    const enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.className = 'key-enable-toggle';
    enableBox.checked = !entry.disabled;
    enableBox.title = entry.disabled ? 'Bật lại key này' : 'Tạm tắt key này (không xoá)';
    enableBox.addEventListener('change', () => {
      if (enableBox.checked) delete entry.disabled;
      else entry.disabled = true;
      renderProviders();
      updateKpiDisplay();
      markDirty();
    });
    row.appendChild(enableBox);

    row.appendChild(el('span', 'key-index', String(index + 1)));
    row.insertAdjacentHTML('beforeend', KEY_ICON);
    row.appendChild(el('span', 'key-text', maskKey(entry.key)));

    const labelBtn = el('button', 'key-label-btn', entry.label || '+ Nhãn');
    labelBtn.type = 'button';
    labelBtn.title = 'Bấm để sửa nhãn key';
    labelBtn.addEventListener('click', () => {
      const editor = document.createElement('input');
      editor.type = 'text';
      editor.maxLength = 40;
      editor.value = entry.label || '';
      editor.placeholder = 'Nhãn key…';
      editor.style.cssText = 'width:120px;padding:2px 6px;font-size:11.5px';
      const commit = () => {
        entry.label = editor.value.trim();
        markDirty();
        renderProviders();
      };
      editor.addEventListener('blur', commit, { once: true });
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') editor.blur();
        if (e.key === 'Escape') {
          editor.removeEventListener('blur', commit);
          renderProviders();
        }
      });
      labelBtn.replaceWith(editor);
      editor.focus();
      editor.select();
    });
    row.appendChild(labelBtn);

    const warning = keyFormatWarning(providerId, entry.key);
    if (warning) {
      const flag = el('span', 'key-warn');
      flag.innerHTML = icon('alert', { size: 13 });
      flag.title = warning;
      row.appendChild(flag);
    }

    const health = resolveKeyHealth(providerId, index, entry);
    const healthPill = el('span', 'health-pill', health.label);
    healthPill.dataset.health = health.tone;
    healthPill.dataset.keyHash = keyHashId(providerId, entry.key);
    healthPill.title = health.title;
    row.appendChild(healthPill);

    const pingBtn = iconButton('row-action', 'activity', '', { size: 13 });
    pingBtn.title = 'Ping kiểm tra riêng key này';
    pingBtn.addEventListener('click', () => {
      pingKeys({ providerId, keyIndex: index, triggerBtn: pingBtn }).catch(error => setStatus(error.message, true));
    });
    row.appendChild(pingBtn);

    const remove = iconButton('key-remove', 'trash', 'Xoá', { size: 13 });
    remove.title = 'Xoá key này';
    remove.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: 'Xoá API key?',
        message: `Xoá key ${maskKey(entry.key)} của ${label}?\nHành động này không thể khôi phục.`,
        confirmText: 'Xoá key',
      });
      if (!confirmed) return;
      provider.keys.splice(index, 1);
      renderProviders();
      updateKpiDisplay();
      markDirty();
      setStatus('Đã xoá key — nhớ bấm Lưu cài đặt');
    });
    row.appendChild(remove);
    list.appendChild(row);
  });

  const tools = el('div', 'key-tools');
  if (provider.keys.length > KEY_PREVIEW_LIMIT) {
    const toggle = iconButton('key-link', 'chevron', expanded
      ? 'Thu gọn'
      : `Xem thêm ${provider.keys.length - KEY_PREVIEW_LIMIT} key`, { size: 13 });
    toggle.dataset.expanded = String(expanded);
    toggle.addEventListener('click', () => {
      if (expanded) expandedKeyLists.delete(providerId);
      else expandedKeyLists.add(providerId);
      renderProviders();
    });
    tools.appendChild(toggle);
  }
  if (provider.keys.length >= 2) {
    const clearAll = iconButton('key-link key-link-danger', 'trash', `Xoá hết ${provider.keys.length} key`, { size: 13 });
    clearAll.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: `Xoá hết key của ${label}?`,
        message: `Toàn bộ ${provider.keys.length} key của ${label} sẽ bị xoá.\nKhông khôi phục lại được.`,
        confirmText: 'Xoá tất cả',
      });
      if (!confirmed) return;
      provider.keys = [];
      expandedKeyLists.delete(providerId);
      renderProviders();
      updateKpiDisplay();
      markDirty();
      setStatus(`Đã xoá hết key của ${label} — nhớ bấm Lưu cài đặt`);
    });
    tools.appendChild(clearAll);
  }
  if (tools.children.length) list.appendChild(tools);

  const blobs = provider.keys.filter(entry => parseKeysInput(entry.key).entries.length > 1);
  if (blobs.length) {
    const fixRow = el('div', 'key-fix');
    fixRow.insertAdjacentHTML('beforeend', icon('alert', { size: 13 }));
    fixRow.appendChild(el('span', '', `${blobs.length} mục trông như nhiều key bị dán gộp.`));
    const fix = iconButton('key-link', 'wand', 'Tách ra', { size: 13 });
    fix.addEventListener('click', () => splitPastedKeys(providerId));
    fixRow.appendChild(fix);
    list.appendChild(fixRow);
  }

  const box = el('div', 'add-key-box');
  const input = document.createElement('textarea');
  input.className = 'key-input';
  input.rows = 2;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.noDirty = 'true';
  input.placeholder = `${def.keyPlaceholder}\nDán nhiều key một lượt: mỗi dòng 1 key hoặc cách nhau bằng dấu phẩy / space.`;
  input.value = keyDrafts.get(providerId) || '';

  const foot = el('div', 'add-key-row');
  const hint = el('div', 'key-hint');
  const addButton = iconButton('add-key-button', 'plus', 'Thêm key');
  foot.append(hint, addButton);

  const refresh = () => {
    const { groups, total, duplicates, invalid } = collectGroupedKeys(input.value, providerId);
    input.rows = Math.min(10, Math.max(2, input.value.split('\n').length));
    addButton.lastChild.nodeValue = total > 1 ? `Thêm ${total} key` : 'Thêm key';
    if (!input.value.trim()) {
      hint.textContent = '';
      delete hint.dataset.tone;
      return;
    }
    const parts = [`nhận diện ${total} key mới`];
    if (groups.size > 1 || (groups.size === 1 && !groups.has(providerId))) {
      parts.push([...groups].map(([id, items]) => `${items.length} → ${providerLabelOf(id, config.providers[id] || PROVIDER_PRESETS[id])}`).join(' · '));
    }
    if (duplicates) parts.push(`${duplicates} trùng`);
    if (invalid.length) parts.push(`${invalid.length} mẩu bỏ qua`);
    hint.textContent = parts.join(' · ');
    hint.dataset.tone = total ? 'ok' : 'warn';
  };

  const addKeys = () => {
    const { groups, total, duplicates, invalid } = collectGroupedKeys(input.value, providerId);
    if (!total) {
      setStatus(duplicates
        ? `Toàn bộ ${duplicates} key vừa dán đã có trong danh sách`
        : 'Không tìm thấy key nào trong nội dung vừa dán', true);
      return;
    }

    const added = [];
    for (const [targetId, entries] of groups) {
      const target = ensureProviderExists(targetId);
      if (!target) continue;
      const hadKeys = target.keys.length > 0;
      target.keys.push(...entries);
      if (!hadKeys && !target.enabled) target.enabled = true;
      if (target.keys.length > KEY_PREVIEW_LIMIT) expandedKeyLists.add(targetId);
      added.push(`${entries.length} key → ${providerLabelOf(targetId, target)}`);
    }

    keyDrafts.delete(providerId);
    pendingKeyFocus = providerId;
    renderPresetBar();
    renderPreferredSelect();
    renderProviders();
    updateKpiDisplay();
    markDirty();

    const notes = [];
    if (duplicates) notes.push(`bỏ ${duplicates} key trùng`);
    if (invalid.length) notes.push(`bỏ qua ${invalid.length} mẩu không giống key`);
    const suspicious = [...groups].flatMap(([id, entries]) => entries
      .map(entry => keyFormatWarning(id, entry.key))
      .filter(Boolean));
    if (suspicious.length) notes.push(`cảnh báo định dạng: ${suspicious[0]}`);
    setStatus(
      `Đã thêm ${added.join(' · ')}${notes.length ? ` — ${notes.join(' · ')}` : ''} — nhớ bấm Lưu cài đặt`,
      Boolean(invalid.length || suspicious.length),
    );
  };

  addButton.addEventListener('click', addKeys);
  input.addEventListener('input', () => {
    keyDrafts.set(providerId, input.value);
    refresh();
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (input.value.includes('\n') && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    addKeys();
  });

  box.append(input, foot);
  list.appendChild(box);
  refresh();

  card.appendChild(list);
  if (pendingKeyFocus === providerId) {
    pendingKeyFocus = '';
    input.focus();
  }
}

function renderProviderFields(card, providerId) {
  const def = providerDefOf(providerId);
  const provider = config.providers[providerId];
  const fields = el('div', 'provider-fields');

  if (isCustomProvider(providerId) || providerId === 'openai') {
    fields.appendChild(el('label', 'small-label', 'Tên hiển thị'));
    const name = document.createElement('input');
    name.type = 'text';
    name.spellcheck = false;
    name.maxLength = 40;
    name.value = provider.name || '';
    name.placeholder = 'VD: Groq · OpenRouter · API tự host';
    name.addEventListener('input', () => {
      provider.name = name.value.trim();
      markDirty();
      const label = providerLabelOf(providerId, provider);
      const title = card.querySelector('.provider-title');
      if (title) title.textContent = label;
      const option = $('#preferred').querySelector(`option[value="${providerId}"]`);
      if (option) option.textContent = label;
    });
    fields.appendChild(name);
  }

  if (def?.needsUrl) {
    fields.appendChild(el('label', 'small-label', 'API URL'));
    const url = document.createElement('input');
    url.type = 'url';
    url.spellcheck = false;
    url.value = provider.url || def.defaultUrl;
    url.placeholder = def.defaultUrl;
    url.addEventListener('input', () => { provider.url = url.value.trim(); markDirty(); });
    fields.appendChild(url);

    fields.appendChild(el('label', 'small-label', 'Định dạng API'));
    const format = document.createElement('select');
    for (const [value, text] of [
      ['auto', 'Tự nhận diện'],
      ['responses', 'OpenAI Responses'],
      ['chat', 'OpenAI-compatible Chat'],
      ['libre', 'LibreTranslate'],
      ['generic', 'Generic JSON translate'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      format.appendChild(option);
    }
    format.value = provider.format || 'auto';
    format.addEventListener('change', () => { provider.format = format.value; markDirty(); });
    fields.appendChild(format);
  }

  if (def?.needsModel) {
    fields.appendChild(el('label', 'small-label', providerKind(providerId) === 'gemini'
      ? 'Model — khuyên dùng gemini-3.1-flash-lite (nhanh, tiết kiệm quota)'
      : 'Model'));
    const model = document.createElement('input');
    model.type = 'text';
    model.spellcheck = false;
    model.value = provider.model || def.defaultModel;
    model.placeholder = def.defaultModel;
    if (def.suggestedModels) {
      const datalistId = `${providerId}-model-suggestions`;
      model.setAttribute('list', datalistId);
      const datalist = document.createElement('datalist');
      datalist.id = datalistId;
      for (const name of def.suggestedModels) {
        const option = document.createElement('option');
        option.value = name;
        datalist.appendChild(option);
      }
      fields.appendChild(datalist);
    }
    model.addEventListener('input', () => { provider.model = model.value.trim(); markDirty(); });
    fields.appendChild(model);
  }

  if (providerKind(providerId) === 'deploy') {
    const templates = {
      none: 'Không suy luận (nhanh nhất)',
      minimal: 'Tối thiểu',
      low: 'Thấp',
      medium: 'Trung bình',
      high: 'Cao',
      xhigh: 'Rất cao',
      max: 'Tối đa — sâu nhất',
    };
    const makeEffortSelect = (current, fallback, onChange) => {
      const select = document.createElement('select');
      for (const value of DEPLOY_REASONING_EFFORTS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = templates[value] || value;
        select.appendChild(option);
      }
      select.value = DEPLOY_REASONING_EFFORTS.includes(current) ? current : fallback;
      select.addEventListener('change', () => { onChange(select.value); markDirty(); });
      return select;
    };

    fields.appendChild(el('label', 'small-label', 'Mức suy luận khi dịch (trang, ảnh, OCR, tóm tắt)'));
    fields.appendChild(makeEffortSelect(
      provider.translateReasoningEffort, DEPLOY_TRANSLATE_REASONING,
      value => { provider.translateReasoningEffort = value; },
    ));
    fields.appendChild(el('label', 'small-label', 'Mức suy luận khi giải bài (Quick Solver)'));
    fields.appendChild(makeEffortSelect(
      provider.reasoningEffort, DEPLOY_DEFAULT_REASONING,
      value => { provider.reasoningEffort = value; },
    ));
  }

  if (providerKind(providerId) === 'gemini') {
    const searchWrap = el('label', 'check');
    const searchCheck = document.createElement('input');
    searchCheck.type = 'checkbox';
    searchCheck.checked = provider.googleSearch !== false;
    searchCheck.addEventListener('change', () => {
      provider.googleSearch = searchCheck.checked;
      markDirty();
    });
    searchWrap.append(searchCheck, document.createTextNode('Bật Google Search tra cứu thực tế (sự kiện, dữ liệu mới)'));
    fields.appendChild(searchWrap);

    const extendedWrap = el('label', 'check');
    const extendedCheck = document.createElement('input');
    extendedCheck.type = 'checkbox';
    extendedCheck.checked = provider.extendedThinking === true;
    extendedCheck.addEventListener('change', () => {
      provider.extendedThinking = extendedCheck.checked;
      markDirty();
    });
    extendedWrap.append(extendedCheck, document.createTextNode('Mặc định bật Extended Thinking khi giải toán sâu'));
    fields.appendChild(extendedWrap);
  }

  card.appendChild(fields);
}

function addCustomProvider() {
  const id = nextCustomProviderId(config);
  if (!id) {
    setStatus(`Tối đa ${MAX_CUSTOM_PROVIDERS} API tùy chỉnh`, true);
    return;
  }
  config.providers[id] = emptyProviderConfig(id);
  renderPreferredSelect();
  renderProviders();
  updateKpiDisplay();
  markDirty();
  setStatus('Đã thêm slot API tùy chỉnh — điền URL/model rồi dán key vào đó');
  const card = document.querySelector(`.provider-card[data-provider="${id}"]`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.querySelector('input[type="text"]')?.focus();
}

async function removeOptionalProvider(providerId) {
  const provider = config.providers[providerId];
  const label = providerLabelOf(providerId, provider);
  if (provider.keys.length > 0) {
    const confirmed = await confirmAction({
      title: `Xoá "${label}"?`,
      message: `Xoá "${label}" cùng ${provider.keys.length} key bên trong?\nKhông khôi phục lại được.`,
      confirmText: 'Xoá provider',
    });
    if (!confirmed) return;
  }
  delete config.providers[providerId];
  keyDrafts.delete(providerId);
  expandedKeyLists.delete(providerId);
  if (config.preferred === providerId) config.preferred = providerIdsOf(config)[0];
  renderPresetBar();
  renderPreferredSelect();
  renderProviders();
  updateKpiDisplay();
  markDirty();
  setStatus(`Đã xoá "${label}" — nhớ bấm Lưu cài đặt`);
}

function matchesProviderFilter(providerId, provider) {
  const query = providerQuery.trim().toLowerCase();
  if (query) {
    const label = providerLabelOf(providerId, provider).toLowerCase();
    const haystack = `${providerId} ${label} ${provider.model || ''} ${provider.url || ''}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (providerFilter === 'active') return provider.keys.length > 0;
  if (providerFilter === 'vision') return supportsVision(providerId, provider);
  if (providerFilter === 'issue') {
    return provider.keys.some((entry, idx) => {
      if (entry.disabled) return false;
      const h = healthByKey.get(keyHashId(providerId, entry.key)) || healthByKey.get(`${providerId}:${idx}`);
      return Boolean(h && (h.coolingDown || h.errorStreak > 0));
    });
  }
  return true;
}

function renderProviders() {
  const container = $('#providers');
  container.textContent = '';

  let shown = 0;
  for (const providerId of providerIdsOf(config)) {
    const def = providerDefOf(providerId);
    const provider = config.providers[providerId];
    if (!matchesProviderFilter(providerId, provider)) continue;
    shown++;

    const custom = isCustomProvider(providerId);
    const removable = custom || isPresetProvider(providerId);

    const card = el('div', 'provider-card');
    card.dataset.enabled = String(provider.enabled);
    card.dataset.provider = providerId;

    const head = el('div', 'provider-head');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = provider.enabled;
    toggle.title = 'Bật/tắt provider này';
    toggle.addEventListener('change', () => {
      provider.enabled = toggle.checked;
      card.dataset.enabled = String(provider.enabled);
      updateKpiDisplay();
      markDirty();
    });
    head.appendChild(toggle);

    const customIndex = custom ? Number(providerId.split('-')[1]) : 0;
    head.insertAdjacentHTML('beforeend', brandMark(providerId, { custom: customIndex }));
    head.appendChild(el('span', 'provider-title', providerLabelOf(providerId, provider)));

    const badges = el('div', 'provider-badges');
    if (supportsVision(providerId, provider)) {
      badges.appendChild(el('span', 'pill-vision', 'Vision'));
    }
    const activeCount = activeKeysOf(provider).length;
    badges.appendChild(el('span', 'badge', `${activeCount}/${provider.keys.length} key`));

    if (activeCount > 0) {
      const testCardBtn = iconButton('key-link', 'activity', 'Test', { size: 12 });
      testCardBtn.title = 'Test toàn bộ key đang bật của provider này';
      testCardBtn.addEventListener('click', () => {
        pingKeys({ providerId, triggerBtn: testCardBtn }).catch(error => setStatus(error.message, true));
      });
      badges.appendChild(testCardBtn);
    }

    if (removable) {
      const remove = iconButton('key-link key-link-danger', 'trash', 'Xoá', { size: 12 });
      remove.title = 'Xoá thẻ provider này';
      remove.addEventListener('click', () => removeOptionalProvider(providerId));
      badges.appendChild(remove);
    }
    head.appendChild(badges);
    card.appendChild(head);

    if (def?.site) {
      const site = el('div', 'provider-site');
      const link = document.createElement('a');
      link.href = def.site;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.innerHTML = icon('external', { size: 12 });
      link.appendChild(document.createTextNode('Lấy API key tại đây'));
      site.appendChild(link);
      if (def.badgeTag) site.appendChild(el('span', 'badge', def.badgeTag));
      card.appendChild(site);
    }

    renderKeyList(card, providerId);
    renderProviderFields(card, providerId);
    container.appendChild(card);
  }

  if (!shown) {
    container.appendChild(el('div', 'key-empty', 'Không tìm thấy provider nào khớp bộ lọc hiện tại.'));
  }
}

/* ------------------------- Origin Permissions ------------------------- */

function endpointOrigin(endpoint, label) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    throw new Error(`API URL của "${label}" không hợp lệ`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`API URL của "${label}" phải dùng HTTP/HTTPS`);
  return url.origin;
}

async function ensureEndpointPermissions() {
  const wanted = new Set();
  for (const id of providerIdsOf(config)) {
    const provider = config.providers[id];
    const def = providerDefOf(id);
    if (!provider.enabled && !provider.keys.length) continue;
    const rawUrl = provider.url || def?.defaultUrl;
    if (!rawUrl) continue;
    const origin = endpointOrigin(rawUrl, providerLabelOf(id, provider));
    if (!BUILTIN_ORIGINS.has(origin)) wanted.add(`${origin}/*`);
  }
  if (!wanted.size) return;

  const missing = [];
  for (const pattern of wanted) {
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) missing.push(pattern);
  }
  if (!missing.length) return;

  const granted = await chrome.permissions.request({ origins: missing });
  if (!granted) throw new Error(`Bạn chưa cấp quyền truy cập ${missing.length} API URL tùy chỉnh`);
}

/* ------------------------- Page Live Preview ------------------------- */

const PAGE_PREVIEW_SAMPLES = {
  natural: 'Triển khai pool worker không gián đoạn trước khi bộ giới hạn tốc độ kích hoạt.',
  casual: 'Bật pool worker chạy mượt trước khi dính giới hạn tốc độ nhé.',
  'work-email': 'Vui lòng triển khai worker pool không gián đoạn trước khi cơ chế giới hạn tốc độ có hiệu lực.',
  'game-chat': 'Dựng pool worker zero-downtime lẹ trước khi ăn rate limit!',
  genz: 'Triển khai pool worker mượt không rớt nhịp trước khi dính rate limit nha.',
  formal: 'Thực hiện triển khai cụm xử lý liên tục trước khi ngưỡng giới hạn lưu lượng được áp dụng.',
  technical: 'Triển khai zero-downtime worker pool trước khi rate limiter kích hoạt.',
  academic: 'Thiết lập nhóm tiến trình xử lý liên tục (zero-downtime) trước ngưỡng điều tiết lưu lượng.',
};

function updatePageStylePreview() {
  const style = $('#pageStyle').value;
  const dialect = $('#pageDialect').value;
  const mode = $('#pageTranslateMode').value;
  const displayMode = $('#pageDisplayMode').value;
  const grammarFix = $('#pageGrammarFix').checked;

  const meta = $('#pagePreviewMeta');
  const out = $('#pagePreviewOutput');
  if (!meta || !out) return;

  meta.textContent = '';
  const badges = [
    `Văn phong: ${style}`,
    `Chế độ: ${mode === 'literal' ? 'Sát chữ' : 'Tự nhiên'}`,
    `Hiển thị: ${displayMode === 'bilingual' ? 'Song ngữ' : 'Thay thế'}`,
    `Ngữ pháp EN: ${dialect.toUpperCase()}`,
  ];
  if (grammarFix) badges.push('Sửa ngữ pháp');
  for (const b of badges) meta.appendChild(el('span', 'badge', b));

  const sampleVi = PAGE_PREVIEW_SAMPLES[style] || PAGE_PREVIEW_SAMPLES.natural;
  out.textContent = displayMode === 'bilingual'
    ? `Deploy the zero-downtime worker pool before the rate limiter kicks in.\n↳ ${sampleVi}`
    : sampleVi;
}

/* ------------------------- Save / Test / Prefs ------------------------- */

function parseSiteBlacklist(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(Boolean);
}

let studioOverrides = normalizeSystemPromptOverrides({});

async function saveSettings(showSaved = true) {
  config.preferred = $('#preferred').value;
  await ensureEndpointPermissions();

  await persistConfig();
  await chrome.storage.local.set({
    [SYSTEM_PROMPT_OVERRIDE_KEY]: normalizeSystemPromptOverrides(studioOverrides),
    [PREFS_KEYS.context]: $('#useContext').checked,
    [PREFS_KEYS.defaultMode]: $('#defaultMode').value,
    [PREFS_KEYS.fallbackQuick]: $('#fallbackQuick').checked,
    [PREFS_KEYS.pageUseProvider]: $('#pageUseProvider').checked,
    [PREFS_KEYS.pageFreeFallback]: $('#pageFreeFallback').checked,
    [PREFS_KEYS.selectionTranslate]: $('#selectionTranslate').checked,
    [PREFS_KEYS.inputHelper]: $('#inputHelper').checked,
    [PREFS_KEYS.siteBlacklist]: parseSiteBlacklist($('#siteBlacklist').value),
    [PREFS_KEYS.pageDisplayMode]: $('#pageDisplayMode').value,
    [PREFS_KEYS.pageStyle]: $('#pageStyle').value,
    [PREFS_KEYS.pageDialect]: $('#pageDialect').value,
    [PREFS_KEYS.pageTranslateMode]: $('#pageTranslateMode').value,
    [PREFS_KEYS.pageGrammarFix]: $('#pageGrammarFix').checked,
    [PREFS_KEYS.pageSkipCode]: $('#pageSkipCode').checked,
    [PREFS_KEYS.pageSkipUsernames]: $('#pageSkipUsernames').checked,
    [PREFS_KEYS.pageKeepProperNouns]: $('#pageKeepProperNouns').checked,
    [PREFS_KEYS.pageDynamicTranslate]: $('#pageDynamicTranslate').checked,
    [PREFS_KEYS.pageLazyTranslate]: $('#pageLazyTranslate').checked,
    [PREFS_KEYS.docMode]: $('#docMode').value,
    [PREFS_KEYS.ttsEnabled]: $('#ttsEnabled').checked,
    [PREFS_KEYS.ttsRate]: Number($('#ttsRate').value),
    [PREFS_KEYS.translationCache]: $('#translationCache').checked,
    [PREFS_KEYS.uiTheme]: $('#uiTheme').value,
  });
  markClean();
  updateKpiDisplay();
  if (showSaved) setStatus('Đã lưu toàn bộ cài đặt');
}

async function testApi() {
  setStatus('Đang test dịch câu mẫu…');
  await saveSettings(false);
  const result = await chrome.runtime.sendMessage({
    type: 'nativeTranslate',
    payload: {
      source: 'Câu này chỉ để kiểm tra API dịch có hoạt động không.',
      context: 'This is a connection test. Return only the English translation.',
    },
  });
  if (!result?.ok) {
    const message = result?.error === 'NO_API_KEY'
      ? 'Chưa có provider nào được bật kèm API key'
      : (result?.error || 'API test thất bại');
    throw new Error(message);
  }
  await refreshKeyPoolHealth();
  setStatus(`API hoạt động (${result.providerLabel}):\n${result.text}`);
}

async function loadPrefs() {
  const values = await chrome.storage.local.get([...Object.values(PREFS_KEYS), SYSTEM_PROMPT_OVERRIDE_KEY]);
  studioOverrides = normalizeSystemPromptOverrides(values[SYSTEM_PROMPT_OVERRIDE_KEY]);
  renderPromptStudio();

  $('#useContext').checked = values[PREFS_KEYS.context] !== false;
  $('#defaultMode').value = values[PREFS_KEYS.defaultMode] === 'quick' ? 'quick' : 'native';
  $('#fallbackQuick').checked = values[PREFS_KEYS.fallbackQuick] !== false;
  $('#pageUseProvider').checked = values[PREFS_KEYS.pageUseProvider] !== false;
  $('#pageFreeFallback').checked = values[PREFS_KEYS.pageFreeFallback] !== false;
  $('#selectionTranslate').checked = values[PREFS_KEYS.selectionTranslate] !== false;
  $('#inputHelper').checked = values[PREFS_KEYS.inputHelper] !== false;
  const blacklist = values[PREFS_KEYS.siteBlacklist];
  $('#siteBlacklist').value = Array.isArray(blacklist) ? blacklist.join('\n') : '';
  $('#pageDisplayMode').value = values[PREFS_KEYS.pageDisplayMode] === 'bilingual' ? 'bilingual' : 'replace';
  $('#pageStyle').value = PAGE_STYLE_VALUES.includes(values[PREFS_KEYS.pageStyle]) ? values[PREFS_KEYS.pageStyle] : 'natural';
  $('#pageDialect').value = values[PREFS_KEYS.pageDialect] === 'uk' ? 'uk' : 'us';
  $('#pageTranslateMode').value = values[PREFS_KEYS.pageTranslateMode] === 'literal' ? 'literal' : 'natural';
  $('#pageGrammarFix').checked = values[PREFS_KEYS.pageGrammarFix] === true;
  $('#pageSkipCode').checked = values[PREFS_KEYS.pageSkipCode] !== false;
  $('#pageSkipUsernames').checked = values[PREFS_KEYS.pageSkipUsernames] !== false;
  $('#pageKeepProperNouns').checked = values[PREFS_KEYS.pageKeepProperNouns] !== false;
  $('#pageDynamicTranslate').checked = values[PREFS_KEYS.pageDynamicTranslate] !== false;
  $('#pageLazyTranslate').checked = values[PREFS_KEYS.pageLazyTranslate] !== false;
  $('#docMode').value = ['auto', 'on', 'off'].includes(values[PREFS_KEYS.docMode]) ? values[PREFS_KEYS.docMode] : 'auto';
  $('#ttsEnabled').checked = values[PREFS_KEYS.ttsEnabled] !== false;
  const ttsRate = Number(values[PREFS_KEYS.ttsRate]);
  $('#ttsRate').value = (ttsRate >= 0.5 && ttsRate <= 2) ? String(ttsRate) : '1';
  $('#ttsRateValue').textContent = $('#ttsRate').value;
  $('#translationCache').checked = values[PREFS_KEYS.translationCache] !== false;
  const theme = values[PREFS_KEYS.uiTheme];
  $('#uiTheme').value = ['dark', 'light'].includes(theme) ? theme : 'auto';
  applyTheme(theme);
  updatePageStylePreview();
}

/* ------------------------- Prompt Studio ------------------------- */

function buildStudioPreviewText(task, override) {
  if (task === 'batch') {
    return buildBatchInstructions('auto', 'Vietnamese', {
      style: $('#pageStyle')?.value || 'natural',
      dialect: $('#pageDialect')?.value || 'us',
      mode: $('#pageTranslateMode')?.value || 'natural',
      grammarFix: Boolean($('#pageGrammarFix')?.checked),
      systemOverride: override,
    });
  }
  if (task === 'native') return buildNativeInstructions($('#tone')?.value || 'natural', override);
  if (task === 'summary') return buildSummaryInstructions('Vietnamese', 8, override);
  if (task === 'qa') return buildQaInstructions(override);
  if (task === 'vision') return buildVisionInstructions('Vietnamese', override);
  if (task === 'ocr') return buildOcrVisionInstructions(override);
  return '';
}

function renderPromptStudio() {
  const taskEl = $('#studioTask');
  const inputEl = $('#studioOverrideInput');
  const previewEl = $('#studioPreview');
  if (!taskEl || !inputEl || !previewEl) return;

  const task = taskEl.value || 'batch';
  const override = studioOverrides[task] || '';
  if (inputEl.value !== override) inputEl.value = override;
  previewEl.textContent = buildStudioPreviewText(task, override);
}

/* ------------------------- Prompt Templates ------------------------- */

let templates = [];
let activeTemplateId = '';
let editingTemplateId = null;

async function persistTemplates() {
  await chrome.storage.local.set({ [TEMPLATE_KEYS.templates]: templates });
}

function renderTemplates() {
  const list = $('#templateList');
  list.textContent = '';

  if (!templates.length) {
    list.appendChild(el('div', 'key-empty', 'Chưa có template nào.'));
  }

  templates.forEach(tpl => {
    const row = el('div', 'key-row');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activeTemplate';
    radio.className = 'tpl-radio';
    radio.dataset.noDirty = 'true';
    radio.checked = tpl.id === activeTemplateId;
    radio.title = 'Chọn làm template đang dùng';
    radio.addEventListener('change', async () => {
      activeTemplateId = tpl.id;
      await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: activeTemplateId });
      renderTemplates();
      setStatus(`Đang dùng template "${tpl.name}"`);
    });
    row.appendChild(radio);
    row.appendChild(el('span', 'tpl-name', tpl.name));

    const edit = iconButton('row-action', 'edit', 'Sửa', { size: 13 });
    edit.title = 'Sửa template này';
    edit.addEventListener('click', () => {
      editingTemplateId = tpl.id;
      $('#tplName').value = tpl.name;
      $('#tplPrompt').value = tpl.prompt;
      $('#tplSave').lastChild.nodeValue = 'Cập nhật template';
      $('#tplCancel').hidden = false;
      $('#tplName').focus();
    });
    row.appendChild(edit);

    const remove = iconButton('row-action row-action-danger', 'trash', 'Xoá', { size: 13 });
    remove.title = 'Xoá template này';
    remove.addEventListener('click', async () => {
      templates = templates.filter(item => item.id !== tpl.id);
      if (activeTemplateId === tpl.id) {
        activeTemplateId = '';
        await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: '' });
      }
      if (editingTemplateId === tpl.id) resetTemplateForm();
      await persistTemplates();
      renderTemplates();
      setStatus('Đã xoá template');
    });
    row.appendChild(remove);
    list.appendChild(row);
  });

  const noneRow = el('div', 'key-row');
  const noneRadio = document.createElement('input');
  noneRadio.type = 'radio';
  noneRadio.name = 'activeTemplate';
  noneRadio.className = 'tpl-radio';
  noneRadio.dataset.noDirty = 'true';
  noneRadio.checked = activeTemplateId === '';
  noneRadio.title = 'Không dùng template';
  noneRadio.addEventListener('change', async () => {
    activeTemplateId = '';
    await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: '' });
    renderTemplates();
    setStatus('Đã bỏ chọn template — dịch theo mặc định');
  });
  noneRow.appendChild(noneRadio);
  noneRow.appendChild(el('span', 'tpl-name', 'Mặc định (không dùng template)'));
  list.appendChild(noneRow);
}

function resetTemplateForm() {
  editingTemplateId = null;
  $('#tplName').value = '';
  $('#tplPrompt').value = '';
  $('#tplSave').lastChild.nodeValue = 'Lưu template';
  $('#tplCancel').hidden = true;
}

async function saveTemplateForm() {
  const name = $('#tplName').value.trim();
  const prompt = $('#tplPrompt').value.trim();
  if (!name || !prompt) return setStatus('Nhập đủ tên và prompt cho template', true);

  if (editingTemplateId) {
    const tpl = templates.find(item => item.id === editingTemplateId);
    if (tpl) {
      tpl.name = name;
      tpl.prompt = prompt;
    }
    setStatus(`Đã cập nhật template "${name}"`);
  } else {
    templates.push({ id: `tpl-${Date.now().toString(36)}`, name, prompt });
    setStatus(`Đã thêm template "${name}"`);
  }
  resetTemplateForm();
  await persistTemplates();
  renderTemplates();
}

async function loadTemplates() {
  const values = await chrome.storage.local.get([TEMPLATE_KEYS.templates, TEMPLATE_KEYS.active]);
  if (values[TEMPLATE_KEYS.templates] === undefined) {
    templates = DEFAULT_TEMPLATES.map(tpl => ({ ...tpl }));
    await persistTemplates();
  } else {
    templates = Array.isArray(values[TEMPLATE_KEYS.templates]) ? values[TEMPLATE_KEYS.templates] : [];
  }
  const savedActive = values[TEMPLATE_KEYS.active];
  activeTemplateId = typeof savedActive === 'string' && templates.some(tpl => tpl.id === savedActive) ? savedActive : '';
  renderTemplates();
}

/* ------------------------- Searchable Glossary ------------------------- */

let glossary = [];

async function persistGlossary() {
  await chrome.storage.local.set({ [GLOSSARY_KEY]: glossary });
}

function renderGlossary() {
  const list = $('#glossaryList');
  list.textContent = '';

  const q = glossaryQuery.trim().toLowerCase();
  const filtered = q
    ? glossary.filter(e => e.source.toLowerCase().includes(q) || e.target.toLowerCase().includes(q))
    : glossary;

  $('#glossaryCount').textContent = q ? `${filtered.length}/${glossary.length} từ` : `${glossary.length} từ`;

  if (!filtered.length) {
    list.appendChild(el('div', 'key-empty', glossary.length ? 'Không có thuật ngữ khớp từ khóa.' : 'Chưa có thuật ngữ nào.'));
    return;
  }

  filtered.forEach(entry => {
    const row = el('div', 'key-row glossary-row');
    row.appendChild(el('span', 'glossary-source', entry.source));
    row.insertAdjacentHTML('beforeend', icon('chevron', { size: 13, className: 'glossary-arrow' }));
    row.appendChild(el('span', 'glossary-target', entry.target));
    const remove = iconButton('row-action row-action-danger', 'trash', 'Xoá', { size: 13 });
    remove.title = 'Xoá cặp từ này';
    remove.addEventListener('click', async () => {
      const idx = glossary.indexOf(entry);
      if (idx >= 0) glossary.splice(idx, 1);
      await persistGlossary();
      renderGlossary();
      setStatus('Đã xoá cặp từ');
    });
    row.appendChild(remove);
    list.appendChild(row);
  });
}

async function mergeGlossary(entries) {
  let added = 0;
  for (const entry of entries) {
    const source = String(entry?.source || '').trim();
    const target = String(entry?.target || '').trim();
    if (!source || !target) continue;
    const existing = glossary.find(item => item.source === source);
    if (existing) existing.target = target;
    else {
      glossary.push({ source, target });
      added++;
    }
  }
  await persistGlossary();
  renderGlossary();
  return added;
}

async function addGlossaryEntry() {
  const source = $('#glossarySource').value.trim();
  const target = $('#glossaryTarget').value.trim();
  if (!source || !target) return setStatus('Nhập đủ thuật ngữ gốc và bản dịch', true);
  await mergeGlossary([{ source, target }]);
  $('#glossarySource').value = '';
  $('#glossaryTarget').value = '';
  $('#glossarySource').focus();
  setStatus('Đã thêm cặp từ vào glossary');
}

async function importGlossaryFile(file) {
  const helper = globalThis.NPT_GLOSSARY;
  if (!helper?.parse) return setStatus('Module glossary.js chưa sẵn sàng', true);
  const text = await file.text();
  const entries = helper.parse(text);
  if (!Array.isArray(entries) || !entries.length) return setStatus('Không đọc được cặp từ nào từ file này', true);
  const added = await mergeGlossary(entries);
  setStatus(`Đã import ${entries.length} cặp từ (${added} từ mới, còn lại cập nhật)`);
}

function exportGlossary(format) {
  const helper = globalThis.NPT_GLOSSARY;
  if (!helper?.serialize) return setStatus('Module glossary.js chưa sẵn sàng', true);
  if (!glossary.length) return setStatus('Glossary đang trống', true);
  const text = helper.serialize(glossary, format);
  const isJson = format === 'json';
  downloadFile(isJson ? 'glossary.json' : 'glossary.csv', text, isJson ? 'application/json' : 'text/csv');
  setStatus(`Đã xuất ${glossary.length} từ`);
}

async function loadGlossary() {
  const values = await chrome.storage.local.get([GLOSSARY_KEY]);
  glossary = Array.isArray(values[GLOSSARY_KEY]) ? values[GLOSSARY_KEY] : [];
  renderGlossary();
}

/* ------------------------- Quota DeepL ------------------------- */

function renderUsageRow(container, usage) {
  const row = el('div');
  row.style.marginTop = '8px';

  if (usage.error) {
    const line = el('div', 'note', `DeepL ${usage.keyMasked || ''}: ${usage.error}`);
    line.style.cssText = 'margin:0;color:var(--danger)';
    row.appendChild(line);
    container.appendChild(row);
    return;
  }

  const count = Number(usage.count) || 0;
  const limit = Number(usage.limit) || 0;
  const label = el('div', 'note', `DeepL ${usage.keyMasked}${usage.disabled ? ' (tắt)' : ''}: ${count.toLocaleString('vi-VN')}/${limit.toLocaleString('vi-VN')} ký tự`);
  label.style.margin = '0';
  row.appendChild(label);

  if (limit > 0) {
    const percent = Math.min(100, Math.round((count / limit) * 100));
    const track = el('div');
    track.style.cssText = 'height:6px;margin-top:4px;border-radius:99px;background:var(--panel-strong);overflow:hidden';
    const fill = el('div');
    fill.style.cssText = `height:100%;width:${percent}%;border-radius:99px;background:linear-gradient(135deg,var(--accent),var(--accent-2))`;
    track.appendChild(fill);
    row.appendChild(track);
  }
  container.appendChild(row);
}

async function renderDeeplUsage() {
  const container = $('#deeplUsage');
  container.textContent = '';
  const result = await chrome.runtime.sendMessage({ type: 'deeplUsage' }).catch(() => null);
  const usages = Array.isArray(result?.usages) ? result.usages : [];
  if (!result?.ok || !usages.length) {
    const line = el('div', 'note', result?.error || 'Chưa có dữ liệu quota DeepL.');
    if (!result?.ok) line.style.color = 'var(--danger)';
    container.appendChild(line);
    return;
  }
  for (const usage of usages) renderUsageRow(container, usage);
}

/* ------------------------- Theme & Accessible Tabs ------------------------- */

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function selectTab(name, { focusTab = false } = {}) {
  const tabs = [...document.querySelectorAll('#sidebarNav .tab')];
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus();
  }
  for (const panel of document.querySelectorAll('.tabpanel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  const meta = TAB_META[name];
  if (meta) {
    $('#dashSectionTitle').textContent = meta.title;
    $('#dashSectionSub').textContent = meta.sub;
  }
  if (location.hash.replace('#', '') !== name) {
    history.replaceState(null, '', `#${name}`);
  }
}

/* ------------------------- Cache & Backup ------------------------- */

async function refreshCacheStats() {
  const result = await chrome.runtime.sendMessage({ type: 'translationCacheStats' }).catch(() => null);
  $('#cacheCount').textContent = result?.ok ? `${result.entries.toLocaleString('vi-VN')} mục` : '— mục';
}

async function clearCache() {
  const confirmed = await confirmAction({
    title: 'Xoá toàn bộ cache bản dịch?',
    message: 'Tất cả bản dịch đang nhớ dùng chung giữa các tab sẽ bị xoá sạch.',
    confirmText: 'Xoá cache',
  });
  if (!confirmed) return;
  const result = await chrome.runtime.sendMessage({ type: 'clearTranslationCache' }).catch(() => null);
  if (!result?.ok) return setStatus(result?.error || 'Không xoá được cache', true);
  await Promise.all([refreshCacheStats(), refreshKeyPoolHealth()]);
  setStatus('Đã xoá cache bản dịch');
}

const BACKUP_KEYS = [
  ...Object.values(PREFS_KEYS),
  SYSTEM_PROMPT_OVERRIDE_KEY,
  TEMPLATE_KEYS.templates,
  TEMPLATE_KEYS.active,
  GLOSSARY_KEY,
  'tm-fab-position',
  'tm-input-helper-offset',
  'tm-image-target',
];
const BACKUP_KEY_PATTERN = /^tm-page-translator-language:/;

function isBackupKey(key) {
  return BACKUP_KEYS.includes(key) || BACKUP_KEY_PATTERN.test(key);
}

function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportSettings() {
  await saveSettings(false);
  const all = await chrome.storage.local.get(null);
  const data = {};
  for (const [key, value] of Object.entries(all)) {
    if (!isBackupKey(key)) continue;
    data[key] = value;
  }
  downloadFile(
    `native-translator-settings-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ version: chrome.runtime.getManifest().version, settings: data }, null, 2),
    'application/json',
  );
  setStatus('Đã xuất cài đặt (không kèm API key)');
}

async function importSettings(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_) {
    return setStatus('File không phải JSON hợp lệ', true);
  }
  const data = parsed?.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  if (!data || typeof data !== 'object') return setStatus('Không đọc được cài đặt trong file', true);

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isBackupKey(key)) continue;
    clean[key] = value;
  }
  if (!Object.keys(clean).length) return setStatus('File không chứa cài đặt nào dùng được', true);

  await chrome.storage.local.set(clean);
  setStatus(`Đã nhập ${Object.keys(clean).length} mục cài đặt — đang tải lại…`);
  setTimeout(() => location.reload(), 700);
}

async function resetSettings() {
  const confirmed = await confirmAction({
    title: 'Đưa cài đặt về mặc định?',
    message: 'API key, glossary và prompt template sẽ được GIỮ NGUYÊN.\nCác tùy chọn dịch trang, TTS, cache và giao diện sẽ về mặc định.',
    confirmText: 'Khôi phục mặc định',
  });
  if (!confirmed) return;
  const all = await chrome.storage.local.get(null);
  const remove = Object.keys(all).filter(key =>
    isBackupKey(key)
    && key !== GLOSSARY_KEY
    && key !== TEMPLATE_KEYS.templates
    && key !== TEMPLATE_KEYS.active);
  await chrome.storage.local.remove(remove);
  setStatus('Đã về mặc định — đang tải lại…');
  setTimeout(() => location.reload(), 700);
}

/* ------------------------- Event Wiring & Boot ------------------------- */

const sidebarTabs = [...document.querySelectorAll('#sidebarNav .tab')];
sidebarTabs.forEach((tab, idx) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    let nextIdx = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIdx = (idx + 1) % sidebarTabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIdx = (idx - 1 + sidebarTabs.length) % sidebarTabs.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = sidebarTabs.length - 1;
    if (nextIdx >= 0) {
      event.preventDefault();
      selectTab(sidebarTabs[nextIdx].dataset.tab, { focusTab: true });
    }
  });
});

for (const radio of document.querySelectorAll('input[name="routingStrategy"]')) {
  radio.addEventListener('change', () => {
    if (!config) return;
    config.routingStrategy = radio.value;
    updateKpiDisplay();
    markDirty();
  });
}

$('#universalKeyInput')?.addEventListener('input', updateUniversalDropzonePreview);
$('#universalAddBtn')?.addEventListener('click', commitUniversalDropzone);
$('#universalKeyInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    commitUniversalDropzone();
  }
});

$('#providerSearch')?.addEventListener('input', (event) => {
  providerQuery = event.target.value;
  renderProviders();
});

for (const pill of document.querySelectorAll('.filter-pill')) {
  pill.addEventListener('click', () => {
    providerFilter = pill.dataset.filter || 'all';
    for (const p of document.querySelectorAll('.filter-pill')) {
      p.setAttribute('aria-pressed', String(p === pill));
    }
    renderProviders();
  });
}

$('#save').addEventListener('click', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#testAllKeys').addEventListener('click', (event) => pingKeys({ triggerBtn: event.currentTarget }).catch(error => setStatus(error.message, true)));
$('#addCustomProvider').addEventListener('click', addCustomProvider);
$('#testApi').addEventListener('click', () => testApi().catch(error => setStatus(error.message, true)));
$('#preferred').addEventListener('change', () => { config.preferred = $('#preferred').value; markDirty(); });
$('#tone').addEventListener('change', () => {
  config.tone = $('#tone').value;
  renderPromptStudio();
  markDirty();
});
$('#uiTheme').addEventListener('change', () => applyTheme($('#uiTheme').value));
$('#cacheClear').addEventListener('click', () => clearCache().catch(error => setStatus(error.message, true)));
$('#settingsExport').addEventListener('click', () => exportSettings().catch(error => setStatus(error.message, true)));
$('#settingsImport').addEventListener('click', () => $('#settingsFile').click());
$('#settingsFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) await importSettings(file).catch(error => setStatus(error.message, true));
});
$('#settingsReset').addEventListener('click', () => resetSettings().catch(error => setStatus(error.message, true)));

for (const id of ['#pageStyle', '#pageDialect', '#pageTranslateMode', '#pageDisplayMode', '#pageGrammarFix']) {
  $(id)?.addEventListener('change', () => {
    updatePageStylePreview();
    renderPromptStudio();
  });
}

$('#studioTask')?.addEventListener('change', renderPromptStudio);
$('#studioOverrideInput')?.addEventListener('input', (event) => {
  const task = $('#studioTask').value || 'batch';
  studioOverrides[task] = event.target.value.slice(0, 2000);
  renderPromptStudio();
  markDirty();
});
$('#studioResetTask')?.addEventListener('click', () => {
  const task = $('#studioTask').value || 'batch';
  delete studioOverrides[task];
  renderPromptStudio();
  markDirty();
  setStatus(`Đã khôi phục prompt mặc định cho "${task}" — nhớ bấm Lưu cài đặt`);
});

window.addEventListener('beforeunload', event => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

$('#refreshDeeplUsage').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await renderDeeplUsage();
  } finally {
    button.disabled = false;
  }
});

$('#tplSave').addEventListener('click', () => saveTemplateForm().catch(error => setStatus(error.message, true)));
$('#tplCancel').addEventListener('click', resetTemplateForm);
$('#glossarySearch')?.addEventListener('input', (event) => {
  glossaryQuery = event.target.value;
  renderGlossary();
});
$('#glossaryAdd').addEventListener('click', () => addGlossaryEntry().catch(error => setStatus(error.message, true)));
$('#glossaryTarget').addEventListener('keydown', event => {
  if (event.key === 'Enter') addGlossaryEntry().catch(error => setStatus(error.message, true));
});
$('#glossaryImport').addEventListener('click', () => $('#glossaryFile').click());
$('#glossaryFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) await importGlossaryFile(file).catch(error => setStatus(error.message, true));
});
$('#glossaryExportJson').addEventListener('click', () => exportGlossary('json'));
$('#glossaryExportCsv').addEventListener('click', () => exportGlossary('csv'));
$('#ttsRate').addEventListener('input', () => { $('#ttsRateValue').textContent = $('#ttsRate').value; });

for (const control of document.querySelectorAll('.tabpanel input, .tabpanel select, .tabpanel textarea')) {
  if (control.type === 'file' || control.dataset.noDirty === 'true') continue;
  if (['universalKeyInput', 'providerSearch', 'glossarySearch', 'studioTask', 'tplName', 'tplPrompt', 'glossarySource', 'glossaryTarget'].includes(control.id)) {
    continue;
  }
  control.addEventListener('change', markDirty);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || dirty) return;
  Promise.all([loadConfig(), loadPrefs()])
    .then(() => {
      $('#tone').value = config.tone;
      renderRoutingStrategy();
      renderPresetBar();
      renderPreferredSelect();
      renderProviders();
      refreshKeyPoolHealth();
      markClean();
    })
    .catch(() => {});
});

(async () => {
  try {
    $('#versionPill').textContent = `v${chrome.runtime.getManifest().version}`;
    $('#brandLogo').innerHTML = brandLogo(32);
    globalThis.NPT_ICONS.hydrate();
    const hash = location.hash.replace('#', '');
    if (hash && document.querySelector(`#sidebarNav .tab[data-tab="${CSS.escape(hash)}"]`)) {
      selectTab(hash);
    }

    await loadConfig();
    $('#tone').value = config.tone;
    renderRoutingStrategy();
    renderPresetBar();
    renderPreferredSelect();
    renderProviders();
    await loadPrefs();
    await loadTemplates();
    await loadGlossary();
    markClean();
    document.body.dataset.ready = 'true';
    renderDeeplUsage();
    refreshCacheStats();
    refreshKeyPoolHealth();
  } catch (error) {
    document.body.dataset.ready = 'true';
    setStatus(error.message, true);
  }
})();
