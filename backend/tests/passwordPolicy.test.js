const {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  validateNewPassword,
} = require("../utils/passwordPolicy");

describe("password policy", () => {
  test("accepts long passphrases without composition theater", () => {
    expect(validateNewPassword("four calm words together").ok).toBe(true);
  });

  test("enforces current length bounds", () => {
    expect(validateNewPassword("x".repeat(MIN_PASSWORD_LENGTH - 1)).code).toBe("password_too_short");
    expect(validateNewPassword("x".repeat(MAX_PASSWORD_LENGTH + 1)).code).toBe("password_too_long");
  });

  test("rejects common and account-specific values", () => {
    expect(validateNewPassword("Password123!").code).toBe("password_blocklisted");
    expect(validateNewPassword("passwordpassword").code).toBe("password_blocklisted");
    expect(validateNewPassword("alex.johnson@example.com", {
      user: { email: "alex.johnson@example.com" },
    }).code).toBe("password_blocklisted");
  });

  test("normalizes Unicode consistently before hashing", () => {
    expect(normalizePassword("Cafe\u0301 long passphrase")).toBe("Café long passphrase");
  });
});
