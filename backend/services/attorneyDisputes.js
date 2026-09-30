const { reportOperationalFailure } = require("../utils/operationalFailure");
const crypto = require("crypto");
const mongoose = require("mongoose"), Case = require("../models/Case"), User = require("../models/User"), AuditLog = require("../models/AuditLog");
const account = require("./attorneyAccountBoundary"), { fingerprint } = require("./matterDraftRevision"), { normalizeCaseStatus } = require("../utils/caseState");
const id = value => String(value?._id || value || ""), validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const ref = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null, cents = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const fields = "title attorney attorneyId paralegal paralegalId withdrawnParalegalId status disputes disputeSettlement escrowIntentId escrowStatus paymentReleased payoutFinalizedAt pausedReason disputeDeadlineAt completionClaimStatus completionClaimToken hiringClaimStatus hiringClaimToken withdrawalClaimStatus withdrawalClaimToken archived readOnly purgedAt currency __v".split(" "), projection = Object.fromEntries(fields.map(key => [key, 1]));
const fail = (status, suffix) => { throw Object.assign(new Error("The dispute record could not be verified."), { status, publicCode: `WORKSPACE_DISPUTE_${suffix}` }); };
const owner = req => req.method === "GET" ? req.query.expectedOwnerId : req.body?.expectedOwnerId;
async function actor(req) { try { return await account.read(req, owner(req)); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; } }
async function matter(req, session) {
  await actor(req); if (!validId(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { projection, session }); if (!raw) fail(404, "NOT_FOUND");
  if (![raw.attorney, raw.attorneyId].some(value => id(value) === owner(req)) || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId)) fail(403, "RESTRICTED");
  if (raw.paralegal && raw.paralegalId && id(raw.paralegal) !== id(raw.paralegalId)) fail(409, "CHANGED"); return raw;
}
const opaqueRevision = value => crypto.createHmac("sha256", process.env.JWT_SECRET).update(JSON.stringify(value)).digest("hex");
const revision = raw => opaqueRevision(fields.map(key => raw[key]));
const exact = raw => ({ _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : { $eq: raw[key] }])) });
const disputeId = value => ref(value?.disputeId) ? value.disputeId : validId(id(value?._id)) ? id(value._id) : null;
const statusOf = value => typeof value?.status === "string" && value.status.trim() ? value.status.trim().toLowerCase() : "open";
const list = raw => Array.isArray(raw.disputes) ? raw.disputes : [];
function canOpen(raw) {
  if (!["in progress", "paused", "completed"].includes(normalizeCaseStatus(raw.status)) || !raw.escrowIntentId || String(raw.escrowStatus || "").toLowerCase() !== "funded") return "funded_work_required";
  if (list(raw).some(value => statusOf(value) === "open")) return "review_open";
  if (raw.completionClaimStatus || raw.completionClaimToken || raw.hiringClaimStatus || raw.hiringClaimToken || raw.withdrawalClaimStatus || raw.withdrawalClaimToken) return "processing";
  if (raw.pausedReason === "paralegal_withdrew" && raw.disputeDeadlineAt) {
    if (!iso(raw.disputeDeadlineAt)) return "withdrawal_deadline_unavailable";
    if (!raw.payoutFinalizedAt && Date.now() <= new Date(raw.disputeDeadlineAt).getTime()) return "paralegal_review_window";
    return "withdrawal_window_ended";
  }
  return "ready";
}
const receiptId = (req, requestId) => new mongoose.Types.ObjectId(fingerprint(["attorney_dispute", owner(req), requestId]).slice(0, 24));
async function receipt(req, requestId, session) {
  const saved = await AuditLog.collection.findOne({ _id: receiptId(req, requestId) }, { session, ...(session ? {} : { readConcern: { level: "majority" } }) });
  if (saved && (id(saved.actor) !== owner(req) || id(saved.case) !== id(req.params.caseId) || saved.actorRole !== "attorney" || saved.meta?.kind !== "attorney_dispute" || !["open", "comment"].includes(saved.meta.operation))) fail(409, "REQUEST_CHANGED"); return saved;
}
function outcome(raw, saved) {
  if (!saved) return { status: "not_found", disputeId: null, commentId: null, changedSinceSave: false };
  const dispute = list(raw).find(value => disputeId(value) === saved.meta.disputeId), comment = dispute?.comments?.find?.(value => id(value?._id) === saved.meta.commentId);
  const current = saved.meta.operation === "open" ? dispute : comment;
  return { status: "recorded", action: saved.meta.operation, disputeId: saved.meta.disputeId, commentId: saved.meta.commentId || null, changedSinceSave: !current || fingerprint(current) !== saved.meta.savedRevision };
}
const orderRevision = values => fingerprint(values.map(value => [disputeId(value), value?.createdAt]));
function cursor(value, expected, length) {
  if (value === undefined) return length;
  try { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,250}$/.test(value)) fail(400, "INVALID"); const pair = JSON.parse(Buffer.from(value, "base64url").toString()); if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] < 0 || pair[0] > length || pair[1] !== expected) fail(409, "CHANGED"); return pair[0]; } catch (error) { if (error.publicCode) throw error; fail(400, "INVALID"); }
}
const nextCursor = (index, digest) => index > 0 ? Buffer.from(JSON.stringify([index, digest])).toString("base64url") : null;
async function present(raw, req, query, saved) {
  const values = list(raw), ordered = orderRevision(values), from = cursor(query.cursor, ordered, values.length), page = values.slice(Math.max(0, from - 25), from).reverse();
  const selected = query.disputeId ? values.find(value => disputeId(value) === query.disputeId) : [...values].reverse().find(value => statusOf(value) === "open") || values.at(-1) || null;
  const selectedId = disputeId(selected), duplicates = selectedId ? values.filter(value => disputeId(value) === selectedId).length > 1 : false;
  const comments = Array.isArray(selected?.comments) ? selected.comments : [], commentDigest = fingerprint(comments.map(value => [id(value?._id), value?.createdAt])), end = cursor(query.commentCursor, commentDigest, comments.length), visibleComments = comments.slice(Math.max(0, end - 25), end).reverse();
  const selectedComment = query.commentId ? comments.find(value => id(value?._id) === query.commentId) || null : null;
  const people = [...new Set([...page.map(value => id(value?.raisedBy)), id(selected?.raisedBy), ...visibleComments.map(value => id(value?.by)), id(selectedComment?.by)].filter(validId))];
  const names = new Map((await User.collection.find({ _id: { $in: people.map(value => new mongoose.Types.ObjectId(value)) } }, { projection: { firstName: 1, lastName: 1 } }).toArray()).map(person => [id(person._id), [person.firstName, person.lastName].filter(value => typeof value === "string").join(" ").trim()]));
  const person = value => ({ id: validId(id(value)) ? id(value) : null, name: names.get(id(value)) || "Name not recorded" });
  const shape = value => ({ id: disputeId(value), status: ["open", "resolved", "rejected"].includes(statusOf(value)) ? statusOf(value) : "unknown", message: typeof value?.message === "string" ? value.message : "No details are recorded.", raisedBy: person(value?.raisedBy), createdAt: iso(value?.createdAt), updatedAt: iso(value?.updatedAt), requestedAmount: cents(value?.amountRequestedCents), commentCount: Array.isArray(value?.comments) ? value.comments.length : 0 });
  const shapeComment = value => ({ id: validId(id(value?._id)) ? id(value._id) : null, by: person(value?.by), text: typeof value?.text === "string" ? value.text : "No comment text is recorded.", createdAt: iso(value?.createdAt) });
  const decision = raw.disputeSettlement, matching = selectedId && decision?.disputeId === selectedId && ["refund", "release_full", "release_partial"].includes(decision.action);
  const currency = typeof raw.currency === "string" && /^[A-Za-z]{3}$/.test(raw.currency) ? raw.currency.toUpperCase() : raw.currency == null ? "USD" : null;
  const reason = canOpen(raw);
  return { ownerId: owner(req), caseId: id(raw._id), caseTitle: typeof raw.title === "string" ? raw.title : "Untitled Matter", revision: revision(raw), reason, canOpen: reason === "ready", total: values.length, items: page.map(shape), nextCursor: nextCursor(Math.max(0, from - 25), ordered), selection: !query.disputeId ? "automatic" : selected ? "found" : "unavailable", selected: selected ? { ...shape(selected), revision: opaqueRevision(selected), canComment: Boolean(selectedId && !duplicates), comments: visibleComments.map(shapeComment), nextCommentCursor: nextCursor(Math.max(0, end - 25), commentDigest), selectedComment: selectedComment ? shapeComment(selectedComment) : null, commentSelection: !query.commentId ? "none" : selectedComment ? "found" : "unavailable", decision: matching ? { action: decision.action, grossCents: cents(decision.grossAmount), payoutCents: cents(decision.payoutAmount), refundCents: cents(decision.refundAmount), at: iso(decision.resolvedAt) } : null } : null, currency, operation: query.requestId ? outcome(raw, saved) : null };
}
async function read(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "cursor", "disputeId", "commentCursor", "commentId", "requestId"].includes(key)) || query.disputeId !== undefined && !ref(query.disputeId) || query.commentId !== undefined && !validId(query.commentId) || query.requestId !== undefined && !uuid(query.requestId)) fail(400, "INVALID");
  const raw = await matter(req), saved = query.requestId ? await receipt(req, query.requestId) : null, dto = await present(raw, req, query, saved), current = await matter(req);
  if (revision(raw) !== revision(current)) fail(409, "CHANGED"); return dto;
}
function input(req) {
  const body = req.body || {}, operation = body.action;
  if (Object.keys(body).some(key => !["expectedOwnerId", "requestId", "reviewedRevision", "action", "disputeId", "reviewedDisputeRevision", "text"].includes(key)) || !uuid(body.requestId) || !["open", "comment"].includes(operation) || !/^[a-f0-9]{64}$/.test(body.reviewedRevision || "") || typeof body.text !== "string" || !body.text.trim() || body.text.length > (operation === "open" ? 20000 : 10000) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text) || operation === "comment" && (!ref(body.disputeId) || !/^[a-f0-9]{64}$/.test(body.reviewedDisputeRevision || "")) || operation === "open" && (body.disputeId !== undefined || body.reviewedDisputeRevision !== undefined)) fail(400, "INVALID");
  return { ...body, text: body.text.trim(), hash: fingerprint([operation, body.disputeId || null, body.text.trim()]) };
}
async function ready() { let timer; try { await Promise.race([AuditLog.init(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Dispute initialization incomplete")), 8000); })]); } finally { clearTimeout(timer); } }
async function save(req) {
  const data = input(req); await actor(req); const initial = await matter(req), existing = await receipt(req, data.requestId);
  if (existing) { if (existing.meta.inputHash !== data.hash) fail(409, "REQUEST_CHANGED"); const current = await matter(req); return { changed: false, operation: outcome(current, existing), doc: current }; }
  if (revision(initial) !== data.reviewedRevision) fail(409, "CHANGED");
  await ready(); const session = await mongoose.startSession(); let dispatches = [], saved, updated, target, commitAttempted = false, changed = true;
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    const raw = await matter(req, session); if (revision(raw) !== data.reviewedRevision) fail(409, "CHANGED");
    const now = new Date(); let update, savedValue, commentId = null;
    if (data.action === "open") {
      if (canOpen(raw) !== "ready") fail(409, "OPEN_RESTRICTED");
      const shell = new Case(), draft = shell.disputes.create({ disputeId: new mongoose.Types.ObjectId().toString(), message: data.text, raisedBy: owner(req), status: "open", comments: [], createdAt: now, updatedAt: now }); await draft.validate();
      savedValue = draft.toObject(); target = disputeId(savedValue);
      update = { $push: { disputes: savedValue }, $set: { status: "disputed", pausedReason: "dispute", disputeDeadlineAt: null, adminDisputeDeadlineAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), adminDisputeOverdueNotifiedAt: null, updatedAt: now }, $inc: { __v: 1 } };
    } else {
      const matches = list(raw).map((value, index) => ({ value, index })).filter(entry => disputeId(entry.value) === data.disputeId);
      if (matches.length !== 1 || opaqueRevision(matches[0].value) !== data.reviewedDisputeRevision) fail(409, "CHANGED");
      target = data.disputeId; const shell = new Case(), dispute = shell.disputes.create({ message: "Validation parent", raisedBy: owner(req) }), draft = dispute.comments.create({ by: owner(req), text: data.text, createdAt: now }); await draft.validate(); savedValue = draft.toObject(); commentId = id(savedValue._id);
      update = { $push: { [`disputes.${matches[0].index}.comments`]: savedValue }, $set: { [`disputes.${matches[0].index}.updatedAt`]: now, updatedAt: now }, $inc: { __v: 1 } };
    }
    updated = await Case.collection.findOneAndUpdate(exact(raw), update, { session, returnDocument: "after" }); if (!updated) fail(409, "CHANGED");
    const [audit] = await AuditLog.create([{ _id: receiptId(req, data.requestId), actor: owner(req), actorRole: "attorney", action: data.action === "open" ? "dispute.create" : "dispute.comment.add", targetType: "case", targetId: id(raw._id), case: raw._id, method: req.method, path: req.originalUrl?.split("?")[0], meta: { kind: "attorney_dispute", operation: data.action, inputHash: data.hash, disputeId: target, commentId, savedRevision: fingerprint(savedValue) } }], { session });
    if (data.action === "open") dispatches = await require("./matterReviewNotifications").stageOpening(updated, savedValue, session, req.user.id);
    await actor(req); commitAttempted = true; await session.commitTransaction(); saved = audit.toObject();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyDisputes.transaction_abort"));
    const recovered = await receipt(req, data.requestId).catch(() => null);
    if (recovered && recovered.meta.inputHash === data.hash) { saved = recovered; updated = await matter(req); target = recovered.meta.disputeId; changed = commitAttempted; }
    else { if (error.publicCode) throw error; if (error.code === 11000 || error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED"); fail(503, "UNCONFIRMED"); }
  } finally { await session.endSession(); }
  const current = await matter(req); return { changed, dispatches, action: data.action, disputeId: target, doc: updated, operation: outcome(current, saved) };
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "WORKSPACE_DISPUTE_UNCONFIRMED", error: "The dispute could not be confirmed. Check its current record before trying again." });
module.exports = { read, save, sendError, actor };
