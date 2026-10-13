const User = require("../../models/User");

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getFounderApproverEmails() {
  return String(process.env.INCIDENT_FOUNDER_APPROVER_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function allowAdminFallbackForCurrentRuntime() {
  const runtime = String(process.env.NODE_ENV || "development").trim().toLowerCase();
  return ["development", "test", "local"].includes(runtime);
}

function shouldAllowFounderAdminFallback() {
  return (
    allowAdminFallbackForCurrentRuntime() &&
    truthyEnv(process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK)
  );
}

async function findFounderApproverUsers() {
  const allowlist = getFounderApproverEmails();
  if (allowlist.length) {
    return User.find({
      email: { $in: allowlist },
    })
      .select("_id email role status")
      .lean();
  }

  if (!shouldAllowFounderAdminFallback()) {
    return [];
  }

  return User.find({
    role: "admin",
    status: "approved",
  })
    .select("_id email role status")
    .lean();
}

module.exports = {
  truthyEnv,
  getFounderApproverEmails,
  allowAdminFallbackForCurrentRuntime,
  shouldAllowFounderAdminFallback,
  findFounderApproverUsers,
};
