process.env.S3_BUCKET = "synthetic-owner-enforced-bucket";
const mockDone = jest.fn(async () => ({}));
const mockUpload = jest.fn();
jest.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(options) {
      if (options.params.ACL) throw Object.assign(new Error("The bucket does not allow ACLs"), { name: "AccessControlListNotSupported" });
      mockUpload(options);
      this.done = mockDone;
    }
  },
}));
const { uploadPdfToS3 } = require("../services/caseLifecycle");

test("receipt uploads work with ACLs disabled and retain their original bytes and type", async () => {
  const buffer = Buffer.from("%PDF-1.4\nSynthetic receipt");
  const key = "cases/aaaaaaaaaaaaaaaaaaaaaaaa/receipt-attorney.pdf";
  await expect(uploadPdfToS3({ key, buffer })).resolves.toEqual({ key });
  expect(mockUpload).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
    Bucket: "synthetic-owner-enforced-bucket", Key: key, Body: buffer, ContentType: "application/pdf",
  }) }));
  expect(mockDone).toHaveBeenCalledTimes(1);
});
