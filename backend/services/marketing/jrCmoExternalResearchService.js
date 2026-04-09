const axios = require("axios");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("marketing:jr-cmo-external-research");

const DEFAULT_QUERIES = Object.freeze([
  "legal industry attorneys paralegals",
  "law firms legal operations legal tech",
  "attorney paralegal workload hiring compliance",
]);

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function compactText(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function decodeEntities(value = "") {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function clipSentence(value = "", max = 180) {
  const text = compactText(value, max);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function externalResearchEnabled() {
  return truthyEnv(process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED);
}

function researchTimeoutMs() {
  return Math.max(1000, Number(process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_TIMEOUT_MS || 8000));
}

function maxResearchItems() {
  return Math.max(2, Math.min(12, Number(process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_MAX_ITEMS || 6)));
}

function configuredQueries() {
  const raw = String(process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_QUERIES || "").trim();
  if (!raw) return [...DEFAULT_QUERIES];
  return raw
    .split(/\n|,/)
    .map((entry) => compactText(entry, 180))
    .filter(Boolean)
    .slice(0, 6);
}

function buildGoogleNewsRssUrl(query = "") {
  const encoded = encodeURIComponent(String(query || "").trim());
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

function extractTagValue(block = "", tagName = "") {
  const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(block);
  return decodeEntities(match?.[1] || "");
}

function safeIsoDate(value = "") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseGoogleNewsRss(xml = "", query = "") {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match = itemRegex.exec(String(xml || ""));
  while (match) {
    const block = match[1] || "";
    const title = compactText(extractTagValue(block, "title").replace(/\s*-\s*[^-]+$/, ""), 220);
    const link = compactText(extractTagValue(block, "link"), 500);
    const pubDateRaw = extractTagValue(block, "pubDate");
    const sourceMatch = /<source\b[^>]*?(?:url="([^"]+)")?[^>]*>([\s\S]*?)<\/source>/i.exec(block);
    const sourceName = compactText(decodeEntities(sourceMatch?.[2] || ""), 120);
    const sourceUrl = compactText(sourceMatch?.[1] || "", 500);
    if (title && link) {
      items.push({
        title,
        link,
        sourceName,
        sourceUrl,
        query,
        publishedAt: pubDateRaw ? safeIsoDate(pubDateRaw) : "",
      });
    }
    match = itemRegex.exec(String(xml || ""));
  }
  return items;
}

function uniqueBy(items = [], selector = (item) => item) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = selector(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function classifyExternalTone(items = []) {
  const text = (Array.isArray(items) ? items : [])
    .map((item) => item.title)
    .join(" ")
    .toLowerCase();

  const cautiousSignals = (text.match(/\b(layoff|slowdown|pressure|risk|scrutiny|regulation|compliance|uncertain|cutback|downturn|soften)\b/g) || [])
    .length;
  const momentumSignals = (text.match(/\b(growth|expand|adoption|invest|investment|hiring|improve|launch|release|rollout|demand rises|gain)\b/g) || [])
    .length;
  const credibilitySignals = (text.match(/\b(standard|compliance|discipline|quality|professional|governance|ethics)\b/g) || []).length;

  if (cautiousSignals >= Math.max(2, momentumSignals + 1)) {
    return {
      toneRecommendation: "cautious",
      toneReasoning: "External legal-industry coverage is leaning risk-aware or constrained today, so LPC should sound restrained and careful rather than expansive.",
    };
  }
  if (momentumSignals >= 2 && momentumSignals > cautiousSignals) {
    return {
      toneRecommendation: "quiet_momentum",
      toneReasoning: "External legal-industry coverage is showing measured forward movement today, so LPC can sound quietly current without slipping into hype.",
    };
  }
  if (credibilitySignals >= 1) {
    return {
      toneRecommendation: "credible",
      toneReasoning: "External coverage is centering standards, governance, or professional discipline, so LPC should keep the tone credible and premium.",
    };
  }
  return {
    toneRecommendation: "focused",
    toneReasoning: "External coverage is mixed, so LPC should keep the tone focused and factual rather than chasing a stronger emotional register.",
  };
}

function buildIndustryClimateSummary({ now = new Date(), items = [], tone = {} } = {}) {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(now));
  const topLines = uniqueBy(items, (item) => item.title.toLowerCase())
    .slice(0, 3)
    .map((item) => item.title);

  return compactText(
    `As of ${dateLabel}, external legal-industry coverage suggests a ${String(tone.toneRecommendation || "focused").replace(
      /_/g,
      " "
    )} day. Recent signal includes ${topLines.join("; ")}.`,
    2000
  );
}

async function fetchGoogleNewsItems({ now = new Date(), axiosClient = axios } = {}) {
  const timeout = researchTimeoutMs();
  const queries = configuredQueries();
  const responses = await Promise.allSettled(
    queries.map((query) =>
      axiosClient.get(buildGoogleNewsRssUrl(query), {
        timeout,
        headers: {
          "User-Agent": "LetsParaConnect Jr CMO Research/1.0",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      })
    )
  );

  const items = [];
  responses.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      logger.warn("Jr. CMO external query failed.", {
        query: queries[index],
        error: result.reason?.message || result.reason || "unknown_error",
      });
      return;
    }
    items.push(...parseGoogleNewsRss(result.value?.data || "", queries[index]));
  });

  return uniqueBy(items, (item) => item.link || item.title.toLowerCase())
    .slice(0, maxResearchItems())
    .sort((left, right) => {
      const leftTime = new Date(left.publishedAt || 0).getTime();
      const rightTime = new Date(right.publishedAt || 0).getTime();
      return rightTime - leftTime;
    });
}

async function buildExternalDayResearch({ now = new Date(), axiosClient = axios } = {}) {
  if (!externalResearchEnabled()) {
    return {
      ok: false,
      reason: "disabled",
      sourceMode: "internal_only",
      items: [],
      activeSignals: [],
      sourceRefs: [],
    };
  }

  try {
    const items = await fetchGoogleNewsItems({ now, axiosClient });
    if (!items.length) {
      return {
        ok: false,
        reason: "no_external_results",
        sourceMode: "internal_only",
        items: [],
        activeSignals: [],
        sourceRefs: [],
      };
    }

    const tone = classifyExternalTone(items);
    return {
      ok: true,
      provider: "google_news_rss",
      sourceMode: "external_research",
      toneRecommendation: tone.toneRecommendation,
      toneReasoning: tone.toneReasoning,
      industryClimateSummary: buildIndustryClimateSummary({ now, items, tone }),
      activeSignals: uniqueBy(items, (item) => item.title.toLowerCase())
        .slice(0, 4)
        .map((item) => clipSentence(item.title, 180)),
      items,
      sourceRefs: items.slice(0, 4).map((item) => ({
        label: item.title,
        url: item.link,
        source: item.sourceName || item.query,
        publishedAt: item.publishedAt || "",
      })),
    };
  } catch (err) {
    logger.warn("Jr. CMO external research failed; falling back to internal-only day context.", err?.message || err);
    return {
      ok: false,
      reason: "external_research_failed",
      sourceMode: "internal_only",
      error: err?.message || String(err || ""),
      items: [],
      activeSignals: [],
      sourceRefs: [],
    };
  }
}

module.exports = {
  buildExternalDayResearch,
  classifyExternalTone,
  externalResearchEnabled,
  fetchGoogleNewsItems,
  parseGoogleNewsRss,
};
