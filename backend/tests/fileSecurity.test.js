const {
  malwareScanRequired,
  classifyMalwareScanResult,
  getObjectMalwareScan,
  validateMatterFileBuffer,
  validateStoredMatterFile,
} = require("../utils/fileSecurity");

describe("Matter file security", () => {
  test.each([undefined, "", "false", "0", "1", "yes", "on", "true"])("production always requires scanning with setting %s", setting => {
    expect(malwareScanRequired({ NODE_ENV: "production", S3_MALWARE_SCAN_REQUIRED: setting })).toBe(true);
  });

  test.each(["1", "true", "yes", "on", " TRUE "])("recognizes startup-supported truthy setting %s", setting => {
    expect(malwareScanRequired({ NODE_ENV: "test", S3_MALWARE_SCAN_REQUIRED: setting })).toBe(true);
  });

  test("allows an explicit non-production fixture to omit scanning", () => {
    expect(malwareScanRequired({ NODE_ENV: "test", S3_MALWARE_SCAN_REQUIRED: "false" })).toBe(false);
  });

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

describe("Stored file validation quarantine", () => {
  let previous;
  beforeEach(() => { previous = process.env.S3_MALWARE_SCAN_REQUIRED; process.env.S3_MALWARE_SCAN_REQUIRED = "true"; });
  afterEach(() => { if (previous === undefined) delete process.env.S3_MALWARE_SCAN_REQUIRED; else process.env.S3_MALWARE_SCAN_REQUIRED = previous; });
  function fixture(result, { versionId, changed = false, afterResult = result } = {}) {
    let tags = 0;
    const s3 = { send: jest.fn(async command => {
      const name = command.constructor.name;
      if (name === "GetObjectTaggingCommand") return { TagSet: (tags++ ? afterResult : result) ? [{ Key: "GuardDutyMalwareScanStatus", Value: tags === 1 ? result : afterResult }] : [] };
      if (name === "GetObjectCommand") return { Body: Buffer.from("%PDF-1.7\nsynthetic") };
      if (name === "HeadObjectCommand") return { ETag: changed ? '"other"' : '"original"' };
      throw Error(name);
    }) };
    return { s3, bucket: "test", key: "cases/test/document.pdf", mimeType: "application/pdf", filename: "document.pdf", head: { ETag: '"original"', ...(versionId ? { VersionId: versionId } : {}) } };
  }
  test.each(["", "THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED"])("never downloads a file with scan result %s", async result => {
    const options = fixture(result);
    await expect(validateStoredMatterFile(options)).rejects.toMatchObject({ code: expect.stringMatching(/^FILE_SCAN_|^FILE_SECURITY_/) });
    expect(options.s3.send.mock.calls.some(([c]) => c.constructor.name === "GetObjectCommand")).toBe(false);
  });
  test("pins clean content and both scan checks to the stored version", async () => {
    const options = fixture("NO_THREATS_FOUND", { versionId: "version-1" });
    await expect(validateStoredMatterFile(options)).resolves.toMatchObject({ extension: "pdf" });
    const calls = options.s3.send.mock.calls.map(([c]) => c);
    expect(calls.map(c => c.constructor.name)).toEqual(["GetObjectTaggingCommand", "GetObjectCommand", "GetObjectTaggingCommand"]);
    expect(calls.every(c => c.input.VersionId === "version-1")).toBe(true);
    expect(calls[1].input.IfMatch).toBe('"original"');
  });
  test("rejects an unversioned replacement during validation", async () => {
    await expect(validateStoredMatterFile(fixture("NO_THREATS_FOUND", { changed: true }))).rejects.toMatchObject({ code: "FILE_CHANGED" });
  });
  test("rejects a scan result revoked while reading", async () => {
    await expect(validateStoredMatterFile(fixture("NO_THREATS_FOUND", { afterResult: "THREATS_FOUND" }))).rejects.toMatchObject({ code: "FILE_SECURITY_BLOCKED" });
  });
  test("fails closed when the object identity cannot be pinned", async () => {
    const options = fixture("NO_THREATS_FOUND"); options.head = {};
    await expect(validateStoredMatterFile(options)).rejects.toMatchObject({ code: "FILE_IDENTITY_UNVERIFIED" });
    expect(options.s3.send).not.toHaveBeenCalled();
  });
});
