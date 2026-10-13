const crypto = require("crypto");

const INCIDENT_ACCESS_TOKEN_HEADER = "x-incident-access-token";

function hashReporterAccessToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function generateReporterAccessToken() {
  const token = crypto.randomBytes(24).toString("hex");
  return {
    token,
    hash: hashReporterAccessToken(token),
    issuedAt: new Date(),
  };
}

function tokensMatch(token, storedHash) {
  const candidateHash = String(hashReporterAccessToken(token || ""));
  const expectedHash = String(storedHash || "").trim();
  if (!candidateHash || !expectedHash || candidateHash.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidateHash), Buffer.from(expectedHash));
}

function getReporterAccessToken(req) {
  return String(req?.get?.(INCIDENT_ACCESS_TOKEN_HEADER) || "").trim();
}

function userCanReadIncident(incident, user) {
  if (!incident || !user) return false;
  if (String(user.role || "").toLowerCase() === "admin") return true;
  const reporterUserId = String(incident.reporter?.userId || "");
  const requesterUserId = String(user.id || user._id || "");
  return Boolean(reporterUserId && requesterUserId && reporterUserId === requesterUserId);
}

function reporterTokenCanReadIncident(incident, accessToken) {
  if (!incident || !accessToken) return false;
  return tokensMatch(accessToken, incident.reporter?.accessTokenHash);
}

function canReadIncident(incident, { user = null, accessToken = "" } = {}) {
  return userCanReadIncident(incident, user) || reporterTokenCanReadIncident(incident, accessToken);
}

module.exports = {
  INCIDENT_ACCESS_TOKEN_HEADER,
  hashReporterAccessToken,
  generateReporterAccessToken,
  getReporterAccessToken,
  userCanReadIncident,
  reporterTokenCanReadIncident,
  canReadIncident,
};
