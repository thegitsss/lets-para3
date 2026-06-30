import { requireAuth, secureFetch, logoutUser } from "./auth.js";

const directorSession = requireAuth("director");

const stageFilter = document.getElementById("stageFilter");
const rangeFilter = document.getElementById("rangeFilter");
const statusEl = document.getElementById("directorStatus");
const recordsBody = document.getElementById("recordsBody");
const identityEl = document.getElementById("directorIdentity");
const translucencyRange = document.getElementById("cardTranslucencyRange");
const translucencyValue = document.getElementById("cardTranslucencyValue");
const backgroundInput = document.getElementById("dashboardBackgroundInput");
const resetAppearanceBtn = document.getElementById("resetAppearanceBtn");
const doneAppearanceBtn = document.getElementById("doneAppearanceBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const openZohoBtn = document.getElementById("openZohoBtn");
const appearanceModeBtns = Array.from(document.querySelectorAll("[data-appearance-mode]"));
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";
const RECORDS_PER_PAGE = 10;
const APPEARANCE_KEY = `lpc_director_dashboard_appearance:${directorSession.user?._id || directorSession.user?.id || directorSession.user?.email || "director"}`;
const LAST_IMPORT_KEY = `lpc_director_last_import:${directorSession.user?._id || directorSession.user?.id || directorSession.user?.email || "director"}`;
const ZOHO_MAIL_URL = "https://mail.zoho.com/";
const ZOHO_MAIL_APP_URL = "zohomail://";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let currentRecords = [];
let currentPage = 1;
let statusTimer = null;
let autoRefreshTimer = null;
let portalLoadInFlight = false;

function getSelectedRangeDays() {
  const value = Number(rangeFilter?.value || 7);
  return [1, 7, 30].includes(value) ? value : 7;
}

function recordMatchesRange(record = {}, days = 7) {
  const safeDays = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;
  const dateValues = [
    record.firstOutreachSentAt,
    record.followUpSentAt,
    record.lastReplyAt,
    record.registeredAt,
    record.firstMatterPostedAt,
    record.firstMatterCompletedAt,
  ]
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (!dateValues.length) return false;
  const end = new Date(Math.max(...DEMO_RECORDS.flatMap((item) => [
    item.firstOutreachSentAt,
    item.followUpSentAt,
    item.lastReplyAt,
    item.registeredAt,
    item.firstMatterPostedAt,
    item.firstMatterCompletedAt,
  ]).map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime())).map((date) => date.getTime())));
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (safeDays - 1));
  start.setHours(0, 0, 0, 0);
  return dateValues.some((date) => date >= start && date <= end);
}

const DEMO_RECORDS = [
  {
    id: "demo-1",
    attorneyName: "Jordan Ellis",
    attorneyEmail: "jordan.ellis@examplelaw.com",
    state: "TX",
    stage: "commission_complete",
    stageLabel: "Commission Complete",
    firstOutreachSentAt: "2026-06-03T14:15:00.000Z",
    followUpSentAt: null,
    registeredAt: "2026-06-05T18:20:00.000Z",
    firstMatterPostedAt: "2026-06-07T16:30:00.000Z",
    firstMatterCompletedAt: "2026-06-18T19:15:00.000Z",
    commissionEarnedCents: 11000,
  },
  {
    id: "demo-2",
    attorneyName: "Amelia Reyes",
    attorneyEmail: "areyes@reyesfirm.example",
    state: "TX",
    stage: "matter_posted",
    stageLabel: "Matter Posted",
    firstOutreachSentAt: "2026-06-06T15:10:00.000Z",
    followUpSentAt: null,
    registeredAt: "2026-06-09T13:00:00.000Z",
    firstMatterPostedAt: "2026-06-15T17:45:00.000Z",
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-3",
    attorneyName: "Marcus Chen",
    attorneyEmail: "mchen@chenlegal.example",
    state: "TX",
    stage: "attorney_registered",
    stageLabel: "Attorney Registered",
    firstOutreachSentAt: "2026-06-10T16:40:00.000Z",
    followUpSentAt: null,
    registeredAt: "2026-06-13T20:15:00.000Z",
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-4",
    attorneyName: "Priya Shah",
    attorneyEmail: "pshah@shahlaw.example",
    state: "TX",
    stage: "follow_up_sent",
    stageLabel: "Follow-Up Auto Sent",
    firstOutreachSentAt: "2026-06-01T14:05:00.000Z",
    followUpSentAt: "2026-06-17T13:30:00.000Z",
    registeredAt: "2026-06-08T15:00:00.000Z",
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-5",
    attorneyName: "Nathan Brooks",
    attorneyEmail: "nbrooks@brookspllc.example",
    state: "TX",
    stage: "founder_attention",
    stageLabel: "Founder Attention",
    firstOutreachSentAt: "2026-06-12T18:10:00.000Z",
    followUpSentAt: null,
    registeredAt: null,
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-6",
    attorneyName: "Grace Whitman",
    attorneyEmail: "gwhitman@whitmanlaw.example",
    state: "TX",
    stage: "outreach_sent",
    stageLabel: "Outreach Sent",
    firstOutreachSentAt: "2026-06-20T12:50:00.000Z",
    followUpSentAt: null,
    registeredAt: null,
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-7",
    attorneyName: "Evan Castillo",
    attorneyEmail: "ecastillo@castillolegal.example",
    state: "TX",
    stage: "outreach_sent",
    stageLabel: "Outreach Sent",
    firstOutreachSentAt: "2026-06-21T13:25:00.000Z",
    followUpSentAt: null,
    registeredAt: null,
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-8",
    attorneyName: "Leah Morgan",
    attorneyEmail: "lmorgan@morganlaw.example",
    state: "TX",
    stage: "attorney_registered",
    stageLabel: "Attorney Registered",
    firstOutreachSentAt: "2026-06-14T14:55:00.000Z",
    followUpSentAt: null,
    registeredAt: "2026-06-18T16:05:00.000Z",
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-9",
    attorneyName: "Daniel Foster",
    attorneyEmail: "dfoster@fosterpllc.example",
    state: "TX",
    stage: "matter_completed",
    stageLabel: "Matter Completed",
    firstOutreachSentAt: "2026-05-28T15:45:00.000Z",
    followUpSentAt: null,
    registeredAt: "2026-06-02T18:30:00.000Z",
    firstMatterPostedAt: "2026-06-04T21:10:00.000Z",
    firstMatterCompletedAt: "2026-06-24T14:40:00.000Z",
    commissionEarnedCents: 0,
  },
  {
    id: "demo-10",
    attorneyName: "Monica Patel",
    attorneyEmail: "mpatel@patellaw.example",
    state: "TX",
    stage: "commission_complete",
    stageLabel: "Commission Complete",
    firstOutreachSentAt: "2026-05-24T12:35:00.000Z",
    followUpSentAt: null,
    registeredAt: "2026-05-30T15:45:00.000Z",
    firstMatterPostedAt: "2026-06-02T17:20:00.000Z",
    firstMatterCompletedAt: "2026-06-19T20:00:00.000Z",
    commissionEarnedCents: 8800,
  },
  {
    id: "demo-11",
    attorneyName: "Caleb Nguyen",
    attorneyEmail: "cnguyen@nguyenlaw.example",
    state: "TX",
    stage: "follow_up_sent",
    stageLabel: "Follow-Up Auto Sent",
    firstOutreachSentAt: "2026-06-02T17:15:00.000Z",
    followUpSentAt: "2026-06-20T13:00:00.000Z",
    registeredAt: "2026-06-11T14:10:00.000Z",
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
  {
    id: "demo-12",
    attorneyName: "Sofia Martin",
    attorneyEmail: "smartin@martinlegal.example",
    state: "TX",
    stage: "founder_attention",
    stageLabel: "Founder Attention",
    firstOutreachSentAt: "2026-06-22T18:20:00.000Z",
    followUpSentAt: null,
    registeredAt: null,
    firstMatterPostedAt: null,
    firstMatterCompletedAt: null,
    commissionEarnedCents: 0,
  },
];

function buildDemoOverview() {
  const counts = DEMO_RECORDS.reduce(
    (acc, record) => {
      acc.total += 1;
      acc[record.stage] = (acc[record.stage] || 0) + 1;
      acc.commissionEarnedCents += Number(record.commissionEarnedCents || 0);
      if (record.stage === "commission_complete") acc.commissionableMatterCount += 1;
      return acc;
    },
    { total: 0, commissionEarnedCents: 0, commissionableMatterCount: 0 }
  );
  return {
    profile: {
      displayName: "Skyler Director",
      zohoEmail: "skyler@lets-paraconnect.com",
    },
    counts,
    attention: {
      founderReplies: counts.founder_attention || 0,
      followUpsAutoSent: counts.follow_up_sent || 0,
      commissionableRecords: DEMO_RECORDS.filter((record) => Number(record.commissionableMatterCount || 0) > 0 || Number(record.commissionEarnedCents || 0) > 0).length,
    },
    lastSyncedAt: DEMO_RECORDS.reduce((latest, record) => {
      const newest = [
        record.firstOutreachSentAt,
        record.followUpSentAt,
        record.lastReplyAt,
        record.registeredAt,
        record.firstMatterPostedAt,
        record.firstMatterCompletedAt,
      ]
        .map((value) => (value ? new Date(value).getTime() : 0))
        .reduce((max, value) => Math.max(max, value), 0);
      return newest > latest ? newest : latest;
    }, 0),
  };
}

function buildAnalyticsFromRecords(records = [], days = 14) {
  const safeDays = Math.min(90, Math.max(1, Number(days) || 14));
  const dates = (records || [])
    .flatMap((record) => [
      record.firstOutreachSentAt,
      record.followUpSentAt,
      record.lastReplyAt,
      record.registeredAt,
      record.firstMatterPostedAt,
      record.firstMatterCompletedAt,
    ])
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));
  const end = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (safeDays - 1));
  const series = [];
  const byDate = new Map();
  for (let i = 0; i < safeDays; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = date.toISOString().slice(0, 10);
    const bucket = {
      date: key,
      emailsSent: 0,
      registrations: 0,
      followUps: 0,
      replies: 0,
      mattersPosted: 0,
      mattersCompleted: 0,
      commissionableMatters: 0,
    };
    byDate.set(key, bucket);
    series.push(bucket);
  }
  const increment = (value, field, amount = 1) => {
    if (!value) return;
    const key = new Date(value).toISOString().slice(0, 10);
    const bucket = byDate.get(key);
    if (bucket) bucket[field] += amount;
  };
  records.forEach((record) => {
    increment(record.firstOutreachSentAt, "emailsSent");
    increment(record.followUpSentAt, "followUps");
    increment(record.lastReplyAt, "replies");
    increment(record.registeredAt, "registrations");
    increment(record.firstMatterPostedAt, "mattersPosted");
    increment(record.firstMatterCompletedAt, "mattersCompleted");
    if (record.firstMatterCompletedAt) {
      increment(record.firstMatterCompletedAt, "commissionableMatters", Number(record.commissionableMatterCount || 0));
    }
  });
  const totals = series.reduce(
    (acc, bucket) => {
      Object.keys(acc).forEach((key) => {
        if (key in bucket) acc[key] += Number(bucket[key] || 0);
      });
      return acc;
    },
    { emailsSent: 0, registrations: 0, followUps: 0, replies: 0, mattersPosted: 0, mattersCompleted: 0, commissionableMatters: 0 }
  );
  totals.conversionRatePct = totals.emailsSent ? Math.round((totals.registrations / totals.emailsSent) * 100) : 0;
  totals.replyRatePct = totals.emailsSent ? Math.round((totals.replies / totals.emailsSent) * 100) : 0;
  return {
    range: {
      start: series[0]?.date || "",
      end: series[series.length - 1]?.date || "",
      days: series.length,
    },
    totals,
    series,
  };
}

function setStatus(message, { tone = "", transient = false } = {}) {
  if (!statusEl) return;
  clearTimeout(statusTimer);
  statusEl.classList.remove("success", "error", "fade-out");
  if (tone) statusEl.classList.add(tone);
  statusEl.textContent = message || "";
  if (transient && message) {
    statusTimer = setTimeout(() => {
      statusEl.classList.add("fade-out");
      statusTimer = setTimeout(() => {
        statusEl.textContent = "";
        statusEl.classList.remove("success", "error", "fade-out");
      }, 260);
    }, 2600);
  }
}

function openSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.hidden = false;
  settingsCloseBtn?.focus();
}

function closeSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.hidden = true;
  settingsBtn?.focus();
}

function isMobileDevice() {
  return (
    window.matchMedia?.("(max-width: 760px)")?.matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
  );
}

function openZohoMail() {
  if (isMobileDevice()) {
    const startedAt = Date.now();
    window.location.href = ZOHO_MAIL_APP_URL;
    window.setTimeout(() => {
      if (Date.now() - startedAt < 1800) {
        window.location.href = ZOHO_MAIL_URL;
      }
    }, 900);
    return;
  }
  window.open(ZOHO_MAIL_URL, "_blank", "noopener,noreferrer");
}

function readLastImportAt() {
  try {
    return localStorage.getItem(LAST_IMPORT_KEY) || "";
  } catch (_) {
    return "";
  }
}

function saveLastImportAt(value = new Date().toISOString()) {
  try {
    localStorage.setItem(LAST_IMPORT_KEY, value);
  } catch (_) {}
  renderLastImportAt(value);
}

function renderLastImportAt(value = readLastImportAt()) {
  const el = document.getElementById("lastImportAt");
  if (!el) return;
  if (!value) {
    el.textContent = "";
    return;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    el.textContent = "";
    return;
  }
  el.textContent = `Last import: ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function readAppearance() {
  try {
    return JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "{}") || {};
  } catch (_) {
    return {};
  }
}

function saveAppearance(nextAppearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(nextAppearance));
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeTranslucency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function normalizeLuminance(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(255, Math.max(0, numeric));
}

function normalizeColorMode(value) {
  return String(value || "").toLowerCase() === "dark" ? "dark" : "light";
}

function applyAdaptiveCardPalette({ alpha, backgroundLuminance, colorMode = "light" }) {
  const root = document.documentElement;
  const mode = normalizeColorMode(colorMode);
  const luminance = normalizeLuminance(backgroundLuminance);
  const hasMeasuredDarkBackground = luminance !== null && luminance < 118;
  const isMostlyGlass = alpha < 0.45;
  const useLightCardText = mode === "dark" || (hasMeasuredDarkBackground && isMostlyGlass);
  const cardRgb = mode === "dark" ? "15, 23, 42" : "255, 255, 255";

  root.dataset.directorContrast = useLightCardText ? "dark-bg" : "light-bg";
  root.dataset.directorMode = mode;
  root.style.setProperty("--director-ink", mode === "dark" ? "#f8fafc" : "#120f13");
  root.style.setProperty("--director-muted", mode === "dark" ? "rgba(248, 250, 252, 0.7)" : "#89838c");
  root.style.setProperty("--director-bg", mode === "dark" ? "#101820" : "#f4f5f7");
  root.style.setProperty("--director-panel", mode === "dark" ? "#111827" : "#ffffff");
  root.style.setProperty("--director-card-bg", `rgba(${cardRgb}, var(--director-card-alpha))`);
  root.style.setProperty("--director-card-line", mode === "dark" ? "rgba(248, 250, 252, 0.16)" : "rgba(255, 255, 255, 0.42)");
  root.style.setProperty("--director-card-ink", useLightCardText ? "#f8fafc" : "#120f13");
  root.style.setProperty("--director-card-muted", useLightCardText ? "rgba(248, 250, 252, 0.72)" : "#89838c");
  root.style.setProperty("--director-chart-grid", useLightCardText ? "rgba(248, 250, 252, 0.18)" : "rgba(18, 15, 19, 0.08)");
  root.style.setProperty("--director-chart-bar", useLightCardText ? "rgba(147, 197, 253, 0.22)" : "rgba(91, 142, 233, 0.2)");
  root.style.setProperty("--director-graph-primary", useLightCardText ? "#bfdbfe" : "#4f8ee8");
  root.style.setProperty("--director-graph-secondary", useLightCardText ? "#fda4af" : "#c94e68");
  root.style.setProperty("--director-graph-tertiary", useLightCardText ? "#c4b5fd" : "#625cc0");
  root.style.setProperty("--director-dot-idle", useLightCardText ? "rgba(248, 250, 252, 0.22)" : "rgba(227, 229, 233, 0.88)");
  root.style.setProperty("--director-soft-track", useLightCardText ? "rgba(248, 250, 252, 0.2)" : "rgba(18, 15, 19, 0.08)");
  root.style.setProperty("--director-control-bg", useLightCardText ? "rgba(15, 23, 42, 0.28)" : "rgba(255, 255, 255, 0.9)");
  root.style.setProperty("--director-control-line", useLightCardText ? "rgba(248, 250, 252, 0.24)" : "rgba(18, 15, 19, 0.08)");
  root.style.setProperty("--director-hover-bg", useLightCardText ? "rgba(248, 250, 252, 0.12)" : "rgba(255, 255, 255, 0.38)");
}

function deriveUiLuminanceFromPixels(pixels) {
  const values = [];
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    values.push(luminance);
    total += luminance;
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mean = total / values.length;
  const median = values[Math.floor(values.length * 0.5)];
  const upper = values[Math.floor(values.length * 0.72)];
  return mean * 0.25 + median * 0.25 + upper * 0.5;
}

function applyAppearance({ translucency = 0, backgroundImage = "", backgroundLuminance = null, colorMode = "light" } = {}) {
  const normalizedTranslucency = normalizeTranslucency(translucency);
  const normalizedMode = normalizeColorMode(colorMode);
  const alpha = 1 - normalizedTranslucency * 0.0098;
  document.documentElement.style.setProperty("--director-card-alpha", String(alpha));
  document.documentElement.style.setProperty(
    "--director-background-overlay",
    normalizedMode === "dark"
      ? "linear-gradient(135deg, rgba(15, 18, 24, 0.9), rgba(28, 32, 40, 0.82))"
      : "linear-gradient(135deg, rgba(255, 255, 255, 0.84), rgba(244, 245, 247, 0.78))"
  );
  document.documentElement.style.setProperty(
    "--director-photo-overlay",
    normalizedMode === "dark"
      ? "linear-gradient(135deg, rgba(10, 12, 16, 0.45), rgba(10, 12, 16, 0.35))"
      : "linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(18, 15, 19, 0.08))"
  );
  document.body?.classList.toggle("director-mode-dark", normalizedMode === "dark");
  applyAdaptiveCardPalette({ alpha, backgroundLuminance, colorMode: normalizedMode });
  const applyPhotoClass = () => {
    if (!document.body) return;
    document.body.classList.toggle("has-director-photo-bg", !!backgroundImage);
  };

  if (backgroundImage) {
    document.documentElement.style.setProperty("--director-background-image", `url("${backgroundImage}")`);
  } else {
    document.documentElement.style.setProperty("--director-background-image", "none");
  }
  if (document.body) applyPhotoClass();
  else document.addEventListener("DOMContentLoaded", applyPhotoClass, { once: true });

  if (translucencyRange) translucencyRange.value = String(normalizedTranslucency);
  if (translucencyValue) translucencyValue.textContent = `${normalizedTranslucency}%`;
  appearanceModeBtns.forEach((button) => {
    const active = button.dataset.appearanceMode === normalizedMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function updateAppearance(patch = {}) {
  const current = readAppearance();
  const next = {
    translucency: normalizeTranslucency(
      Object.prototype.hasOwnProperty.call(patch, "translucency") ? patch.translucency : current.translucency
    ),
    backgroundImage: Object.prototype.hasOwnProperty.call(patch, "backgroundImage")
      ? patch.backgroundImage || ""
      : current.backgroundImage || "",
    backgroundLuminance: Object.prototype.hasOwnProperty.call(patch, "backgroundLuminance")
      ? normalizeLuminance(patch.backgroundLuminance)
      : normalizeLuminance(current.backgroundLuminance),
    colorMode: normalizeColorMode(
      Object.prototype.hasOwnProperty.call(patch, "colorMode") ? patch.colorMode : current.colorMode
    ),
  };
  if (!next.backgroundImage) next.backgroundLuminance = null;
  applyAppearance(next);
  if (!saveAppearance(next)) {
    setStatus("That image is too large to save in this browser. Try a smaller image.");
  }
}

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Unable to load image."));
      img.onload = () => {
        const maxDimension = 2200;
        const scale = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((img.width || 1) * scale));
        canvas.height = Math.max(1, Math.round((img.height || 1) * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Unable to process image."));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let luminance = null;
        try {
          const sampleWidth = Math.min(80, canvas.width);
          const sampleHeight = Math.min(80, canvas.height);
          const sampleCanvas = document.createElement("canvas");
          sampleCanvas.width = sampleWidth;
          sampleCanvas.height = sampleHeight;
          const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
          if (!sampleCtx) throw new Error("Unable to sample image.");
          sampleCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
          const pixels = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
          luminance = deriveUiLuminanceFromPixels(pixels);
        } catch (_) {
          luminance = null;
        }
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.82), luminance });
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

function measureImageLuminance(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Unable to load image."));
    img.onload = () => {
      try {
        const sampleWidth = Math.min(80, img.width || 1);
        const sampleHeight = Math.min(80, img.height || 1);
        const canvas = document.createElement("canvas");
        canvas.width = sampleWidth;
        canvas.height = sampleHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Unable to sample image.");
        ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
        const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
        resolve(deriveUiLuminanceFromPixels(pixels));
      } catch (err) {
        reject(err);
      }
    };
    img.src = source;
  });
}

async function ensureAppearanceLuminance() {
  const appearance = readAppearance();
  if (!appearance.backgroundImage) return;
  try {
    const luminance = await measureImageLuminance(appearance.backgroundImage);
    if (Math.abs((normalizeLuminance(appearance.backgroundLuminance) ?? -1) - luminance) > 1) {
      updateAppearance({ backgroundLuminance: luminance });
    }
  } catch (_) {
    /* Existing background remains usable without adaptive sampling. */
  }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `Last synced: ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readJsonOrThrow(res, fallback) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || payload?.message || fallback);
  return payload;
}

function renderOverview(payload = {}) {
  const counts = payload.counts || {};
  const total = Number(counts.total || 0);
  const emailsSent = total;
  const registered =
    Number(counts.attorney_registered || 0) +
    Number(counts.follow_up_needed || 0) +
    Number(counts.follow_up_sent || 0);
  const completedMatterCount = Math.min(50, Number(counts.commissionableMatterCount || 0));
  const conversionPct = emailsSent ? Math.round((registered / emailsSent) * 100) : 0;
  const rangeDays = Number(payload.range?.days || getSelectedRangeDays());
  const rangeLabel = rangeDays === 1 ? "today" : rangeDays === 7 ? "last 7 days" : "last 30 days";

  document.getElementById("countTotal").textContent = String(total);
  document.getElementById("countFollowUp").textContent = String(counts.follow_up_sent || 0);
  document.getElementById("countAttention").textContent = String(counts.founder_attention || 0);
  document.getElementById("countCommission").textContent = formatMoney(counts.commissionEarnedCents || 0);
  document.getElementById("lastSyncedAt").textContent = formatDateTime(payload.lastSyncedAt);
  renderLastImportAt();
  const emptyState = document.getElementById("directorEmptyState");
  if (emptyState) emptyState.classList.toggle("visible", total === 0);

  const attention = payload.attention || {};
  document.getElementById("attentionReplies").textContent = String(attention.founderReplies || counts.founder_attention || 0);
  document.getElementById("attentionFollowUps").textContent = String(attention.followUpsAutoSent || counts.follow_up_sent || 0);
  document.getElementById("attentionFailedFollowUps").textContent = String(attention.followUpsFailed || counts.follow_up_failed || 0);
  document.getElementById("attentionCommission").textContent = String(attention.commissionableRecords || 0);

  const emailsSentEl = document.getElementById("metricEmailsSent");
  const conversionEl = document.getElementById("metricConversionRate");
  const completedEl = document.getElementById("metricCompletedMatters");
  const completedCapEl = document.getElementById("metricCompletedCap");
  const completedBarEl = document.getElementById("completedMatterBar");

  if (emailsSentEl) emailsSentEl.textContent = String(emailsSent);
  if (conversionEl) conversionEl.textContent = `${conversionPct}%`;
  if (completedEl) completedEl.textContent = String(completedMatterCount);
  if (completedCapEl) completedCapEl.textContent = `${completedMatterCount}/50`;
  if (completedBarEl) completedBarEl.style.width = `${Math.min(100, completedMatterCount * 2)}%`;

  if (payload.profile) {
    if (identityEl) identityEl.textContent = `${payload.profile.displayName || "Director"} · ${payload.profile.zohoEmail}`;
  }
  document.querySelectorAll("[data-range-note]").forEach((node) => {
    node.textContent = rangeLabel;
  });
}

function seriesValues(series = [], key = "") {
  return (Array.isArray(series) ? series : []).map((item) => Number(item?.[key] || 0));
}

function setMiniBars(selector, values = []) {
  const bars = Array.from(document.querySelectorAll(`${selector} span`));
  if (!bars.length) return;
  const data = values.slice(-bars.length);
  while (data.length < bars.length) data.unshift(0);
  const max = Math.max(1, ...data);
  bars.forEach((bar, index) => {
    const value = data[index] || 0;
    bar.style.height = `${Math.max(16, Math.round((value / max) * 82))}%`;
    bar.style.opacity = value ? "1" : "0.28";
  });
}

function setDotGrid(selector, activeCount = 0) {
  const dots = Array.from(document.querySelectorAll(`${selector} span`));
  if (!dots.length) return;
  const active = Math.min(dots.length, Math.max(0, Number(activeCount) || 0));
  dots.forEach((dot, index) => {
    dot.style.background = index < active ? "rgba(104, 198, 138, 0.62)" : "var(--director-dot-idle)";
  });
}

function setArcGauge(percent = 0) {
  const arc = document.querySelector(".arc-chart");
  if (!arc) return;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const end = 16 + clamped * 0.6;
  arc.style.background = `
    radial-gradient(circle at center bottom, var(--director-card-bg) 0 52%, transparent 53%),
    conic-gradient(from 245deg, transparent 0 16%, #8bb7f4 16% ${end}%, var(--director-soft-track) ${end}% 76%, transparent 76% 100%)
  `;
}

function pointsForSeries(values = [], { width = 900, height = 246, padding = 18, max = 1 } = {}) {
  const data = values.length ? values : [0];
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const denominator = Math.max(1, data.length - 1);
  return data
    .map((value, index) => {
      const x = padding + (index / denominator) * usableWidth;
      const y = height - padding - (Number(value || 0) / max) * usableHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function renderPerformanceChart(analytics = {}) {
  const chart = document.querySelector(".performance-chart");
  const svg = chart?.querySelector("svg");
  if (!chart || !svg) return;
  const series = Array.isArray(analytics.series) ? analytics.series : [];
  const emailValues = seriesValues(series, "emailsSent");
  const registrationValues = seriesValues(series, "registrations");
  const completedValues = seriesValues(series, "mattersCompleted");
  const max = Math.max(1, ...emailValues, ...registrationValues, ...completedValues);
  svg.innerHTML = `
    <polyline points="${pointsForSeries(emailValues, { max })}" fill="none" stroke="var(--director-graph-primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <polyline points="${pointsForSeries(registrationValues, { max })}" fill="none" stroke="var(--director-graph-secondary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <polyline points="${pointsForSeries(completedValues, { max })}" fill="none" stroke="var(--director-graph-tertiary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
  `;
}

function renderAnalytics(analytics = {}) {
  const totals = analytics.totals || {};
  const series = Array.isArray(analytics.series) ? analytics.series : [];
  const emailsSent = Number(totals.emailsSent || 0);
  const conversionPct = Number(totals.conversionRatePct || 0);
  const completedMatterCount = Math.min(50, Number(totals.commissionableMatters || 0));
  const registeredCount = Number(totals.registrations || 0);
  const followUpsSent = Number(totals.followUps || 0);

  const emailsSentEl = document.getElementById("metricEmailsSent");
  const registeredEl = document.getElementById("metricRegisteredCount");
  const conversionEl = document.getElementById("metricConversionRate");
  const completedEl = document.getElementById("metricCompletedMatters");
  const completedCapEl = document.getElementById("metricCompletedCap");
  const completedBarEl = document.getElementById("completedMatterBar");
  const followUpsSentEl = document.getElementById("metricFollowUpsSent");

  if (emailsSentEl) emailsSentEl.textContent = String(emailsSent);
  if (registeredEl) registeredEl.textContent = String(registeredCount);
  if (conversionEl) conversionEl.textContent = `${conversionPct}%`;
  if (completedEl) completedEl.textContent = String(completedMatterCount);
  if (completedCapEl) completedCapEl.textContent = `${completedMatterCount}/50`;
  if (completedBarEl) completedBarEl.style.width = `${Math.min(100, completedMatterCount * 2)}%`;
  if (followUpsSentEl) followUpsSentEl.textContent = String(followUpsSent);

  setArcGauge(emailsSent ? Math.min(100, emailsSent * 8) : 0);
  setDotGrid(".open-card .dot-grid", registeredCount);
  setMiniBars(".conversion-card .mini-bars", seriesValues(series, "registrations"));
  renderPerformanceChart(analytics);
}

function renderRecords(records = [], { preservePage = false } = {}) {
  const previousPage = currentPage;
  currentRecords = Array.isArray(records) ? records : [];
  currentPage = preservePage ? previousPage : 1;
  renderCurrentRecordsPage();
}

function renderCurrentRecordsPage() {
  if (!recordsBody) return;
  if (!currentRecords.length) {
    const filterLabel = stageFilter?.selectedOptions?.[0]?.textContent || "this view";
    recordsBody.innerHTML = `
      <tr class="records-empty">
        <td colspan="9">
          <strong>No attorneys found</strong>
          ${escapeHTML(filterLabel === "All stages" ? "Import today to add records." : `No records match ${filterLabel}.`)}
        </td>
      </tr>
    `;
    renderPagination();
    return;
  }
  const totalPages = Math.max(1, Math.ceil(currentRecords.length / RECORDS_PER_PAGE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * RECORDS_PER_PAGE;
  const pageRecords = currentRecords.slice(start, start + RECORDS_PER_PAGE);

  recordsBody.innerHTML = pageRecords
    .map((record) => {
      const stage = String(record.stage || "");
      const stageClass =
        stage === "founder_attention"
          ? " attention"
          : stage === "follow_up_failed"
          ? " attention"
          : stage === "attorney_registered" || stage === "follow_up_needed"
          ? " registered"
          : stage === "follow_up_sent"
          ? " registered"
          : stage === "matter_posted" || stage === "matter_completed"
          ? " matter"
          : stage === "commission_complete"
          ? " commission"
          : "";
      return `
        <tr>
          <td data-label="Attorney">${escapeHTML(record.attorneyName || "—")}</td>
          <td data-label="Email">${escapeHTML(record.attorneyEmail || "—")}</td>
          <td data-label="State">${escapeHTML(record.state || "—")}</td>
          <td data-label="Stage"><span class="director-badge${stageClass}">${escapeHTML(record.stageLabel || record.stage || "—")}</span></td>
          <td data-label="Outreach">${escapeHTML(formatDate(record.firstOutreachSentAt))}</td>
          <td data-label="Follow-Up">${escapeHTML(formatDate(record.followUpSentAt))}</td>
          <td data-label="Registered">${escapeHTML(formatDate(record.registeredAt))}</td>
          <td data-label="Matter">${escapeHTML(formatDate(record.firstMatterPostedAt || record.firstMatterCompletedAt))}</td>
          <td data-label="Commission">${escapeHTML(formatMoney(record.commissionEarnedCents || 0))}</td>
        </tr>
      `;
    })
    .join("");
  renderPagination();
}

function renderPagination() {
  const pagination = document.getElementById("recordsPagination");
  const pageInfo = document.getElementById("recordsPageInfo");
  const prevBtn = document.getElementById("recordsPrevBtn");
  const nextBtn = document.getElementById("recordsNextBtn");
  if (!pagination || !pageInfo || !prevBtn || !nextBtn) return;

  const total = currentRecords.length;
  const totalPages = Math.max(1, Math.ceil(total / RECORDS_PER_PAGE));
  const shouldShow = total > RECORDS_PER_PAGE;
  pagination.hidden = !shouldShow;
  if (!shouldShow) return;

  const start = (currentPage - 1) * RECORDS_PER_PAGE + 1;
  const end = Math.min(total, currentPage * RECORDS_PER_PAGE);
  pageInfo.textContent = `${start}-${end} of ${total}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

async function loadPortal({ silent = false, preservePage = false } = {}) {
  if (portalLoadInFlight) return;
  portalLoadInFlight = true;
  if (DEMO_MODE) {
    try {
      const stage = stageFilter?.value || "";
      const rangeDays = getSelectedRangeDays();
      const rangedRecords = DEMO_RECORDS.filter((record) => recordMatchesRange(record, rangeDays));
      const records = stage ? rangedRecords.filter((record) => record.stage === stage) : rangedRecords;
      const overview = buildDemoOverview();
      overview.counts = rangedRecords.reduce(
        (acc, record) => {
          acc.total += 1;
          acc[record.stage] = (acc[record.stage] || 0) + 1;
          acc.commissionEarnedCents += Number(record.commissionEarnedCents || 0);
          acc.commissionableMatterCount += Number(record.commissionableMatterCount || 0);
          return acc;
        },
        { total: 0, commissionEarnedCents: 0, commissionableMatterCount: 0 }
      );
      overview.attention = {
        founderReplies: rangedRecords.filter((record) => record.stage === "founder_attention").length,
        followUpsAutoSent: rangedRecords.filter((record) => record.stage === "follow_up_sent" || record.followUpSentAt).length,
        followUpsFailed: rangedRecords.filter((record) => record.stage === "follow_up_failed").length,
        commissionableRecords: rangedRecords.filter((record) => Number(record.commissionableMatterCount || 0) > 0 || Number(record.commissionEarnedCents || 0) > 0).length,
      };
      overview.range = { days: rangeDays };
      renderOverview(overview);
      renderAnalytics(buildAnalyticsFromRecords(rangedRecords, rangeDays));
      renderRecords(records, { preservePage });
      if (!silent) setStatus("");
    } finally {
      portalLoadInFlight = false;
    }
    return;
  }

  if (!silent) setStatus("");
  try {
    const rangeDays = getSelectedRangeDays();
    const recordParams = new URLSearchParams({
      stage: stageFilter?.value || "",
      rangeDays: String(rangeDays),
      limit: "250",
    });
    const [overviewRes, analyticsRes, recordsRes] = await Promise.all([
      secureFetch(`/api/director/overview?${new URLSearchParams({ rangeDays: String(rangeDays) })}`, { headers: { Accept: "application/json" } }),
      secureFetch(`/api/director/analytics?${new URLSearchParams({ days: String(rangeDays) })}`, { headers: { Accept: "application/json" } }),
      secureFetch(`/api/director/records?${recordParams}`, {
        headers: { Accept: "application/json" },
      }),
    ]);
    const overview = await readJsonOrThrow(overviewRes, "Unable to load director overview.");
    const analytics = await readJsonOrThrow(analyticsRes, "Unable to load director analytics.");
    const records = await readJsonOrThrow(recordsRes, "Unable to load director records.");
    renderOverview(overview);
    renderAnalytics(analytics);
    renderRecords(records.records || [], { preservePage });
    if (!silent) setStatus("");
  } catch (err) {
    if (!silent) {
      renderRecords([], { preservePage });
      setStatus("Unable to load.", { tone: "error" });
    } else {
      console.warn("[director] auto refresh failed", err);
    }
  } finally {
    portalLoadInFlight = false;
  }
}

function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = window.setInterval(() => {
    if (document.hidden || (settingsOverlay && !settingsOverlay.hidden)) return;
    loadPortal({ silent: true, preservePage: true }).catch(() => {});
  }, AUTO_REFRESH_MS);
}

async function importToday() {
  if (DEMO_MODE) {
    setStatus("Demo mode", { transient: true });
    return;
  }

  setStatus("Importing...");
  try {
    const res = await secureFetch("/api/director/import-today", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to import today's outreach.");
    await checkReplies({ silent: true, reload: false });
    saveLastImportAt();
    await loadPortal();
    setStatus(`Imported ${payload.imported || 0}`, { tone: "success", transient: true });
  } catch (err) {
    setStatus("Import unavailable. Try again later.", { tone: "error" });
  }
}

async function checkReplies({ silent = false, reload = true } = {}) {
  if (DEMO_MODE) return;

  if (!silent) setStatus("Checking replies...");
  try {
    const res = await secureFetch("/api/director/import-replies", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to check replies.");
    if (reload) await loadPortal();
    if (!silent) {
      setStatus(`Replies flagged: ${payload.imported || 0}`);
    }
  } catch (err) {
    if (!silent) setStatus(err?.message || "Unable to check replies.");
    else console.warn("[director] automatic reply check failed", err);
  }
}

document.getElementById("logoutBtn")?.addEventListener("click", logoutUser);
document.getElementById("importTodayBtn")?.addEventListener("click", importToday);
openZohoBtn?.addEventListener("click", openZohoMail);
settingsBtn?.addEventListener("click", openSettings);
settingsCloseBtn?.addEventListener("click", closeSettings);
settingsOverlay?.addEventListener("click", (event) => {
  if (event.target === settingsOverlay) closeSettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsOverlay && !settingsOverlay.hidden) {
    closeSettings();
  }
});
translucencyRange?.addEventListener("input", () => {
  updateAppearance({ translucency: translucencyRange.value });
});
backgroundInput?.addEventListener("change", async () => {
  const file = backgroundInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("Choose an image file for the dashboard background.");
    backgroundInput.value = "";
    return;
  }
  try {
    setStatus("Applying dashboard background...");
    const { dataUrl, luminance } = await resizeImageFile(file);
    updateAppearance({ backgroundImage: dataUrl, backgroundLuminance: luminance });
    setStatus("Background updated.");
  } catch (err) {
    setStatus(err?.message || "Unable to apply dashboard background.");
  } finally {
    backgroundInput.value = "";
  }
});
resetAppearanceBtn?.addEventListener("click", () => {
  const confirmed = window.confirm("Reset appearance settings?");
  if (!confirmed) return;
  try {
    localStorage.removeItem(APPEARANCE_KEY);
  } catch (_) {}
  applyAppearance({ translucency: 0, backgroundImage: "", colorMode: "light" });
  setStatus("Appearance reset.");
});
doneAppearanceBtn?.addEventListener("click", closeSettings);
appearanceModeBtns.forEach((button) => {
  button.addEventListener("click", () => {
    updateAppearance({ colorMode: button.dataset.appearanceMode || "light" });
  });
});
document.getElementById("recordsPrevBtn")?.addEventListener("click", () => {
  currentPage -= 1;
  renderCurrentRecordsPage();
});
document.getElementById("recordsNextBtn")?.addEventListener("click", () => {
  currentPage += 1;
  renderCurrentRecordsPage();
});
stageFilter?.addEventListener("change", () => loadPortal().catch(() => {}));
rangeFilter?.addEventListener("change", () => loadPortal().catch(() => {}));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadPortal({ silent: true, preservePage: true }).catch(() => {});
  }
});

applyAppearance(readAppearance());
ensureAppearanceLuminance();
loadPortal()
  .then(() => {
    scheduleAutoRefresh();
    return checkReplies({ silent: true });
  })
  .catch(() => {
    scheduleAutoRefresh();
  });
