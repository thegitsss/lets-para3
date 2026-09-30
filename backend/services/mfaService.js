const crypto = require("crypto");
const { encryptString, decryptString } = require("../utils/dataEncryption");

const MFA_ISSUER = "Let's-ParaConnect";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const normalized = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return bytes.length ? Buffer.from(bytes) : null;
}

function tokenForTimeStep(secret, timeStep) {
  const key = base32Decode(secret);
  if (!key || !Number.isSafeInteger(timeStep) || timeStep < 0) return "";
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** TOTP_DIGITS);
  return String(binary).padStart(TOTP_DIGITS, "0");
}

function generateTotpToken(secret, now = Date.now()) {
  const timeStep = Math.floor(Number(now) / 1000 / TOTP_PERIOD_SECONDS);
  return { token: tokenForTimeStep(secret, timeStep), timeStep };
}

async function createTotpEnrollment(email) {
  const secret = base32Encode(crypto.randomBytes(20));
  const label = encodeURIComponent(`${MFA_ISSUER}:${String(email || "LPC account")}`);
  const params = new URLSearchParams({
    secret,
    issuer: MFA_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return {
    secret,
    encryptedSecret: encryptString(secret),
    uri: `otpauth://totp/${label}?${params.toString()}`,
  };
}

async function verifyTotp({ encryptedSecret, token, afterTimeStep, now = Date.now() }) {
  const secret = decryptString(encryptedSecret || "");
  const candidate = String(token || "");
  if (!secret || !/^\d{6}$/.test(candidate)) return { valid: false };
  const currentStep = Math.floor(Number(now) / 1000 / TOTP_PERIOD_SECONDS);
  for (const delta of [-1, 0, 1]) {
    const timeStep = currentStep + delta;
    if (Number.isInteger(afterTimeStep) && timeStep <= afterTimeStep) continue;
    const expected = tokenForTimeStep(secret, timeStep);
    if (expected && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) {
      return { valid: true, delta, timeStep };
    }
  }
  return { valid: false };
}

function newChallengeId() {
  return crypto.randomBytes(32).toString("base64url");
}

module.exports = {
  MFA_ISSUER,
  createTotpEnrollment,
  generateTotpToken,
  newChallengeId,
  verifyTotp,
};
