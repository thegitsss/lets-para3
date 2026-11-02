"use strict";
const crypto = require("node:crypto");
const { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand } = require("@aws-sdk/client-textract");
const { buildS3ClientConfig } = require("../../utils/s3Client");
const fail = (suffix, message, retryable = false) => { throw Object.assign(new Error(message), { status: 422, publicCode: "PREPARATION_OCR_" + suffix, retryable }); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function configured(env = process.env) {
  return Boolean(env.S3_BUCKET) && ["us-east-1", "us-east-2", "us-west-2"].includes(String(env.S3_REGION || env.AWS_REGION || "us-east-1").trim());
}
// OCR receives only the exact, security-checked S3 version already authorized by
// the Matter file reader. Its durable checkpoint contains no extracted text.
async function readScannedPages({ bucket, key, versionId, etag, pageCount, requestKey, checkpoint, onCheckpoint = async () => {}, onPoll = async () => {}, client, pause = wait, timeoutMs = 15 * 60000 }) {
  if (!versionId || versionId === "null") fail("VERSION_REQUIRED", "Scanned PDFs require versioned document storage. A readable PDF or Word document can be used now.");
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 80) fail("PAGE_LIMIT", "Choose a PDF of up to 80 pages.");
  if (!client && !configured()) fail("UNAVAILABLE", "Scanned-document reading is not available for this storage location. Use a PDF with selectable text or a Word document.");
  client ||= new TextractClient(buildS3ClientConfig());
  let jobId = checkpoint?.versionId === versionId && checkpoint?.etag === etag ? checkpoint.jobId : null;
  const abortSignal = () => AbortSignal.timeout(30000);
  try {
    if (!jobId) {
      await onPoll();
      const token = crypto.createHash("sha256").update(JSON.stringify([requestKey, bucket, key, versionId, etag])).digest("hex");
      const response = await client.send(new StartDocumentTextDetectionCommand({ ClientRequestToken: token, DocumentLocation: { S3Object: { Bucket: bucket, Name: key, Version: versionId } } }), { abortSignal: abortSignal() });
      if (!response.JobId) fail("UNCONFIRMED", "Scanned-document reading could not be confirmed. Try again.", true);
      jobId = response.JobId;
      await onCheckpoint({ jobId, versionId, etag });
    }
    const started = Date.now();
    let response;
    while (Date.now() - started < timeoutMs) {
      await onPoll();
      response = await client.send(new GetDocumentTextDetectionCommand({ JobId: jobId, MaxResults: 1000 }), { abortSignal: abortSignal() });
      if (response.JobStatus === "IN_PROGRESS") { await pause(2500); continue; }
      if (!["SUCCEEDED", "PARTIAL_SUCCESS"].includes(response.JobStatus)) fail("FAILED", "This scan could not be read. Try another copy of the document.");
      break;
    }
    if (!response || response.JobStatus === "IN_PROGRESS") fail("WAITING", "This scan is taking longer than expected. Retry to continue the same reading request.", true);
    let partial = response.JobStatus === "PARTIAL_SUCCESS";
    const pages = new Map();
    let count = 0, size = 0, cursor = response.NextToken;
    const cursors = new Set();
    function collect(batch) {
      if ((batch.DocumentMetadata?.Pages || pageCount) > 80) fail("PAGE_LIMIT", "Choose a PDF of up to 80 pages.");
      for (const block of batch.Blocks || []) {
        if (++count > 80000) fail("TEXT_LIMIT", "Select a shorter scanned document.");
        if (block.BlockType !== "LINE" || typeof block.Text !== "string") continue;
        const page = block.Page;
        if (!Number.isInteger(page) || page < 1 || page > pageCount) fail("INVALID", "The scan returned an incomplete page reference. Choose another document copy.");
        size += block.Text.length;
        if (size > 180000) fail("TEXT_LIMIT", "Select fewer or shorter documents.");
        if (!pages.has(page)) pages.set(page, []);
        pages.get(page).push(block.Text);
      }
    }
    collect(response);
    while (cursor) {
      if (cursors.has(cursor) || cursors.size > 100) fail("INVALID", "The scan returned incomplete results. Retry the reading request.", true);
      cursors.add(cursor); await onPoll();
      const batch = await client.send(new GetDocumentTextDetectionCommand({ JobId: jobId, MaxResults: 1000, NextToken: cursor }), { abortSignal: abortSignal() });
      if (!["SUCCEEDED", "PARTIAL_SUCCESS"].includes(batch.JobStatus)) fail("INVALID", "The scan results changed. Retry the reading request.", true);
      partial ||= batch.JobStatus === "PARTIAL_SUCCESS";
      collect(batch); cursor = batch.NextToken;
    }
    return { pages: Array.from({ length: pageCount }, (_, index) => ({ page: index + 1, section: null, text: (pages.get(index + 1) || []).join("\n") })), partial, readingMethod: "text_and_ocr" };
  } catch (error) {
    if (error.publicCode) throw error;
    if (["AccessDeniedException", "InvalidS3ObjectException", "UnsupportedDocumentException", "BadDocumentException"].includes(error.name)) fail("UNAVAILABLE", "This scanned PDF could not be opened for reading. Use another document copy or a PDF with selectable text.");
    fail("UNCONFIRMED", "Scanned-document reading could not be confirmed. Retry to continue the same request.", true);
  }
}
module.exports = { configured, readScannedPages };
