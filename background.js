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

const SITE_CONFIG = {
  US: { domain: "www.amazon.com", label: "美国站" },
  CA: { domain: "www.amazon.ca", label: "加拿大站" },
  MX: { domain: "www.amazon.com.mx", label: "墨西哥站" }
};

let reportPreparationInProgress = false;

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
const DEFAULT_ANALYSIS_PROMPT = `你是一名面向跨境电商卖家的亚马逊竞品评论分析专家。

任务：基于已验证购买评论，写一份给人看的中文 Markdown 报告。它应该像一份清爽的运营分析笔记，普通人也能看懂，而不是固定 schema 或 JSON。

写作要求：
1. 开头先给结论，直接告诉读者这批评论整体在说什么。
2. 优先讲清楚哪里有痛点、哪里有亮点、哪里值得改。
3. 改品建议必须具体、可执行，并按高/中/低优先级排序。
4. Listing 卖点建议要尽量通俗，能直接用于标题、五点描述或 A+ 页面。
5. 不要写 ASIN、评论ID、站点、链接、用户昵称或主页；也不要写“中文翻译”“原文”“1星/2星/3星/4星/5星”这些字段名或任何类似标签。
6. 不要写证据表，不要用编号证据清单；如果要举例，只用自然语言概括，比如“有人提到……”“也有人反馈……”“少数用户觉得……”，不要保留原始标签。
7. 不要编造评论中没有出现的信息；样本不足时要明确说明。
8. 语言尽量自然、简洁、好读，不要堆术语，不要写成学术论文。
9. 不要输出任何精确数值，尽量用“多数/少数/集中/偶见/整体偏正面/口碑分化”等说法，也不要出现星级数字。
10. 总长度尽量控制在 800-1200 中文字。
11. 直接输出 Markdown 正文，不要输出 JSON、表格、代码块或额外解释。
12. 章节只用标题，不要写编号，不要写证据表。

推荐章节：
一眼看懂
主要痛点
主要亮点
可以怎么改
适合怎么卖
需要注意的风险
代表性反馈。`;
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
const ANALYSIS_HEARTBEAT_MS = 30 * 1000;


function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function reportTraceLine(message) {
  return `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
}

async function appendReportTrace(message) {
  const line = reportTraceLine(message);
  console.info(line);
  const state = await getState();
  const reportTrace = [...(state.reportTrace || []), line].slice(-20);
  await setState({ reportTrace });
  return line;
}

async function getState() {
  const { collectorState } = await chrome.storage.local.get("collectorState");
  return { ...DEFAULT_STATE, ...collectorState };
}

async function setState(patch) {
  const state = await getState();
  await chrome.storage.local.set({ collectorState: { ...state, ...patch } });
}

function activeAsins(state) {
  if (Array.isArray(state.asins) && state.asins.length) return state.asins;
  return state.asin ? [state.asin] : [];
}

function buildTasks(asins, sites) {
  return sites.flatMap((site) => asins.map((asin) => ({ key: `${site}:${asin}`, asin, site })));
}

function activeTasks(state) {
  if (Array.isArray(state.tasks) && state.tasks.length) return state.tasks;
  return buildTasks(activeAsins(state), Array.isArray(state.sites) && state.sites.length ? state.sites : [state.site || "US"]);
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

function filterReviews(reviews) {
  return (reviews || []).filter(reviewMatchesVerifiedFilter);
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

function validateAgentConfig(config) {
  if (!config.agentUrl || !config.agentModel || !config.agentApiKey) return "请填写接口地址、模型和 API Key";
  if (!/^https?:\/\//i.test(config.agentUrl)) return "接口地址需要以 http:// 或 https:// 开头";
  return "";
}

function agentOriginPattern(agentUrl) {
  const url = new URL(agentUrl);
  return `${url.protocol}//${url.host}/*`;
}

async function ensureAgentPermission(agentUrlOrUrls) {
  const urls = Array.isArray(agentUrlOrUrls) ? agentUrlOrUrls : [agentUrlOrUrls];
  const origins = [...new Set(urls.map(agentOriginPattern))];
  return chrome.permissions.contains({ origins });
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
    if (index === 0 || (index + 1) % 10 === 0 || index === result.length - 1) {
      await persistTranslatedProgress(result, index, result.length, true);
    }
  }
  return { reviews: result, failed };
}

async function persistTranslatedProgress(result, index, total, trace = false) {
  const currentState = await getState();
  const mergedReviews = mergeReviewsByKey(currentState.reviews, result.slice(0, index + 1));
  const message = `已翻译 ${index + 1}/${total} 条已验证购买评论`;
  await setState({ reviews: mergedReviews, message });
  if (trace) await appendReportTrace(`翻译进度 ${index + 1}/${total}`);
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
    filteredCount: filteredReviews.length,
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

function escapeHtml(value) {
  return cleanXmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function dosDateTimeParts(date) {
  const value = date instanceof Date ? date : new Date();
  const year = Math.max(1980, value.getFullYear());
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
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
    const { time, date } = dosDateTimeParts(file.lastModified ? new Date(file.lastModified) : new Date());
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

async function packageBlob(files) {
  const normalizedFiles = [];
  for (const file of files) {
    const content = file.content instanceof Blob
      ? new Uint8Array(await file.content.arrayBuffer())
      : file.content;
    normalizedFiles.push({ ...file, content });
  }
  return new Blob([zipFiles(normalizedFiles)], { type: "application/zip" });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
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

function analysisUserPrompt(prompt, payload) {
  return `${prompt}

请基于下面这批亚马逊竞品评论数据，撰写一份自然语言中文 Markdown 报告。
不要输出 JSON、固定 schema、代码块、表格或额外解释。
建议使用二级/三级标题和项目符号组织内容，但不要把内容写成机器字段。
报告开头的总览已经会显示 ASIN 和站点，正文不要重复这些信息。
正文不要出现 ASIN、评论ID、站点、链接、用户昵称、主页、中文翻译、原文、1星/2星/3星/4星/5星 之类的标签。
如果要举例，请直接用自然语言概括，不要保留编号证据清单，也不要写“证据包括”这类机械表达。

数据如下：
${JSON.stringify(payload, null, 2)}`;
}

function ratingBandLabel(value) {
  const rating = Math.round(Number.parseFloat(value));
  if (rating <= 2) return "低分反馈";
  if (rating === 3) return "中性反馈";
  if (rating >= 4) return "正面反馈";
  return "未识别";
}

async function callOpenAiAnalysis(config, prompt, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(openAiChatUrl(config.agentUrl), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.agentApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.agentModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: "你只输出中文 Markdown 分析报告，不输出 JSON、表格或代码块。" },
          { role: "user", content: analysisUserPrompt(prompt, payload) }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`OpenAI 分析接口返回 ${response.status}`);
    const data = await parseJsonResponse(response, "OpenAI 分析接口");
    return normalizeAnalysisMarkdown(data.choices?.[0]?.message?.content || "");
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI 分析接口超过 ${formatDuration(ANALYSIS_TIMEOUT_MS)} 仍未返回结果，请检查模型速度或代理服务`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callClaudeAnalysis(config, prompt, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(claudeMessagesUrl(config.agentUrl), {
      method: "POST",
      headers: {
        "x-api-key": config.agentApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.agentModel,
        max_tokens: 4096,
        temperature: 0.2,
        system: "你只输出中文 Markdown 分析报告，不输出 JSON、表格或代码块。",
        messages: [
          { role: "user", content: analysisUserPrompt(prompt, payload) }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Claude 分析接口返回 ${response.status}`);
    const data = await parseJsonResponse(response, "Claude 分析接口");
    return normalizeAnalysisMarkdown((data.content || [])
      .map((part) => part?.text || "")
      .join(""));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Claude 分析接口超过 ${formatDuration(ANALYSIS_TIMEOUT_MS)} 仍未返回结果，请检查模型速度或代理服务`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  const trimmed = text.trim();
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    throw new Error(`${label}返回了网页，不是 JSON。已自动尝试原地址和 /v1，请检查接口地址是否指向真实 API 服务`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${label}返回内容不是 JSON，请检查接口地址、模型和代理服务配置`);
  }
}

async function callAnalysisAgent(config, rows, state, payload = analysisRequestPayload(state, rows)) {
  const candidates = agentBaseUrlCandidates(config);
  const granted = await ensureAgentPermission(candidates);
  if (!granted) throw new Error("未授权访问 AI 服务域名");
  return tryAgentBaseUrls(config, async (candidate) => {
    if (candidate.agentProvider === "claude") {
      return callClaudeAnalysis(candidate, candidate.analysisPrompt, payload);
    }
    return callOpenAiAnalysis(candidate, candidate.analysisPrompt, payload);
  });
}

function listFromAnalysis(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function displayValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${displayValue(item)}`)
      .filter((item) => item && !item.endsWith(": "))
      .join("；");
  }
  return String(value);
}

function normalizeAnalysisMarkdown(markdown) {
  let text = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

function humanizeAnalysisMarkdown(markdown) {
  let text = normalizeAnalysisMarkdown(markdown);
  text = text.replace(/^(#{1,6}\s*)(?:\d+\s*[.)、．]?\s*)+/gm, "$1");
  text = text.replace(/^(#{1,6}\s*)(?:[一二两三四五六七八九十]+\s*[.)、．]?\s*)+/gm, "$1");
  text = text.replace(/^\s*(?:\d+|[一二两三四五六七八九十]+)\s*[.)、．]\s+/gm, "- ");
  text = text.replace(/(^|[\s（(])(?:[1-2]|一|二|两)\s*星(?:级)?(?:\s*[:：])?/g, "$1少数低分反馈");
  text = text.replace(/(^|[\s（(])3\s*星(?:级)?(?:\s*[:：])?/g, "$1中性反馈");
  text = text.replace(/(^|[\s（(])(?:[4-5]|四|五)\s*星(?:级)?(?:\s*[:：])?/g, "$1正面反馈");
  text = text.replace(/\b(?:中文翻译|原文|评论ID|reviewId|ASIN|asin|站点|site|链接|url|用户昵称|主页)\s*[:：]?\s*/gi, "");
  text = text.replace(/\b(?:中文翻译|原文|评论ID|reviewId|ASIN|asin|站点|site|链接|url|用户昵称|主页)\b/gi, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function stripTokens(text, tokens) {
  let value = String(text || "");
  for (const token of [...new Set((tokens || []).map((item) => String(item || "").trim()).filter(Boolean))]) {
    value = value.split(token).join("");
  }
  return value;
}

function compactAnalysisMarkdown(markdown) {
  const lines = normalizeAnalysisMarkdown(markdown)
    .split("\n")
    .map((line) => line.trimEnd());
  const out = [];
  let sectionHeading = "";
  let subheadingCount = 0;
  let paragraphCount = 0;
  let bulletCount = 0;
  let listMode = false;
  let evidenceMode = false;

  const resetSection = (title = "") => {
    sectionHeading = title;
    subheadingCount = 0;
    paragraphCount = 0;
    bulletCount = 0;
    listMode = false;
    evidenceMode = /证据|evidence/i.test(title);
  };

  const resetBlock = () => {
    paragraphCount = 0;
    bulletCount = 0;
    listMode = false;
  };

  resetSection();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (level <= 3) {
        out.push(line);
        resetSection(title);
        continue;
      }
      if (level === 4) {
        if (!evidenceMode && subheadingCount >= 3) continue;
        subheadingCount += 1;
        resetBlock();
        out.push(line);
        continue;
      }
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      out.push("---");
      continue;
    }

    const isBullet = /^[-*]\s+/.test(line);
    const isNumbered = /^\d+\.\s+/.test(line);
    if (isBullet || isNumbered) {
      if (!listMode) {
        listMode = true;
        bulletCount = 0;
      }
      const bulletLimit = evidenceMode ? 5 : 3;
      if (bulletCount >= bulletLimit) continue;
      bulletCount += 1;
      out.push(line);
      continue;
    }

    listMode = false;
    const paragraphLimit = evidenceMode ? 4 : 2;
    if (paragraphCount >= paragraphLimit) continue;
    paragraphCount += 1;
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(String(text || ""));
  const linkTokens = [];
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    const token = `__LINK_${linkTokens.length}__`;
    linkTokens.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
    return token;
  });
  html = html.replace(/https?:\/\/[^\s<]+/g, "");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/__LINK_(\d+)__/g, (_match, index) => linkTokens[Number(index)] || "");
  return html;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const out = [];
  let inList = false;
  let inOrderedList = false;
  let inBlockquote = false;
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const text = paragraphLines.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push(`<p>${renderInlineMarkdown(text)}</p>`);
    paragraphLines = [];
  };
  const closeLists = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (inOrderedList) {
      out.push("</ol>");
      inOrderedList = false;
    }
  };

  const closeQuote = () => {
    if (inBlockquote) {
      out.push("</blockquote>");
      inBlockquote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const text = line.trim();
    if (!text) {
      flushParagraph();
      closeLists();
      closeQuote();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
      flushParagraph();
      closeLists();
      closeQuote();
      out.push("<hr>");
      continue;
    }
    const heading = text.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeLists();
      closeQuote();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(text)) {
      flushParagraph();
      closeQuote();
      if (inOrderedList) {
        out.push("</ol>");
        inOrderedList = false;
      }
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInlineMarkdown(text.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(text)) {
      flushParagraph();
      closeQuote();
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (!inOrderedList) {
        out.push("<ol>");
        inOrderedList = true;
      }
      out.push(`<li>${renderInlineMarkdown(text.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }
    if (/^>\s?/.test(text)) {
      flushParagraph();
      closeLists();
      if (!inBlockquote) {
        out.push("<blockquote>");
        inBlockquote = true;
      }
      out.push(`<p>${renderInlineMarkdown(text.replace(/^>\s?/, ""))}</p>`);
      continue;
    }
    closeLists();
    closeQuote();
    paragraphLines.push(text);
  }
  flushParagraph();
  if (inList) out.push("</ul>");
  if (inOrderedList) out.push("</ol>");
  if (inBlockquote) out.push("</blockquote>");
  return out.join("\n");
}

function ratingDistribution(rows) {
  const counts = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
  rows.forEach((row) => {
    const rating = Math.round(Number.parseFloat(row.rating));
    if (counts[String(rating)] !== undefined) counts[String(rating)] += 1;
  });
  return counts;
}

function ratingNarrative(rows) {
  const counts = ratingDistribution(rows);
  const low = counts["1"] + counts["2"];
  const neutral = counts["3"];
  const high = counts["4"] + counts["5"];
  if (!rows.length) return "暂无可用样本。";
  if (low === 0 && high > 0) return "整体口碑偏正面，负面反馈不多。";
  if (high >= low * 2 && low > 0) return "整体口碑偏正面，但少量低分反馈主要集中在耐用性、结构稳定性和做工细节。";
  if (low > high) return "口碑分化较明显，低分反馈和正面反馈都不少，需要优先盯住核心缺陷。";
  if (neutral > high && neutral > low) return "反馈比较中性，用户还在观望，说明产品体验并没有形成特别强的记忆点。";
  return "整体评价还不错，但仍有几个明显问题需要重点处理。";
}

function reportHtml(analysisMarkdown, rows, state) {
  const asins = [...new Set(rows.map((row) => row.asin).filter(Boolean))];
  const reviewIds = [...new Set(rows.map((row) => row.reviewId).filter(Boolean))];
  const sites = [...new Set(rows.map((row) => row.siteLabel).filter(Boolean))];
  const markdown = stripTokens(humanizeAnalysisMarkdown(compactAnalysisMarkdown(analysisMarkdown)), [...asins, ...reviewIds]);
  const narrative = markdown ? markdownToHtml(markdown) : "<p>AI 未返回可展示的分析正文。</p>";
  const overviewText = rows.length
    ? `这份报告只保留给运营看的结论、痛点、亮点和改法，细节请看导出的 Excel。`
    : "本报告未检测到可分析的已验证购买评论。";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>亚马逊竞品评论分析报告</title>
  <style>
    :root{font-family:"Microsoft YaHei",Arial,sans-serif;color:#172033;background:#f3f6fb}
    *{box-sizing:border-box}
    body{margin:0;background:linear-gradient(180deg,#f6f8fc 0%,#edf2f8 100%)}
    .report{max-width:1180px;margin:0 auto;padding:34px 28px 48px}
    header{padding:28px 30px;border:1px solid #dbe3ee;border-radius:16px;background:linear-gradient(180deg,#ffffff 0%,#f8fbff 100%);color:#132033;box-shadow:0 10px 30px rgba(20,35,58,.06)}
    header h1{margin:0 0 8px;font-size:32px;line-height:1.15;color:#132033}
    header p{max-width:100%;margin:0;color:#516178;line-height:1.8;font-size:15px}
    .chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
    .chips span{padding:7px 11px;border-radius:999px;background:#edf3fb;color:#23344c;font-size:13px;border:1px solid #dce6f2}
    section{border:1px solid #dce3ee;border-radius:14px;background:#fff;box-shadow:0 6px 20px rgba(24,39,75,.04)}
    section{margin-top:16px;padding:22px}
    section h2{margin:0 0 14px;font-size:20px;color:#172033}
    .section-note{margin:0 0 16px;color:#52627a;line-height:1.7}
    .markdown-body{color:#1b2740;line-height:1.86;font-size:15px}
    .markdown-body h2,.markdown-body h3,.markdown-body h4{margin:16px 0 10px;color:#132033;line-height:1.3}
    .markdown-body h2{font-size:22px}
    .markdown-body h3{font-size:18px}
    .markdown-body h4{font-size:16px}
    .markdown-body p{margin:0 0 11px}
    .markdown-body ul,.markdown-body ol{margin:0 0 11px 18px;padding:0}
    .markdown-body li{margin:0 0 5px}
    .markdown-body blockquote{margin:12px 0;padding:10px 14px;border-left:4px solid #c9d8ea;background:#f7faff;color:#43556f}
    .markdown-body hr{border:0;border-top:1px solid #e6edf5;margin:14px 0}
    .markdown-body code{padding:2px 6px;border-radius:6px;background:#eef3f8;font-family:Menlo,Consolas,monospace;font-size:.92em}
    .markdown-body a{color:#0b63ce;text-decoration:none}
    .markdown-body a:hover{text-decoration:underline}
    .markdown-body h3:first-child{margin-top:0}
    footer{margin-top:18px;color:#66758a;font-size:12px;line-height:1.65}
    @media (max-width:780px){.report{padding:18px 12px}header{padding:22px}header h1{font-size:24px}section{padding:18px}.markdown-body{font-size:14px}}
  </style>
</head>
<body>
  <main class="report">
    <header>
      <h1>亚马逊竞品评论报告</h1>
      <p>${escapeHtml(overviewText)}</p>
      <div class="chips">
        <span>ASIN：${escapeHtml(asins.join("、") || activeAsins(state).join("、") || "-")}</span>
        <span>站点：${escapeHtml(sites.join("、") || "-")}</span>
      </div>
    </header>
    <section>
      <h2>一眼看懂</h2>
      <p>${escapeHtml(ratingNarrative(rows))}</p>
    </section>
    <section>
      <h2>运营解读</h2>
      <p class="section-note">下面这部分只保留适合快速判断的内容，明细已经放在 Excel 里。</p>
      <div class="markdown-body">${narrative}</div>
    </section>
    <footer>报告基于插件采集并导出的已验证购买评论生成。Excel 保留明细，这份报告只看结论、痛点、亮点和改法。</footer>
  </main>
</body>
</html>`;
}

function exportBaseName(state) {
  const asins = activeAsins(state);
  const now = new Date();
  const dateStamp = formatDateParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const asinPart = asins[0] || state.asin || "export";
  const multiPart = asins.length > 1 || (Array.isArray(state.sites) && state.sites.length > 1) ? "-multi" : "";
  return `${asinPart}${multiPart}-${dateStamp}`;
}


async function prepareReportPackage() {
  if (reportPreparationInProgress) return;
  reportPreparationInProgress = true;
  try {
    const state = await getState();
    const config = await getAgentConfig();
    if (!hasAgentConfig(config)) throw new Error("请先在 AI Agent 中配置并测试连接");
    const tasks = activeTasks(state);
    const completedTaskCount = (state.completedTasks || []).filter((key) => tasks.some((task) => task.key === key)).length;
    const allTasksCompleted = tasks.length > 0 && completedTaskCount >= tasks.length;
    if (state.running || !allTasksCompleted) throw new Error("任务还没有全部完成");

    const startedAt = Date.now();
    await setState({
      reportStatus: "preparing",
      reportError: "",
      reportPackage: null,
      reportPackageName: "",
      reportStartedAt: startedAt,
      reportFinishedAt: 0,
      reportTrace: [reportTraceLine("开始生成 AI 报告")],
      message: "正在生成 AI 分析报告…"
    });
    await appendReportTrace(`已完成采集：${state.reviews.length} 条原始评论`);
    const { state: exportState, filteredCount, reviews, failed, rows } = await prepareExportData();
    await appendReportTrace(`筛选已验证购买评论：${filteredCount} 条`);
    await setState({ reviews, message: "评论数据已整理，正在调用 AI 分析…" });
    const payload = analysisRequestPayload(exportState, rows);
    const payloadSizeKb = Math.ceil(JSON.stringify(payload).length / 1024);
    await appendReportTrace(`开始调用 AI 分析，输入 ${rows.length} 条评论，约 ${payloadSizeKb} KB`);
    const analysisStartedAt = Date.now();
    const heartbeatId = setInterval(() => {
      appendReportTrace(`AI 分析仍在进行中，已等待 ${formatDuration(Date.now() - analysisStartedAt)}`).catch(() => {});
    }, ANALYSIS_HEARTBEAT_MS);
    let analysisResult;
    try {
      analysisResult = await callAnalysisAgent(config, rows, exportState, payload);
    } finally {
      clearInterval(heartbeatId);
    }
    const { agentUrl, result: rawAnalysis } = analysisResult;
    await appendReportTrace(`AI 分析完成，耗时 ${formatDuration(Date.now() - analysisStartedAt)}，接口 ${normalizeBaseUrl(agentUrl)}`);
    const resolvedConfig = normalizeBaseUrl(agentUrl) !== normalizeBaseUrl(config.agentUrl)
      ? { ...config, agentUrl }
      : config;
    if (resolvedConfig.agentUrl !== config.agentUrl) {
      await setAgentConfig(resolvedConfig);
    }
    const analysisMarkdown = normalizeAnalysisMarkdown(rawAnalysis);
    if (!analysisMarkdown) throw new Error("AI 没有返回可展示的分析正文");
    await appendReportTrace(`AI 报告正文已收到，长度 ${analysisMarkdown.length} 字符`);
    await appendReportTrace("开始打包 AI 报告");
    const report = reportHtml(analysisMarkdown, rows, exportState);
    const baseName = exportBaseName(exportState);
    const zip = await packageBlob([
      { name: `${baseName}-report.html`, content: new Blob([report], { type: "text/html;charset=utf-8" }) }
    ]);
    await appendReportTrace("HTML 报告已生成，正在压缩成 ZIP");
    const packageBase64 = bytesToBase64(new Uint8Array(await zip.arrayBuffer()));
    await appendReportTrace(`报告包已打包完成，准备保存为 ZIP`);
    await setState({
      reviews,
      reportStatus: "ready",
      reportError: "",
      reportPackage: packageBase64,
      reportPackageName: `${baseName}.zip`,
      reportFinishedAt: Date.now(),
      message: failed ? `AI 报告已准备好，${failed} 条翻译失败并保留原文` : `AI 报告已准备好，已验证购买 ${rows.length} 条`
    });
    await appendReportTrace(`AI 报告已准备好，总耗时 ${formatDuration(Date.now() - startedAt)}`);
    return { ok: true };
  } catch (error) {
    const errorLine = reportTraceLine(`报告准备失败：${error.message}`);
    console.error(errorLine);
    const currentState = await getState();
    await setState({
      reportStatus: "error",
      reportError: error.message,
      reportFinishedAt: Date.now(),
      reportTrace: [...(currentState.reportTrace || []), errorLine].slice(-20),
      message: `报告准备失败：${error.message}`
    });
    return { ok: false, error: error.message };
  } finally {
    reportPreparationInProgress = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PREPARE_REPORT") {
    prepareReportPackage()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
