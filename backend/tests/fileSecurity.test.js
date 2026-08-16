const {
  classifyMalwareScanResult,
  getObjectMalwareScan,
  validateMatterFileBuffer,
} = require("../utils/fileSecurity");

describe("Matter file security", () => {
  test("accepts a declared PDF only when its extension and signature agree", () => {
    expect(validateMatterFileBuffer({
      buffer: Buffer.from("%PDF-1.7\nvalid"),
      mimeType: "application/pdf",
      filename: "evidence.pdf",
    })).toEqual({ mimeType: "application/pdf", extension: "pdf" });

    expect(() => validateMatterFileBuffer({
      buffer: Buffer.from("<script>alert(1)</script>"),
      mimeType: "application/pdf",
      filename: "evidence.pdf",
    })).toThrow(/contents do not match/i);

    expect(() => validateMatterFileBuffer({
      buffer: Buffer.from("%PDF-1.7\nvalid"),
      mimeType: "application/pdf",
      filename: "evidence.txt",
    })).toThrow(/extension does not match/i);
  });

  test("requires OOXML container identity instead of accepting an arbitrary ZIP", () => {
    const fakeZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("ordinary archive content"),
    ]);
    expect(() => validateMatterFileBuffer({
      buffer: fakeZip,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "brief.docx",
    })).toThrow(/contents do not match/i);

    const docxPrefix = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml word/document.xml"),
    ]);
    expect(validateMatterFileBuffer({
      buffer: docxPrefix,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "brief.docx",
    })).toEqual(expect.objectContaining({ extension: "docx" }));
  });

  test.each([
    ["NO_THREATS_FOUND", "clean", true],
    ["THREATS_FOUND", "blocked", false],
    ["FAILED", "error", false],
    ["UNSUPPORTED", "error", false],
    ["ACCESS_DENIED", "error", false],
    ["", "pending", false],
  ])("maps GuardDuty result %s to %s", (result, status, safe) => {
    expect(classifyMalwareScanResult(result, { required: true })).toEqual({ status, result: result || "PENDING", safe });
  });

  test("reads only the managed GuardDuty result tag and fails closed when it is absent", async () => {
    const s3 = {
      send: jest.fn(async () => ({
        TagSet: [
          { Key: "untrusted-status", Value: "NO_THREATS_FOUND" },
          { Key: "GuardDutyMalwareScanStatus", Value: "THREATS_FOUND" },
        ],
      })),
    };
    await expect(getObjectMalwareScan({
      s3,
      bucket: "matter-bucket",
      key: "cases/case/documents/file.pdf",
      required: true,
    })).resolves.toEqual({ status: "blocked", result: "THREATS_FOUND", safe: false });

    s3.send.mockResolvedValueOnce({ TagSet: [] });
    await expect(getObjectMalwareScan({
      s3,
      bucket: "matter-bucket",
      key: "cases/case/documents/pending.pdf",
      required: true,
    })).resolves.toEqual({ status: "pending", result: "PENDING", safe: false });
  });
});
