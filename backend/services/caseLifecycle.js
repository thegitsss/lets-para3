// backend/services/caseLifecycle.js
// Utilities for case archives (ZIP generation + scheduled S3 purges).

const { PassThrough } = require("stream");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const puppeteer = require("puppeteer");
const {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Message = require("../models/Message");

const BUCKET = process.env.S3_BUCKET || "";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const CREDENTIALS =
  process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      }
    : undefined;

const s3 = new S3Client({ region: REGION, credentials: CREDENTIALS });
const PURGE_INTERVAL_MS = Math.max(30_000, Number(process.env.CASE_PURGE_INTERVAL_MS || 60_000));
const PURGE_BATCH_LIMIT = Math.max(1, Math.min(10, Number(process.env.CASE_PURGE_BATCH_LIMIT || 3)));
let purgeWorkerStarted = false;

function normalizeKey(key) {
  return String(key || "").replace(/^\/+/, "");
}

function safeFilename(input, { fallback = "file" } = {}) {
  const value = String(input || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  if (!value) return fallback;
  return value.length > 120 ? value.slice(0, 120) : value;
}

function formatDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatDateOnly(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleDateString("en-US", { dateStyle: "medium" });
}

function formatAmountDollars(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return "0.00";
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMessageTimestampParts(value) {
  if (!value) {
    return { date: "Unknown date", time: "" };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: "Unknown date", time: "" };
  }
  return {
    date: date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    time: date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
  };
}

function buildPersonName(person, fallback = "") {
  if (person && typeof person === "object") {
    const full = `${person.firstName || ""} ${person.lastName || ""}`.trim();
    if (full) return full;
  }
  return fallback || "";
}

function normalizeMessageText(value) {
  if (!value) return "";
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function getSenderKey(message) {
  const sender =
    message?.senderId?._id ||
    message?.senderId ||
    message?.userId?._id ||
    message?.userId ||
    "";
  return sender ? String(sender) : "";
}

function getTimestampMs(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function collectAttachmentNames(message) {
  const names = new Set();
  if (message?.fileName) names.add(String(message.fileName));
  if (message?.type === "file" && message?.text) names.add(String(message.text));
  const content = message?.content;
  if (content && typeof content === "object") {
    const candidates = [content.fileName, content.filename, content.name, content.originalName, content.original];
    for (const candidate of candidates) {
      if (candidate) names.add(String(candidate));
    }
    if (Array.isArray(content.files)) {
      for (const file of content.files) {
        const fileName = file?.fileName || file?.filename || file?.name || file?.originalName || file?.original;
        if (fileName) names.add(String(fileName));
      }
    }
  }
  return Array.from(names).filter(Boolean);
}

function ensureUniqueFilename(name, seen) {
  if (!seen.has(name)) {
    seen.set(name, 1);
    return name;
  }
  const count = seen.get(name) || 1;
  seen.set(name, count + 1);
  const extIndex = name.lastIndexOf(".");
  if (extIndex > 0) {
    return `${name.slice(0, extIndex)}-${count}${name.slice(extIndex)}`;
  }
  return `${name}-${count}`;
}

function buildFileMessage(fileDoc) {
  if (!fileDoc) return null;
  const fileName =
    fileDoc.originalName || fileDoc.filename || fileDoc.name || fileDoc.fileName || "Document";
  return {
    _id: fileDoc._id,
    createdAt: fileDoc.createdAt,
    senderId: fileDoc.userId || null,
    senderRole: fileDoc.userId?.role || "",
    type: "file",
    text: fileName,
    fileName,
  };
}

const EXPORT_LAYOUT = {
  maxWidth: 640,
  marginTop: 72,
  marginBottom: 96,
};
const EXPORT_COLORS = {
  text: "#1f1f1f",
  divider: "#e0e0e0",
  paralegal: "#4b6f8f",
  footer: "#b0b0b0",
  accent: "#C9A24D",
};
const EXPORT_FONT_NAME = "CormorantGaramondLight";
const EXPORT_FONT_PATH = path.resolve(__dirname, "..", "assets", "fonts", "CormorantGaramond-Light.ttf");
const EXPORT_FONT_AVAILABLE = fs.existsSync(EXPORT_FONT_PATH);
const RECEIPT_LOGO_PATH = path.resolve(__dirname, "..", "..", "frontend", "mountain-favicon.png");
const RECEIPT_LOGO_AVAILABLE = fs.existsSync(RECEIPT_LOGO_PATH);
const EXPORT_CACHE = {
  fontDataUri: null,
  receiptLogoDataUri: null,
};
const RECEIPT_FONT_WEIGHT = 300;
const ATTACHMENT_ASSOCIATION_WINDOW_MS = 15 * 60 * 1000;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toDataUri(filePath, mimeType) {
  if (!filePath) return "";
  try {
    const data = fs.readFileSync(filePath);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  } catch (err) {
    console.warn("[caseLifecycle] Unable to load asset", filePath, err?.message || err);
    return "";
  }
}

function getFontDataUri() {
  if (EXPORT_CACHE.fontDataUri !== null) {
    return EXPORT_CACHE.fontDataUri;
  }
  if (!EXPORT_FONT_AVAILABLE) {
    console.warn("[caseLifecycle] Export font not found:", EXPORT_FONT_PATH);
    EXPORT_CACHE.fontDataUri = "";
    return EXPORT_CACHE.fontDataUri;
  }
  EXPORT_CACHE.fontDataUri = toDataUri(EXPORT_FONT_PATH, "font/ttf");
  return EXPORT_CACHE.fontDataUri;
}

function getReceiptLogoDataUri() {
  if (EXPORT_CACHE.receiptLogoDataUri !== null) {
    return EXPORT_CACHE.receiptLogoDataUri;
  }
  if (!RECEIPT_LOGO_AVAILABLE) {
    console.warn("[caseLifecycle] Receipt logo not found:", RECEIPT_LOGO_PATH);
    EXPORT_CACHE.receiptLogoDataUri = "";
    return EXPORT_CACHE.receiptLogoDataUri;
  }
  EXPORT_CACHE.receiptLogoDataUri = toDataUri(RECEIPT_LOGO_PATH, "image/png");
  return EXPORT_CACHE.receiptLogoDataUri;
}

function normalizeReceiptLineItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      label: String(item?.label || "").trim(),
      value: String(item?.value || "").trim(),
    }))
    .filter((item) => item.label || item.value);
}

function buildCaseExportHtml(caseData, messages) {
  const fontDataUri = getFontDataUri();
  const bodyFontFamily = '"Times New Roman", Times, serif';
  const footerFontFamily = fontDataUri ? `'${EXPORT_FONT_NAME}'` : bodyFontFamily;
  const fontFaceCss = fontDataUri
    ? `@font-face { font-family: '${EXPORT_FONT_NAME}'; src: url('${fontDataUri}') format('truetype'); font-weight: 300; font-style: normal; }`
    : "";

  const attorneyName =
    buildPersonName(caseData.attorney, caseData.attorneyNameSnapshot) ||
    buildPersonName(caseData.attorneyId) ||
    "Attorney";
  const paralegalName =
    buildPersonName(caseData.paralegal, caseData.paralegalNameSnapshot) ||
    buildPersonName(caseData.paralegalId) ||
    "Paralegal";

  const amountCents =
    typeof caseData.totalAmount === "number"
      ? caseData.totalAmount
      : typeof caseData.lockedTotalAmount === "number"
        ? caseData.lockedTotalAmount
        : 0;
  const amountDisplay = formatAmountDollars(amountCents);

  const metadataRows = [
    ["Title", caseData.title || "Case"],
    ["Attorney", attorneyName],
    ["Paralegal", paralegalName],
    ["Completed", formatDateOnly(caseData.completedAt)],
    ["Payment", `$${amountDisplay}`],
  ]
    .map(
      ([label, value]) => `<div>${escapeHtml(label)}: ${escapeHtml(value)}</div>`
    )
    .join("");

  const messageEntries = [];
  const pendingAttachments = new Map();
  const lastMessageBySender = new Map();

  for (const msg of messages || []) {
    const senderKey = getSenderKey(msg);
    const senderName = buildPersonName(msg.senderId, "") || (msg.senderRole ? String(msg.senderRole) : "User");
    const role = String(msg.senderRole || msg.senderId?.role || "").toLowerCase();
    const roleClass = role.includes("para") ? "paralegal" : "attorney";
    const rawBody = normalizeMessageText(msg.text || msg.content || msg.transcript || "");
    const inlineAttachments = collectAttachmentNames(msg);
    const createdAt = msg.createdAt || null;
    const createdAtMs = getTimestampMs(createdAt);

    const isFileOnly = msg.type === "file" || (!rawBody && inlineAttachments.length);
    if (isFileOnly) {
      const names = inlineAttachments.length ? inlineAttachments : rawBody ? [rawBody] : [];
      if (names.length) {
        const attachToPrev = senderKey ? lastMessageBySender.get(senderKey) : null;
        if (
          attachToPrev &&
          createdAtMs !== null &&
          attachToPrev.createdAtMs !== null &&
          createdAtMs - attachToPrev.createdAtMs <= ATTACHMENT_ASSOCIATION_WINDOW_MS
        ) {
          names.forEach((name) => attachToPrev.attachments.add(name));
        } else if (senderKey) {
          const queue = pendingAttachments.get(senderKey) || [];
          names.forEach((name) =>
            queue.push({ name, createdAt, createdAtMs, senderName, senderRole: msg.senderRole, senderId: msg.senderId })
          );
          pendingAttachments.set(senderKey, queue);
        } else {
          messageEntries.push({
            senderName,
            roleClass,
            createdAt,
            createdAtMs,
            bodyText: "",
            attachments: new Set(names),
          });
        }
      }
      continue;
    }

    const attachments = new Set(inlineAttachments);
    if (senderKey && pendingAttachments.has(senderKey)) {
      const queued = pendingAttachments.get(senderKey) || [];
      const remaining = [];
      for (const item of queued) {
        if (
          createdAtMs !== null &&
          item.createdAtMs !== null &&
          createdAtMs - item.createdAtMs <= ATTACHMENT_ASSOCIATION_WINDOW_MS
        ) {
          attachments.add(item.name);
        } else {
          remaining.push(item);
        }
      }
      if (remaining.length) pendingAttachments.set(senderKey, remaining);
      else pendingAttachments.delete(senderKey);
    }

    let bodyText = rawBody;
    if (bodyText && attachments.has(bodyText)) bodyText = "";

    const entry = {
      senderName,
      roleClass,
      createdAt,
      createdAtMs,
      bodyText,
      attachments,
    };
    if (entry.bodyText || entry.attachments.size) {
      messageEntries.push(entry);
      if (senderKey) lastMessageBySender.set(senderKey, entry);
    }
  }

  for (const queue of pendingAttachments.values()) {
    for (const item of queue) {
      messageEntries.push({
        senderName: item.senderName || "User",
        roleClass: String(item.senderRole || "").toLowerCase().includes("para") ? "paralegal" : "attorney",
        createdAt: item.createdAt,
        createdAtMs: item.createdAtMs,
        bodyText: "",
        attachments: new Set([item.name]),
      });
    }
  }

  const sortedEntries = messageEntries.slice().sort((a, b) => {
    const aTime = typeof a.createdAtMs === "number" ? a.createdAtMs : Number.POSITIVE_INFINITY;
    const bTime = typeof b.createdAtMs === "number" ? b.createdAtMs : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });

  const messageItems = [];
  let lastDateLabel = null;
  for (const entry of sortedEntries) {
    const { date, time } = formatMessageTimestampParts(entry.createdAt);
    const attachmentLine = entry.attachments.size
      ? Array.from(entry.attachments)
          .map((name) => `<div class="message-attachment">Document: ${escapeHtml(name)}</div>`)
          .join("")
      : "";
    const metaLine = time
      ? `${escapeHtml(entry.senderName)} &middot; ${escapeHtml(time)}`
      : `${escapeHtml(entry.senderName)}`;

    if (date && date !== lastDateLabel) {
      messageItems.push(`<div class="message-date">${escapeHtml(date)}</div>`);
      lastDateLabel = date;
    }

    messageItems.push(`
      <div class="message ${entry.roleClass}">
        <div class="meta">${metaLine}</div>
        ${entry.bodyText ? `<div>${escapeHtml(entry.bodyText)}</div>` : ""}
        ${attachmentLine}
      </div>
    `);
  }

  const messageHtml =
    messageItems.length > 0
      ? messageItems.join("")
      : `<div class="message"><div>No messages available.</div></div>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${fontFaceCss}
      html, body { margin: 0; padding: 0; }
      body {
        font-family: ${bodyFontFamily};
        font-weight: 500;
        font-size: 14pt;
        line-height: 1.5;
        color: ${EXPORT_COLORS.text};
        background: #ffffff;
      }
      .page {
        max-width: ${EXPORT_LAYOUT.maxWidth}px;
        margin: ${EXPORT_LAYOUT.marginTop}px auto ${EXPORT_LAYOUT.marginBottom}px auto;
      }
      h2 {
        font-size: 16pt;
        font-weight: 500;
        margin: 0 0 18px 0;
        padding-bottom: 6px;
        border-bottom: 1px solid ${EXPORT_COLORS.divider};
        text-align: left;
      }
      .messages-heading {
        text-align: right;
      }
      .case-details {
        margin-bottom: 48px;
      }
      .case-details div {
        margin-bottom: 8px;
      }
      .messages {
        margin-top: 24px;
        text-align: right;
      }
      .message {
        margin-bottom: 28px;
        text-align: right;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .message-date {
        margin: 28px 0 14px;
        font-size: 10pt;
        font-weight: 500;
        color: ${EXPORT_COLORS.text};
        text-align: right;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .message .meta {
        font-size: 10pt;
        margin-bottom: 4px;
      }
      .message-attachment {
        margin-top: 6px;
      }
      .message.attorney {
        color: ${EXPORT_COLORS.text};
      }
      .message.paralegal {
        color: ${EXPORT_COLORS.paralegal};
      }
      footer {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 14pt;
        color: ${EXPORT_COLORS.footer};
        font-family: ${footerFontFamily};
        font-weight: 300;
      }
    </style>
  </head>
  <body>
    <footer>
      Let<span style="color:${EXPORT_COLORS.accent};">&#8217;</span>s-ParaConnect
    </footer>
    <div class="page">
      <h2>Case Details</h2>
      <div class="case-details">
        ${metadataRows}
      </div>
      <h2 class="messages-heading">Messages</h2>
      <div class="messages">
        ${messageHtml}
      </div>
    </div>
  </body>
</html>`;
}

function buildReceiptHtml(payload = {}) {
  const fontDataUri = getFontDataUri();
  const logoDataUri = getReceiptLogoDataUri();
  const bodyFontFamily = fontDataUri ? `'${EXPORT_FONT_NAME}'` : '"Times New Roman", Times, serif';
  const fontFaceCss = fontDataUri
    ? `@font-face { font-family: '${EXPORT_FONT_NAME}'; src: url('${fontDataUri}') format('truetype'); font-weight: ${RECEIPT_FONT_WEIGHT}; font-style: normal; }`
    : "";
  const title = payload.title || "Receipt";
  const receiptId = payload.receiptId || "N/A";
  const issuedAt = payload.issuedAt || "N/A";
  const partyLabel = payload.partyLabel || "Billed to";
  const partyName = payload.partyName || "N/A";
  const attorneyName = payload.attorneyName || "";
  const caseTitle = payload.caseTitle || "Case";
  const paymentMethod = payload.paymentMethod || "On file";
  const paymentStatus = payload.paymentStatus || "Paid";
  const totalLabel = payload.totalLabel || "Total";
  const totalAmount = payload.totalAmount || "0.00";
  const lineItems = normalizeReceiptLineItems(payload.lineItems);

  const detailRows = [
    ["Date issued", issuedAt],
    [partyLabel, partyName],
    ...(attorneyName ? [["Attorney", attorneyName]] : []),
    ["Case title", caseTitle],
  ]
    .map(
      ([label, value]) =>
        `<tr><td class="detail-label">${escapeHtml(label)}</td><td class="detail-value">${value}</td></tr>`
    )
    .join("");

  const lineRows = lineItems
    .map(
      (item) =>
        `<tr><td class="item-label">${escapeHtml(item.label)}</td><td class="item-amount">${escapeHtml(
          item.value
        )}</td></tr>`
    )
    .join("");

  const paymentRows = [
    ["Payment method", paymentMethod],
    ["Payment status", paymentStatus],
  ]
    .map(
      ([label, value]) =>
        `<tr><td class="detail-label">${escapeHtml(label)}</td><td class="detail-value">${escapeHtml(
          value
        )}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${fontFaceCss}
      html, body { margin: 0; padding: 0; }
      body {
        font-family: ${bodyFontFamily};
        font-weight: ${RECEIPT_FONT_WEIGHT};
        font-size: 14pt;
        line-height: 1.4;
        color: ${EXPORT_COLORS.text};
        background: #ffffff;
      }
      .page {
        max-width: ${EXPORT_LAYOUT.maxWidth}px;
        margin: ${EXPORT_LAYOUT.marginTop}px auto ${EXPORT_LAYOUT.marginBottom}px auto;
      }
      .receipt-title {
        font-size: 16pt;
        font-weight: ${RECEIPT_FONT_WEIGHT};
        margin: 0 0 18px 0;
      }
      .receipt-header {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: nowrap;
        gap: 16px;
        margin-bottom: 26px;
        text-align: center;
      }
      .receipt-logo {
        width: 84px;
        height: 84px;
        display: block;
      }
      .receipt-brand {
        font-size: 28pt;
        font-weight: ${RECEIPT_FONT_WEIGHT};
        font-family: ${bodyFontFamily};
        white-space: nowrap;
        line-height: 1.1;
      }
      .section {
        margin-bottom: 18px;
      }
      .section-header {
        font-size: 12pt;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        margin: 0 0 10px 0;
      }
      .detail-id {
        font-size: 10.5pt;
        color: #6b7280;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      td {
        padding: 4px 0;
        vertical-align: top;
      }
      .detail-label,
      .item-label {
        width: 62%;
      }
      .detail-value {
        text-align: right;
      }
      .item-amount {
        text-align: right;
        white-space: nowrap;
      }
      .total-row td {
        padding-top: 10px;
        border-top: 1px solid ${EXPORT_COLORS.divider};
        font-weight: ${RECEIPT_FONT_WEIGHT};
      }
      footer {
        position: fixed;
        bottom: 0.8in;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 14pt;
        color: ${EXPORT_COLORS.footer};
        font-family: ${bodyFontFamily};
        font-weight: ${RECEIPT_FONT_WEIGHT};
      }
      .receipt-footer-brand {
        white-space: nowrap;
        line-height: 1.1;
      }
      .receipt-footer-id {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 10pt;
        color: ${EXPORT_COLORS.footer};
        line-height: 2;
      }
    </style>
  </head>
  <body>
    <footer>
      <div class="receipt-footer-brand">Let<span style="color:${EXPORT_COLORS.accent};">&#8217;</span>s-ParaConnect</div>
    </footer>
    <div class="receipt-footer-id">Receipt ID: ${escapeHtml(receiptId)}</div>
    <div class="page">
      <div class="receipt-header">
        ${logoDataUri ? `<img class="receipt-logo" src="${logoDataUri}" alt="Let’s-ParaConnect" />` : ""}
        <div class="receipt-brand">Let<span style="color:${EXPORT_COLORS.accent};">&#8217;</span>s-ParaConnect</div>
      </div>
      <div class="receipt-title">${escapeHtml(title)}</div>

      <section class="section">
        <div class="section-header">Details</div>
        <table>
          ${detailRows}
        </table>
      </section>

      <section class="section">
        <div class="section-header">Line items</div>
        <table class="line-items">
          ${lineRows}
          <tr class="total-row">
            <td class="item-label">${escapeHtml(totalLabel)}</td>
            <td class="item-amount">${escapeHtml(totalAmount)}</td>
          </tr>
        </table>
      </section>

      <section class="section">
        <div class="section-header">Payment</div>
        <table>
          ${paymentRows}
        </table>
      </section>
    </div>
  </body>
</html>`;
}

async function renderHtmlToPdf(html, options = {}) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const defaultOptions = {
      format: "Letter",
      printBackground: true,
      margin: {
        top: "40px",
        bottom: "1in",
        left: "40px",
        right: "40px",
      },
    };
    const mergedMargin = Object.assign({}, defaultOptions.margin, options.margin || {});
    const pdfOptions = Object.assign({}, defaultOptions, options, { margin: mergedMargin });
    const pdfBuffer = await page.pdf({
      ...pdfOptions,
    });
    await page.close();
    if (!pdfBuffer) {
      throw new Error("PDF render returned empty buffer");
    }
    return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

async function buildCaseExportPdfBuffer(caseData, messages) {
  const html = buildCaseExportHtml(caseData, messages);
  return renderHtmlToPdf(html);
}

async function buildReceiptPdfBuffer(payload) {
  const html = buildReceiptHtml(payload);
  return renderHtmlToPdf(html, { margin: { bottom: "0in" } });
}

async function uploadPdfToS3({ key, buffer }) {
  if (!BUCKET) {
    throw new Error("S3 bucket is not configured");
  }
  if (!key || !buffer) {
    throw new Error("Receipt upload requires key and buffer");
  }
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "application/pdf",
      ACL: "private",
    },
  });
  await upload.done();
  return { key };
}

function getReceiptKey(caseId, kind) {
  const type = String(kind || "").toLowerCase();
  const suffix = type === "paralegal" || type === "payout" ? "payout" : "attorney";
  return `cases/${caseId}/receipt-${suffix}-v2.pdf`;
}

async function appendS3Object(archive, key, name) {
  if (!key || !name || !BUCKET) return;
  const normalized = normalizeKey(key);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: normalized }));
    if (res?.Body) {
      archive.append(res.Body, { name });
    }
  } catch (err) {
    console.warn("[caseLifecycle] Missing S3 object", normalized, err?.message || err);
  }
}

async function generateArchiveZip(caseDoc) {
  if (!BUCKET) {
    throw new Error("S3 bucket is not configured");
  }
  if (!caseDoc || !caseDoc._id) {
    throw new Error("Case document required");
  }

  const caseData = typeof caseDoc.toObject === "function" ? caseDoc.toObject({ depopulate: false }) : caseDoc;
  const caseId = String(caseData._id);
  const archiveKey = `cases/${caseId}/archive-v2.zip`;
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = new PassThrough();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: archiveKey,
      Body: stream,
      ContentType: "application/zip",
      ACL: "private",
    },
  });

  archive.pipe(stream);

  const pipelinePromise = new Promise((resolve, reject) => {
    stream.on("close", resolve);
    stream.on("error", reject);
    archive.on("error", reject);
  });

  const messages = await Message.find({ caseId })
    .select("senderId senderRole text content createdAt fileName fileKey transcript")
    .populate("senderId", "firstName lastName role")
    .lean();

  const caseFiles = await CaseFile.find({ caseId })
    .select("originalName storageKey mimeType size createdAt userId")
    .populate("userId", "firstName lastName role")
    .lean();

  const fileMessages = (caseFiles || [])
    .map(buildFileMessage)
    .filter((entry) => entry && entry.fileName);

  const combinedMessages = [...(messages || []), ...fileMessages];

  const sortedMessages = combinedMessages.slice().sort((a, b) => {
    const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });
  const exportPdf = await buildCaseExportPdfBuffer(caseData, sortedMessages);
  archive.append(exportPdf, { name: "Case_Summary.pdf" });

  // Documents
  const documentEntries = [];
  if (Array.isArray(caseData.files)) {
    for (const file of caseData.files) {
      if (!file?.key) continue;
      documentEntries.push({
        key: file.key,
        name: file.original || file.filename || `document-${Date.now()}`,
      });
    }
  }
  if (Array.isArray(caseFiles)) {
    for (const file of caseFiles) {
      if (!file?.storageKey) continue;
      documentEntries.push({
        key: file.storageKey,
        name: file.originalName || file.filename || `document-${Date.now()}`,
      });
    }
  }
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg?.fileKey) continue;
      documentEntries.push({
        key: msg.fileKey,
        name: msg.fileName || msg.text || `document-${Date.now()}`,
      });
    }
  }
  if (documentEntries.length) {
    const seenNames = new Map();
    const seenKeys = new Set();
    for (const entry of documentEntries) {
      if (!entry?.key || seenKeys.has(entry.key)) continue;
      seenKeys.add(entry.key);
      const baseName = safeFilename(entry.name || `document-${Date.now()}`);
      const uniqueName = ensureUniqueFilename(baseName, seenNames);
      const path = `Documents/${uniqueName}`;
      // eslint-disable-next-line no-await-in-loop
      await appendS3Object(archive, entry.key, path);
    }
  }

  archive.finalize();
  await Promise.all([upload.done(), pipelinePromise]);

  return {
    key: archiveKey,
    readyAt: new Date(),
    size: archive.pointer(),
  };
}

async function deleteCaseFolder(caseId) {
  if (!BUCKET) return;
  const prefix = `cases/${caseId}/`;
  let token;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    const objects = (res.Contents || []).map((obj) => ({ Key: obj.Key }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: objects, Quiet: true },
        })
      );
    }
    token = res.NextContinuationToken;
  } while (token);
}

async function purgeExpiredCases(limit = PURGE_BATCH_LIMIT) {
  if (!BUCKET) return;
  const now = new Date();
  const targets = await Case.find({
    purgeScheduledFor: { $lte: now },
    purgedAt: null,
  })
    .limit(limit)
    .select("_id");

  for (const doc of targets) {
    const caseId = String(doc._id);
    try {
      // eslint-disable-next-line no-await-in-loop
      await deleteCaseFolder(caseId);
    } catch (err) {
      console.error("[caseLifecycle] purge delete error", caseId, err?.message || err);
      continue;
    }

    const purgeFields = {
      files: [],
      downloadUrl: [],
      archiveZipKey: "",
      archiveReadyAt: null,
      archiveDownloadedAt: null,
      purgeScheduledFor: null,
      purgedAt: new Date(),
    };
    await Case.updateOne({ _id: caseId }, { $set: purgeFields });
  }
}

function startPurgeWorker() {
  if (purgeWorkerStarted) return;
  if (process.env.DISABLE_CASE_PURGER === "true") return;
  purgeWorkerStarted = true;
  if (!BUCKET) {
    console.warn("[caseLifecycle] S3 bucket not configured; purge worker disabled.");
    return;
  }
  setInterval(() => {
    purgeExpiredCases().catch((err) => {
      console.error("[caseLifecycle] purge worker error", err);
    });
  }, PURGE_INTERVAL_MS);
}

module.exports = {
  generateArchiveZip,
  buildReceiptPdfBuffer,
  uploadPdfToS3,
  getReceiptKey,
  deleteCaseFolder,
  purgeExpiredCases,
  startPurgeWorker,
};
