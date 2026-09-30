const verifyToken = require("./verifyToken");
const roles = new Set(["attorney", "paralegal", "admin"]);
const has = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
const supplied = object => has(object, "expectedOwnerId") || has(object, "expectedRole");
function invalid() {
  return Object.assign(new Error("Verify your account before using LPC Assistant."), { status: 400, code: "SUPPORT_ACCOUNT_INVALID" });
}
function expectation(req) {
  const read = ["GET", "HEAD"].includes(String(req.method).toUpperCase());
  const input = read ? req.query : req.body, other = read ? req.body : req.query;
  if (supplied(other)) throw invalid();
  if (!supplied(input)) return null;
  if (typeof input.expectedOwnerId !== "string" || !/^[a-f\d]{24}$/i.test(input.expectedOwnerId) || typeof input.expectedRole !== "string" || !roles.has(input.expectedRole)) throw invalid();
  return { ownerId: input.expectedOwnerId.toLowerCase(), role: input.expectedRole };
}
function deny(res, error) {
  res.set("Cache-Control", "private, no-store");
  return res.status(error.status || 403).json({ code: error.code || "SUPPORT_ACCOUNT_CHANGED", error: error.message || "Your signed-in account changed." });
}
function compare(req, res, expected) {
  if (String(req.user?._id || req.user?.id || "").toLowerCase() !== expected.ownerId || req.user?.role !== expected.role) {
    deny(res, { message: "Your signed-in account changed." }); return false;
  }
  req.supportExpectedAccount = expected;
  return true;
}
function requireSupportAccount(req, res, next) {
  let expected;
  try { expected = expectation(req); } catch (error) { return deny(res, error); }
  if (!expected || compare(req, res, expected)) return next();
}
function requireGuardedSupportReset(req, res, next) {
  let expected;
  try { expected = expectation(req); } catch (error) { return deny(res, error); }
  if (!expected) return next();
  const cookie = req.cookies?.token || req.cookies?.[process.env.JWT_COOKIE_NAME || "access"];
  if (!cookie) return deny(res, { status: 401, message: "Verify your signed-in account before requesting a reset link." });
  return verifyToken(req, res, error => {
    if (error) return next(error);
    if (!req.authSessionId) return deny(res, { message: "Verify your signed-in account before requesting a reset link." });
    if (!compare(req, res, expected)) return;
    if (typeof req.body?.email === "string" && req.body.email.trim().toLowerCase() !== String(req.user?.email || "").trim().toLowerCase()) {
      return deny(res, { status: 409, code: "SUPPORT_ACCOUNT_TARGET_CHANGED", message: "Your account email changed. Reload before requesting a reset link." });
    }
    return next();
  });
}
module.exports = { requireSupportAccount, requireGuardedSupportReset };
