/* ========================================================================
 * NPT Providers — định nghĩa các nhà cung cấp dịch thuật + xoay vòng API key.
 * File này là JS thuần (không dùng chrome.*) nên chạy được trong:
 *   - service worker (background.js qua importScripts)
 *   - trang options/popup (thẻ <script>)
 *   - node (để chạy test)
 * ====================================================================== */
(function attachProviders(global) {
  'use strict';

  // Module sinh & chuẩn hóa System Prompt tách riêng tại prompts.js (nạp trước providers.js).
  const PROMPTS = global.NPT_PROMPTS || (typeof require === 'function' ? require('./prompts.js') : null);
  if (!PROMPTS) {
    throw new Error('NPT_PROMPTS (prompts.js) phải được nạp trước providers.js');
  }

  const {
    TONES,
    SYSTEM_PROMPT_OVERRIDE_KEY,
    PROMPT_STUDIO_TASKS,
    CASUAL_REWRITES,
    PAGE_STYLES,
    PAGE_DIALECTS,
    PAGE_MODE_LITERAL_INSTRUCTION,
    PAGE_GRAMMAR_FIX_INSTRUCTION,
    PAGE_KEEP_PROPER_NOUNS_INSTRUCTION,
    DEFAULT_PAGE_OPTIONS,
    SUMMARY_TARGET,
    VISION_TARGET,
    buildNativeInstructions,
    buildPrompt,
    humanizeCasual,
    normalizePageContext,
    normalizePageOptions,
    normalizeSystemPromptOverrides,
    buildBatchInstructions,
    clampSummaryBullets,
    buildSummaryInstructions,
    buildQaInstructions,
    buildVisionInstructions,
    buildOcrVisionInstructions,
  } = PROMPTS;

  const CONFIG_STORAGE_KEY = 'tm-multi-provider-config';
  const PROVIDER_ORDER = ['deepl', 'gemini', 'openai', 'deploy'];
  const PRESET_ORDER = [
    'anthropic',
    'groq',
    'openrouter',
    'cerebras',
    'deepseek',
    'xai',
    'mistral',
    'together',
    'fireworks',
    'perplexity',
    'siliconflow',
    'cohere',
  ];
  const ROUTING_STRATEGIES = ['failover', 'round-robin', 'smart-stripe'];

  const PROVIDER_DEFS = {
    deepl: {
      id: 'deepl',
      label: 'DeepL',
      keyPlaceholder: 'VD: xxxxxxxx-xxxx:fx (free) hoặc key Pro',
      needsModel: false,
      needsUrl: false,
      site: 'https://www.deepl.com/pro-api',
      endpointFor(key) {
        // Key free của DeepL kết thúc bằng ":fx".
        return /:fx\s*$/i.test(String(key || ''))
          ? 'https://api-free.deepl.com/v2/translate'
          : 'https://api.deepl.com/v2/translate';
      },
    },
    gemini: {
      id: 'gemini',
      label: 'Google AI Studio (Gemini)',
      keyPlaceholder: 'Key chuẩn bắt đầu bằng AIza... (key dạng AQ. bị Google giới hạn)',
      needsModel: true,
      needsUrl: false,
      defaultModel: 'gemini-3.5-flash-lite',
      suggestedModels: [
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
      ],
      supportsVision: true,
      site: 'https://aistudio.google.com/apikey',
    },
    openai: {
      id: 'openai',
      label: 'OpenAI-compatible (tùy chỉnh)',
      keyPlaceholder: 'Key nếu API yêu cầu (có thể để trống với API free)',
      needsModel: true,
      needsUrl: true,
      defaultModel: 'gpt-4o-mini',
      defaultUrl: 'https://api.openai.com/v1/chat/completions',
      suggestedModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'],
    },
    deploy: {
      id: 'deploy',
      label: 'Deploy.com API',
      keyPlaceholder: 'Token API deploy.com (dán nguyên chuỗi, giữ cả dấu "==")',
      needsModel: true,
      needsUrl: false,
      defaultModel: 'deepseek-ai/deepseek-v4.1-flash-1017',
      suggestedModels: [
        'deepseek-ai/deepseek-v4.1-flash-1017',
        'zai-org/glm-5.3-flash',
      ],
      supportsVision: true,
      site: 'https://deploy.com',
    },
    anthropic: {
      id: 'anthropic',
      label: 'Anthropic Claude',
      keyPlaceholder: 'Key Claude bắt đầu bằng sk-ant-...',
      needsModel: true,
      needsUrl: false,
      defaultModel: 'claude-haiku-4-5',
      suggestedModels: [
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'claude-3-7-sonnet-latest',
      ],
      supportsVision: true,
      site: 'https://console.anthropic.com/settings/keys',
    },
  };

  /* ------------------------------------------------------------------
   * Danh mục 12 nhà cung cấp Preset 1-Click (v5.0).
   * Mỗi preset có URL, model gợi ý và prefix key chuẩn — người dùng chỉ cần
   * dán key (hoặc dán lẫn nhiều hãng vào ô đa năng) là tự kích hoạt ngay.
   * ------------------------------------------------------------------ */
  const PROVIDER_PRESETS = {
    anthropic: {
      id: 'anthropic',
      kind: 'anthropic',
      label: 'Anthropic Claude',
      keyPlaceholder: 'Key Claude bắt đầu bằng sk-ant-...',
      needsModel: true,
      needsUrl: false,
      defaultUrl: 'https://api.anthropic.com/v1/messages',
      defaultModel: 'claude-haiku-4-5',
      suggestedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest'],
      supportsVision: true,
      badgeTag: 'Vision + Lý luận',
      site: 'https://console.anthropic.com/settings/keys',
    },
    groq: {
      id: 'groq',
      kind: 'openai',
      label: 'Groq Cloud',
      keyPlaceholder: 'Key Groq bắt đầu bằng gsk_...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.groq.com/openai/v1/chat/completions',
      defaultModel: 'llama-3.3-70b-versatile',
      suggestedModels: ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b'],
      badgeTag: 'Siêu tốc',
      site: 'https://console.groq.com/keys',
    },
    openrouter: {
      id: 'openrouter',
      kind: 'openai',
      label: 'OpenRouter',
      keyPlaceholder: 'Key OpenRouter bắt đầu bằng sk-or-v1-...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://openrouter.ai/api/v1/chat/completions',
      defaultModel: 'google/gemini-2.5-flash',
      suggestedModels: ['google/gemini-2.5-flash', 'deepseek/deepseek-chat-v3-0324', 'anthropic/claude-3.7-sonnet', 'openai/gpt-4.1-mini'],
      supportsVision: true,
      badgeTag: 'Đa model + Vision',
      site: 'https://openrouter.ai/keys',
    },
    cerebras: {
      id: 'cerebras',
      kind: 'openai',
      label: 'Cerebras Inference',
      keyPlaceholder: 'Key Cerebras bắt đầu bằng csk-...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.cerebras.ai/v1/chat/completions',
      defaultModel: 'llama-3.3-70b',
      suggestedModels: ['llama-3.3-70b', 'qwen-3-32b'],
      badgeTag: 'Siêu tốc',
      site: 'https://cloud.cerebras.ai/',
    },
    deepseek: {
      id: 'deepseek',
      kind: 'openai',
      label: 'DeepSeek Official',
      keyPlaceholder: 'Key DeepSeek bắt đầu bằng sk-...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.deepseek.com/chat/completions',
      defaultModel: 'deepseek-chat',
      suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
      badgeTag: 'Giá rẻ + Chuẩn',
      site: 'https://platform.deepseek.com/api_keys',
    },
    xai: {
      id: 'xai',
      kind: 'openai',
      label: 'xAI (Grok)',
      keyPlaceholder: 'Key xAI bắt đầu bằng xai-...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.x.ai/v1/chat/completions',
      defaultModel: 'grok-3-mini',
      suggestedModels: ['grok-3-mini', 'grok-3'],
      site: 'https://console.x.ai/',
    },
    mistral: {
      id: 'mistral',
      kind: 'openai',
      label: 'Mistral AI',
      keyPlaceholder: 'API key từ La Plateforme (console.mistral.ai)',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.mistral.ai/v1/chat/completions',
      defaultModel: 'mistral-small-latest',
      suggestedModels: ['mistral-small-latest', 'mistral-large-latest'],
      site: 'https://console.mistral.ai/api-keys',
    },
    together: {
      id: 'together',
      kind: 'openai',
      label: 'Together AI',
      keyPlaceholder: 'Key Together bắt đầu bằng tgp_v1_... hoặc hex key',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.together.xyz/v1/chat/completions',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      suggestedModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
      site: 'https://api.together.ai/settings/api-keys',
    },
    fireworks: {
      id: 'fireworks',
      kind: 'openai',
      label: 'Fireworks AI',
      keyPlaceholder: 'Key Fireworks bắt đầu bằng fw_...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
      defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      suggestedModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
      site: 'https://fireworks.ai/account/api-keys',
    },
    perplexity: {
      id: 'perplexity',
      kind: 'openai',
      label: 'Perplexity',
      keyPlaceholder: 'Key Perplexity bắt đầu bằng pplx-...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.perplexity.ai/chat/completions',
      defaultModel: 'sonar',
      suggestedModels: ['sonar', 'sonar-pro'],
      badgeTag: 'Tìm kiếm Web',
      site: 'https://www.perplexity.ai/settings/api',
    },
    siliconflow: {
      id: 'siliconflow',
      kind: 'openai',
      label: 'SiliconFlow',
      keyPlaceholder: 'Key SiliconFlow bắt đầu bằng sk-...',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.siliconflow.cn/v1/chat/completions',
      defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
      suggestedModels: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
      site: 'https://cloud.siliconflow.cn/account/ak',
    },
    cohere: {
      id: 'cohere',
      kind: 'openai',
      label: 'Cohere Compatibility',
      keyPlaceholder: 'API key từ dashboard.cohere.com',
      needsModel: true,
      needsUrl: true,
      defaultUrl: 'https://api.cohere.com/compatibility/v1/chat/completions',
      defaultModel: 'command-a-03-2025',
      suggestedModels: ['command-a-03-2025', 'command-r-plus-08-2024'],
      site: 'https://dashboard.cohere.com/api-keys',
    },
  };

  // Nguồn origin mặc định duy nhất dùng chung giữa background.js và options.js.
  const BUILTIN_ORIGINS = [...new Set([
    'https://translate.googleapis.com',
    'https://translate.google.com',
    'https://api.mymemory.translated.net',
    'https://api.openai.com',
    'https://generativelanguage.googleapis.com',
    'https://api-free.deepl.com',
    'https://api.deepl.com',
    'https://api-sf1-cdn.deploy.com',
    'https://api.anthropic.com',
    ...Object.values(PROVIDER_PRESETS)
      .map(preset => {
        try { return preset.defaultUrl ? new URL(preset.defaultUrl).origin : ''; }
        catch (_) { return ''; }
      })
      .filter(Boolean),
  ])];

  /* ------------------------------------------------------------------
   * Deploy.com API — endpoint OpenAI-compatible, model dạng vendor/model.
   * Khác biệt so với slot 'openai' tự nhập:
   *  - URL cố định (chỉ override khi người dùng ghi đè provider.url)
   *  - luôn gửi reasoning_effort, mặc định 'max' (suy luận sâu nhất)
   *  - đọc được ảnh (image_url dạng data URL) nên dùng được cho dịch ảnh/OCR
   * ------------------------------------------------------------------ */
  const DEPLOY_API_BASE = 'https://api-sf1-cdn.deploy.com/api/v1';
  const DEPLOY_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  // Giải bài / câu hỏi khó: suy luận sâu nhất.
  const DEPLOY_DEFAULT_REASONING = 'max';
  /* Dịch trang / dịch ảnh / OCR / tóm tắt: 'none'. Đo thật trên API cho thấy
   * 'max' ở các việc này chậm 5-8x (12.5s vs 1.6s cho 6 câu) mà bản dịch không
   * khá hơn, còn bounding box ảnh lệch NHIỀU hơn (sai số TB 63-84 vs 36-41). */
  const DEPLOY_TRANSLATE_REASONING = 'none';

  function deployEndpoint(providerConfig) {
    const override = String(providerConfig?.url || '').trim();
    return override || `${DEPLOY_API_BASE}/chat/completions`;
  }

  // Mức suy luận cho giải bài: override của caller > cấu hình > 'max'.
  function deployReasoningEffort(providerConfig, override) {
    const wanted = String(override || '').trim().toLowerCase();
    if (DEPLOY_REASONING_EFFORTS.includes(wanted)) return wanted;
    const configured = String(providerConfig?.reasoningEffort || '').trim().toLowerCase();
    return DEPLOY_REASONING_EFFORTS.includes(configured) ? configured : DEPLOY_DEFAULT_REASONING;
  }

  // Mức suy luận cho dịch/OCR: cấu hình riêng, mặc định 'none' cho nhanh.
  function deployTranslateReasoning(providerConfig) {
    const configured = String(providerConfig?.translateReasoningEffort || '').trim().toLowerCase();
    return DEPLOY_REASONING_EFFORTS.includes(configured) ? configured : DEPLOY_TRANSLATE_REASONING;
  }

  // Content dạng chat: ảnh đi kèm thành part image_url (data URL base64).
  function chatUserContent(prompt, image) {
    if (!image?.imageBase64) return prompt;
    return [
      { type: 'text', text: String(prompt || '') },
      {
        type: 'image_url',
        image_url: { url: `data:${image.mimeType || 'image/png'};base64,${image.imageBase64}` },
      },
    ];
  }

  function supportsVision(id, providerConfig) {
    const kind = providerKind(id);
    if (kind === 'gemini' || kind === 'deploy' || kind === 'anthropic') return true;
    if (PROVIDER_PRESETS[id]?.supportsVision) return true;
    return Boolean(providerConfig?.supportsVision);
  }

  // Provider đọc được ảnh: Gemini (inline_data), Deploy (image_url), Anthropic (base64), OpenRouter.
  function visionProviderIds(config) {
    return providerIdsOf(config).filter(id => {
      const provider = config?.providers?.[id];
      if (!provider?.enabled || !activeKeysOf(provider).length) return false;
      return supportsVision(id, provider);
    });
  }

  /* ------------------------------------------------------------------
   * Nhiều endpoint OpenAI-compatible + 12 Preset chạy song song.
   * ------------------------------------------------------------------ */
  const CUSTOM_PROVIDER_RE = /^openai-(\d+)$/;
  const MAX_CUSTOM_PROVIDERS = 20;

  function isPresetProvider(id) {
    return Boolean(PROVIDER_PRESETS[String(id || '')]);
  }

  function isCustomProvider(id) {
    return CUSTOM_PROVIDER_RE.test(String(id || ''));
  }

  function providerKind(id) {
    const raw = String(id || '');
    if (isPresetProvider(raw)) return PROVIDER_PRESETS[raw].kind;
    return isCustomProvider(raw) ? 'openai' : raw;
  }

  function providerDefOf(id) {
    const raw = String(id || '');
    if (PROVIDER_PRESETS[raw]) return PROVIDER_PRESETS[raw];
    return PROVIDER_DEFS[providerKind(raw)] || null;
  }

  // Tên hiển thị: đặt tên tùy chỉnh -> tên preset / label gốc / đánh số slot custom.
  function providerLabelOf(id, providerConfig) {
    const name = String(providerConfig?.name || '').trim();
    if (name) return name;
    const raw = String(id || '');
    if (PROVIDER_PRESETS[raw]) return PROVIDER_PRESETS[raw].label;
    const custom = CUSTOM_PROVIDER_RE.exec(raw);
    if (custom) return `API tùy chỉnh ${custom[1]}`;
    return providerDefOf(raw)?.label || raw;
  }

  function presetProviderIds(source) {
    return PRESET_ORDER.filter(id => Boolean(source?.providers?.[id]));
  }

  // Thứ tự hiển thị: 4 provider gốc -> preset đã thêm -> slot tùy chỉnh theo số.
  function customProviderIds(source) {
    return Object.keys(source?.providers || {})
      .filter(isCustomProvider)
      .sort((a, b) => Number(CUSTOM_PROVIDER_RE.exec(a)[1]) - Number(CUSTOM_PROVIDER_RE.exec(b)[1]))
      .slice(0, MAX_CUSTOM_PROVIDERS);
  }

  function providerIdsOf(config) {
    return [...PROVIDER_ORDER, ...presetProviderIds(config), ...customProviderIds(config)];
  }

  // Id còn trống cho slot tùy chỉnh mới ('' nếu đã kịch trần).
  function nextCustomProviderId(config) {
    const used = new Set(Object.keys(config?.providers || {}));
    for (let index = 2; index <= MAX_CUSTOM_PROVIDERS + 1; index++) {
      const id = `openai-${index}`;
      if (!used.has(id)) return id;
    }
    return '';
  }

  /* ------------------------------------------------------------------
   * Ngôn ngữ đích của dịch trang: chỉ VI/EN.
   *  - deepl:       mã target_lang của DeepL
   *  - englishName: tên tiếng Anh đưa vào prompt LLM
   * ------------------------------------------------------------------ */
  const BATCH_TARGET = {
    vi: { deepl: 'VI', englishName: 'Vietnamese' },
    en: { deepl: 'EN-US', englishName: 'English' },
  };

  function findBatchTarget(code) {
    return BATCH_TARGET[String(code || '').toLowerCase()] || null;
  }

  // Tắt mọi bộ lọc an toàn của Gemini: dịch chat có slang/tục không bị chặn.
  const GEMINI_SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  ];

  // Cấu hình generation cho Gemini: temperature thấp (0.1) cho dịch thuật chuẩn xác.
  // Thinking chỉ bật/tắt đúng cú pháp theo từng thế hệ model để tránh lỗi HTTP 400 INVALID_ARGUMENT:
  // - Dòng 3.x (Gemini 3): dùng thinkingLevel: 'low' (dòng 3 không hỗ trợ thinkingBudget).
  // - Dòng 2.5: dùng thinkingBudget: 0 để tắt reasoning.
  // - Dòng 1.5, 2.0 hoặc model khác: không gửi thinkingConfig (Google API sẽ từ chối nếu gửi).
  function buildGeminiGenerationConfig(model, temperature = 0.1) {
    const config = { temperature };
    const m = String(model || '').toLowerCase();
    if (/3\./.test(m) || /gemini-3/.test(m)) {
      config.thinkingConfig = { thinkingLevel: 'low' };
    } else if (/2\.5/.test(m)) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }
    return config;
  }


  /* ------------------------------------------------------------------
   * Cấu hình lưu trong chrome.storage.local (xóa extension là mất hết).
   * {
   *   preferred: 'deepl',
   *   providers: {
   *     deepl:  { enabled: true,  keys: [{ key, label }] },
   *     gemini: { enabled: true,  keys: [], model },
   *     openai: { enabled: false, keys: [], model, url, format },
   *   }
   * }
   * ------------------------------------------------------------------ */

  function emptyProviderConfig(id) {
    const def = providerDefOf(id);
    return {
      enabled: false,
      keys: [],
      // Chỉ kiểu OpenAI-compatible mới cần tên riêng: có nhiều slot cùng kiểu.
      ...(def.needsUrl ? { name: isPresetProvider(id) ? def.label : '' } : {}),
      ...(def.needsModel ? { model: def.defaultModel } : {}),
      ...(providerKind(id) === 'gemini' ? { googleSearch: true, extendedThinking: false } : {}),
      // Deploy: mặc định suy luận sâu nhất (đọc được ảnh qua image_url).
      ...(providerKind(id) === 'deploy' ? {
        reasoningEffort: DEPLOY_DEFAULT_REASONING,
        translateReasoningEffort: DEPLOY_TRANSLATE_REASONING,
      } : {}),
      ...(def.needsUrl ? { url: def.defaultUrl, format: 'auto' } : {}),
    };
  }

  /* ------------------------------------------------------------------
   * Nhập key theo lô.
   *
   * Ngưởi dùng thường có cả chục key và dán một lượt, từ đủ kiểu nguồn:
   * mỗi dòng một key, ngăn bằng dấu phẩy, mảng JSON copy từ code, danh
   * sách có số thứ tự, dòng .env kiểu GEMINI_API_KEY=..., kèm chú thích
   * trong ngoặc. Ô nhập cũ lấy NGUYÊN chuỗi làm MỘT key nên dán nhiều key
   * là hỏng sạch — thêm được đúng một "key" rác rồi provider từ chối hết.
   * parseKeysInput() bóc mọi dạng đó ra danh sách key sạch, đã lọc trùng.
   * ------------------------------------------------------------------ */

  const MIN_KEY_LENGTH = 6;
  // Ký tự có thể có trong API key thật: chữ, số và - _ . : + / = ~
  const KEY_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+/=~-]*$/;
  // Chữ hay bị dán kèm quanh key — chắc chắn không phải key.
  const KEY_NOISE = new Set([
    'key', 'keys', 'api', 'apikey', 'api-key', 'api_key', 'token', 'secret',
    'null', 'undefined', 'none', 'true', 'false', 'your-api-key', 'your_api_key',
  ]);
  // Nhãn lấy từ dòng .env (GEMINI_API_KEY=...) chỉ là tên biến — không đáng lưu.
  const LABEL_NOISE_RE = /^[A-Z0-9_]+$|\b(?:api|key|token|secret)\b/i;

  // Bóc dấu nháy / ngoặc / cú pháp JSON bọc ngoài và dấu câu cuối mẩu.
  function stripKeyWrappers(token) {
    let value = String(token || '').trim();
    for (let round = 0; round < 5; round++) {
      const before = value;
      value = value
        .replace(/^[\s"'`<([{«‹]+/, '')
        .replace(/[\s"'`>)\]}»›,;]+$/, '')
        .trim();
      if (value === before) break;
    }
    return value;
  }

  // Nhận key rộng tay: chỉ loại những mẩu chắc chắn không phải key.
  function looksLikeKey(value) {
    const key = String(value || '');
    if (key.length < MIN_KEY_LENGTH) return false;
    if (KEY_NOISE.has(key.toLowerCase())) return false;
    if (key.includes('://')) return false;                   // URL dán kèm
    if (/^\d+$/.test(key) && key.length < 12) return false;  // số thứ tự / quota
    return KEY_CHARS_RE.test(key);
  }

  /* Phần đứng trước dấu "=" hoặc ":" chỉ được coi là NHÃN khi nó trông như
   * nhãn thật: có khoảng trắng ("acc 2"), là tên biến .env (GEMINI_API_KEY),
   * hoặc là một từ ngắn ("acc", "key3"). Key DeepL "uuid:fx" hay key base64
   * có "=" ở giữa vì vậy không bị cắt mất đầu. */
  function looksLikeKeyLabel(name) {
    if (/\s/.test(name)) return true;
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return true;
    return /^[A-Za-z]{1,12}\d{0,3}$/.test(name);
  }

  function keyTokensOf(text) {
    return String(text).split(/[\s,;|]+/).map(stripKeyWrappers).filter(Boolean);
  }

  // Tiền tố key quen mặt của các provider phổ biến.
  const KEY_PREFIX_RE = /AIza|AQ\.|sk-ant-|sk-or-|sk-|gsk_|csk-|xai-|hf_|ya29\.|pplx-|fw_|tgp_/g;
  // Một key thật ngắn nhất trong các dạng dưới đây vẫn dài hơn con số này.
  const MIN_RUN_PIECE = 24;

  /* Dán nhiều key vào ô MỘT dòng (bản cũ) là mất hết newline: các key bị nối
   * liền thành một chuỗi dài, không còn dấu phân tách nào. Nếu thấy đuôi ":fx"
   * của DeepL lặp lại hoặc tiền tố key lặp lại thì cắt lại đúng chỗ. Chỉ làm
   * khi chuỗi dài gấp đôi một key bình thường và MỌI mảnh cắt ra đều đủ dài —
   * để không bao giờ xé một key thật thành hai. */
  function splitRunTogetherKeys(token) {
    if (token.length < 2 * MIN_RUN_PIECE + 12) return [token];

    const fxParts = token.split(/(?<=:fx)/i);
    if (fxParts.length > 1 && fxParts.every(part => part.length >= MIN_RUN_PIECE)) return fxParts;

    const marks = [...token.matchAll(KEY_PREFIX_RE)].map(match => match.index);
    if (marks.length < 2) return [token];
    const pieces = marks.map((start, index) => token.slice(start, marks[index + 1]));
    if (marks[0] > 0) pieces.unshift(token.slice(0, marks[0]));
    return pieces.every(piece => piece.length >= MIN_RUN_PIECE) ? pieces : [token];
  }

  // Bóc nhãn (nếu có) và các mẩu key của MỘT dòng.
  function splitKeyLine(line) {
    let text = String(line);
    let label = '';

    // Đầu dòng kiểu danh sách: "1. key", "2) key", "- key", "• key".
    text = text.replace(/^\s*(?:[-*•+>]+|\(?\d{1,3}[.)])\s+/, '');

    // Chú thích cuối dòng: "key # acc 2", "key // acc 2".
    const comment = /(?:^|\s)(?:#|\/\/)\s*([^\s#][^#]{0,59})$/.exec(text);
    if (comment) {
      label = comment[1].trim();
      text = text.slice(0, comment.index);
    }

    // Nhãn trong ngoặc cuối dòng: "key (tài khoản 2)".
    const paren = /\(([^()]{1,60})\)\s*$/.exec(text);
    if (paren) {
      label = label || paren[1].trim();
      text = text.slice(0, paren.index);
    }

    let tokens = keyTokensOf(text);

    /* Nhãn đứng trước: "acc 2 = key", "GEMINI_API_KEY: key". Chỉ nhận khi
     * phần sau đủ dài, bắt đầu như một key thật ("https://..." không bị hiểu
     * là nhãn "https" + key) và cách hiểu đó KHÔNG làm mất key nào. */
    const prefixed = /^\s*([A-Za-z][\w .-]{0,31}?)\s*[=:]\s*(\S.*)$/.exec(text);
    const rest = prefixed ? stripKeyWrappers(prefixed[2]) : '';
    if (rest.length >= 12 && /^[A-Za-z0-9]/.test(rest) && looksLikeKeyLabel(prefixed[1].trim())) {
      const restTokens = keyTokensOf(prefixed[2]);
      if (restTokens.filter(looksLikeKey).length >= tokens.filter(looksLikeKey).length) {
        const name = prefixed[1].trim();
        if (!label && !LABEL_NOISE_RE.test(name)) label = name;
        tokens = restTokens;
      }
    }

    return { label: label.slice(0, 40), tokens };
  }

  /* Bóc key từ một chuỗi dán tự do. Trả về:
   *   entries    : [{ key, label }] theo đúng thứ tự dán, đã lọc trùng
   *   duplicates : số mẩu trùng (trùng nhau trong input hoặc trùng options.existing)
   *   invalid    : các mẩu không nhận ra được — để UI báo lại cho người dùng
   */
  function parseKeysInput(input, options = {}) {
    const existing = Array.isArray(options.existing) ? options.existing : [];
    const seen = new Set(existing
      .map(entry => String((typeof entry === 'string' ? entry : entry?.key) || '').trim())
      .filter(Boolean));

    const entries = [];
    const invalid = [];
    let duplicates = 0;

    const text = String(input || '')
      // Ký tự vô hình dán kèm từ web (ZWSP, BOM, soft hyphen) — xoá hẳn, nếu
      // đổi thành khoảng trắng thì một key thật lại bị xé làm hai mẩu rác.
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/[\u00a0\u2000-\u200a\u202f\u3000]/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"');

    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      const line = rawLine.trim();
      if (!line || /^(?:#|\/\/)/.test(line)) continue; // dòng trống / dòng chú thích

      const { label, tokens } = splitKeyLine(line);
      const found = [];
      for (const token of tokens.flatMap(splitRunTogetherKeys)) {
        if (!looksLikeKey(token)) {
          invalid.push(token.length > 28 ? `${token.slice(0, 28)}…` : token);
          continue;
        }
        if (seen.has(token)) {
          duplicates++;
          continue;
        }
        seen.add(token);
        found.push(token);
      }
      // Nhãn chỉ có nghĩa khi dòng đó cho đúng một key.
      for (const key of found) entries.push({ key, label: found.length === 1 ? label : '' });
    }

    return { entries, duplicates, invalid };
  }

  /* Đoán key thuộc KIỂU provider nào, để dán một mớ key trộn lẫn của nhiều
   * nhà cung cấp là tự chia về đúng thẻ. Chỉ trả lời khi chắc chắn — key lạ
   * (API tự host, proxy) trả '' và được giữ nguyên ở chỗ người dùng đang dán.
   *   AIza… / AQ.…            -> gemini
   *   uuid hoặc uuid:fx       -> deepl
   *   sk-… gsk_… xai-… hf_…   -> openai (OpenAI, OpenRouter, Groq, xAI, HF)
   */
  function detectProviderForKey(key) {
    const value = String(key || '').trim();
    if (!value) return '';
    if (/^AIza[\w-]{10,}$/.test(value) || /^AQ\./.test(value)) return 'gemini';
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?::[a-z]{2})?$/i.test(value)) return 'deepl';
    if (/^sk-ant-[\w-]{10,}$/i.test(value)) return 'anthropic';
    if (/^(?:sk|gsk|xai|hf|or|pk|csk|pplx|fw|tgp)[-_]/i.test(value)) return 'openai';
    // Token deploy.com là base64 thô kết thúc bằng "==" (vd: AbCdEfGhIjKlMnOpQrStUv==).
    if (/^[A-Za-z0-9+/]{16,}={2}$/.test(value) && value.length % 4 === 0) return 'deploy';
    return '';
  }

  /* Định tuyến chi tiết từng preset cho Dashboard / Universal Key Dropzone. */
  function detectPresetForKey(key) {
    const value = String(key || '').trim();
    if (!value) return '';
    if (/^AIza[\w-]{10,}$/.test(value) || /^AQ\./.test(value)) return 'gemini';
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?::[a-z]{2})?$/i.test(value)) return 'deepl';
    if (/^sk-ant-[\w-]{10,}$/i.test(value)) return 'anthropic';
    if (/^sk-or-[\w-]{10,}$/i.test(value)) return 'openrouter';
    if (/^gsk_[\w-]{10,}$/i.test(value)) return 'groq';
    if (/^csk-[\w-]{10,}$/i.test(value)) return 'cerebras';
    if (/^xai-[\w-]{10,}$/i.test(value)) return 'xai';
    if (/^pplx-[\w-]{10,}$/i.test(value)) return 'perplexity';
    if (/^fw_[\w-]{10,}$/i.test(value)) return 'fireworks';
    if (/^tgp_(?:v\d+_)?[\w-]{10,}$/i.test(value)) return 'together';
    if (/^[A-Za-z0-9+/]{16,}={2}$/.test(value) && value.length % 4 === 0) return 'deploy';
    if (/^(?:sk|hf|or|pk)[-_]/i.test(value)) return 'openai';
    return '';
  }

  /* Cảnh báo mềm khi key trông sai định dạng của provider. */
  function keyFormatWarning(providerId, key) {
    const value = String(key || '');
    if (providerKind(providerId) === 'gemini' && !value.startsWith('AIza')) {
      return 'Key Gemini chuẩn bắt đầu bằng "AIza". Key dạng "AQ." là key bị Google giới hạn — Gemini API sẽ từ chối. Hãy tạo key "AIza" bằng project/tài khoản Google khác, hoặc tạo trong Google Cloud Console.';
    }
    if (providerId === 'anthropic' && !value.startsWith('sk-ant-')) {
      return 'Key Anthropic Claude chuẩn thường bắt đầu bằng "sk-ant-".';
    }
    return '';
  }

  function activeKeysOf(providerConfig) {
    return (Array.isArray(providerConfig?.keys) ? providerConfig.keys : [])
      .filter(entry => entry && entry.key && entry.disabled !== true);
  }

  // Chấp nhận cả entry dạng chuỗi ("key") lẫn { key, label, disabled? }; chỉ giữ disabled khi true.
  function normalizeKeyList(list) {
    const seen = new Set();
    const entries = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const isText = typeof entry === 'string';
      const key = String((isText ? entry : entry?.key) || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const item = { key, label: String((isText ? '' : entry?.label) || '').trim() };
      if (!isText && entry?.disabled === true) item.disabled = true;
      entries.push(item);
    }
    return entries;
  }

  function normalizeConfig(raw) {
    const ids = [...PROVIDER_ORDER, ...presetProviderIds(raw), ...customProviderIds(raw)];
    const config = {
      preferred: ids.includes(raw?.preferred) ? raw.preferred : PROVIDER_ORDER[0],
      tone: TONES.includes(raw?.tone) ? raw.tone : 'natural',
      routingStrategy: ROUTING_STRATEGIES.includes(raw?.routingStrategy) ? raw.routingStrategy : 'failover',
      providers: {},
    };
    for (const id of ids) {
      const base = emptyProviderConfig(id);
      const incoming = raw?.providers?.[id] || {};
      const keys = typeof incoming.keys === 'string'
        ? parseKeysInput(incoming.keys).entries
        : incoming.keys;
      config.providers[id] = {
        ...base,
        ...incoming,
        enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : base.enabled,
        keys: normalizeKeyList(keys),
        ...(base.name !== undefined ? { name: String(incoming.name || base.name || '').trim().slice(0, 40) } : {}),
        ...(providerKind(id) === 'deploy' ? {
          reasoningEffort: deployReasoningEffort(incoming),
          translateReasoningEffort: deployTranslateReasoning(incoming),
        } : {}),
      };
    }
    return config;
  }

  function orderedProviderIds(config) {
    const all = providerIdsOf(config);
    const rest = all.filter(id => id !== config.preferred);
    return all.includes(config.preferred) ? [config.preferred, ...rest] : rest;
  }

  function usableProviders(config) {
    return orderedProviderIds(config).filter(id => {
      const provider = config.providers[id];
      if (!provider?.enabled) return false;
      const active = activeKeysOf(provider);
      // OpenAI-compatible gốc ('openai' và 'openai-N') cho phép không key nếu chưa nhập key nào (local API).
      if (providerKind(id) === 'openai' && !isPresetProvider(id)) {
        if (provider.keys.length === 0) return true;
        return active.length > 0;
      }
      return active.length > 0;
    });
  }

  function maskKey(key) {
    const value = String(key || '');
    if (value.length <= 6) return '••••';
    return `${value.slice(0, 3)}…${value.slice(-4)}`;
  }

  // Endpoint GET /v2/usage (xem quota) của DeepL: cùng host free/pro với /v2/translate.
  function deeplUsageEndpoint(key) {
    return PROVIDER_DEFS.deepl.endpointFor(key).replace(/\/v2\/translate$/, '/v2/usage');
  }

  // Phần định nghĩa & build prompt đã tách sang prompts.js (nạp vào biến local phía trên).

  /* ------------------------------------------------------------------
   * Dựng request theo từng provider.
   * Trả về { url, method, headers, body } — body là chuỗi JSON.
   * ------------------------------------------------------------------ */
  // Resolve url/model/format/headers cho OpenAI-compatible (dùng chung single + batch).
  function resolveOpenAIRequest(providerConfig, apiKey) {
    const url = String(providerConfig?.url || PROVIDER_DEFS.openai.defaultUrl).trim();
    const model = String(providerConfig?.model || PROVIDER_DEFS.openai.defaultModel).trim();
    let format = String(providerConfig?.format || 'auto').trim();
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch (_) { pathname = ''; }

    if (format === 'auto') {
      if (/\/responses\/?$/i.test(pathname)) format = 'responses';
      else if (/libretranslate|\/translate\/?$/i.test(url)) format = 'libre';
      else format = 'chat';
    }

    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return { url, model, format, headers };
  }

  // Multimodal (QA có ảnh / Vision / OCR) dùng chat/completions `image_url`;
  // nếu endpoint đang trỏ `/responses`, chuyển sang `/chat/completions` thay vì nuốt ảnh.
  function resolveOpenAIVisionRequest(providerConfig, apiKey) {
    const resolved = resolveOpenAIRequest(providerConfig, apiKey);
    if (resolved.format === 'libre' || resolved.format === 'generic') {
      throw new Error('IMAGE_NEEDS_VISION');
    }
    if (resolved.format === 'responses') {
      return {
        ...resolved,
        url: resolved.url.replace(/\/responses\/?$/i, '/chat/completions'),
        format: 'chat',
      };
    }
    return resolved;
  }

  /* Request Anthropic Claude (/v1/messages): hỗ trợ text, batch JSON, Vision ảnh base64. */
  function buildAnthropicRequest({ providerConfig, apiKey, system, prompt, image, maxTokens = 4096, temperature = 0.1, timeoutMs }) {
    const model = String(providerConfig?.model || PROVIDER_DEFS.anthropic.defaultModel).trim();
    const content = image?.imageBase64
      ? [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: String(image.mimeType || 'image/png'),
              data: String(image.imageBase64 || ''),
            },
          },
          { type: 'text', text: String(prompt || '') },
        ]
      : String(prompt || '');

    const payload = {
      model,
      max_tokens: Number.isFinite(maxTokens) ? maxTokens : 4096,
      messages: [{ role: 'user', content }],
    };
    if (system) payload.system = String(system);
    if (Number.isFinite(temperature)) payload.temperature = temperature;

    return {
      url: PROVIDER_PRESETS.anthropic.defaultUrl,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': String(apiKey || '').trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      ...(Number(timeoutMs) > 0 ? { timeout: Number(timeoutMs) } : {}),
    };
  }

  /* Request deploy.com: chat/completions + reasoning_effort + (tuỳ chọn) ảnh.
   * reasoning_effort LUÔN gửi để mức suy luận là hành vi mặc định thật, không
   * phụ thuộc việc server tự bật reasoning hay không (đo được: 'max' sinh
   * reasoning_tokens cao nhất, 'none' = 0).
   *
   * `mode` quyết định mức mặc định khi providerConfig không ghi đè:
   *   'translate' (dịch trang, dịch ảnh, OCR, tóm tắt) -> 'none'  (nhanh, chính xác hơn)
   *   'solve'     (Quick Solver)                        -> 'max'   (suy luận sâu nhất)
   *
   * KHÔNG gửi max_tokens trừ khi caller yêu cầu rõ: token suy luận bị tính
   * chung vào trần đó, nên trần thấp làm model nghĩ hết quota rồi trả content
   * RỖNG (đo thật: max_tokens 8000 -> 8001 reasoning, content rỗng; bỏ trần ->
   * cùng câu hỏi trả lời đầy đủ). Chặn thời gian bằng timeout thay vì trần token. */
  function buildDeployRequest({ providerConfig, apiKey, system, prompt, image, maxTokens, temperature, reasoningEffort, timeoutMs, mode }) {
    const model = String(providerConfig?.model || PROVIDER_DEFS.deploy.defaultModel).trim();
    const effort = String(mode || 'translate') === 'solve'
      ? deployReasoningEffort(providerConfig, reasoningEffort)
      : deployTranslateReasoning(providerConfig);
    const payload = {
      model,
      messages: [
        { role: 'system', content: String(system || '') },
        {
          role: 'user',
          content: image ? chatUserContent(prompt, image) : String(prompt || ''),
        },
      ],
      stream: false,
      reasoning_effort: effort,
    };
    if (Number.isFinite(maxTokens)) payload.max_tokens = maxTokens;
    if (Number.isFinite(temperature)) payload.temperature = temperature;

    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const token = String(apiKey || '').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    // Dịch dùng 'none' nên thường xong trong vài giây; vẫn giữ trần rộng để
    // người dùng chọn mức cao trong Cài đặt mà không bị cắt ngang.
    const defaultTimeout = String(mode || 'translate') === 'solve' ? 200000 : 120000;
    return {
      url: deployEndpoint(providerConfig),
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      openaiFormat: 'chat',
      timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : defaultTimeout,
    };
  }

  function buildRequest({ providerId, providerConfig, apiKey, source, context, tone, systemOverride }) {
    const kind = providerKind(providerId);
    const instructions = buildNativeInstructions(tone, systemOverride);
    const prompt = buildPrompt(source, context);

    if (kind === 'deepl') {
      return {
        url: PROVIDER_DEFS.deepl.endpointFor(apiKey),
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${apiKey}`,
        },
        body: JSON.stringify({
          text: [source],
          target_lang: 'EN-US',
        }),
      };
    }

    if (kind === 'gemini') {
      const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const model = rawModel.replace(/^models\//i, '');
      const generationConfig = buildGeminiGenerationConfig(model, 0.1);
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (kind === 'anthropic') {
      return buildAnthropicRequest({ providerConfig, apiKey, system: instructions, prompt, maxTokens: 1500, temperature: 0.1 });
    }

    if (kind === 'openai') {
      const { url, model, format, headers } = resolveOpenAIRequest(providerConfig, apiKey);

      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 900, store: false };
      } else if (format === 'libre') {
        payload = { q: source, source: 'vi', target: 'en', format: 'text' };
        if (apiKey) {
          delete headers.Authorization;
          payload.api_key = apiKey;
        }
      } else if (format === 'generic') {
        payload = {
          text: source, q: source, source: 'vi', target: 'en',
          source_language: 'vi', target_language: 'en', context, model,
        };
      } else {
        payload = {
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt },
          ],
          stream: false,
        };
      }

      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    if (kind === 'deploy') {
      return buildDeployRequest({ providerConfig, apiKey, system: instructions, prompt });
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  function extractPath(object, path) {
    return String(path || '').split('.').reduce((value, key) => value?.[key], object);
  }

  function extractOpenAIText(data, format) {
    if (format === 'responses') {
      if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
      const chunks = [];
      for (const item of data?.output || []) {
        for (const content of item?.content || []) {
          if (typeof content?.text === 'string') chunks.push(content.text);
        }
      }
      return chunks.join('').trim();
    }

    if (format === 'chat') {
      const value = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
      if (typeof value === 'string') return value.trim();
      if (Array.isArray(value)) {
        return value.map(part => (typeof part === 'string' ? part : part?.text || '')).join('').trim();
      }
      return '';
    }

    const candidates = [
      data?.translatedText,
      data?.translation,
      data?.text,
      data?.result,
      data?.responseData?.translatedText,
      extractPath(data, 'data.translatedText'),
      extractPath(data, 'data.translation'),
      extractPath(data, 'data.text'),
    ];
    return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || '';
  }

  /* ------------------------------------------------------------------
   * Phân loại kết quả HTTP:
   *  - ok:               có bản dịch
   *  - keyFailed:        key hỏng/hết quota -> thử key khác
   *  - providerFailed:   provider chết/request sai -> thử provider khác
   * ------------------------------------------------------------------ */
  // Status đáng thử lại NGAY trên cùng key: nghẽn tạm thời phía provider, không
  // phải lỗi key. Trước đây tất cả rơi vào 'providerFailed' nên một cú 503 chớp
  // nhoáng của Gemini là mất luôn provider cho request đó.
  const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
  const MAX_TRANSIENT_RETRIES = 2;
  const TRANSIENT_BACKOFF_MS = 800;
  const MAX_RETRY_AFTER_MS = 30 * 60 * 1000;

  // Retry-After: giây hoặc HTTP-date. Trả về ms, null nếu không đọc được.
  function parseRetryAfter(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return null;
    return Math.max(0, Math.min(when - Date.now(), MAX_RETRY_AFTER_MS));
  }

  // Phân loại lỗi theo HTTP status (dùng chung single + batch). 2xx -> null.
  function classifyHttpError({ providerId, providerLabel, status, bodyText, retryAfterMs }) {
    const def = { label: providerLabel || providerLabelOf(providerId) };

    if (status === 0) {
      return { kind: 'providerFailed', message: `${def.label}: lỗi mạng/timeout` };
    }

    if (status === 401 || status === 403) {
      return { kind: 'keyFailed', message: `${def.label}: key bị từ chối (HTTP ${status})`, cooldownMs: 30 * 60 * 1000 };
    }

    // DeepL 456 = cạn quota của cả CHU KỲ THANH TOÁN (thường là hết tháng).
    // Cooldown 2 phút như 429 nghĩa là cứ 2 phút lại đốt một request chắc chắn
    // hỏng cho tới hết tháng.
    if (status === 456) {
      return {
        kind: 'keyFailed',
        message: `${def.label}: đã dùng hết quota của chu kỳ (HTTP 456)`,
        cooldownMs: 6 * 60 * 60 * 1000,
      };
    }

    if (status === 429) {
      // Provider nói rõ chờ bao lâu thì nghe theo; kiểm tra cả header lẫn detail/message trong bodyText
      let retryMs = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : 0;
      if (!retryMs && bodyText) {
        try {
          const parsed = JSON.parse(bodyText);
          const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
          for (const d of details) {
            if (d?.retryDelay) {
              const m = String(d.retryDelay).match(/^([0-9.]+)\s*s/i);
              if (m) {
                retryMs = Math.round(parseFloat(m[1]) * 1000);
                break;
              }
            }
          }
          if (!retryMs && parsed?.error?.message) {
            const m = String(parsed.error.message).match(/retry\s+(?:after|in)\s+([0-9.]+)\s*s/i);
            if (m) {
              retryMs = Math.round(parseFloat(m[1]) * 1000);
            }
          }
        } catch (_) {}
      }
      const hinted = retryMs > 0 ? Math.min(retryMs, MAX_RETRY_AFTER_MS) : 0;
      const cooldownMs = hinted ? Math.max(5000, hinted) : 2 * 60 * 1000;
      return { kind: 'keyFailed', message: `${def.label}: bị giới hạn tốc độ (HTTP 429)`, cooldownMs };
    }

    if (TRANSIENT_STATUSES.has(status)) {
      return {
        kind: 'retry',
        message: `${def.label}: provider tạm lỗi (HTTP ${status})`,
        retryDelayMs: retryAfterMs || 0,
      };
    }

    if (status === 400 || status === 404 || status === 422) {
      let detail = '';
      try {
        const data = JSON.parse(bodyText || '{}');
        const violations = Array.isArray(data?.error?.details)
          ? data.error.details
              .flatMap(d => d?.fieldViolations || [])
              .filter(v => v?.description || v?.field)
              .map(v => `${v.field ? v.field + ': ' : ''}${v.description || ''}`.trim())
              .filter(Boolean)
              .join('; ')
          : '';
        detail = violations || data?.error?.message || data?.message || data?.detail || '';
      } catch (_) { /* bỏ qua */ }
      return {
        kind: 'providerFailed',
        message: `${def.label}: ${String(detail || `HTTP ${status}`).slice(0, 160)}`,
      };
    }

    if (status < 200 || status >= 300) {
      return { kind: 'providerFailed', message: `${def.label}: HTTP ${status}` };
    }

    return null;
  }

  function classifyResponse({ providerId, providerLabel, openaiFormat, status, bodyText, retryAfterMs }) {
    const kind = providerKind(providerId);
    const def = { label: providerLabel || providerLabelOf(providerId) };
    const httpError = classifyHttpError({ providerId, providerLabel: def.label, status, bodyText, retryAfterMs });
    if (httpError) return httpError;

    let data;
    try {
      data = JSON.parse(bodyText || '{}');
    } catch (_) {
      return { kind: 'providerFailed', message: `${def.label}: phản hồi không phải JSON` };
    }

    let text = '';
    if (kind === 'deepl') {
      text = String(data?.translations?.[0]?.text || '').trim();
    } else if (kind === 'gemini') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textChunks = [];
      for (const part of parts) {
        if (part?.text) {
          textChunks.push(part.text);
        } else if (part?.executableCode) {
          const lang = String(part.executableCode.language || 'python').toLowerCase();
          const code = String(part.executableCode.code || '').trim();
          textChunks.push(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
        } else if (part?.codeExecutionResult) {
          const output = String(part.codeExecutionResult.output || '').trim();
          const outcome = part.codeExecutionResult.outcome || '';
          const resultText = output || (outcome === 'OUTCOME_OK' ? '(Thực thi thành công không có output)' : '(Thực thi thất bại)');
          textChunks.push(`\n\n*Kết quả thực thi mã:*\n\`\`\`\n${resultText}\n\`\`\`\n\n`);
        }
      }
      text = textChunks.join('').trim();
    } else if (kind === 'anthropic') {
      text = Array.isArray(data?.content)
        ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim()
        : '';
    } else {
      text = extractOpenAIText(data, openaiFormat || 'chat');
    }

    if (!text) {
      // Reasoning model có thể nghĩ hết sạch trần token rồi trả content rỗng:
      // báo đúng nguyên nhân thay vì "không nhận diện được trường bản dịch".
      const truncated = data?.choices?.[0]?.finish_reason === 'length' || data?.stop_reason === 'max_tokens';
      return {
        kind: 'providerFailed',
        message: truncated
          ? `${def.label}: model nghĩ hết trần token nên không còn chỗ trả lời (tăng max_tokens hoặc giảm mức suy luận)`
          : `${def.label}: không nhận diện được trường bản dịch`,
      };
    }

    return { kind: 'ok', text };
  }

  // Các constant & builder cho batch instructions đã được tách sang prompts.js.

  function buildBatchRequest({ providerId, providerConfig, apiKey, texts, sourceLanguage, targetLanguage, pageOptions }) {
    const kind = providerKind(providerId);
    // Ngôn ngữ đích chỉ hỗ trợ VI/EN.
    const target = findBatchTarget(targetLanguage);
    if (!target) throw new Error('Ngôn ngữ đích không hỗ trợ');

    if (kind === 'deepl') {
      // DeepL hỗ trợ mảng text trong 1 request duy nhất.
      return {
        url: PROVIDER_DEFS.deepl.endpointFor(apiKey),
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${apiKey}`,
        },
        body: JSON.stringify({
          text: texts,
          target_lang: target.deepl,
        }),
      };
    }

    // pageOptions chỉ áp cho LLM; nhánh deepl ở trên đã return sớm.
    const instructions = buildBatchInstructions(sourceLanguage, target.englishName, pageOptions);
    const prompt = JSON.stringify(texts);

    if (kind === 'gemini') {
      const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const model = rawModel.replace(/^models\//i, '');
      const generationConfig = {
        ...buildGeminiGenerationConfig(model, 0.1),
        responseMimeType: 'application/json',
      };
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (kind === 'anthropic') {
      return buildAnthropicRequest({ providerConfig, apiKey, system: instructions, prompt, maxTokens: 4096, temperature: 0.1 });
    }

    if (kind === 'openai') {
      const { url, model, format, headers } = resolveOpenAIRequest(providerConfig, apiKey);

      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 4000, store: false };
      } else if (format === 'chat') {
        payload = {
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt },
          ],
          stream: false,
        };
      } else {
        // libre/generic không có schema batch JSON rõ ràng -> bỏ qua provider này.
        throw new Error(`${PROVIDER_DEFS.openai.label}: format "${format}" không hỗ trợ dịch batch`);
      }

      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    if (kind === 'deploy') {
      return buildDeployRequest({ providerConfig, apiKey, system: instructions, prompt });
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  // Parse khoan dung mảng JSON từ text model trả về (strip fence, unwrap object, cắt [ ... ]).
  function parseJsonArrayText(raw) {
    let text = String(raw || '').trim();
    if (!text) return null;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      const direct = JSON.parse(text);
      if (Array.isArray(direct)) return direct;
      if (direct && typeof direct === 'object') {
        const wrapped = direct.translations || direct.data || direct.result || direct.items;
        if (Array.isArray(wrapped)) return wrapped;
      }
    } catch (_) {
      // Rơi xuống cắt đoạn [...] nếu model chèn thêm lời dẫn.
    }
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  // Nhánh classify cho batch: lỗi HTTP dùng chung classifyHttpError,
  // body 2xx phải parse ra mảng bản dịch CÙNG ĐỘ DÀI với texts gửi đi.
  function classifyBatchResponse({ providerId, providerLabel, openaiFormat, status, bodyText, expectedLength, retryAfterMs }) {
    const kind = providerKind(providerId);
    const def = { label: providerLabel || providerLabelOf(providerId) };
    const httpError = classifyHttpError({ providerId, providerLabel: def.label, status, bodyText, retryAfterMs });
    if (httpError) return httpError;

    let data;
    try {
      data = JSON.parse(bodyText || '{}');
    } catch (_) {
      // LỖI PARSE (không phải HTTP): caller được retry 1 lần trên cùng key.
      return { kind: 'providerFailed', parseFailure: true, message: `${def.label}: phản hồi không phải JSON` };
    }

    let translations = null;
    if (kind === 'deepl') {
      if (Array.isArray(data?.translations)) {
        translations = data.translations.map(item => String(item?.text ?? ''));
      }
    } else {
      let text = '';
      if (kind === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        text = parts.map(part => part?.text || '').join('').trim();
      } else if (kind === 'anthropic') {
        text = Array.isArray(data?.content)
          ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim()
          : '';
      } else {
        text = extractOpenAIText(data, openaiFormat || 'chat');
      }
      const parsed = parseJsonArrayText(text);
      if (parsed) {
        translations = parsed.map(item => (typeof item === 'string' ? item : String(item ?? '')));
      }
    }

    if (!translations) {
      // LỖI PARSE mảng JSON của LLM: caller được retry 1 lần trên cùng key.
      return { kind: 'providerFailed', parseFailure: true, message: `${def.label}: không parse được mảng bản dịch` };
    }
    if (translations.length !== expectedLength) {
      return {
        kind: 'providerFailed',
        message: `${def.label}: số bản dịch (${translations.length}) không khớp số đoạn gửi (${expectedLength})`,
      };
    }

    return { kind: 'ok', translations };
  }

  /* ------------------------------------------------------------------
   * Multi-Key Engine (v5.0):
   *  - failover:     ưu tiên tuần tự theo provider, vẫn chọn key rảnh trước khi có nhiều luồng.
   *  - round-robin:  xoay đều toàn bộ pool key đang bật trên mọi provider.
   *  - smart-stripe: chấm điểm theo ưu tiên + inflight + độ trễ EMA + errorStreak
   *                  để tự động phân tải song song qua nhiều hãng & nhiều key cùng lúc.
   * ------------------------------------------------------------------ */
  function createKeyState() {
    return {
      cooldowns: new Map(),
      pointers: new Map(),
      metrics: new Map(),
      inflight: new Map(),
      globalPointer: 0,
      lastProviderId: '',
      nextDispatchTime: 0,
      onChange: null,
    };
  }

  function ensureKeyStateFields(state) {
    if (!state.cooldowns) state.cooldowns = new Map();
    if (!state.pointers) state.pointers = new Map();
    if (!state.metrics) state.metrics = new Map();
    if (!state.inflight) state.inflight = new Map();
    if (!Number.isFinite(state.globalPointer)) state.globalPointer = 0;
    return state;
  }

  function cooldownKey(providerId, key) {
    return `${providerId}${key}`;
  }

  // Mã băm FNV-1a 64-bit để lưu telemetry key trong chrome.storage.session mà không lộ key thô.
  function keyHashId(providerId, key) {
    const input = `${providerId}\u0000${key}`;
    let h1 = 0x811c9dc5;
    let h2 = 0xc2b2ae35;
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
  }

  function recordKeyMetric(state, cdKey, { ok, latencyMs, status, now }) {
    ensureKeyStateFields(state);
    const prev = state.metrics.get(cdKey) || {
      emaLatencyMs: 0,
      lastLatencyMs: 0,
      successCount: 0,
      errorCount: 0,
      errorStreak: 0,
      lastStatus: '',
      lastUsedAt: 0,
    };
    const lat = Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : prev.lastLatencyMs;
    const nextEma = ok
      ? (prev.emaLatencyMs > 0 ? Math.round(prev.emaLatencyMs * 0.65 + lat * 0.35) : lat)
      : prev.emaLatencyMs;

    state.metrics.set(cdKey, {
      emaLatencyMs: nextEma,
      lastLatencyMs: lat,
      successCount: prev.successCount + (ok ? 1 : 0),
      errorCount: prev.errorCount + (ok ? 0 : 1),
      errorStreak: ok ? 0 : Math.min(10, prev.errorStreak + 1),
      lastStatus: String(status || (ok ? 'ok' : 'error')).slice(0, 120),
      lastUsedAt: Number(now) || Date.now(),
    });
  }

  function exportKeyHealthSnapshot(config, keyState, now = Date.now()) {
    const state = ensureKeyStateFields(keyState || createKeyState());
    const cooldowns = {};
    const metrics = {};
    for (const id of providerIdsOf(config)) {
      const keys = config?.providers?.[id]?.keys || [];
      for (const entry of keys) {
        if (!entry?.key) continue;
        const cdKey = cooldownKey(id, entry.key);
        const hId = keyHashId(id, entry.key);
        const until = state.cooldowns.get(cdKey) || 0;
        if (until > now) cooldowns[hId] = until;
        const metric = state.metrics.get(cdKey);
        if (metric) metrics[hId] = metric;
      }
    }
    return { cooldowns, metrics, savedAt: now };
  }

  function hydrateKeyState(keyState, snapshot, config, now = Date.now()) {
    const state = ensureKeyStateFields(keyState || createKeyState());
    if (!snapshot || typeof snapshot !== 'object') return state;
    const cooldowns = snapshot.cooldowns || {};
    const metrics = snapshot.metrics || {};
    for (const id of providerIdsOf(config)) {
      const keys = config?.providers?.[id]?.keys || [];
      for (const entry of keys) {
        if (!entry?.key) continue;
        const cdKey = cooldownKey(id, entry.key);
        const hId = keyHashId(id, entry.key);
        if (Number(cooldowns[hId]) > now) state.cooldowns.set(cdKey, Number(cooldowns[hId]));
        if (metrics[hId] && typeof metrics[hId] === 'object') state.metrics.set(cdKey, metrics[hId]);
      }
    }
    return state;
  }

  function collectActivePool(config, providerId) {
    const providerConfig = config.providers[providerId];
    const active = activeKeysOf(providerConfig);
    if (active.length) return active;
    if (providerKind(providerId) === 'openai' && !isPresetProvider(providerId) && providerConfig.keys.length === 0) {
      return [{ key: '', label: '' }];
    }
    return [];
  }

  async function withKeyRotation({ config, keyState, now, sleep, attempt }) {
    const state = ensureKeyStateFields(keyState || createKeyState());
    const currentTime = now || (() => Date.now());
    const wait = sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));

    const providerIds = usableProviders(config);
    if (!providerIds.length) {
      throw new Error('NO_API_KEY');
    }

    const strategy = ROUTING_STRATEGIES.includes(config?.routingStrategy) ? config.routingStrategy : 'failover';
    const errors = [];
    const failedProviders = new Set();

    async function runSlot(slot) {
      const { providerId, providerConfig, providerLabel, entry, cdKey, poolLen, index } = slot;
      if (poolLen > 1) state.pointers.set(providerId, (index + 1) % poolLen);

      // Micro-staggering thông minh: cùng provider giãn 30ms chống 429 burst, khác provider giãn 10ms.
      const staggerMs = state.lastProviderId && state.lastProviderId !== providerId ? 10 : 30;
      state.lastProviderId = providerId;
      const nowTime = currentTime();
      const scheduledTime = Math.max(nowTime, state.nextDispatchTime || 0);
      state.nextDispatchTime = scheduledTime + staggerMs;
      const delayMs = scheduledTime - nowTime;
      if (delayMs > 0) await wait(delayMs);

      let verdict;
      let buildFailed = false;
      const startedAt = currentTime();
      state.inflight.set(cdKey, (state.inflight.get(cdKey) || 0) + 1);

      try {
        for (let transientAttempt = 0; ; transientAttempt++) {
          try {
            ({ verdict } = await attempt({ providerId, providerConfig, providerLabel, apiKey: entry.key }));
          } catch (error) {
            errors.push(`${providerLabel}: ${error?.message || error}`);
            buildFailed = true;
            break;
          }
          if (verdict.kind !== 'retry' || transientAttempt >= MAX_TRANSIENT_RETRIES) break;
          await wait(verdict.retryDelayMs || TRANSIENT_BACKOFF_MS * (transientAttempt + 1));
        }
      } finally {
        const left = (state.inflight.get(cdKey) || 1) - 1;
        if (left <= 0) state.inflight.delete(cdKey);
        else state.inflight.set(cdKey, left);
      }

      const elapsed = Math.max(0, currentTime() - startedAt);
      if (buildFailed) {
        recordKeyMetric(state, cdKey, { ok: false, latencyMs: elapsed, status: 'buildError', now: currentTime() });
        state.onChange?.();
        return { kind: 'providerFailed' };
      }
      if (verdict.kind === 'retry') {
        verdict = { kind: 'keyFailed', message: verdict.message, cooldownMs: 15000 };
      }

      if (verdict.kind === 'ok') {
        if (poolLen > 1) state.pointers.set(providerId, (index + 1) % poolLen);
        recordKeyMetric(state, cdKey, { ok: true, latencyMs: elapsed, status: 'ok', now: currentTime() });
        state.onChange?.();
        return {
          kind: 'ok',
          outcome: {
            verdict,
            provider: providerId,
            providerLabel,
            keyMasked: entry.key ? maskKey(entry.key) : '',
          },
        };
      }

      errors.push(entry.key ? `${verdict.message} [${maskKey(entry.key)}]` : verdict.message);
      recordKeyMetric(state, cdKey, { ok: false, latencyMs: elapsed, status: verdict.message, now: currentTime() });

      if (verdict.kind === 'keyFailed') {
        state.cooldowns.set(cdKey, currentTime() + (verdict.cooldownMs || 60000));
        state.onChange?.();
        return { kind: 'keyFailed' };
      }

      state.onChange?.();
      return { kind: 'providerFailed' };
    }

    if (strategy === 'smart-stripe' || strategy === 'round-robin') {
      const candidates = [];
      const ts = currentTime();
      for (const providerId of providerIds) {
        const providerConfig = config.providers[providerId];
        const providerLabel = providerLabelOf(providerId, providerConfig);
        const keyPool = collectActivePool(config, providerId);
        // Round-robin xoay vòng qua toàn pool bằng state.globalPointer, tránh xoay 2 lần với state.pointers.
        const startIdx = strategy === 'round-robin' ? 0 : (state.pointers.get(providerId) || 0);

        for (let offset = 0; offset < keyPool.length; offset++) {
          const index = (startIdx + offset) % keyPool.length;
          const entry = keyPool[index];
          const cdKey = cooldownKey(providerId, entry.key);
          if ((state.cooldowns.get(cdKey) || 0) > ts) continue;

          const metric = state.metrics.get(cdKey);
          const inflight = state.inflight.get(cdKey) || 0;
          const preferredBonus = providerId === config.preferred ? 90 : 0;
          const latencyPenalty = metric?.emaLatencyMs ? Math.min(400, metric.emaLatencyMs * 0.12) : 0;
          const streakPenalty = (metric?.errorStreak || 0) * 450;
          const score = preferredBonus - (inflight * 320) - latencyPenalty - streakPenalty - (offset * 4);

          candidates.push({
            providerId,
            providerConfig,
            providerLabel,
            entry,
            cdKey,
            poolLen: keyPool.length,
            index,
            score,
          });
        }
      }

      let ordered = candidates;
      if (strategy === 'smart-stripe') {
        ordered = [...candidates].sort((a, b) => b.score - a.score);
      } else if (candidates.length > 1) {
        const start = state.globalPointer % candidates.length;
        state.globalPointer = (state.globalPointer + 1) % candidates.length;
        ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
      }

      for (const slot of ordered) {
        if (failedProviders.has(slot.providerId)) continue;
        const step = await runSlot(slot);
        if (step.kind === 'ok') return step.outcome;
        if (step.kind === 'providerFailed') failedProviders.add(slot.providerId);
      }

      throw new Error(errors.length ? errors.join(' · ') : 'Tất cả provider đều thất bại');
    }

    // Chế độ failover cổ điển: ưu tiên hết provider đứng trước rồi mới sang provider kế.
    for (const providerId of providerIds) {
      const providerConfig = config.providers[providerId];
      const providerLabel = providerLabelOf(providerId, providerConfig);
      const keyPool = collectActivePool(config, providerId);
      const startIndex = state.pointers.get(providerId) || 0;
      const slots = [];
      const ts = currentTime();

      for (let offset = 0; offset < keyPool.length; offset++) {
        const index = (startIndex + offset) % keyPool.length;
        const entry = keyPool[index];
        const cdKey = cooldownKey(providerId, entry.key);
        if ((state.cooldowns.get(cdKey) || 0) > ts) continue;
        slots.push({
          providerId,
          providerConfig,
          providerLabel,
          entry,
          cdKey,
          poolLen: keyPool.length,
          index,
          inflight: state.inflight.get(cdKey) || 0,
          offset,
        });
      }

      // Khi 1 provider có nhiều key và đang chạy nhiều batch song song, ưu tiên key rảnh trước.
      slots.sort((a, b) => (a.inflight - b.inflight) || (a.offset - b.offset));

      for (const slot of slots) {
        const step = await runSlot(slot);
        if (step.kind === 'ok') return step.outcome;
        if (step.kind === 'providerFailed') break;
      }

      // Tránh bắn request dồn dập khi đổi provider.
      await wait(120);
    }

    throw new Error(errors.length ? errors.join(' · ') : 'Tất cả provider đều thất bại');
  }

  async function translateWithRotation({ config, source, context, fetchText, keyState, now, sleep, systemOverride }) {
    const text = String(source || '').trim();
    if (!text) throw new Error('Không có nội dung cần dịch');

    const outcome = await withKeyRotation({
      config,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const request = buildRequest({
          providerId,
          providerConfig,
          apiKey,
          source: text,
          context,
          tone: config.tone,
          systemOverride,
        });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId,
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });
        return { verdict };
      },
    });

    const finalText = config.tone === 'casual'
      ? humanizeCasual(outcome.verdict.text)
      : outcome.verdict.text;

    return {
      text: finalText,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
  }

  // Dịch batch (dịch cả trang): translations cùng độ dài/thứ tự với texts.
  // pageOptions (style/dialect/mode...) được truyền tiếp vào buildBatchRequest.
  async function translateBatchWithRotation({ config, texts, sourceLanguage, targetLanguage, fetchText, keyState, now, sleep, pageOptions }) {
    const list = Array.isArray(texts) ? texts.map(item => String(item ?? '')) : [];
    if (!list.length) throw new Error('Không có nội dung cần dịch');
    if (!findBatchTarget(targetLanguage)) throw new Error('Ngôn ngữ đích không hỗ trợ');

    const outcome = await withKeyRotation({
      config,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const request = buildBatchRequest({
          providerId,
          providerConfig,
          apiKey,
          texts: list,
          sourceLanguage,
          targetLanguage,
          pageOptions,
        });
        let retriedParse = false;
        for (;;) {
          const response = await fetchText(request);
          const verdict = classifyBatchResponse({
            providerId,
            providerLabel,
            openaiFormat: request?.openaiFormat,
            status: response.status,
            bodyText: response.bodyText,
            retryAfterMs: response.retryAfterMs,
            expectedLength: list.length,
          });
          if (verdict.kind === 'providerFailed' && verdict.parseFailure && !retriedParse) {
            retriedParse = true;
            continue;
          }
          return { verdict };
        }
      },
    });

    return {
      translations: outcome.verdict.translations,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
  }

  /* ------------------------------------------------------------------
   * Tóm tắt trang (summarize): dùng prompt từ prompts.js, hỗ trợ thêm Anthropic.
   * ------------------------------------------------------------------ */
  function buildSummaryRequest({ providerId, providerConfig, apiKey, text, targetLanguage, maxBullets, systemOverride }) {
    const targetName = SUMMARY_TARGET[String(targetLanguage || '').toLowerCase()];
    if (!targetName) throw new Error('Ngôn ngữ đích không hỗ trợ');
    const kind = providerKind(providerId);
    if (kind === 'deepl') throw new Error('SUMMARIZE_REQUIRES_LLM');

    const instructions = buildSummaryInstructions(targetName, clampSummaryBullets(maxBullets), systemOverride);
    const prompt = String(text || '');

    if (kind === 'gemini') {
      const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const model = rawModel.replace(/^models\//i, '');
      const generationConfig = buildGeminiGenerationConfig(model, 0.1);
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (kind === 'anthropic') {
      return buildAnthropicRequest({ providerConfig, apiKey, system: instructions, prompt, maxTokens: 2048, temperature: 0.1 });
    }

    if (kind === 'openai') {
      const { url, model, format, headers } = resolveOpenAIRequest(providerConfig, apiKey);

      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 2000, store: false };
      } else if (format === 'chat') {
        payload = {
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt },
          ],
          stream: false,
        };
      } else {
        // libre/generic là engine dịch thuần, không tóm tắt tự do được.
        throw new Error(`${PROVIDER_DEFS.openai.label}: format "${format}" không hỗ trợ tóm tắt`);
      }

      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    if (kind === 'deploy') {
      // Không đặt trần token: reasoning 'max' ăn chung trần, trần thấp -> content rỗng.
      return buildDeployRequest({ providerConfig, apiKey, system: instructions, prompt });
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  // Tóm tắt qua rotation key: ép config chỉ còn provider LLM (bỏ DeepL).
  // Chỉ có DeepL key -> throw 'SUMMARIZE_REQUIRES_LLM' để UI báo rõ.
  async function summarizeWithRotation({ config, text, targetLanguage, maxBullets, fetchText, keyState, now, sleep, systemOverride }) {
    const content = String(text || '').trim();
    if (!content) throw new Error('Không có nội dung cần tóm tắt');
    const target = String(targetLanguage || '').toLowerCase();
    if (!SUMMARY_TARGET[target]) throw new Error('Ngôn ngữ đích không hỗ trợ');

    // Mọi provider LLM đang bật (Gemini + Anthropic + OpenAI/Preset + Deploy).
    const llmProviders = {};
    for (const id of providerIdsOf(config)) {
      if (providerKind(id) === 'deepl') continue;
      const provider = config?.providers?.[id];
      if (provider?.enabled) llmProviders[id] = provider;
    }
    const llmIds = Object.keys(llmProviders);
    if (!llmIds.length) throw new Error('SUMMARIZE_REQUIRES_LLM');
    const llmConfig = {
      ...config,
      // preferred 'deepl' không còn trong providers -> về LLM đầu tiên khả dụng.
      preferred: llmProviders[config?.preferred] ? config.preferred : llmIds[0],
      providers: llmProviders,
    };

    const outcome = await withKeyRotation({
      config: llmConfig,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const request = buildSummaryRequest({
          providerId,
          providerConfig,
          apiKey,
          text: content,
          targetLanguage: target,
          maxBullets,
          systemOverride,
        });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId,
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });
        return { verdict };
      },
    });

    // Response là plain text bullet — giữ nguyên, chỉ trim.
    return {
      text: String(outcome.verdict.text || '').trim(),
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
    };
  }

  /* ------------------------------------------------------------------
   * AI Quick Solver: Giải bài tập và câu hỏi nhanh (dùng buildQaInstructions từ prompts.js).
   * ------------------------------------------------------------------ */
  function buildQaRequest({ providerId, providerConfig, apiKey, text, imageBase64, mimeType, extendedThinking, thinkingLevel, codeExecution, systemOverride }) {
    const kind = providerKind(providerId);
    if (kind === 'deepl') throw new Error('QA_REQUIRES_LLM');
    if (imageBase64 && !supportsVision(providerId, providerConfig)) {
      throw new Error('IMAGE_NEEDS_VISION');
    }

    const instructions = buildQaInstructions(systemOverride);
    const prompt = String(text || '').trim() || (imageBase64 ? 'Hãy quan sát kỹ hình ảnh câu hỏi dưới đây, đọc chính xác mọi công thức toán/ký hiệu/chỉ số, suy luận từng bước giải chi tiết và đưa ra đáp án chính xác nhất.' : '');

    if (kind === 'gemini') {
      const isExtended = extendedThinking === true || providerConfig?.extendedThinking === true;
      let rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      if (isExtended && !rawModel.includes('3.8')) {
        rawModel = 'gemini-3.8-flash';
      }
      const model = rawModel.replace(/^models\//i, '');
      const parts = [{ text: prompt }];
      if (imageBase64) {
        parts.push({
          inline_data: {
            mime_type: String(mimeType || 'image/jpeg'),
            data: String(imageBase64 || '')
          }
        });
      }

      const generationConfig = isExtended
        ? {
            temperature: 1.0,
            thinkingConfig: {
              thinkingLevel: String(thinkingLevel || 'high').toLowerCase()
            }
          }
        : {
            temperature: 0.1
          };

      const bodyPayload = {
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
        safetySettings: GEMINI_SAFETY_SETTINGS,
      };

      const useCodeExecution = (codeExecution === true || providerConfig?.codeExecution === true || isExtended) && providerConfig?.codeExecution !== false;
      if (useCodeExecution) {
        bodyPayload.tools = [{ code_execution: {} }];
      } else if (providerConfig?.googleSearch !== false) {
        bodyPayload.tools = [{ google_search: {} }];
      }

      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify(bodyPayload),
      };
    }

    if (kind === 'anthropic') {
      return buildAnthropicRequest({
        providerConfig,
        apiKey,
        system: instructions,
        prompt,
        image: imageBase64 ? { imageBase64, mimeType } : null,
        maxTokens: 4096,
        temperature: 0.1,
        timeoutMs: 120000,
      });
    }

    if (kind === 'openai') {
      const { url, model, format, headers } = imageBase64
        ? resolveOpenAIVisionRequest(providerConfig, apiKey)
        : resolveOpenAIRequest(providerConfig, apiKey);
      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 1500, temperature: 0.1, store: false };
      } else if (format === 'chat') {
        const userContent = imageBase64 ? chatUserContent(prompt, { imageBase64, mimeType }) : prompt;
        payload = {
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: userContent },
          ],
          temperature: 0.1,
          stream: false,
        };
      } else {
        throw new Error(`${PROVIDER_DEFS.openai.label}: format "${format}" không hỗ trợ giải câu hỏi`);
      }
      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    if (kind === 'deploy') {
      return buildDeployRequest({
        providerConfig,
        apiKey,
        system: instructions,
        prompt,
        image: imageBase64 ? { imageBase64, mimeType } : null,
        mode: 'solve',
        timeoutMs: 200000,
      });
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  async function solveQuestionWithRotation({ config, text, imageBase64, mimeType, extendedThinking, thinkingLevel, codeExecution, fetchText, keyState, now, sleep, systemOverride }) {
    if (!text && !imageBase64) throw new Error('Không có nội dung câu hỏi');

    let eligibleProviders = {};
    if (imageBase64) {
      // Ảnh: chỉ provider đọc được ảnh (Gemini / Deploy / Anthropic / OpenRouter Vision).
      for (const id of visionProviderIds(config)) {
        eligibleProviders[id] = config.providers[id];
      }
      if (!Object.keys(eligibleProviders).length) {
        throw new Error('IMAGE_NEEDS_VISION');
      }
    } else {
      for (const id of providerIdsOf(config)) {
        if (providerKind(id) === 'deepl') continue;
        const provider = config?.providers?.[id];
        if (provider?.enabled) eligibleProviders[id] = provider;
      }
    }

    const eligibleIds = Object.keys(eligibleProviders);
    if (!eligibleIds.length) {
      throw new Error(imageBase64 ? 'IMAGE_NEEDS_VISION' : 'QA_REQUIRES_LLM');
    }

    const solverConfig = {
      ...config,
      preferred: eligibleProviders[config?.preferred] ? config.preferred : eligibleIds[0],
      providers: eligibleProviders,
    };

    const outcome = await withKeyRotation({
      config: solverConfig,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const currentTime = now ? now() : Date.now();
        const isSearchCoolingDown = Boolean(keyState?.searchCooldownUntil && keyState.searchCooldownUntil > currentTime);
        const allowSearch = providerConfig?.googleSearch !== false && !isSearchCoolingDown;

        const isThinkingCoolingDown = Boolean(keyState?.extendedThinkingCooldownUntil && keyState.extendedThinkingCooldownUntil > currentTime);
        const allowExtended = extendedThinking === true
          ? true
          : (Boolean(providerConfig?.extendedThinking) && !isThinkingCoolingDown);

        const request = buildQaRequest({
          providerId,
          providerConfig: {
            ...providerConfig,
            googleSearch: allowSearch,
            extendedThinking: allowExtended,
          },
          apiKey,
          text,
          imageBase64,
          mimeType,
          extendedThinking: allowExtended,
          thinkingLevel,
          codeExecution,
          systemOverride,
        });
        const response = await fetchText(request);
        let verdict = classifyResponse({
          providerId,
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });

        if (verdict.kind !== 'ok' && providerKind(providerId) === 'gemini') {
          const rawErr = `${verdict.message || ''} ${response.bodyText || ''}`.toLowerCase();
          const is429 = response.status === 429 || verdict.kind === 'keyFailed' || rawErr.includes('429') || rawErr.includes('resource_exhausted');
          const isToolIssue = allowSearch && (is429 || rawErr.includes('tool') || rawErr.includes('search') || rawErr.includes('grounding') || response.status === 400);

          if (isToolIssue) {
            if (keyState) {
              keyState.searchCooldownUntil = currentTime + 60000;
            }
            const fallbackReq = buildQaRequest({
              providerId,
              providerConfig: {
                ...providerConfig,
                googleSearch: false,
                extendedThinking: allowExtended,
              },
              apiKey,
              text,
              imageBase64,
              mimeType,
              extendedThinking: allowExtended,
              thinkingLevel,
              codeExecution,
              systemOverride,
            });
            const fallbackResp = await fetchText(fallbackReq);
            const fallbackVerdict = classifyResponse({
              providerId,
              providerLabel,
              openaiFormat: fallbackReq?.openaiFormat,
              status: fallbackResp.status,
              bodyText: fallbackResp.bodyText,
              retryAfterMs: fallbackResp.retryAfterMs,
            });
            if (fallbackVerdict.kind === 'ok') {
              return { verdict: fallbackVerdict };
            }
            verdict = fallbackVerdict;
          }

          if (verdict.kind !== 'ok' && (allowExtended || is429)) {
            if (keyState && !extendedThinking) {
              keyState.extendedThinkingCooldownUntil = currentTime + 60000;
            }
            const liteReq = buildQaRequest({
              providerId,
              providerConfig: {
                ...providerConfig,
                model: 'gemini-3.5-flash-lite',
                googleSearch: false,
                extendedThinking: false,
              },
              apiKey,
              text,
              imageBase64,
              mimeType,
              extendedThinking: false,
              systemOverride,
            });
            const liteResp = await fetchText(liteReq);
            const liteVerdict = classifyResponse({
              providerId,
              providerLabel,
              openaiFormat: liteReq?.openaiFormat,
              status: liteResp.status,
              bodyText: liteResp.bodyText,
              retryAfterMs: liteResp.retryAfterMs,
            });
            if (liteVerdict.kind === 'ok') {
              return { verdict: liteVerdict, fallbackUsed: true };
            }
            verdict = liteVerdict;
          }

          if (verdict.kind !== 'ok' && (response.status === 429 || verdict.kind === 'keyFailed')) {
            const waitMs = Number(response.retryAfterMs) > 0 ? Math.min(Number(response.retryAfterMs), 3000) : 1500;
            if (sleep) {
              await sleep(waitMs);
            }
            const retryReq = buildQaRequest({
              providerId,
              providerConfig: {
                ...providerConfig,
                model: 'gemini-3.5-flash-lite',
                googleSearch: false,
                extendedThinking: false,
              },
              apiKey,
              text,
              imageBase64,
              mimeType,
              extendedThinking: false,
              systemOverride,
            });
            const retryResp = await fetchText(retryReq);
            const retryVerdict = classifyResponse({
              providerId,
              providerLabel,
              openaiFormat: retryReq?.openaiFormat,
              status: retryResp.status,
              bodyText: retryResp.bodyText,
              retryAfterMs: retryResp.retryAfterMs,
            });
            if (retryVerdict.kind === 'ok') {
              return { verdict: retryVerdict, fallbackUsed: true };
            }
            verdict = retryVerdict;
          }
        }

        return { verdict };
      },
    });

    const isFallback = Boolean(outcome.verdict?.fallbackUsed || outcome.fallbackUsed);
    const geminiThinking = extendedThinking && providerKind(outcome.provider) === 'gemini';
    const finalProviderLabel = isFallback
      ? `${outcome.providerLabel} (Flash Lite Fallback)`
      : (geminiThinking ? `${outcome.providerLabel} (3.8 Extended)` : outcome.providerLabel);

    return {
      answer: String(outcome.verdict?.text || '').trim(),
      provider: outcome.provider,
      providerLabel: finalProviderLabel,
    };
  }

  /* ------------------------------------------------------------------
   * Dịch ảnh (OCR + dịch) — hỗ trợ Gemini, Deploy, Anthropic, OpenRouter Vision.
   * ------------------------------------------------------------------ */
  function buildVisionRequest({ providerId = 'gemini', providerConfig, apiKey, mimeType, imageBase64, targetLanguage, systemOverride }) {
    const targetName = VISION_TARGET[String(targetLanguage || '').toLowerCase()];
    if (!targetName) throw new Error('Ngôn ngữ đích không hỗ trợ');

    const instructions = buildVisionInstructions(targetName, systemOverride);
    const prompt = `Transcribe the text in this image with per-line bounding boxes and translate it into ${targetName}.`;
    const kind = providerKind(providerId);

    if (kind === 'deploy') {
      return buildDeployRequest({
        providerConfig,
        apiKey,
        system: instructions,
        prompt,
        image: { imageBase64, mimeType: mimeType || 'image/png' },
        temperature: 0.2,
      });
    }

    if (kind === 'anthropic') {
      return buildAnthropicRequest({
        providerConfig,
        apiKey,
        system: instructions,
        prompt,
        image: { imageBase64, mimeType: mimeType || 'image/png' },
        maxTokens: 4096,
        temperature: 0.2,
      });
    }

    if (kind === 'openai') {
      const { url, model, headers } = resolveOpenAIVisionRequest(providerConfig, apiKey);
      return {
        url,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: chatUserContent(prompt, { imageBase64, mimeType: mimeType || 'image/png' }) },
          ],
          temperature: 0.2,
          stream: false,
        }),
        openaiFormat: 'chat',
      };
    }

    const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
    const model = rawModel.replace(/^models\//i, '');

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-goog-api-key': String(apiKey || '').trim(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: String(mimeType || 'image/png'), data: String(imageBase64 || '') } },
          ],
        }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        safetySettings: GEMINI_SAFETY_SETTINGS,
      }),
    };
  }

  function parseVisionLines(raw, providerLabel = 'Gemini') {
    const parsed = parseJsonArrayText(raw);
    if (!parsed) throw new Error(`${providerLabel}: không parse được mảng OCR từ ảnh`);
    return parsed
      .filter(item => item && typeof item.original === 'string' && typeof item.translated === 'string')
      .map(item => ({
        original: item.original.trim(),
        translated: item.translated.trim(),
        box: Array.isArray(item.box) && item.box.length === 4 && item.box.every(n => Number.isFinite(Number(n)))
          ? item.box.map(Number)
          : null,
      }))
      .filter(item => item.original || item.translated);
  }

  function buildOcrVisionRequest({ providerId = 'gemini', providerConfig, apiKey, mimeType, imageBase64, systemOverride }) {
    const instructions = buildOcrVisionInstructions(systemOverride);
    const prompt = 'Transcribe all text visible in this image accurately.';
    const kind = providerKind(providerId);

    if (kind === 'deploy') {
      return buildDeployRequest({
        providerConfig,
        apiKey,
        system: instructions,
        prompt,
        image: { imageBase64, mimeType: mimeType || 'image/png' },
        temperature: 0.1,
      });
    }

    if (kind === 'anthropic') {
      return buildAnthropicRequest({
        providerConfig,
        apiKey,
        system: instructions,
        prompt,
        image: { imageBase64, mimeType: mimeType || 'image/png' },
        maxTokens: 4096,
        temperature: 0.1,
      });
    }

    if (kind === 'openai') {
      const { url, model, headers } = resolveOpenAIVisionRequest(providerConfig, apiKey);
      return {
        url,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: chatUserContent(prompt, { imageBase64, mimeType: mimeType || 'image/png' }) },
          ],
          temperature: 0.1,
          stream: false,
        }),
        openaiFormat: 'chat',
      };
    }

    const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
    const model = rawModel.replace(/^models\//i, '');

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-goog-api-key': String(apiKey || '').trim(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: String(mimeType || 'image/png'), data: String(imageBase64 || '') } },
          ],
        }],
        generationConfig: { temperature: 0.1 },
        safetySettings: GEMINI_SAFETY_SETTINGS,
      }),
    };
  }

  function parseOcrVisionText(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';

    const parsed = parseJsonArrayText(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .map(item => (typeof item === 'string' ? item : item?.text || item?.original || ''))
        .filter(Boolean)
        .join('\n');
    }

    const unfenced = trimmed.replace(/^```(?:text|json)?\s*\n?|\n?```$/gi, '').trim();
    return unfenced;
  }

  function parseOcrVisionLines(raw) {
    const text = parseOcrVisionText(raw);
    if (!text) return [];
    return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ text: line }));
  }

  async function ocrVisionWithRotation({ config, mimeType, imageBase64, fetchText, keyState, now, sleep, systemOverride }) {
    if (!imageBase64) throw new Error('Không có dữ liệu ảnh');

    const visionIds = visionProviderIds(config);
    if (!visionIds.length) {
      throw new Error('IMAGE_NEEDS_VISION');
    }
    const visionConfig = {
      ...config,
      preferred: visionIds.includes(config?.preferred) ? config.preferred : visionIds[0],
      providers: Object.fromEntries(visionIds.map(id => [id, config.providers[id]])),
    };

    const outcome = await withKeyRotation({
      config: visionConfig,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const request = buildOcrVisionRequest({ providerId, providerConfig, apiKey, mimeType, imageBase64, systemOverride });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId,
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });
        return { verdict };
      },
    });

    const rawText = outcome.verdict?.text || '';
    const parsedText = parseOcrVisionText(rawText);
    const lines = parseOcrVisionLines(rawText);

    return {
      text: parsedText,
      lines,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
  }

  async function translateVisionWithRotation({ config, mimeType, imageBase64, targetLanguage, fetchText, keyState, now, sleep, systemOverride }) {
    if (!imageBase64) throw new Error('Không có dữ liệu ảnh');
    const target = String(targetLanguage || 'vi').toLowerCase();
    if (!VISION_TARGET[target]) throw new Error('Ngôn ngữ đích không hỗ trợ');

    const visionIds = visionProviderIds(config);
    if (!visionIds.length) {
      throw new Error('IMAGE_NEEDS_VISION');
    }
    const visionConfig = {
      ...config,
      preferred: visionIds.includes(config?.preferred) ? config.preferred : visionIds[0],
      providers: Object.fromEntries(visionIds.map(id => [id, config.providers[id]])),
    };

    const outcome = await withKeyRotation({
      config: visionConfig,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const request = buildVisionRequest({ providerId, providerConfig, apiKey, mimeType, imageBase64, targetLanguage: target, systemOverride });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId,
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });
        return { verdict };
      },
    });

    return {
      lines: parseVisionLines(outcome.verdict.text, outcome.providerLabel),
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
  }

  const api = {
    CONFIG_STORAGE_KEY,
    SYSTEM_PROMPT_OVERRIDE_KEY,
    PROMPT_STUDIO_TASKS,
    PROVIDER_ORDER,
    PRESET_ORDER,
    ROUTING_STRATEGIES,
    PROVIDER_DEFS,
    PROVIDER_PRESETS,
    BUILTIN_ORIGINS,
    TONES,
    DEPLOY_API_BASE,
    DEPLOY_DEFAULT_REASONING,
    DEPLOY_TRANSLATE_REASONING,
    DEPLOY_REASONING_EFFORTS,
    normalizeConfig,
    normalizeKeyList,
    activeKeysOf,
    parseKeysInput,
    detectProviderForKey,
    detectPresetForKey,
    keyFormatWarning,
    emptyProviderConfig,
    isPresetProvider,
    isCustomProvider,
    providerKind,
    providerDefOf,
    providerLabelOf,
    providerIdsOf,
    nextCustomProviderId,
    MAX_CUSTOM_PROVIDERS,
    orderedProviderIds,
    usableProviders,
    supportsVision,
    visionProviderIds,
    maskKey,
    deeplUsageEndpoint,
    buildNativeInstructions,
    humanizeCasual,
    buildRequest,
    buildAnthropicRequest,
    classifyResponse,
    PAGE_STYLES,
    PAGE_DIALECTS,
    normalizePageOptions,
    normalizeSystemPromptOverrides,
    buildBatchInstructions,
    buildBatchRequest,
    classifyBatchResponse,
    translateWithRotation,
    translateBatchWithRotation,
    buildSummaryInstructions,
    buildSummaryRequest,
    summarizeWithRotation,
    buildVisionInstructions,
    buildVisionRequest,
    parseVisionLines,
    translateVisionWithRotation,
    buildOcrVisionInstructions,
    buildOcrVisionRequest,
    parseOcrVisionText,
    parseOcrVisionLines,
    ocrVisionWithRotation,
    buildQaInstructions,
    buildQaRequest,
    solveQuestionWithRotation,
    createKeyState,
    cooldownKey,
    keyHashId,
    recordKeyMetric,
    exportKeyHealthSnapshot,
    hydrateKeyState,
    parseRetryAfter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_PROVIDERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
