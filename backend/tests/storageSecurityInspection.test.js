const { inspect, summarize, READS } = require("../scripts/inspect-storage-security");

describe("read-only storage inspection", () => {
  test("uses configuration reads, never object reads or writes", () => {
    expect(Object.values(READS)).toEqual([
      "GetPublicAccessBlockCommand", "GetBucketPolicyStatusCommand", "GetBucketEncryptionCommand",
      "GetBucketOwnershipControlsCommand", "GetBucketVersioningCommand", "GetBucketPolicyCommand",
    ]);
  });
  test("does not treat absent policy or encryption evidence as verified", () => {
    expect(summarize("policyStatus", {}).status).toBe("review_required");
    expect(summarize("encryption", {}).status).toBe("review_required");
    expect(summarize("publicAccessBlock", { PublicAccessBlockConfiguration: { BlockPublicAcls: true } }).status).toBe("review_required");
  });
  test("does not mistake policy keywords for effective enforcement", () => {
    const policy = JSON.stringify({ Statement: [{ Effect: "Allow", Condition: { StringEquals: { "s3:ExistingObjectTag/GuardDutyMalwareScanStatus": "NO_THREATS_FOUND" } } }] });
    expect(summarize("policy", { Policy: policy })).toMatchObject({ status: "review_required", mentionsCleanScanTag: true });
  });
  test("records denied reads without exposing credentials, bucket names, or raw errors", async () => {
    const client = { send: jest.fn().mockRejectedValue(Object.assign(new Error("secret-bucket secret-key"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })) };
    const result = await inspect({ client, bucket: "secret-bucket", expectedOwner: "123456789012" });
    expect(result.status).toBe("incomplete");
    expect(Object.values(result.observations).every(item => item.status === "unconfirmed")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret-bucket|secret-key|123456789012/);
    expect(client.send.mock.calls.every(([command]) => command.input.ExpectedBucketOwner === "123456789012")).toBe(true);
  });
});
