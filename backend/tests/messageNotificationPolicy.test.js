const {
  DEFAULT_MESSAGE_EMAIL_SUPPRESS_MINUTES,
  resolveMessageNotificationPolicy,
} = require("../utils/messageNotificationPolicy");

describe("message notification policy", () => {
  test("uses the one shared production-facing suppression setting", () => {
    expect(resolveMessageNotificationPolicy({ MESSAGE_EMAIL_SUPPRESS_MINUTES: "120" })).toEqual({
      suppressMinutes: 120,
      suppressMs: 7_200_000,
    });
  });

  test("falls back safely for missing, disabled, malformed, or excessive values", () => {
    for (const value of [undefined, "", "0", "not-a-number", "1441"]) {
      const env = value === undefined ? {} : { MESSAGE_EMAIL_SUPPRESS_MINUTES: value };
      expect(resolveMessageNotificationPolicy(env).suppressMinutes).toBe(
        DEFAULT_MESSAGE_EMAIL_SUPPRESS_MINUTES
      );
    }
  });
});
