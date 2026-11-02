"use strict";
// Synthetic Textract DTOs only; no provider credentials or external requests.
const { readScannedPages, configured } = require("../services/connectedWorkspace/ocr");
const base = { bucket: "synthetic-lpc-documents", key: "synthetic/source.pdf", versionId: "synthetic-version-1", etag: '"synthetic-etag"', pageCount: 3, requestKey: "synthetic-request" };
const line = (Page, Text) => ({ BlockType: "LINE", Page, Text });
function provider(responses) {
  return { send: jest.fn(async command => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Synthetic response queue exhausted");
    return next;
  }) };
}
test("OCR is available only for the configured document region", () => {
  expect(configured({ S3_BUCKET: "documents", S3_REGION: "us-east-1" })).toBe(true);
  expect(configured({ S3_BUCKET: "documents", S3_REGION: "eu-west-1" })).toBe(false);
  expect(configured({ S3_REGION: "us-east-1" })).toBe(false);
});
test.each([undefined, "null", ""])("an unversioned scan never reaches the OCR provider: %j", async versionId => {
  const client = provider([]);
  await expect(readScannedPages({ ...base, versionId, client })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_VERSION_REQUIRED", retryable: false });
  expect(client.send).not.toHaveBeenCalled();
});
test.each([0, 81])("page limits reject the scan before dispatch: %j", async pageCount => {
  const client = provider([]);
  await expect(readScannedPages({ ...base, pageCount, client })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_PAGE_LIMIT" });
  expect(client.send).not.toHaveBeenCalled();
});
test("OCR pins the authorized object version and checkpoints no document text", async () => {
  const client = provider([{ JobId: "synthetic-job" }, { JobStatus: "SUCCEEDED", Blocks: [line(2, "SYNTHETIC PRIVATE OCR TEXT")] }]);
  const checkpoint = jest.fn(), onPoll = jest.fn();
  const result = await readScannedPages({ ...base, client, onCheckpoint: checkpoint, onPoll });
  expect(client.send.mock.calls[0][0].input).toEqual({ ClientRequestToken: expect.stringMatching(/^[a-f0-9]{64}$/), DocumentLocation: { S3Object: { Bucket: base.bucket, Name: base.key, Version: base.versionId } } });
  expect(checkpoint).toHaveBeenCalledWith({ jobId: "synthetic-job", versionId: base.versionId, etag: base.etag });
  expect(JSON.stringify(checkpoint.mock.calls)).not.toContain("PRIVATE");
  expect(result.pages).toEqual([{ page: 1, section: null, text: "" }, { page: 2, section: null, text: "SYNTHETIC PRIVATE OCR TEXT" }, { page: 3, section: null, text: "" }]);
  expect(onPoll).toHaveBeenCalledTimes(2);
});
test("a matching durable checkpoint resumes the original provider job without dispatching another", async () => {
  const client = provider([{ JobStatus: "SUCCEEDED", Blocks: [line(1, "A synthetic page")] }]);
  await readScannedPages({ ...base, client, checkpoint: { versionId: base.versionId, etag: base.etag, jobId: "already-dispatched" } });
  expect(client.send).toHaveBeenCalledTimes(1);
  expect(client.send.mock.calls[0][0].input).toMatchObject({ JobId: "already-dispatched" });
});
test("a checkpoint for different bytes cannot be used to read a replacement source", async () => {
  const client = provider([{ JobId: "replacement-job" }, { JobStatus: "SUCCEEDED", Blocks: [] }]);
  await readScannedPages({ ...base, client, checkpoint: { versionId: "earlier-version", etag: base.etag, jobId: "earlier-job" } });
  expect(client.send.mock.calls[0][0].constructor.name).toBe("StartDocumentTextDetectionCommand");
  expect(client.send.mock.calls[1][0].input.JobId).toBe("replacement-job");
});
test("pagination preserves literal line order and real page references while leaving missing pages blank", async () => {
  const client = provider([{ JobId: "pagination-job" }, { JobStatus: "SUCCEEDED", NextToken: "next-one", Blocks: [line(2, "Second page, first line")] }, { JobStatus: "SUCCEEDED", Blocks: [line(1, "First page"), line(2, "Second page, next line")] }]);
  const result = await readScannedPages({ ...base, client });
  expect(client.send.mock.calls[2][0].input).toEqual({ JobId: "pagination-job", MaxResults: 1000, NextToken: "next-one" });
  expect(result).toMatchObject({ readingMethod: "text_and_ocr", partial: false, pages: [{ page: 1, text: "First page" }, { page: 2, text: "Second page, first line\nSecond page, next line" }, { page: 3, text: "" }] });
});
test("partial provider coverage is disclosed even when the partial result appears in a later batch", async () => {
  const client = provider([{ JobId: "partial-job" }, { JobStatus: "SUCCEEDED", NextToken: "next", Blocks: [line(1, "Readable page")] }, { JobStatus: "PARTIAL_SUCCESS", Blocks: [line(3, "Another readable page")] }]);
  expect((await readScannedPages({ ...base, client })).partial).toBe(true);
});
test("a scan with no returned text remains unknown rather than gaining invented coverage", async () => {
  const client = provider([{ JobId: "empty-job" }, { JobStatus: "PARTIAL_SUCCESS", Blocks: [{ BlockType: "PAGE", Page: 1 }] }]);
  const result = await readScannedPages({ ...base, client });
  expect(result.partial).toBe(true);
  expect(result.pages.every(page => page.text === "")).toBe(true);
});
test("repeated pagination cursors fail closed with a recoverable reading error", async () => {
  const client = provider([{ JobId: "loop-job" }, { JobStatus: "SUCCEEDED", NextToken: "same", Blocks: [] }, { JobStatus: "SUCCEEDED", NextToken: "same", Blocks: [] }]);
  await expect(readScannedPages({ ...base, client })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_INVALID", retryable: true });
  expect(client.send).toHaveBeenCalledTimes(3);
});
test.each([0, 4])("invalid OCR page references cannot become source citations: %j", async page => {
  const client = provider([{ JobId: "bad-page-job" }, { JobStatus: "SUCCEEDED", Blocks: [line(page, "Wrong page")] }]);
  await expect(readScannedPages({ ...base, client })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_INVALID" });
});
test("the combined OCR text limit applies across provider batches", async () => {
  const client = provider([{ JobId: "large-job" }, { JobStatus: "SUCCEEDED", NextToken: "next", Blocks: [line(1, "A".repeat(100000))] }, { JobStatus: "SUCCEEDED", Blocks: [line(2, "B".repeat(100000))] }]);
  await expect(readScannedPages({ ...base, client })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_TEXT_LIMIT" });
});
test("an exhausted polling budget retains a retryable checkpoint rather than dispatching a replacement", async () => {
  let now = 0;
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  const client = provider([{ JobId: "still-running" }, { JobStatus: "IN_PROGRESS" }]), checkpoint = jest.fn();
  try {
    await expect(readScannedPages({ ...base, client, timeoutMs: 1, onCheckpoint: checkpoint, pause: async () => { now = 2; } })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_WAITING", retryable: true });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ jobId: "still-running" }));
  } finally { clock.mockRestore(); }
});
test("revoked authority reported by polling propagates without another provider request", async () => {
  const client = provider([]), error = Object.assign(new Error("Account changed"), { status: 403, publicCode: "FILE_WRITE_ACCOUNT_CHANGED" });
  await expect(readScannedPages({ ...base, client, onPoll: async () => { throw error; } })).rejects.toBe(error);
  expect(client.send).not.toHaveBeenCalled();
});
test("an unavailable source is actionable while an unknown dispatch acknowledgement remains retryable", async () => {
  const denied = Object.assign(new Error("synthetic access denied"), { name: "AccessDeniedException" });
  await expect(readScannedPages({ ...base, client: provider([denied]) })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_UNAVAILABLE", retryable: false });
  await expect(readScannedPages({ ...base, client: provider([new Error("synthetic connection lost")]) })).rejects.toMatchObject({ publicCode: "PREPARATION_OCR_UNCONFIRMED", retryable: true });
});
