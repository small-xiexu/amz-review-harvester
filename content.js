const BLOCK_PATTERNS = [
  "captcha",
  "enter the characters you see below",
  "请输入您在下图中看到的字符",
  "robot check",
  "sorry, we just need to make sure you're not a robot"
];
let collectionInProgress = false;
let loadMoreTimer = null;

const SITE_CONFIG = {
  US: { domain: "www.amazon.com", label: "美国站" },
  CA: { domain: "www.amazon.ca", label: "加拿大站" },
  MX: { domain: "www.amazon.com.mx", label: "墨西哥站" }
};

function text(root, selector) {
  return root.querySelector(selector)?.textContent?.trim() || "";
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

function removeLeadingRating(value, rating) {
  let title = compactText(value);
  const ratingText = compactText(rating);
  if (ratingText && title.toLowerCase().startsWith(ratingText.toLowerCase())) {
    title = title.slice(ratingText.length).trim();
  }
  return looksLikeRating(title, ratingText) ? "" : title;
}

function extractReviewTitle(review, rating) {
  const titleRoot = review.querySelector("[data-hook='review-title']");
  if (!titleRoot) return "";

  const spanTitle = [...titleRoot.querySelectorAll("span")]
    .map((node) => removeLeadingRating(node.textContent, rating))
    .filter(Boolean)
    .pop();
  if (spanTitle) return spanTitle;

  return removeLeadingRating(titleRoot.textContent, rating);
}

function extractColor(variant) {
  const colorMatch = compactText(variant).match(
    /(?:Color|Colour|颜色|Couleur)\s*[:：]\s*(.+?)(?=(?:Size|Taille|Tamaño|尺寸)\s*[:：]|[|,，;；]|$)/i
  );
  return colorMatch?.[1]?.trim() || "";
}

function extractSize(variant) {
  const sizeMatch = compactText(variant).match(
    /(?:Size|Taille|Tamaño|尺寸)\s*[:：]\s*(.+?)(?=(?:Color|Colour|颜色|Couleur)\s*[:：]|[|,，;；]|$)/i
  );
  return sizeMatch?.[1]?.trim() || "";
}

function extractHelpfulCount(review) {
  const helpfulText = [
    text(review, "[data-hook='helpful-vote-statement']"),
    ...[...review.querySelectorAll("span")]
      .map((node) => node.textContent?.trim() || "")
      .filter((value) => /helpful|utile|útil/i.test(value))
  ].find(Boolean) || "";
  const normalized = compactText(helpfulText).toLowerCase();
  if (!normalized) return "";
  if (/one|un|une|uno|una|1/.test(normalized)) return "1";
  const countMatch = normalized.match(/(\d[\d,.]*)/);
  return countMatch ? countMatch[1].replace(/[,.]/g, "") : "";
}

function hasReviewImage(review) {
  return Boolean(
    review.querySelector("img[data-hook*='review'], img[src*='customerReviews'], [data-hook*='review-image'], .review-image-tile")
  );
}

function imageSource(image) {
  const source = image.currentSrc || image.src || image.getAttribute("data-src") || "";
  if (!source) return "";
  try {
    return new URL(source, location.href).href;
  } catch {
    return source;
  }
}

function highResolutionImageUrl(url) {
  return String(url || "").replace(/\._[^.]+_?(?=\.)/, "");
}

function extractImageUrls(review) {
  const selectors = [
    "img[data-hook*='review']",
    "img[src*='customerReviews']",
    "[data-hook*='review-image'] img",
    ".review-image-tile img"
  ];
  const urls = [...review.querySelectorAll(selectors.join(","))]
    .map(imageSource)
    .map(highResolutionImageUrl)
    .filter(Boolean)
    .filter((url) => !/grey-pixel|transparent|avatar|profile/i.test(url));
  return [...new Set(urls)];
}

function hasReviewVideo(review) {
  return Boolean(
    review.querySelector("video, [data-hook*='review-video'], [data-hook*='video']")
  );
}

function extractProfileUrl(review) {
  const link = review.querySelector("a.a-profile, a[href*='/gp/profile/'], a[href*='/profile/']");
  const href = link?.getAttribute("href") || "";
  if (!href) return "";
  try {
    return new URL(href, location.origin).href;
  } catch {
    return href;
  }
}

function isBlockedPage() {
  const body = document.body?.innerText?.toLowerCase() || "";
  return BLOCK_PATTERNS.some((pattern) => body.includes(pattern)) ||
    Boolean(document.querySelector("form[action*='validateCaptcha'], #captchacharacters"));
}

function isLoginPage() {
  if (/\/ap\/signin|\/gp\/signin|\/signin/i.test(location.pathname + location.search + location.hash)) return true;
  return Boolean(document.querySelector(
    "#ap_email, #ap_password, form[name='signIn'], form#ap_signin_form, input[name='email'], input[name='password']"
  ));
}

function isReviewPage() {
  return location.pathname.includes("/product-reviews/") || Boolean(document.querySelector("[data-hook='review']"));
}

function extractReviews(asin, site) {
  return [...document.querySelectorAll("[data-hook='review']")].map((review) => {
    const id = review.id || review.getAttribute("data-review-id") || "";
    const variant = text(review, "[data-hook='format-strip']");
    const rating = text(review, "[data-hook='review-star-rating']") || text(review, "[data-hook='cmps-review-star-rating']");
    const imageUrls = extractImageUrls(review);
    return {
      asin,
      site,
      reviewId: id,
      title: extractReviewTitle(review, rating),
      rating,
      date: text(review, "[data-hook='review-date']"),
      variant,
      color: extractColor(variant),
      size: extractSize(variant),
      verified: text(review, "[data-hook='avp-badge']"),
      helpfulCount: extractHelpfulCount(review),
      imageUrls,
      imageCount: imageUrls.length,
      hasBuyerImage: imageUrls.length || hasReviewImage(review) ? "是" : "否",
      hasVideo: hasReviewVideo(review) ? "是" : "否",
      author: text(review, ".a-profile-name"),
      authorProfileUrl: extractProfileUrl(review),
      body: text(review, "[data-hook='review-body'] span") || text(review, "[data-hook='review-body']"),
      url: id ? `${location.origin}/gp/customer-reviews/${id}` : location.href
    };
  });
}

function mergeReviews(existing, incoming) {
  const map = new Map(existing.map((review) => [review.reviewId || `${review.author}|${review.date}|${review.body}`, review]));
  for (const review of incoming) {
    map.set(review.reviewId || `${review.author}|${review.date}|${review.body}`, review);
  }
  return [...map.values()];
}

function findLoadMoreButton() {
  const selectors = [
    "[data-hook='load-more-reviews']",
    "[data-hook='see-all-reviews-link-foot']",
    "button",
    "[role='button']",
    "a.a-button-text",
    "input[type='button']",
    "input[type='submit']"
  ];
  const patterns = [
    /show\s+\d+\s+more\s+reviews?/i,
    /show\s+more\s+reviews?/i,
    /更多.*评论/,
    /plus.*commentaires/i,
    /más.*reseñas/i
  ];
  const candidates = [...document.querySelectorAll(selectors.join(","))];
  return candidates.find((element) => {
    const label = `${element.textContent || ""} ${element.value || ""} ${element.getAttribute("aria-label") || ""}`.trim();
    const visible = Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    return visible && !element.disabled && patterns.some((pattern) => pattern.test(label));
  }) || null;
}

function waitForNewReviews(previousCount, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const count = document.querySelectorAll("[data-hook='review']").length;
      if (count > previousCount) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 750);
    };
    check();
  });
}

function waitForLoadMoreButton(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const button = findLoadMoreButton();
      if (button) {
        resolve(button);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, 750);
    };
    check();
  });
}

async function updateState(patch) {
  const { collectorState = {} } = await chrome.storage.local.get("collectorState");
  const next = { ...collectorState, ...patch };
  if (patch.running === false && patch.nextActionAt === undefined) {
    next.nextActionAt = 0;
  }
  await chrome.storage.local.set({ collectorState: next });
  return next;
}

function activeAsins(state) {
  if (Array.isArray(state.asins) && state.asins.length) return state.asins;
  return state.asin ? [state.asin] : [];
}

function activeTasks(state) {
  if (Array.isArray(state.tasks) && state.tasks.length) return state.tasks;
  const sites = Array.isArray(state.sites) && state.sites.length ? state.sites : [state.site || "US"];
  return sites.flatMap((site) => activeAsins(state).map((asin) => ({
    key: `${site}:${asin}`,
    asin,
    site
  })));
}

function activeTask(state) {
  const tasks = activeTasks(state);
  return tasks[Math.min(Number(state.currentTaskIndex ?? state.currentAsinIndex ?? 0), Math.max(tasks.length - 1, 0))] || null;
}

function siteLabel(site) {
  return SITE_CONFIG[site]?.label || site || "未知站点";
}

function reviewPageUrl(state, asin, pageNumber = 1) {
  const domain = SITE_CONFIG[state.site]?.domain || SITE_CONFIG.US.domain;
  return `https://${domain}/product-reviews/${asin}/?reviewerType=all_reviews&sortBy=recent&pageNumber=${pageNumber}`;
}

function pageCountsByTask(state, task, pageCount) {
  return { ...(state.pageCountsByTask || {}), [task.key]: pageCount };
}

async function finishCurrentTask(state, reviews, pageCount, reason, expectedTask = activeTask(state)) {
  const tasks = activeTasks(state);
  const task = expectedTask;
  const expectedIndex = tasks.findIndex((item) => item.key === task?.key);
  const currentIndex = expectedIndex >= 0
    ? expectedIndex
    : Math.min(Number(state.currentTaskIndex ?? state.currentAsinIndex ?? 0), Math.max(tasks.length - 1, 0));
  const completedTasks = [...new Set([...(state.completedTasks || []), task?.key].filter(Boolean))];
  const completedAsins = [...new Set([...(state.completedAsins || []), task?.asin].filter(Boolean))];
  const counts = pageCountsByTask(state, task, pageCount);
  const nextIndex = currentIndex + 1;
  const nextTask = tasks[nextIndex];

  if (nextTask) {
    await updateState({
      reviews,
      asin: nextTask.asin,
      site: nextTask.site,
      currentTaskIndex: nextIndex,
      currentAsinIndex: activeAsins(state).indexOf(nextTask.asin),
      pageCount: counts[nextTask.key] || 0,
      pageCountsByTask: counts,
      completedAsins,
      completedTasks,
      lastProcessedUrl: "",
      nextActionAt: 0,
      message: `${reason}，正在打开第 ${nextIndex + 1}/${tasks.length} 个任务：${nextTask.asin} / ${nextTask.site}`
    });
    location.href = reviewPageUrl({ ...state, site: nextTask.site }, nextTask.asin, 1);
    return;
  }

  const finalMessage = tasks.length > 1
    ? `${reason}，全部 ${tasks.length} 个任务已完成，共保存 ${reviews.length} 条评论`
    : `${reason}，共保存 ${reviews.length} 条评论`;

  await updateState({
    running: false,
    reviews,
    pageCount,
    pageCountsByTask: counts,
    completedAsins,
    completedTasks,
    reportStatus: "preparing",
    reportError: "",
    reportPackage: null,
    reportPackageName: "",
    reportStartedAt: Date.now(),
    reportFinishedAt: 0,
    reportTrace: [],
    message: `${finalMessage}，正在准备报告`
  });
  chrome.runtime.sendMessage({ type: "PREPARE_REPORT" }, () => {
    if (!chrome.runtime.lastError) return;
    updateState({
      reportStatus: "error",
      reportError: chrome.runtime.lastError.message,
      reportFinishedAt: Date.now(),
      reportTrace: [`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} 采集完成，但后台报告任务启动失败：${chrome.runtime.lastError.message}`],
      message: `采集完成，但后台报告任务启动失败：${chrome.runtime.lastError.message}`
    });
  });
}

async function collect() {
  if (collectionInProgress) return;
  collectionInProgress = true;
  if (loadMoreTimer) {
    clearTimeout(loadMoreTimer);
    loadMoreTimer = null;
  }

  const { collectorState: state } = await chrome.storage.local.get("collectorState");
  if (!state?.running) {
    collectionInProgress = false;
    return;
  }

  const task = activeTask(state);
  const asin = task?.asin || "";
  const site = task?.site || state.site || "US";

  if (isBlockedPage()) {
    await updateState({ running: false, message: "检测到验证码或访问限制，已自动暂停" });
    collectionInProgress = false;
    return;
  }

  if (isLoginPage()) {
    await updateState({
      running: false,
      message: `${siteLabel(site)}需要重新登录，登录后点击“开始 / 继续”即可接着采集`
    });
    collectionInProgress = false;
    return;
  }

  const expectedDomain = SITE_CONFIG[site]?.domain || SITE_CONFIG.US.domain;
  if (location.hostname !== expectedDomain) {
    location.href = reviewPageUrl({ ...state, site }, asin, 1);
    collectionInProgress = false;
    return;
  }

  if (!isReviewPage()) {
    await updateState({ running: false, message: "当前不是评论页面，请打开“查看全部评论”后继续" });
    collectionInProgress = false;
    return;
  }
  if (!location.pathname.toUpperCase().includes(asin)) {
    await updateState({ running: false, message: `当前评论页面与 ASIN ${asin} 不一致，已暂停` });
    collectionInProgress = false;
    return;
  }

  const incoming = extractReviews(asin, site);
  const reviews = mergeReviews(state.reviews || [], incoming);
  const newReviewCount = reviews.length - (state.reviews || []).length;
  const currentPageCount = Number(state.pageCountsByTask?.[task.key] ?? state.pageCountsByAsin?.[asin] ?? state.pageCount ?? 0);
  const pageCount = currentPageCount + (newReviewCount > 0 ? 1 : 0);
  const counts = pageCountsByTask(state, task, pageCount);

  if (!incoming.length) {
    await updateState({ running: false, reviews, message: "当前页面未识别到评论，已暂停" });
    collectionInProgress = false;
    return;
  }

  if (pageCount >= state.maxPages) {
    await finishCurrentTask(state, reviews, pageCount, `${asin} / ${site} 已达到本次上限`, task);
    collectionInProgress = false;
    return;
  }

  const min = Math.max(20, Number(state.minDelay || 45));
  const max = Math.max(min, Number(state.maxDelay || 90));
  const delay = Math.floor(min + Math.random() * (max - min + 1));
  const nextActionAt = Date.now() + delay * 1000;
  const loadMoreButton = await waitForLoadMoreButton();
  if (!loadMoreButton) {
    await finishCurrentTask(state, reviews, pageCount, `${asin} / ${site} 未找到“Show 10 more reviews”按钮`, task);
    collectionInProgress = false;
    return;
  }

  await updateState({
    reviews,
    pageCount,
    pageCountsByTask: counts,
    lastProcessedUrl: location.href,
    nextActionAt,
    message: `${asin} / ${site} ${newReviewCount > 0 ? `本批新增 ${newReviewCount} 条` : "当前批次均已保存"}，等待自动点击“Show 10 more reviews”`
  });

  collectionInProgress = false;
  loadMoreTimer = setTimeout(async () => {
    const { collectorState: latest } = await chrome.storage.local.get("collectorState");
    if (!latest?.running) return;
    if (activeTask(latest)?.key !== task.key) return;

    const button = findLoadMoreButton();
    if (!button) {
      const { collectorState: latestState } = await chrome.storage.local.get("collectorState");
      await finishCurrentTask(latestState || state, reviews, pageCount, `${asin} / ${site} 加载更多按钮已消失`, task);
      return;
    }

    const previousCount = document.querySelectorAll("[data-hook='review']").length;
    button.scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    button.click();
    await updateState({ nextActionAt: 0, message: "已点击加载更多，正在等待新评论出现…" });

    const loaded = await waitForNewReviews(previousCount);
    if (!loaded) {
      const { collectorState: latestState } = await chrome.storage.local.get("collectorState");
      await finishCurrentTask(latestState || state, reviews, pageCount, `${asin} / ${site} 点击后 20 秒内没有新评论`, task);
      return;
    }
    collect();
  }, delay * 1000);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "COLLECT_NOW") collect();
});

setTimeout(collect, 2500);
