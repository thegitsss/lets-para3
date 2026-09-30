const { publishCaseEvent } = require("./caseEvents");
const { publishNotificationEvent } = require("./notificationEvents");
const { publishMatterDiscoveryEvent } = require("./matterDiscoveryEvents");

function entityId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

// Signals only. Clients always re-fetch their role-authorized projections.
function publishCaseProjectionRefresh(
  caseDoc,
  type = "case_refresh",
  { additionalUserIds = [], discovery = false, caseEvent = "case" } = {}
) {
  const caseId = entityId(caseDoc?._id || caseDoc?.id);
  const at = new Date().toISOString();
  if (caseId && caseEvent) publishCaseEvent(caseId, caseEvent, { at, type });

  const participantIds = new Set([
    entityId(caseDoc?.attorneyId),
    entityId(caseDoc?.attorney),
    entityId(caseDoc?.paralegalId),
    entityId(caseDoc?.paralegal),
    entityId(caseDoc?.pendingParalegalId),
    entityId(caseDoc?.withdrawnParalegalId),
    ...(Array.isArray(caseDoc?.invites)
      ? caseDoc.invites.map((invite) => entityId(invite?.paralegalId))
      : []),
    ...(Array.isArray(caseDoc?.applicants)
      ? caseDoc.applicants.map((applicant) => entityId(applicant?.paralegalId))
      : []),
    ...additionalUserIds.map(entityId),
  ].filter(Boolean));
  participantIds.forEach((userId) => {
    publishNotificationEvent(userId, "notifications", { at, type });
  });
  if (discovery) publishMatterDiscoveryEvent(type);
}

module.exports = { publishCaseProjectionRefresh };
