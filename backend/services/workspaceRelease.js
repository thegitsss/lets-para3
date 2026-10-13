const crypto = require('node:crypto');
const mongoose = require('mongoose');
const WorkspaceRelease = require('../models/WorkspaceRelease');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const ROLES = ['attorney', 'paralegal'];
const objectId = value => typeof value === 'string' && /^[a-f\d]{24}$/.test(value);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function failure(status, code, message) { return Object.assign(new Error(message), { status, statusCode: status, code }); }
function defaults() { return { revision: 0, enabled: false, killSwitch: false, attorney: { basisPoints: 0, overrides: {} }, paralegal: { basisPoints: 0, overrides: {} } }; }
function serialize(record) {
  if (!record) return defaults();
  const value = typeof record.toObject === 'function' ? record.toObject({ flattenMaps: true }) : record;
  const result = { revision: value.revision, enabled: value.enabled, killSwitch: value.killSwitch };
  for (const role of ROLES) result[role] = { basisPoints: value[role].basisPoints, overrides: { ...(value[role].overrides instanceof Map ? Object.fromEntries(value[role].overrides) : value[role].overrides) } };
  return result;
}
function validateUpdate(input) {
  const invalid = () => { throw failure(400, 'WORKSPACE_RELEASE_INVALID', 'Review the workspace release settings and try again.'); };
  if (!plainObject(input) || Object.keys(input).some(key => !['expectedRevision', 'enabled', 'killSwitch', 'attorney', 'paralegal', 'reason'].includes(key))) invalid();
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision === Number.MAX_SAFE_INTEGER || typeof input.enabled !== 'boolean' || typeof input.killSwitch !== 'boolean') invalid();
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f<>]/.test(input.reason)) invalid();
  const config = { enabled: input.enabled, killSwitch: input.killSwitch };
  for (const role of ROLES) {
    const cohort = input[role];
    if (!plainObject(cohort) || Object.keys(cohort).some(key => !['basisPoints', 'overrides'].includes(key)) || !Number.isSafeInteger(cohort.basisPoints) || cohort.basisPoints < 0 || cohort.basisPoints > 10000 || !plainObject(cohort.overrides) || Object.keys(cohort.overrides).length > 500) invalid();
    const overrides = {};
    for (const [id, version] of Object.entries(cohort.overrides).sort()) { if (!objectId(id) || !['legacy', 'v2'].includes(version)) invalid(); overrides[id] = version; }
    config[role] = { basisPoints: cohort.basisPoints, overrides };
  }
  return { expectedRevision: input.expectedRevision, reason: input.reason.trim(), config };
}
function bucketFor(role, id) {
  // Stable across processes, config revisions, percentage changes and rebuilds.
  return crypto.createHash('sha256').update(`lpc-workspace-cohort-v1:${role}:${id}`).digest().readUInt32BE(0) % 10000;
}
function decisionFor(user, config = defaults()) {
  const id = String(user?._id || user?.id || ''), role = String(user?.role || '');
  if (!objectId(id) || !ROLES.includes(role) || user.status !== 'approved' || user.disabled || user.deleted) throw failure(403, 'WORKSPACE_RELEASE_ACCESS_DENIED', 'This account cannot open the member workspace.');
  let version = 'baseline', reason = 'not_activated';
  if (config.killSwitch) { version = 'legacy'; reason = 'global_rollback'; }
  else if (config.enabled) {
    const cohort = config[role], override = cohort.overrides[id];
    version = override || (bucketFor(role, id) < cohort.basisPoints ? 'v2' : 'legacy');
    reason = override ? 'account_override' : 'cohort';
  }
  return { schemaVersion: 1, ownerId: id, role, revision: config.revision, version, reason, defaultDestination: version === 'v2' ? `/${role}-v2.html#/home` : `/dashboard-${role}.html` };
}
async function readConfig() { return serialize(await WorkspaceRelease.findById('workspaces').lean()); }
async function readDecision(user) { return decisionFor(user, await readConfig()); }
async function updateConfig(req, input) {
  const { expectedRevision, reason, config } = validateUpdate(input);
  if (req.user?.role !== 'admin' || !objectId(String(req.user?.id || ''))) throw failure(403, 'WORKSPACE_RELEASE_ACCESS_DENIED', 'Administrator access is required.');
  const session = await mongoose.startSession();
  try {
    let saved;
    await session.withTransaction(async () => {
      // Resolve every explicit assignment to its current role. An override never
      // bypasses the ordinary approved/disabled/deleted account boundary.
      for (const role of ROLES) {
        const ids = Object.keys(config[role].overrides);
        if (ids.length && await User.countDocuments({ _id: { $in: ids }, role }).session(session) !== ids.length) throw failure(400, 'WORKSPACE_RELEASE_ACCOUNT_MISMATCH', 'An account override does not match its workspace role.');
      }
      const before = await WorkspaceRelease.findById('workspaces').session(session);
      if ((before?.revision || 0) !== expectedRevision) throw failure(409, 'WORKSPACE_RELEASE_CHANGED', 'The workspace release settings changed. Read them again before making a decision.');
      const prior = serialize(before);
      if (before) {
        before.set({ ...config, revision: expectedRevision + 1, updatedBy: req.user.id });
        saved = await before.save({ session });
      } else saved = (await WorkspaceRelease.create([{ _id: 'workspaces', ...config, revision: 1, updatedBy: req.user.id }], { session }))[0];
      await AuditLog.logFromReq(req, 'workspace.release.changed', { targetType: 'other', targetId: 'workspaces', session, meta: { expectedRevision, revision: saved.revision, reason, after: serialize(saved), before: prior } });
    });
    return serialize(saved);
  } catch (error) {
    if (error?.code === 11000) throw failure(409, 'WORKSPACE_RELEASE_CHANGED', 'The workspace release settings changed. Read them again before making a decision.');
    throw error;
  } finally { await session.endSession(); }
}
module.exports = { defaults, serialize, validateUpdate, bucketFor, decisionFor, readConfig, readDecision, updateConfig };
