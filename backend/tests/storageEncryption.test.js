const { confidentialStorageEncryption } = require("../utils/storageEncryption");
const key = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
test.each([undefined, "", "alias/lpc-confidential", "12345678", "arn:aws:s3:::wrong-service"])("production refuses missing or ambiguous KMS identity: %s", value => {
 expect(() => confidentialStorageEncryption({ NODE_ENV: "production", S3_SSE_KMS_KEY_ID: value })).toThrow(/explicit KMS key ARN/);
});
test("production writes explicitly use the configured KMS key", () => {
 expect(confidentialStorageEncryption({ NODE_ENV: "production", S3_SSE_KMS_KEY_ID: key })).toEqual({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: key });
});
test("nonproduction can enforce the same gate", () => {
 expect(() => confidentialStorageEncryption({ NODE_ENV: "test", REQUIRE_STORAGE_KMS: "true" })).toThrow();
});
test("synthetic local storage retains explicit AES256 without production credentials", () => {
 expect(confidentialStorageEncryption({ NODE_ENV: "test" })).toEqual({ ServerSideEncryption: "AES256" });
});
