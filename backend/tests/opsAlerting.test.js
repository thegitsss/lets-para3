const mockSendEmail = jest.fn();

jest.mock("../utils/email", () => mockSendEmail);

const { sendOwnerAlert } = require("../utils/opsAlerting");

describe("operations alert delivery", () => {
  beforeEach(() => {
    mockSendEmail.mockReset();
    process.env.OWNER_ALERT_EMAILS = "owner@example.com,oncall@example.com";
  });

  afterEach(() => {
    delete process.env.OWNER_ALERT_EMAILS;
  });

  test("escapes HTML, redacts secrets and identities, and returns no recipient addresses", async () => {
    mockSendEmail.mockResolvedValue({ messageId: "provider-message-id" });

    const result = await sendOwnerAlert("Operational alert", [
      "<strong>Case</strong> admin@example.com sk_live_sensitive123",
    ]);

    expect(mockSendEmail).toHaveBeenCalledWith(
      "owner@example.com,oncall@example.com",
      "Operational alert",
      "<p>&lt;strong&gt;Case&lt;/strong&gt; [REDACTED] [REDACTED]</p>",
      expect.objectContaining({ headers: { "X-LPC-Ops-Alert": "true" } })
    );
    expect(result).toEqual({ skipped: false, delivered: true, recipientCount: 2 });
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
    expect(JSON.stringify(result)).not.toContain("provider-message-id");
  });

  test("reports disabled or failed transport without returning provider messages", async () => {
    mockSendEmail.mockResolvedValue({ error: true, message: "provider detail must not escape" });

    const result = await sendOwnerAlert("Operational alert", ["Delivery test"]);

    expect(result).toEqual({
      skipped: false,
      delivered: false,
      recipientCount: 2,
      errorCode: "EMAIL_DELIVERY_FAILED",
    });
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });
});
