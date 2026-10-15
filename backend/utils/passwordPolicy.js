const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  "123456789012345",
  "1234567890123456",
  "adminadminadmin",
  "changemechangeme",
  "correcthorsebatterystaple",
  "iloveyouiloveyou",
  "letmeinletmeinletmein",
  "letsparaconnect",
  "let's-paraconnect",
  "paraconnectparaconnect",
  "passwordpassword",
  "password123!",
  "password123456",
  "qwertyqwertyqwerty",
  "welcome123welcome",
]);

function normalizePassword(value) {
  return String(value ?? "").normalize("NFC");
}

function contextSpecificPasswords(user = {}) {
  const email = String(user.email || "").trim().toLowerCase();
  const localPart = email.split("@")[0] || "";
  const firstName = String(user.firstName || "").trim().toLowerCase();
  const lastName = String(user.lastName || "").trim().toLowerCase();
  return new Set([
    email,
    localPart,
    `${firstName}${lastName}`,
    `${firstName}.${lastName}`,
    `${firstName}-${lastName}`,
  ].filter((value) => value.length >= MIN_PASSWORD_LENGTH));
}

function validateNewPassword(value, { user = {} } = {}) {
  const password = normalizePassword(value);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      code: "password_too_short",
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be no more than ${MAX_PASSWORD_LENGTH} characters.`,
      code: "password_too_long",
    };
  }

  const normalizedCandidate = password.toLocaleLowerCase("en-US");
  if (COMMON_PASSWORDS.has(normalizedCandidate) || contextSpecificPasswords(user).has(normalizedCandidate)) {
    return {
      ok: false,
      error: "Choose a less common password or a longer, unique passphrase.",
      code: "password_blocklisted",
    };
  }

  return { ok: true, password };
}

module.exports = {
  COMMON_PASSWORDS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  validateNewPassword,
};
