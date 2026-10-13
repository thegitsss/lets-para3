const { Types } = require("mongoose");
const Case = require("../models/Case"), account = require("./attorneyAccountBoundary");
const { fingerprint } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState");
const { evaluateWorkspaceAccess } = require("./attorneyWorkflowPolicy");
const { publishCaseEvent } = require("../utils/caseEvents");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const { logAction } = require("../utils/audit");
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const guardFields = ["title", "tasks", "taskRevision", "__v", "status", "attorney", "attorneyId", "paralegal", "paralegalId", "hiredAt", "tasksLocked", "readOnly", "archived", "withdrawnParalegalId", "pausedReason", "payoutFinalizedType", "payoutFinalizedAt", "paymentReleased", "escrowStatus", "escrowIntentId", "completionClaimStatus", "hiringClaimStatus"];
const fail = (status, suffix) => { throw Object.assign(new Error("The Matter work could not be changed."), { status, publicCode: `WORKSPACE_${suffix}` }); };
const completed = value => [true, "true", 1, "1"].includes(value);
const title = task => String(typeof task === "string" ? task : task?.title || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 200);
const done = task => completed(task?.completed ?? task?.done ?? task?.isCompleted);
const revision = raw => fingerprint(guardFields.map(key => raw[key]));
const snapshotFilter = raw => ({ _id: raw._id, ...Object.fromEntries(guardFields.map(key => [key, raw[key] === undefined ? { $exists: false } : raw[key]])) });
function preserveCompletion(tasks, values) {
  return tasks.map((task, index) => typeof task === "string" ? { title: task, completed: values[index] } : { ...task, completed: values[index] });
}
async function accountRead(req) {
  try { return await account.read(req, req.method === "GET" ? req.query.expectedOwnerId : req.body?.expectedOwnerId); }
  catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; }
}
async function snapshot(req) {
  const user = await accountRead(req);
  if (!validId(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new Types.ObjectId(req.params.caseId) });
  if (!raw) fail(404, "NOT_FOUND");
  if (![raw.attorney, raw.attorneyId].some(id => String(id || "") === String(user._id))) fail(403, "RESTRICTED");
  return raw;
}
function capabilities(raw) {
  const status = normalizeCaseStatus(raw.status), assigned = Boolean(raw.paralegal || raw.paralegalId);
  const policy = evaluateWorkspaceAccess({ caseDoc: raw, viewerRole: "attorney", viewerId: String(raw.attorney || raw.attorneyId) });
  const locked = Boolean(raw.completionClaimStatus || raw.hiringClaimStatus);
  const canToggle = policy.ready && !raw.archived && !raw.readOnly && status === "in progress" && !locked && !raw.paymentReleased;
  const completedLocked = assigned && Boolean(raw.withdrawnParalegalId || raw.pausedReason === "paralegal_withdrew" || ["zero_auto", "partial_attorney", "admin", "expired_zero"].includes(raw.payoutFinalizedType));
  const reason = locked ? "decision_pending" : raw.archived || raw.readOnly || raw.paymentReleased || ["completed", "closed", "disputed"].includes(status) ? "closed" : !assigned ? "assignment_required" : !policy.ready ? "work_unavailable" : "ready";
  return { canToggle, completedLocked, reason, canEditScope: status === "open" && !raw.hiredAt && !assigned && !raw.tasksLocked && !raw.readOnly && !raw.archived && !locked };
}
function present(raw) {
  if (!Array.isArray(raw.tasks) || raw.tasks.some(task => !title(task))) fail(409, "WORK_UNAVAILABLE");
  const state = capabilities(raw);
  return { caseId: String(raw._id), title: raw.title, revision: revision(raw), taskRevision: Number(raw.taskRevision || 0), status: normalizeCaseStatus(raw.status), ...state,
    items: raw.tasks.map((task, index) => ({ index, id: validId(String(task?._id || "")) ? String(task._id) : null, title: title(task), completed: done(task), canToggle: state.canToggle && !(state.completedLocked && done(task)) })) };
}
async function read(req) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const raw = await snapshot(req), result = present(raw);
  if (revision(raw) !== revision(await snapshot(req))) fail(409, "WORK_CHANGED");
  return result;
}
async function update(req) {
  const body = req.body || {};
  if (Object.keys(body).some(key => !["expectedOwnerId", "reviewedRevision", "index", "completed"].includes(key)) || !Number.isInteger(body.index) || body.index < 0 || typeof body.completed !== "boolean" || !/^[a-f0-9]{64}$/.test(body.reviewedRevision || "")) fail(400, "INVALID");
  const raw = await snapshot(req), view = present(raw), item = view.items[body.index];
  if (body.reviewedRevision !== view.revision) fail(409, "WORK_CHANGED");
  if (!item || !item.canToggle) fail(403, "WORK_RESTRICTED");
  if (item.completed === body.completed) return { work: view, changed: false };
  await accountRead(req);
  const task = raw.tasks[body.index], value = typeof task === "string" ? { title: task, completed: body.completed } : { ...task, completed: body.completed };
  const result = await Case.collection.updateOne(snapshotFilter(raw), { $set: { [`tasks.${body.index}`]: value, updatedAt: new Date() }, $inc: { taskRevision: 1, __v: 1 } });
  if (result.modifiedCount !== 1) fail(409, "WORK_CHANGED");
  await logAction(req, "case.task.review", { targetType: "case", targetId: raw._id, meta: { taskIndex: body.index, completed: body.completed } });
  publishCaseEvent(raw._id, "tasks", { at: new Date().toISOString() });
  publishCaseProjectionRefresh(raw, "matter_updated_refresh", { caseEvent: "" });
  return { work: present(await snapshot(req)), changed: true };
}
// Existing clients keep their task-list contract. Capture the raw metadata and
// reject lifecycle/assignment changes between their ACL read and the write.
async function legacySnapshot(doc, expectedTaskRevision) {
  const raw = await Case.collection.findOne({ _id: doc._id });
  const refs = ["attorney", "attorneyId", "paralegal", "paralegalId", "withdrawnParalegalId"];
  if (!raw || normalizeCaseStatus(raw.status) !== normalizeCaseStatus(doc.status) || refs.some(key => String(raw[key] || "") !== String(doc[key] || "")) || Boolean(raw.readOnly) !== Boolean(doc.readOnly) || Number(raw.taskRevision || 0) !== Number(doc.taskRevision || 0) || expectedTaskRevision !== undefined && expectedTaskRevision !== Number(raw.taskRevision || 0)) fail(409, "WORK_CHANGED");
  if (!Array.isArray(raw.tasks) || raw.tasks.length !== doc.tasks.length || raw.tasks.some((task, index) => title(task) !== title(doc.tasks[index]) || done(task) !== done(doc.tasks[index]))) fail(409, "WORK_CHANGED");
  return raw;
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "WORKSPACE_WORK_UNAVAILABLE", error: "The Matter work changed or could not be verified. Refresh the work list before trying again." });
module.exports = { read, update, snapshotFilter, preserveCompletion, legacySnapshot, sendError, revision };
