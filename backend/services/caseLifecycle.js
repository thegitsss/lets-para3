const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("services:caseLifecycle");
// backend/services/caseLifecycle.js
// Utilities for case archives (ZIP generation + scheduled S3 purges).

const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const os = require("os");
const crypto = require("crypto");
const exportContents = require("./matterExportContents");
const fs = require("fs");
const path = require("path");
const {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const Case = require("../models/Case");
const { assertObjectMalwareSafe } = require("../utils/fileSecurity");
const { createS3Client } = require("../utils/s3Client");
const { launchPuppeteer } = require("../utils/puppeteerBrowser");

const BUCKET = process.env.S3_BUCKET || "";
const s3 = createS3Client();
const PURGE_BATCH_LIMIT = Math.max(1, Math.min(10, Number(process.env.CASE_PURGE_BATCH_LIMIT || 3)));
let archiverFactoryPromise = null;

async function loadArchiverFactory() {
  if (!archiverFactoryPromise) {
    archiverFactoryPromise = import("archiver").then((module) => module.ZipArchive);
  }
  return archiverFactoryPromise;
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
const RECEIPT_LOGO_PATH = path.resolve(__dirname, "..", "..", "frontend", "Cleanfav.png");
const RECEIPT_LOGO_AVAILABLE = fs.existsSync(RECEIPT_LOGO_PATH);
const EXPORT_CACHE = {
  fontDataUri: null,
  receiptLogoDataUri: null,
};
const RECEIPT_FONT_WEIGHT = 300;

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
    runtimeLogger.warn("[caseLifecycle] Unable to load asset", filePath, err?.message || err);
    return "";
  }
}

function getFontDataUri() {
  if (EXPORT_CACHE.fontDataUri !== null) {
    return EXPORT_CACHE.fontDataUri;
  }
  if (!EXPORT_FONT_AVAILABLE) {
    runtimeLogger.warn("[caseLifecycle] Export font not found:", EXPORT_FONT_PATH);
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
    runtimeLogger.warn("[caseLifecycle] Receipt logo not found:", RECEIPT_LOGO_PATH);
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

function buildCaseExportHtml(contents) {
  const { summary, messages, documents } = contents;
  const showDate = value => value ? new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Date unavailable";
  const showTime = value => value ? new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "Date unavailable";
  const currency = String(summary.currency).toUpperCase();
  const amount = summary.amount !== null && Intl.supportedValuesOf("currency").includes(currency) && new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits === 2 ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(summary.amount / 100) : "Amount unavailable";
  const rows = [["Matter title", summary.title], ["Matter status", summary.status || "Not recorded"], ["Attorney", summary.attorneyName], ["Paralegal", summary.paralegalName], ["Practice area", summary.practiceArea || "Not recorded"], ["Completed", showDate(summary.completedAt)], ["Deadline", showDate(summary.deadline)], ["Matter amount", amount]];
  const byId = new Map(messages.map(message => [message.id, message]));
  const conversation = messages.map(message => {
    const parent = byId.get(message.replyTo);
    const reply = message.replyTo ? `<p class="context">${parent ? `Reply to ${escapeHtml(parent.senderName)} (${escapeHtml(showTime(parent.createdAt))})` : "Reply to a message no longer available"}</p>` : "";
    return `<article><h3>${escapeHtml(message.senderName)} <span class="role">${escapeHtml(message.senderRole)}</span></h3><p class="context">${escapeHtml(showTime(message.createdAt))}</p>${reply}${message.text ? `<p class="message-text">${escapeHtml(message.text)}</p>` : ""}${message.type === "audio" ? `<p class="context">Audio message${message.transcript ? " — transcript follows" : "; no transcript recorded"}</p>` : ""}${message.transcript ? `<p class="message-text">${escapeHtml(message.transcript)}</p>` : ""}${message.attachments.map(name => `<p class="attachment">Attachment: ${escapeHtml(name)}</p>`).join("")}</article>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}body{font-family:"Times New Roman",Times,serif;color:#1f1f1f;font-size:12pt;line-height:1.5;overflow-wrap:anywhere}
    h1{font-size:22pt;font-weight:normal;margin:0 0 24px}h2{font-size:16pt;font-weight:normal;margin:26px 0 12px;border-bottom:1px solid #ddd;padding-bottom:6px;break-after:avoid}h3{font-size:12pt;margin:0;font-weight:bold;break-after:avoid}
    p{margin:0 0 8px}.details p{margin:0 0 6px}.context,.role{font-size:10pt;color:#555}.role{font-weight:normal;margin-left:8px}.message-text,.scope{white-space:pre-wrap}article{margin-bottom:22px;break-inside:avoid}.attachment{font-size:10pt}li{margin-bottom:8px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:6px 0;vertical-align:top}td:last-child{width:22%;text-align:right}tr{break-inside:avoid}
  </style></head><body><h1>Matter archive</h1><div class="details">${rows.map(([label,value]) => `<p>${escapeHtml(label)}: ${escapeHtml(value)}</p>`).join("")}</div>
  ${summary.briefSummary || summary.details ? `<h2>Matter scope</h2>${summary.briefSummary ? `<p class="scope">${escapeHtml(summary.briefSummary)}</p>` : ""}${summary.details && summary.details !== summary.briefSummary ? `<p class="scope">${escapeHtml(summary.details)}</p>` : ""}` : ""}
  ${summary.tasks.length ? `<h2>Tasks</h2><ul>${summary.tasks.map(task => `<li>${escapeHtml(task.title)}${task.completed === null ? " — completion not recorded" : task.completed ? " — completed" : " — not completed"}</li>`).join("")}</ul>` : ""}
  <h2>Retained messages (${messages.length})</h2>${conversation || "<p>No retained messages.</p>"}
  <h2>Documents (${documents.length})</h2>${documents.length ? `<ul>${documents.map(document => `<li>${escapeHtml(document.path)}</li>`).join("")}</ul>` : "<p>No retained documents.</p>"}
  ${contents.attorneyNotes ? `<h2>Attorney notes</h2><p class="scope">${escapeHtml(contents.attorneyNotes)}</p>` : ""}
  ${contents.receipts?.length ? `<h2>Receipts (${contents.receipts.length})</h2><ul>${contents.receipts.map(receipt => `<li>${escapeHtml(receipt.path)}</li>`).join("")}</ul>` : ""}
  <p class="context">Deleted messages and files are not included. Prior file versions are included where their documents are still recorded.</p></body></html>`;
}

function buildReceiptHtml(payload = {}) {
  const fontDataUri = getFontDataUri();
  const logoDataUri = getReceiptLogoDataUri();
  const bodyFontFamily = fontDataUri ? `'${EXPORT_FONT_NAME}'` : '"Times New Roman", Times, serif';
  const fontFaceCss = fontDataUri
    ? `@font-face { font-family: '${EXPORT_FONT_NAME}'; src: url('${fontDataUri}') format('truetype'); font-weight: ${RECEIPT_FONT_WEIGHT}; font-style: normal; }`
    : "";
  const title = payload.title || "Receipt";
  const issuedAt = payload.issuedAt || "N/A";
  const partyLabel = payload.partyLabel || "Billed to";
  const partyName = payload.partyName || "N/A";
  const attorneyName = payload.attorneyName || "";
  const caseTitle = payload.caseTitle || "Untitled Matter";
  const paymentMethod = payload.paymentMethod === null ? null : payload.paymentMethod || "On file";
  const paymentStatus = payload.paymentStatus || "Paid";
  const totalLabel = payload.totalLabel || "Total";
  const totalAmount = payload.totalAmount || "0.00";
  const lineItems = normalizeReceiptLineItems(payload.lineItems);

  const detailRows = [
    [payload.dateLabel || "Date issued", issuedAt],
    [partyLabel, partyName],
    ...(attorneyName ? [["Attorney", attorneyName]] : []),
    ["Matter title", caseTitle],
  ]
    .map(
      ([label, value]) =>
        `<tr><td class="detail-label">${escapeHtml(label)}</td><td class="detail-value">${escapeHtml(value)}</td></tr>`
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
    .filter(([, value]) => value !== null)
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
      .receipt-mode { font-size: 11pt; color: #4b5563; margin: -10px 0 18px; }
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
        break-after: avoid;
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
      tr, .receipt-amounts, .receipt-payment { break-inside: avoid; }
      .detail-label { width: 38%; }
      .item-label {
        width: 62%;
      }
      .detail-value {
        text-align: right;
        overflow-wrap: anywhere;
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
    </style>
  </head>
  <body>
    <div class="page">
      <div class="receipt-header">
        ${logoDataUri ? `<img class="receipt-logo" src="${logoDataUri}" alt="Let’s-ParaConnect" />` : ""}
        <div class="receipt-brand">Let<span style="color:${EXPORT_COLORS.accent};">&#8217;</span>s-ParaConnect</div>
      </div>
      <div class="receipt-title">${escapeHtml(title)}</div>
      ${payload.testMode === true ? '<p class="receipt-mode">Test record - no money moved</p>' : ""}

      <section class="section">
        <div class="section-header">Details</div>
        <table>
          ${detailRows}
        </table>
      </section>

      <section class="section receipt-amounts">
        <div class="section-header">${lineItems.length ? "Line items" : "Amount"}</div>
        <table class="line-items">
          ${lineRows}
          <tr class="total-row">
            <td class="item-label">${escapeHtml(totalLabel)}</td>
            <td class="item-amount">${escapeHtml(totalAmount)}</td>
          </tr>
        </table>
      </section>

      <section class="section receipt-payment">
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
  const browser = await launchPuppeteer({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

async function buildCaseExportPdfBuffer(contents) {
  return renderHtmlToPdf(buildCaseExportHtml(contents), { margin: { top: "0.65in", bottom: "0.8in", left: "0.7in", right: "0.7in" }, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: `<div style="width:100%;text-align:center;font-family:Times,serif;font-size:10pt;color:#555;padding-bottom:12px;">Let’s-ParaConnect · <span class="pageNumber"></span> / <span class="totalPages"></span></div>` });
}

async function buildReceiptPdfBuffer(payload) {
  const html = buildReceiptHtml(payload);
  // Chromium prints this footer inside the reserved margin on every page.
  // Keeping it outside document flow prevents overlap and footer-only pages.
  const footerTemplate = `<div style="width:100%;padding:0 40px 12px;text-align:center;font-family:'Times New Roman',Times,serif;font-size:10pt;color:#777;overflow-wrap:anywhere;"><div style="font-size:14pt;margin-bottom:16px;">Let<span style="color:${EXPORT_COLORS.accent};">&#8217;</span>s-ParaConnect</div><div>Receipt ID: ${escapeHtml(payload.receiptId || "N/A")}</div></div>`;
  return renderHtmlToPdf(html, { margin: { bottom: "1.2in" }, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate });
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

async function buildArchiveZipFile(caseDoc, { contents, signal, validate = async () => {} } = {}) {
  const limits = exportContents.limits;
  const combinedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(limits.durationMs)]);
  const active = () => {
    combinedSignal.throwIfAborted();
    if (caseDoc.purgedAt || caseDoc.purgeScheduledFor && new Date(caseDoc.purgeScheduledFor) <= new Date()) throw Object.assign(new Error("The Matter archive retention period has ended."), { publicCode: caseDoc.purgedAt ? "EXPORT_PURGED" : "EXPORT_EXPIRED", status: 410 });
  };
  active();
  const source = contents || await exportContents.read(typeof caseDoc.toObject === "function" ? caseDoc.toObject({ depopulate: false }) : caseDoc);
  if (source.documents.length && !BUCKET) throw Object.assign(new Error("Document storage is unavailable."), { publicCode: "EXPORT_UNAVAILABLE", status: 503 });
  if (Buffer.byteLength(JSON.stringify(source)) > 16 * 1024 * 1024) throw Object.assign(new Error("The retained text exceeds the archive preparation limit."), { publicCode: "EXPORT_TOO_LARGE", status: 413 });
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lpc-matter-export-"));
  const cleanup = () => fs.promises.rm(directory, { recursive: true, force: true });
  try {
    const documents = []; let totalBytes = 0;
    for (const document of source.documents) {
      active();
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: document.key }), { abortSignal: combinedSignal });
      if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength < 0 || typeof head.ETag !== "string" || !head.ETag) throw Object.assign(new Error("Document metadata could not be verified."), { publicCode: "EXPORT_SOURCE_CHANGED", status: 409 });
      totalBytes += head.ContentLength;
      if (totalBytes > limits.bytes) throw Object.assign(new Error("The documents exceed the 250 MB archive preparation limit."), { publicCode: "EXPORT_TOO_LARGE", status: 413 });
      const versionId = head.VersionId && head.VersionId !== "null" ? head.VersionId : undefined;
      await assertObjectMalwareSafe({ s3, bucket: BUCKET, key: document.key, versionId, signal: combinedSignal });
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: document.key, IfMatch: head.ETag, ...(versionId ? { VersionId: versionId } : {}) }), { abortSignal: combinedSignal });
      if (!object.Body || typeof object.Body.pipe !== "function" || object.ETag !== head.ETag || object.ContentLength !== head.ContentLength || versionId && object.VersionId !== versionId) {
        object.Body?.destroy?.(); throw Object.assign(new Error("A document changed while the archive was being prepared."), { publicCode: "EXPORT_SOURCE_CHANGED", status: 409 });
      }
      const localPath = path.join(directory, `source-${documents.length}`); let written = 0;
      const bounded = new Transform({ transform(chunk, _encoding, callback) { written += chunk.length; callback(written > head.ContentLength ? Object.assign(new Error("Document length changed."), { publicCode: "EXPORT_SOURCE_CHANGED", status: 409 }) : null, chunk); } });
      await pipeline(object.Body, bounded, fs.createWriteStream(localPath, { flags: "wx", mode: 0o600 }), { signal: combinedSignal });
      if (written !== head.ContentLength) throw Object.assign(new Error("A document download was incomplete."), { publicCode: "EXPORT_SOURCE_CHANGED", status: 409 });
      await assertObjectMalwareSafe({ s3, bucket: BUCKET, key: document.key, versionId, signal: combinedSignal });
      documents.push({ ...document, localPath, size: written });
    }
    active(); await validate(); active();
    const pdf = await buildCaseExportPdfBuffer(source);
    if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid Matter summary PDF");
    const receiptFiles = [];
    for (const receipt of source.receipts || []) {
      active();
      if (!/^Receipts\/(?:payment-payment|withdrawal-[a-f0-9]{64})\.pdf$/.test(receipt.path)) throw new Error("Invalid receipt export path");
      const buffer = await buildReceiptPdfBuffer(receipt.payload);
      if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid receipt PDF");
      receiptFiles.push({ path: receipt.path, buffer });
      if (receiptFiles.reduce((sum, file) => sum + file.buffer.length, 0) > 20 * 1024 * 1024) throw Object.assign(new Error("Receipts exceed the download limit."), { publicCode: "EXPORT_TOO_LARGE", status: 413 });
    }
    const manifest = { title: source.summary.title, preparedAt: new Date().toISOString(), summaryFile: "Case_Summary.pdf", counts: source.counts, documents: documents.map(({ path: filename, name, category, recordedAt, size }) => ({ path: filename, name, category, recordedAt, size })), receipts: receiptFiles.map(file => file.path), attorneyNotesIncluded: Boolean(source.attorneyNotes), excluded: ["Deleted messages", "Removed files and their retained removal history", ...(source.receipts === undefined ? ["Attorney-only notes and financial receipts"] : [])] };
    active();
    const archiver = await loadArchiverFactory(), archive = new archiver({ zlib: { level: 6 } });
    const zipPath = path.join(directory, "archive.zip");
    const writing = pipeline(archive, fs.createWriteStream(zipPath, { flags: "wx", mode: 0o600 }), { signal: combinedSignal });
    archive.on("warning", error => archive.destroy(error));
    archive.append(pdf, { name: "Case_Summary.pdf" });
    archive.append(JSON.stringify(manifest, null, 2) + "\n", { name: "Archive_contents.json" });
    for (const receipt of receiptFiles) archive.append(receipt.buffer, { name: receipt.path });
    for (const document of documents) archive.file(document.localPath, { name: document.path });
    try { await Promise.all([writing, archive.finalize()]); }
    catch (error) { archive.destroy(error); await Promise.allSettled([writing]); throw error; }
    active(); await validate(); active();
    const stat = await fs.promises.stat(zipPath);
    if (stat.size > limits.bytes + 20 * 1024 * 1024) throw Object.assign(new Error("The archive exceeds its preparation limit."), { publicCode: "EXPORT_TOO_LARGE", status: 413 });
    return { path: zipPath, size: stat.size, readyAt: new Date(), cleanup };
  } catch (error) {
    await cleanup().catch(cleanupError => runtimeLogger.error("[caseLifecycle] temporary archive cleanup failed", { error: cleanupError }));
    throw error;
  }
}

async function generateArchiveZip(caseDoc) {
  if (!BUCKET) throw new Error("S3 bucket is not configured");
  const sourceCase = typeof caseDoc.toObject === "function" ? caseDoc.toObject({ depopulate: false }) : caseDoc;
  const contents = await exportContents.read(sourceCase);
  const artifact = await buildArchiveZipFile(caseDoc, { contents, validate: async () => {
    if ((await exportContents.read(sourceCase)).revision !== contents.revision) throw Object.assign(new Error("The retained documents or messages changed during archive preparation."), { publicCode: "EXPORT_CHANGED", status: 409 });
  } });
  const key = `cases/${String(caseDoc._id)}/archive-${crypto.randomUUID()}.zip`;
  const body = fs.createReadStream(artifact.path);
  const upload = new Upload({ client: s3, params: { Bucket: BUCKET, Key: key, Body: body, ContentType: "application/zip", ACL: "private" } });
  try {
    await upload.done();
    return { key, readyAt: artifact.readyAt, size: artifact.size };
  } catch (error) {
    body.destroy(); await upload.abort().catch(abortError => runtimeLogger.error("[caseLifecycle] archive upload abort failed", { error: abortError }));
    throw error;
  } finally {
    body.destroy(); await artifact.cleanup().catch(error => runtimeLogger.error("[caseLifecycle] temporary archive cleanup failed", { error }));
  }
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
      runtimeLogger.error("[caseLifecycle] purge delete error", caseId, err?.message || err);
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

module.exports = {
  generateArchiveZip,
  buildArchiveZipFile,
  buildCaseExportPdfBuffer,
  buildReceiptPdfBuffer,
  uploadPdfToS3,
  getReceiptKey,
  deleteCaseFolder,
  purgeExpiredCases,
};
