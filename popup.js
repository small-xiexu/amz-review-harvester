const DEFAULT_STATE = {
  asin: "",
  asins: [],
  sites: ["US"],
  tasks: [],
  currentTaskIndex: 0,
  currentAsinIndex: 0,
  site: "US",
  running: false,
  pageCount: 0,
  pageCountsByTask: {},
  pageCountsByAsin: {},
  completedTasks: [],
  completedAsins: [],
  maxPages: 10,
  minDelay: 45,
  maxDelay: 90,
  nextActionAt: 0,
  reviews: [],
  lastProcessedUrl: "",
  reportStatus: "idle",
  reportError: "",
  reportPackage: null,
  reportPackageName: "",
  excelExportedAt: 0,
  excelFailedCount: 0,
  reportStartedAt: 0,
  reportFinishedAt: 0,
  reportTrace: [],
  message: "尚未开始"
};

const DEFAULT_DRAFT = {
  asinInput: null,
  sites: null,
  minDelay: null,
  maxDelay: null,
  maxPages: null
};

const SITE_CONFIG = {
  US: { domain: "www.amazon.com", label: "美国站" },
  CA: { domain: "www.amazon.ca", label: "加拿大站" },
  MX: { domain: "www.amazon.com.mx", label: "墨西哥站" }
};

const ids = [
  "asin",
  "minDelay",
  "maxDelay",
  "maxPages",
  "status",
  "start",
  "pause",
  "exportExcel",
  "prepareReport",
  "downloadReport",
  "clear",
  "agentStatus",
  "toggleAgentConfig",
  "agentConfigPanel",
  "agentProvider",
  "agentUrl",
  "agentModel",
  "agentApiKey",
  "agentPrompt",
  "resetAgentPrompt",
  "saveAgentConfig",
  "testAgentConfig",
  "clearAgentConfig"
];
const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let excelExporting = false;
let reportStarting = false;
let reportDownloading = false;
let lastRenderedState = null;
let lastRenderedDraft = { ...DEFAULT_DRAFT };
let countdownTimer = null;
const DEFAULT_AGENT_CONFIG = {
  openai: {
    agentUrl: "https://api.openai.com/v1",
    agentModel: "gpt-4o-mini"
  },
  claude: {
    agentUrl: "https://api.anthropic.com/v1",
    agentModel: "claude-3-5-sonnet-latest"
  }
};
const DEFAULT_ANALYSIS_PROMPT = `你是一名面向跨境电商卖家的产品分析顾问，擅长把亚马逊竞品评论读成新品开发和 Listing 优化建议。

任务：基于已验证购买评论，写一份普通运营、老板、产品经理都能快速看懂的中文 Markdown 洞察报告。报告要像“读完评论后的判断笔记”，不是数据报表，也不是评论明细复述。

写作要求：
1. 先给一句明确结论，直接说明这个竞品为什么有人买、哪里容易翻车、我们做新品时最该抓什么。
2. 重点回答：用户为什么买、喜欢什么、抱怨什么、产品怎么改、Listing 怎么卖、哪些风险要避开。
3. 语言要像人说话，短句、判断明确、少术语；不要写成论文，不要写成字段清单。
4. 改品建议必须具体、可执行，按优先级表达，但不要机械写“高/中/低优先级表格”。
5. Listing 建议要能直接启发标题、五点描述、A+ 页面和卖点图。
6. 只用“多数、少数、集中、偶发、整体偏正面、口碑分化”等模糊表达，不要输出精确评论数、比例、评分数字或星级。
7. 不要写 ASIN、评论ID、站点、链接、用户昵称、主页、字段名、中文翻译、原文、证据、样本、reviewId、url、rating、site。
8. 不要贴原始评论，不要列证据评论，不要用“证据包括/代表性反馈/评论摘录/用户原话”这类段落。需要举例时，用自然语言概括。
9. 不要编造评论中没有出现的信息；如果信息不足，只简短提醒。
10. 直接输出 Markdown 正文，不要输出 JSON、表格、代码块或额外解释。
11. 总长度控制在 900-1300 中文字。

建议章节：
一句话结论
用户为什么买
主要痛点
主要亮点
产品怎么改
Listing 怎么写
需要避开的坑。`;

function normalizeAsin(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

function normalizeAsins(value) {
  const asins = String(value || "")
    .split(/[\s,，;；]+/)
    .map(normalizeAsin)
    .filter((asin) => asin.length === 10);
  return [...new Set(asins)];
}

function activeAsins(state) {
  if (Array.isArray(state.asins) && state.asins.length) return state.asins;
  return state.asin ? [state.asin] : [];
}

function selectedSitesFromUi() {
  return [...document.querySelectorAll("input[name='sites']:checked")]
    .map((input) => input.value)
    .filter((site) => SITE_CONFIG[site]);
}

function applySitesToUi(sites) {
  const selected = new Set(Array.isArray(sites) ? sites : ["US"]);
  document.querySelectorAll("input[name='sites']").forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function buildTasks(asins, sites) {
  return sites.flatMap((site) => asins.map((asin) => ({
    key: `${site}:${asin}`,
    asin,
    site
  })));
}

function activeTasks(state) {
  if (Array.isArray(state.tasks) && state.tasks.length) return state.tasks;
  return buildTasks(activeAsins(state), Array.isArray(state.sites) && state.sites.length ? state.sites : [state.site || "US"]);
}

function activeTask(state) {
  const tasks = activeTasks(state);
  return tasks[Math.min(Number(state.currentTaskIndex ?? state.currentAsinIndex ?? 0), Math.max(tasks.length - 1, 0))] || null;
}

function activeAsin(state) {
  return activeTask(state)?.asin || "";
}

function reviewMergeKey(review) {
  return review.reviewId || `${review.author || ""}|${review.date || ""}|${review.body || ""}`;
}

function mergeReviewsByKey(existing, incoming) {
  const map = new Map((existing || []).map((review) => [reviewMergeKey(review), review]));
  for (const review of incoming || []) {
    const key = reviewMergeKey(review);
    map.set(key, { ...(map.get(key) || {}), ...review });
  }
  return [...map.values()];
}

function reviewMatchesVerifiedFilter(review) {
  return normalizeYesNo(review?.verified) === "是";
}

function filterReviews(reviews, state) {
  return (reviews || []).filter(reviewMatchesVerifiedFilter);
}

async function getState() {
  const { collectorState } = await chrome.storage.local.get("collectorState");
  return { ...DEFAULT_STATE, ...collectorState };
}

async function setState(patch) {
  const state = await getState();
  await chrome.storage.local.set({ collectorState: { ...state, ...patch } });
}

async function getDraft() {
  const { collectorDraft } = await chrome.storage.local.get("collectorDraft");
  const draft = collectorDraft && typeof collectorDraft === "object" ? collectorDraft : {};
  return { ...DEFAULT_DRAFT, ...draft };
}

async function setDraft(patch) {
  const nextDraft = { ...DEFAULT_DRAFT, ...lastRenderedDraft, ...patch };
  lastRenderedDraft = nextDraft;
  await chrome.storage.local.set({ collectorDraft: nextDraft });
  return nextDraft;
}

function draftValue(draft, key, fallback) {
  const value = draft?.[key];
  return value === null || value === undefined ? fallback : value;
}

function draftSites(draft, fallback) {
  return Array.isArray(draft?.sites) ? draft.sites : fallback;
}

function draftFromUi() {
  return {
    asinInput: inputValue(ui.asin),
    sites: selectedSitesFromUi(),
    minDelay: inputValue(ui.minDelay),
    maxDelay: inputValue(ui.maxDelay),
    maxPages: inputValue(ui.maxPages)
  };
}

async function saveDraftFromUi() {
  await setDraft(draftFromUi());
}

function bindDraftAutosave() {
  [ui.asin, ui.minDelay, ui.maxDelay, ui.maxPages].forEach((element) => {
    element?.addEventListener("input", () => {
      saveDraftFromUi().catch(() => {});
    });
  });
  document.querySelectorAll("input[name='sites']").forEach((element) => {
    element.addEventListener("change", () => {
      saveDraftFromUi().catch(() => {});
    });
  });
}

async function getAgentConfig() {
  const { agentConfig = {} } = await chrome.storage.local.get("agentConfig");
  const agentProvider = normalizeAgentProvider(agentConfig.agentProvider);
  const defaults = DEFAULT_AGENT_CONFIG[agentProvider];
  return {
    agentProvider,
    agentUrl: agentConfig.agentUrl || defaults.agentUrl,
    agentModel: agentConfig.agentModel || defaults.agentModel,
    agentApiKey: agentConfig.agentApiKey || "",
    analysisPrompt: agentConfig.analysisPrompt || DEFAULT_ANALYSIS_PROMPT
  };
}

function normalizeAgentProvider(value) {
  if (value === "claude") return "claude";
  return "openai";
}

async function setAgentConfig(config) {
  const agentProvider = normalizeAgentProvider(config.agentProvider);
  await chrome.storage.local.set({
    agentConfig: {
      agentProvider,
      agentUrl: compactText(config.agentUrl),
      agentModel: compactText(config.agentModel),
      agentApiKey: String(config.agentApiKey || "").trim(),
      analysisPrompt: String(config.analysisPrompt || DEFAULT_ANALYSIS_PROMPT).trim()
    }
  });
}

function hasAgentConfig(config) {
  return Boolean(compactText(config.agentUrl) && compactText(config.agentModel) && String(config.agentApiKey || "").trim());
}

function normalizeAgentConfigFromUi() {
  const agentProvider = normalizeAgentProvider(inputValue(ui.agentProvider, "openai"));
  return {
    agentProvider,
    agentUrl: compactText(inputValue(ui.agentUrl)),
    agentModel: compactText(inputValue(ui.agentModel)),
    agentApiKey: String(inputValue(ui.agentApiKey)).trim(),
    analysisPrompt: String(inputValue(ui.agentPrompt, DEFAULT_ANALYSIS_PROMPT)).trim() || DEFAULT_ANALYSIS_PROMPT
  };
}

function validateAgentConfig(config) {
  if (!config.agentUrl || !config.agentModel || !config.agentApiKey) return "请填写接口地址、模型和 API Key";
  if (!/^https?:\/\//i.test(config.agentUrl)) return "接口地址需要以 http:// 或 https:// 开头";
  return "";
}

function setAgentStatus(message, className = "") {
  setElementText(ui.agentStatus, message);
  if (ui.agentStatus) ui.agentStatus.className = className;
}

function agentOriginPattern(agentUrl) {
  const url = new URL(agentUrl);
  return `${url.protocol}//${url.host}/*`;
}

async function ensureAgentPermission(agentUrlOrUrls) {
  const urls = Array.isArray(agentUrlOrUrls) ? agentUrlOrUrls : [agentUrlOrUrls];
  const origins = [...new Set(urls.map(agentOriginPattern))];
  const hasPermission = await chrome.permissions.contains({ origins });
  if (hasPermission) return true;
  return chrome.permissions.request({ origins });
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function withAgentUrl(config, agentUrl) {
  return { ...config, agentUrl };
}

function openAiCompatibleBaseUrls(agentUrl) {
  const baseUrl = normalizeBaseUrl(agentUrl);
  if (!baseUrl) return [];
  const urls = /\/v\d+$/i.test(baseUrl) ? [baseUrl] : [`${baseUrl}/v1`, baseUrl];
  return [...new Set(urls)];
}

function agentBaseUrlCandidates(config) {
  if (config.agentProvider === "claude") return [normalizeBaseUrl(config.agentUrl)];
  return openAiCompatibleBaseUrls(config.agentUrl);
}

async function tryAgentBaseUrls(config, runner) {
  const urls = agentBaseUrlCandidates(config).filter(Boolean);
  let lastError = null;
  for (const agentUrl of urls) {
    try {
      const result = await runner(withAgentUrl(config, agentUrl));
      return { agentUrl, result };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("没有可用的接口地址");
}

function openAiChatUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function claudeMessagesUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/messages`;
}

async function testOpenAiCompatibleConnection(config, signal) {
  const response = await fetch(openAiChatUrl(config.agentUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.agentApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.agentModel,
      temperature: 0,
      max_tokens: 20,
      messages: [
        { role: "system", content: "Return only valid JSON." },
        { role: "user", content: "Return exactly {\"ok\":true}" }
      ]
    }),
    signal
  });
  if (!response.ok) throw new Error(`LLM 测试调用返回 ${response.status}`);
  const data = await parseJsonResponse(response, "OpenAI 测试接口");
  const content = data.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("LLM 测试没有返回内容");
}

async function testClaudeConnection(config, signal) {
  const response = await fetch(claudeMessagesUrl(config.agentUrl), {
    method: "POST",
    headers: {
      "x-api-key": config.agentApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.agentModel,
      max_tokens: 20,
      temperature: 0,
      system: "Return only valid JSON.",
      messages: [
        { role: "user", content: "Return exactly {\"ok\":true}" }
      ]
    }),
    signal
  });
  if (!response.ok) throw new Error(`LLM 测试调用返回 ${response.status}`);
  const data = await parseJsonResponse(response, "Claude 测试接口");
  const content = (data.content || []).map((part) => part?.text || "").join("").trim();
  if (!content) throw new Error("LLM 测试没有返回内容");
}

async function testAgentConnection(config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    return await tryAgentBaseUrls(config, async (candidate) => {
      if (candidate.agentProvider === "claude") {
        await testClaudeConnection(candidate, controller.signal);
      } else {
        await testOpenAiCompatibleConnection(candidate, controller.signal);
      }
      return true;
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function inputValue(element, fallback = "") {
  return element?.value ?? fallback;
}

function setInputValue(element, value) {
  if (element) element.value = value ?? "";
}

function setElementText(element, value) {
  if (element) element.textContent = value ?? "";
}

function setElementDisabled(element, disabled) {
  if (element) element.disabled = disabled;
}

function setPanelHidden(element, hidden) {
  if (element) element.hidden = hidden;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function countdownSeconds(state) {
  if (!state.running) return null;
  const nextActionAt = Number(state.nextActionAt || 0);
  if (!nextActionAt) return null;
  return Math.max(0, Math.ceil((nextActionAt - Date.now()) / 1000));
}

function renderStatusMessage(state) {
  const seconds = countdownSeconds(state);
  if (seconds === null) return `<div>${escapeHtml(state.message)}</div>`;
  return `
    <div>${escapeHtml(state.message)}</div>
    <div class="status-countdown">距离自动点击还有 <strong>${escapeHtml(seconds)}</strong> 秒</div>
  `;
}

function scheduleCountdownRefresh(state) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (countdownSeconds(state) === null) return;
  countdownTimer = setInterval(() => {
    if (lastRenderedState) render(lastRenderedState, lastRenderedDraft);
  }, 1000);
}

function render(state, draft = lastRenderedDraft) {
  lastRenderedState = state;
  lastRenderedDraft = { ...DEFAULT_DRAFT, ...(draft || {}) };
  const asins = activeAsins(state);
  const tasks = activeTasks(state);
  const completedTaskCount = (state.completedTasks || []).filter((key) => tasks.some((task) => task.key === key)).length;
  const allTasksCompleted = tasks.length > 0 && completedTaskCount >= tasks.length;
  const task = allTasksCompleted ? tasks[tasks.length - 1] : activeTask(state);
  setInputValue(ui.asin, draftValue(lastRenderedDraft, "asinInput", asins.join("\n")));
  applySitesToUi(draftSites(lastRenderedDraft, Array.isArray(state.sites) && state.sites.length ? state.sites : [state.site || "US"]));
  setInputValue(ui.minDelay, draftValue(lastRenderedDraft, "minDelay", state.minDelay));
  setInputValue(ui.maxDelay, draftValue(lastRenderedDraft, "maxDelay", state.maxDelay));
  setInputValue(ui.maxPages, draftValue(lastRenderedDraft, "maxPages", state.maxPages));
  const currentIndex = Math.max(tasks.findIndex((item) => item.key === task?.key), 0);
  const currentPageCount = state.pageCountsByTask?.[task?.key] ?? state.pageCountsByAsin?.[task?.asin] ?? state.pageCount ?? 0;
  const exportableReviews = filterReviews(state.reviews, state);
  const reportReady = state.reportStatus === "ready" && Boolean(state.reportPackage);
  const reportPreparing = state.reportStatus === "preparing";
  const reportFailed = state.reportStatus === "error";
  const excelReady = Number(state.excelExportedAt || 0) > 0;
  const reportStartedAt = Number(state.reportStartedAt || 0);
  const reportStale = reportPreparing && reportStartedAt > 0 && Date.now() - reportStartedAt > 10 * 60 * 1000;
  const noExportableReviews = allTasksCompleted && !state.running && exportableReviews.length === 0;
  const reportTrace = Array.isArray(state.reportTrace) ? state.reportTrace.slice(-10) : [];
  const canExportExcel = allTasksCompleted && !state.running && exportableReviews.length > 0;
  const canPrepareReport = excelReady && allTasksCompleted && !state.running && exportableReviews.length > 0 && (!reportPreparing || reportStale);
  const siteLabel = task ? SITE_CONFIG[task.site]?.label || task.site : "-";
  const taskCountText = tasks.length > 1 ? `${allTasksCompleted ? tasks.length : currentIndex + 1}/${tasks.length}` : "1/1";
  const statusClass = reportFailed || reportStale || noExportableReviews ? "paused" : reportPreparing ? "running" : reportReady ? "completed" : allTasksCompleted ? "paused" : state.running ? "running" : "paused";
  const statusLabel = noExportableReviews ? "无可导出" : reportFailed ? "AI 失败" : reportStale ? "AI 超时" : reportPreparing ? "AI 生成中" : reportReady ? "AI 已完成" : excelReady ? "Excel 已导出" : allTasksCompleted ? "待导出 Excel" : state.running ? "运行中" : "已暂停";
  if (ui.status) {
    ui.status.innerHTML = `
      <div class="status-head">
        <span class="status-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
        <div class="status-current">
          <span>当前 ASIN</span>
          <strong>${escapeHtml(task ? task.asin : "-")}</strong>
        </div>
        <div class="status-current site">
          <span>当前站点</span>
          <strong>${escapeHtml(siteLabel)}</strong>
        </div>
      </div>
      <div class="status-metrics">
        <div><span>任务</span><strong>${escapeHtml(taskCountText)}</strong></div>
        <div><span>批次</span><strong>${escapeHtml(`${currentPageCount}/${state.maxPages}`)}</strong></div>
        <div><span>已保存</span><strong>${escapeHtml(state.reviews.length)}</strong></div>
        <div><span>可导出</span><strong>${escapeHtml(exportableReviews.length)}</strong></div>
      </div>
      <div class="status-row"><span>导出规则</span><strong>仅已验证购买</strong></div>
      <div class="status-message">${renderStatusMessage(state)}</div>
      ${reportTrace.length ? `
      <div class="status-trace">
        <div class="status-trace-title">阶段日志</div>
        <div class="status-trace-list">${reportTrace.map((line) => `<div class="status-trace-item">${escapeHtml(line)}</div>`).join("")}</div>
      </div>` : ""}
    `;
  }
  setElementText(ui.start, allTasksCompleted ? "重新开始" : "开始 / 继续");
  setElementDisabled(ui.start, state.running || reportPreparing);
  setElementDisabled(ui.pause, !state.running);
  setElementText(ui.exportExcel, noExportableReviews ? "无可导出评论" : excelReady ? "重新导出 Excel" : "导出 Excel");
  setElementDisabled(ui.exportExcel, excelExporting || !canExportExcel);
  setElementText(ui.prepareReport, reportReady ? "重新生成 AI 报告" : reportFailed || reportStale ? "重新生成 AI 报告" : reportPreparing ? "AI 报告生成中" : excelReady ? "生成 AI 报告" : "先导出 Excel");
  setElementDisabled(ui.prepareReport, reportStarting || reportPreparing || !canPrepareReport);
  setElementText(ui.downloadReport, reportReady ? "下载 AI 报告" : "AI 报告未生成");
  setElementDisabled(ui.downloadReport, reportDownloading || !reportReady);
  scheduleCountdownRefresh(state);
}

async function renderCollector() {
  const [state, draft] = await Promise.all([getState(), getDraft()]);
  render(state, draft);
}

function renderAgentConfig(config) {
  const configured = hasAgentConfig(config);
  setInputValue(ui.agentProvider, config.agentProvider || "openai");
  setInputValue(ui.agentUrl, config.agentUrl);
  setInputValue(ui.agentModel, config.agentModel);
  setInputValue(ui.agentApiKey, config.agentApiKey);
  setInputValue(ui.agentPrompt, config.analysisPrompt || DEFAULT_ANALYSIS_PROMPT);
  const providerLabel = config.agentProvider === "claude" ? "Claude" : "OpenAI";
  setElementText(ui.agentStatus, configured ? `已配置：${providerLabel} / ${config.agentModel}` : "未配置，仅支持采集和导出");
  if (ui.agentStatus) {
    ui.agentStatus.className = configured ? "configured" : "";
  }
  setElementText(ui.toggleAgentConfig, ui.agentConfigPanel?.hidden === false ? "收起" : "配置");
}

function applyAgentProviderDefaults(provider) {
  const normalized = normalizeAgentProvider(provider);
  const defaults = DEFAULT_AGENT_CONFIG[normalized];
  setInputValue(ui.agentProvider, normalized);
  setInputValue(ui.agentUrl, defaults.agentUrl);
  setInputValue(ui.agentModel, defaults.agentModel);
}

function reviewPageUrl(site, asin, pageNumber = 1) {
  const domain = SITE_CONFIG[site]?.domain || SITE_CONFIG.US.domain;
  return `https://${domain}/product-reviews/${asin}/?reviewerType=all_reviews&sortBy=recent&pageNumber=${pageNumber}`;
}

function exportBaseName(state) {
  const asins = activeAsins(state);
  const now = new Date();
  const dateStamp = formatDateParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const asinPart = asins[0] || state.asin || "export";
  const multiPart = asins.length > 1 || (Array.isArray(state.sites) && state.sites.length > 1) ? "-multi" : "";
  return `${asinPart}${multiPart}-${dateStamp}`;
}

ui.start?.addEventListener("click", async () => {
  try {
    const asins = normalizeAsins(inputValue(ui.asin));
    const asin = asins[0] || "";
    const sites = selectedSitesFromUi();
    const tasks = buildTasks(asins, sites);
    const firstTask = tasks[0];
    const minDelay = Number(inputValue(ui.minDelay, DEFAULT_STATE.minDelay));
    const maxDelay = Number(inputValue(ui.maxDelay, DEFAULT_STATE.maxDelay));
    const maxPages = Number(inputValue(ui.maxPages, DEFAULT_STATE.maxPages));
    await setDraft(draftFromUi());
    if (!asins.length) throw new Error("请输入至少 1 个正确的 10 位 ASIN");
    if (!sites.length) throw new Error("请至少选择 1 个站点");
    if (minDelay < 20 || maxDelay < minDelay) throw new Error("等待区间设置不正确");
    if (maxPages < 1 || maxPages > 100) throw new Error("加载批次需在 1 到 100 之间");
    await setDraft({
      asinInput: asins.join("\n"),
      sites,
      minDelay,
      maxDelay,
      maxPages
    });

    const current = await getState();
    const currentTasks = activeTasks(current);
    const changedTasks = currentTasks.map((task) => task.key).join("|") !== tasks.map((task) => task.key).join("|");
    const allCompleted = tasks.length > 0 && tasks.every((task) => (current.completedTasks || []).includes(task.key));
    const reset = (currentTasks.length && changedTasks) || allCompleted
      ? { reviews: [], pageCount: 0, pageCountsByTask: {}, pageCountsByAsin: {}, completedTasks: [], completedAsins: [], lastProcessedUrl: "", reportStatus: "idle", reportError: "", reportPackage: null, reportPackageName: "", excelExportedAt: 0, excelFailedCount: 0, reportStartedAt: 0, reportFinishedAt: 0, reportTrace: [] }
      : {};
    const nextIndex = changedTasks || allCompleted ? 0 : Number(current.currentTaskIndex ?? current.currentAsinIndex ?? 0);
    const nextTask = tasks[Math.min(nextIndex, tasks.length - 1)] || firstTask;
    await setState({
      ...reset,
      asin: nextTask.asin,
      asins,
      sites,
      tasks,
      currentTaskIndex: Math.min(nextIndex, tasks.length - 1),
      currentAsinIndex: asins.indexOf(nextTask.asin),
      site: nextTask.site,
      minDelay,
      maxDelay,
      running: true,
      nextActionAt: 0,
      maxPages,
      message: tasks.length > 1
        ? `正在自动打开第 ${Math.min(nextIndex, tasks.length - 1) + 1}/${tasks.length} 个任务：${nextTask.asin} / ${SITE_CONFIG[nextTask.site]?.label || nextTask.site}`
        : "正在自动打开评论页面"
    });
    await chrome.tabs.create({ url: reviewPageUrl(nextTask.site, nextTask.asin, 1), active: true });
    window.close();
  } catch (error) {
    await setState({ running: false, message: error.message });
    await renderCollector();
  }
});

ui.pause?.addEventListener("click", async () => {
  await setState({ running: false, nextActionAt: 0, message: "已由用户暂停" });
  await renderCollector();
});

ui.clear?.addEventListener("click", async () => {
  if (!confirm("确定清空全部已保存评论和输入草稿吗？")) return;
  await chrome.storage.local.set({
    collectorState: { ...DEFAULT_STATE },
    collectorDraft: { ...DEFAULT_DRAFT }
  });
  await renderCollector();
});

function sentiment(rating) {
  const score = Number.parseFloat(String(rating).replace(",", "."));
  if (score >= 4) return "正面";
  if (score === 3) return "中性";
  if (score > 0) return "负面";
  return "";
}

function formatRating(value) {
  const score = Number.parseFloat(String(value || "").replace(",", "."));
  return Number.isFinite(score) ? score.toFixed(1) : compactText(value);
}

function normalizeYesNo(value) {
  const text = compactText(value).toLowerCase();
  return text ? "是" : "否";
}

function formatHelpfulCount(value) {
  const count = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(count) ? String(count) : "0";
}

function highResolutionImageUrl(url) {
  return String(url || "").replace(/\._[^.]+_?(?=\.)/, "");
}

function formatImageUrls(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(highResolutionImageUrl).join("\n");
  return compactText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map(highResolutionImageUrl)
    .join("\n");
}

function formatImageCount(value, imageUrls) {
  const count = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  if (Number.isFinite(count)) return String(count);
  if (Array.isArray(imageUrls)) return String(imageUrls.filter(Boolean).length);
  return "0";
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikeRating(value, rating) {
  const normalized = compactText(value).toLowerCase();
  const normalizedRating = compactText(rating).toLowerCase();
  return Boolean(normalized) && (
    normalized === normalizedRating ||
    /^\d(?:[.,]\d)?\s+out\s+of\s+5\s+stars$/i.test(normalized)
  );
}

function cleanTitle(value, rating) {
  return looksLikeRating(value, rating) ? "" : compactText(value);
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatDateParts(year, month, day) {
  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

function extractDateFragment(value) {
  const text = compactText(value);
  if (!text) return "";
  const fragment = [
    text.match(/\bon\s+(.+)$/i)?.[1],
    text.match(/\ble\s+(.+)$/i)?.[1],
    text.match(/\bel\s+(.+)$/i)?.[1]
  ].find(Boolean);
  return fragment || text;
}

function formatReviewDate(value) {
  const text = extractDateFragment(value);
  if (!text) return "";

  const monthMap = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
    janvier: 1,
    fevrier: 2,
    février: 2,
    mars: 3,
    avril: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    aout: 8,
    août: 8,
    septembre: 9,
    octobre: 10,
    novembre: 11,
    decembre: 12,
    décembre: 12,
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12
  };

  const englishLike = text.match(/\b([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),\s*(\d{4})\b/);
  if (englishLike) {
    const month = monthMap[englishLike[1].toLowerCase()];
    if (month) return formatDateParts(englishLike[3], month, englishLike[2]);
  }

  const dayFirst = text.match(/\b(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})\b/);
  if (dayFirst) {
    const month = monthMap[dayFirst[2].toLowerCase()];
    if (month) return formatDateParts(dayFirst[3], month, dayFirst[1]);
  }

  const spanish = text.match(/\b(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ]+)\s+de\s+(\d{4})\b/i);
  if (spanish) {
    const month = monthMap[spanish[2].toLowerCase()];
    if (month) return formatDateParts(spanish[3], month, spanish[1]);
  }

  const numeric = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (numeric) return formatDateParts(numeric[3], numeric[2], numeric[1]);

  return text;
}

function extractReviewRegion(value, fallbackSite) {
  const text = compactText(value);
  const patterns = [
    /Reviewed in the (.+?) on /i,
    /Reviewed in (.+?) on /i,
    /Commenté (?:en|au|aux) (.+?) le /i,
    /Reseñado en (.+?) el /i,
    /Revisado en (.+?) el /i
  ];
  const matched = patterns
    .map((pattern) => text.match(pattern)?.[1]?.trim())
    .find(Boolean);
  if (matched) return matched;
  return SITE_CONFIG[fallbackSite]?.label || fallbackSite || "";
}

async function translateText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const endpoint = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`翻译服务返回 ${response.status}`);
  const data = await response.json();
  return (data[0] || []).map((part) => part[0] || "").join("");
}

async function translateReviews(reviews) {
  const result = [...reviews];
  let failed = 0;
  for (let index = 0; index < result.length; index += 1) {
    const review = { ...result[index] };
    review.title = cleanTitle(review.title, review.rating);
    if (!review.title) review.titleZh = "";
    try {
      review.titleZh = review.titleZh || await translateText(review.title);
      review.bodyZh = review.bodyZh || await translateText(review.body);
    } catch {
      failed += 1;
    }
    result[index] = review;
    if (index % 5 === 0 || index === result.length - 1) {
      setElementText(ui.status, `正在翻译 ${index + 1}/${result.length} 条已验证购买评论，请不要关闭弹窗…`);
      const currentState = await getState();
      const mergedReviews = mergeReviewsByKey(currentState.reviews, result.slice(0, index + 1));
      await setState({
        reviews: mergedReviews,
        message: `已翻译 ${index + 1}/${result.length} 条已验证购买评论`
      });
    }
  }
  return { reviews: result, failed };
}

const EXPORT_COLUMNS = [
  ["asin", "ASIN"],
  ["siteLabel", "站点"],
  ["reviewId", "评论ID"],
  ["reviewRegion", "评论地区"],
  ["rawDate", "原始评论日期"],
  ["date", "评论日期"],
  ["rawRating", "原始评星"],
  ["rating", "评星"],
  ["sentiment", "情绪"],
  ["author", "评论人"],
  ["authorProfileUrl", "评论人主页"],
  ["verified", "是否验证购买"],
  ["helpfulCount", "Helpful数量"],
  ["hasBuyerImage", "是否有买家实拍"],
  ["imageCount", "图片数量"],
  ["imageUrls", "图片链接"],
  ["hasVideo", "是否有视频"],
  ["variant", "评论产品的属性"],
  ["color", "颜色"],
  ["size", "尺寸"],
  ["title", "英文标题"],
  ["body", "英文评论"],
  ["titleZh", "标题中文翻译"],
  ["bodyZh", "评论中文翻译"],
  ["url", "评论链接"]
];

function prepareExportRows(reviews, state) {
  return reviews.map((row) => ({
    ...row,
    rawDate: row.date,
    date: formatReviewDate(row.date),
    rawRating: row.rating,
    rating: formatRating(row.rating),
    reviewRegion: extractReviewRegion(row.date, row.site || state.site),
    siteLabel: SITE_CONFIG[row.site || state.site]?.label || row.site || state.site,
    sentiment: sentiment(row.rating),
    verified: normalizeYesNo(row.verified),
    helpfulCount: formatHelpfulCount(row.helpfulCount),
    hasBuyerImage: row.hasBuyerImage || row.hasMedia || "否",
    imageCount: formatImageCount(row.imageCount, row.imageUrls),
    imageUrls: formatImageUrls(row.imageUrls),
    hasVideo: row.hasVideo || "否"
  }));
}

async function prepareExportData() {
  const state = await getState();
  const tasks = activeTasks(state);
  const completedTaskCount = (state.completedTasks || []).filter((key) => tasks.some((task) => task.key === key)).length;
  const allTasksCompleted = tasks.length > 0 && completedTaskCount >= tasks.length;
  if (state.running || !allTasksCompleted) throw new Error("任务还没有全部完成，完成后才能导出 Excel 和分析报告");
  const filteredReviews = filterReviews(state.reviews, state);
  if (!filteredReviews.length) throw new Error("当前没有可导出的已验证购买评论");
  const reviewsNeedingTranslation = filteredReviews.filter((review) => {
    const title = cleanTitle(review.title, review.rating);
    return (title && !review.titleZh) || (review.body && !review.bodyZh);
  });
  const { reviews: translatedReviews, failed } = reviewsNeedingTranslation.length
    ? await translateReviews(filteredReviews)
    : { reviews: filteredReviews, failed: 0 };
  const mergedReviews = mergeReviewsByKey(state.reviews, translatedReviews);
  return {
    state,
    failed,
    reviews: mergedReviews,
    rows: prepareExportRows(translatedReviews, state),
    columns: EXPORT_COLUMNS
  };
}

function cleanXmlText(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function escapeXml(value) {
  return cleanXmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function firstUrl(value) {
  return cleanXmlText(value).split(/\s+/).find((part) => /^https?:\/\//i.test(part)) || "";
}

function cellXml(ref, value, styleIndex, numeric = false) {
  if (numeric && value !== "") {
    return `<c r="${ref}" s="${styleIndex}"><v>${escapeXml(value)}</v></c>`;
  }
  return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function excelDateSerial(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return String(Math.floor(utc / 86400000) + 25569);
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function uint16(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF];
}

function uint32(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function zipFiles(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const checksum = crc32(data);
    const now = new Date(file.lastModified || Date.now());
    const year = Math.max(1980, now.getFullYear());
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const localHeader = new Uint8Array([
      ...uint32(0x04034B50),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(time),
      ...uint16(date),
      ...uint32(checksum),
      ...uint32(data.length),
      ...uint32(data.length),
      ...uint16(nameBytes.length),
      ...uint16(0)
    ]);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = new Uint8Array([
      ...uint32(0x02014B50),
      ...uint16(20),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(time),
      ...uint16(date),
      ...uint32(checksum),
      ...uint32(data.length),
      ...uint32(data.length),
      ...uint16(nameBytes.length),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(offset)
    ]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const endRecord = new Uint8Array([
    ...uint32(0x06054B50),
    ...uint16(0),
    ...uint16(0),
    ...uint16(files.length),
    ...uint16(files.length),
    ...uint32(centralDirectory.length),
    ...uint32(offset),
    ...uint16(0)
  ]);
  return concatBytes([...localParts, centralDirectory, endRecord]);
}

function xlsxBlob(rows, columns) {
  const widths = [14, 12, 20, 18, 42, 14, 22, 8, 8, 18, 36, 14, 12, 14, 10, 42, 10, 30, 18, 14, 36, 70, 36, 70, 36];
  const numericKeys = new Set(["rating", "helpfulCount", "imageCount"]);
  const dateKeys = new Set(["date"]);
  const hyperlinkKeys = new Set(["authorProfileUrl", "imageUrls", "url"]);
  const lastColumn = columnName(columns.length - 1);
  const lastRow = rows.length + 1;
  const hyperlinks = [];
  let relationshipId = 1;

  const headerCells = columns.map(([, label], index) => cellXml(`${columnName(index)}1`, label, 1)).join("");
  const bodyRows = rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = columns.map(([key], columnIndex) => {
      const ref = `${columnName(columnIndex)}${excelRow}`;
      const value = row[key] ?? "";
      const numeric = numericKeys.has(key) && value !== "";
      const dateSerial = dateKeys.has(key) ? excelDateSerial(value) : "";
      const link = hyperlinkKeys.has(key) ? firstUrl(value) : "";
      if (link) {
        hyperlinks.push({ ref, target: link, id: `rId${relationshipId}` });
        relationshipId += 1;
      }
      if (dateSerial) return cellXml(ref, dateSerial, 4, true);
      return cellXml(ref, value, link ? 3 : 2, numeric);
    }).join("");
    return `<row r="${excelRow}">${cells}</row>`;
  }).join("");

  const cols = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  ).join("");
  const hyperlinkXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((link) => `<hyperlink ref="${link.ref}" r:id="${link.id}"/>`).join("")}</hyperlinks>`
    : "";
  const worksheetRelationships = hyperlinks.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hyperlinks.map((link) => `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(link.target)}" TargetMode="External"/>`).join("")}</Relationships>`
    : null;

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${cols}</cols>
  <sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
  ${hyperlinkXml}
</worksheet>`;

  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="评论数据" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD5D9D9"/></left><right style="thin"><color rgb="FFD5D9D9"/></right><top style="thin"><color rgb="FFD5D9D9"/></top><bottom style="thin"><color rgb="FFD5D9D9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="14" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: worksheetXml
    }
  ];
  if (worksheetRelationships) {
    files.push({ name: "xl/worksheets/_rels/sheet1.xml.rels", content: worksheetRelationships });
  }
  return new Blob([zipFiles(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function downloadBlob(blob, filename, saveAs = true) {
  const url = URL.createObjectURL(blob);
  return chrome.downloads.download({ url, filename, saveAs }).finally(() => {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

function analysisRows(rows) {
  return rows.map((row) => ({
    ratingBand: ratingBandLabel(row.rating),
    sentiment: row.sentiment,
    verified: row.verified,
    variant: row.variant,
    color: row.color,
    size: row.size,
    title: row.title,
    body: row.body
  }));
}

function analysisRequestPayload(state, rows) {
  return {
    projectName: "亚马逊竞品评论分析",
    generatedAt: new Date().toISOString(),
    reviews: analysisRows(rows)
  };
}

function ratingBandLabel(value) {
  const rating = Math.round(Number.parseFloat(value));
  if (rating <= 2) return "低分反馈";
  if (rating === 3) return "中性反馈";
  if (rating >= 4) return "正面反馈";
  return "未识别";
}

ui.exportExcel?.addEventListener("click", async () => {
  excelExporting = true;
  await renderCollector();
  try {
    await setState({ message: "正在导出 Excel…" });
    const { state, reviews, failed, rows, columns } = await prepareExportData();
    const xlsx = xlsxBlob(rows, columns);
    await downloadBlob(xlsx, `${exportBaseName(state)}.xlsx`);
    await setState({
      reviews,
      excelExportedAt: Date.now(),
      excelFailedCount: failed,
      message: failed ? `Excel 已导出，${failed} 条翻译失败并保留原文` : `Excel 已导出，已验证购买 ${rows.length} 条`
    });
  } catch (error) {
    await setState({ message: `Excel 导出失败：${error.message}` });
  } finally {
    excelExporting = false;
    await renderCollector();
  }
});

ui.prepareReport?.addEventListener("click", async () => {
  reportStarting = true;
  await renderCollector();
  try {
    await setState({ reportStatus: "preparing", reportError: "", reportPackage: null, reportPackageName: "", reportStartedAt: Date.now(), reportFinishedAt: 0, message: "正在生成 AI 报告…" });
    const response = await chrome.runtime.sendMessage({ type: "PREPARE_REPORT" });
    if (response && response.ok === false) throw new Error(response.error || "后台报告任务启动失败");
  } catch (error) {
    await setState({ message: `AI 报告生成失败：${error.message}` });
  } finally {
    reportStarting = false;
    await renderCollector();
  }
});

ui.downloadReport?.addEventListener("click", async () => {
  reportDownloading = true;
  await renderCollector();
  try {
    const state = await getState();
    if (state.reportStatus !== "ready" || !state.reportPackage) {
      throw new Error("AI 报告还没有准备好");
    }
    const report = new Blob([String(state.reportPackage || "")], { type: "text/html;charset=utf-8" });
    await downloadBlob(report, state.reportPackageName || `${exportBaseName(state)}-report.html`);
    await setState({ message: "AI 报告已下载" });
  } catch (error) {
    await setState({ message: `AI 报告下载失败：${error.message}` });
  } finally {
    reportDownloading = false;
    await renderCollector();
  }
});

ui.toggleAgentConfig?.addEventListener("click", async () => {
  const willOpen = ui.agentConfigPanel?.hidden !== false;
  setPanelHidden(ui.agentConfigPanel, !willOpen);
  renderAgentConfig(await getAgentConfig());
});

ui.agentProvider?.addEventListener("change", () => {
  applyAgentProviderDefaults(inputValue(ui.agentProvider, "openai"));
  setAgentStatus("已切换服务商，保存或测试后生效");
});

ui.resetAgentPrompt?.addEventListener("click", () => {
  setInputValue(ui.agentPrompt, DEFAULT_ANALYSIS_PROMPT);
  setAgentStatus("已恢复默认提示词，保存后生效");
});

ui.saveAgentConfig?.addEventListener("click", async () => {
  const config = normalizeAgentConfigFromUi();
  const error = validateAgentConfig(config);
  if (error) {
    setAgentStatus(error, "error");
    return;
  }
  await setAgentConfig(config);
  setPanelHidden(ui.agentConfigPanel, true);
  renderAgentConfig(await getAgentConfig());
});

ui.testAgentConfig?.addEventListener("click", async () => {
  const config = normalizeAgentConfigFromUi();
  const error = validateAgentConfig(config);
  if (error) {
    setAgentStatus(error, "error");
    return;
  }

  setAgentStatus("正在调用模型测试…");
  setElementDisabled(ui.testAgentConfig, true);
  try {
    const candidates = agentBaseUrlCandidates(config);
    const granted = await ensureAgentPermission(candidates);
    if (!granted) throw new Error("未授权访问该服务域名");
    const { agentUrl } = await testAgentConnection(config);
    const resolvedConfig = { ...config, agentUrl };
    await setAgentConfig(resolvedConfig);
    setInputValue(ui.agentUrl, agentUrl);
    const suffix = normalizeBaseUrl(agentUrl) === normalizeBaseUrl(config.agentUrl) ? "" : "，已自动补全接口地址";
    setAgentStatus(`连接成功${suffix}，配置已保存`, "configured");
  } catch (error) {
    const message = error.name === "AbortError" ? "连接超时，请检查服务地址" : error.message;
    setAgentStatus(`连接失败：${message}`, "error");
  } finally {
    setElementDisabled(ui.testAgentConfig, false);
  }
});

ui.clearAgentConfig?.addEventListener("click", async () => {
  await chrome.storage.local.remove("agentConfig");
  setPanelHidden(ui.agentConfigPanel, true);
  renderAgentConfig(await getAgentConfig());
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.collectorState) render(await getState(), lastRenderedDraft);
  if (changes.agentConfig) renderAgentConfig(await getAgentConfig());
});

bindDraftAutosave();
renderCollector();
getAgentConfig().then(renderAgentConfig);
