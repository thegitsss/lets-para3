function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

function resolveCurrentParalegalAssignmentBoundary(caseDoc, viewer = {}) {
  if (!caseDoc?.withdrawnParalegalId || !caseDoc?.hiredAt) return null;

  const role = String(viewer.role || "").toLowerCase();
  if (role !== "paralegal" && viewer.isParalegal !== true) return null;

  const viewerId = normalizeId(viewer.userId || viewer.id);
  const assignedIds = [normalizeId(caseDoc.paralegal), normalizeId(caseDoc.paralegalId)].filter(Boolean);
  if (viewerId && !assignedIds.includes(viewerId)) return null;

  const boundary = new Date(caseDoc.hiredAt);
  return Number.isNaN(boundary.getTime()) ? null : boundary;
}

function buildAssignmentVisibilityClause(caseDoc, viewer = {}) {
  const boundary = resolveCurrentParalegalAssignmentBoundary(caseDoc, viewer);
  if (!boundary) return null;

  // Legacy records may predate timestamps. Preserve access to those records
  // rather than silently losing evidence while still separating every dated
  // prior-assignment record from the replacement paralegal.
  return {
    $or: [
      { createdAt: { $gte: boundary } },
      { createdAt: { $exists: false } },
      { createdAt: null },
    ],
  };
}

function applyAssignmentVisibility(filter, caseDoc, viewer = {}) {
  const clause = buildAssignmentVisibilityClause(caseDoc, viewer);
  if (!clause) return filter;
  return { $and: [filter, clause] };
}

// The same assignment boundary for a Case-to-record aggregation lookup. Resolve
// it on each Case before selecting its latest record; a global preview must not
// rank a replacement paralegal's conversations using prior-assignment messages.
function buildAssignmentVisibilityLookup(viewer = {}) {
  const role = String(viewer.role || "").toLowerCase();
  let boundary = { $literal: null };
  if (role === "paralegal" || viewer.isParalegal === true) {
    const viewerId = normalizeId(viewer.userId || viewer.id);
    const present = field => ({ $not: [{ $in: [{ $ifNull: [field, null] }, [null, false, 0, ""]] }] });
    const assigned = viewerId ? {
      $in: [{ $literal: viewerId }, ["$paralegal", "$paralegalId"].map(field => ({
        $convert: { input: field, to: "string", onError: "", onNull: "" },
      }))],
    } : true;
    boundary = {
      $cond: [
        { $and: [present("$withdrawnParalegalId"), present("$hiredAt"), assigned] },
        { $convert: { input: "$hiredAt", to: "date", onError: null, onNull: null } },
        null,
      ],
    };
  }
  return {
    let: { assignmentBoundary: boundary },
    expression: {
      $or: [
        { $eq: ["$$assignmentBoundary", null] },
        { $eq: [{ $ifNull: ["$createdAt", null] }, null] },
        { $gte: ["$createdAt", "$$assignmentBoundary"] },
      ],
    },
  };
}

function isRecordVisibleToCurrentAssignment(record, caseDoc, viewer = {}) {
  const boundary = resolveCurrentParalegalAssignmentBoundary(caseDoc, viewer);
  if (!boundary) return true;
  if (!record?.createdAt) return true;
  const createdAt = new Date(record.createdAt);
  if (Number.isNaN(createdAt.getTime())) return true;
  return createdAt.getTime() >= boundary.getTime();
}

module.exports = {
  applyAssignmentVisibility,
  buildAssignmentVisibilityLookup,
  buildAssignmentVisibilityClause,
  isRecordVisibleToCurrentAssignment,
  resolveCurrentParalegalAssignmentBoundary,
};
