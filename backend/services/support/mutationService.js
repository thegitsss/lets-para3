const { reportOperationalFailure } = require("../../utils/operationalFailure");
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Mutation = require('../../models/SupportMutation');
const Conversation = require('../../models/SupportConversation');
const AuthSession = require('../../models/AuthSession');
const User = require('../../models/User');
const { lockActiveAccounts, accountChanged } = require('../../utils/activeAccountWrite');

const LEASE_MS = 90_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fields = '+fingerprint +claimToken +prepared +result';
function supportError(code, message, statusCode = 409, extra = {}) {
  return Object.assign(new Error(message), { code, publicCode: code, statusCode, ...extra });
}
function validateRequestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw supportError('SUPPORT_REQUEST_INVALID', 'A valid Assistant request ID is required.', 400);
  return value.toLowerCase();
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function requestDto(record) { return { id: record.requestId, action: record.action, state: record.state }; }
function success(record, guarded, replayed) {
  return guarded ? { ...record.result, request: requestDto(record), replayed } : record.result;
}
function pending(record) {
  return supportError('SUPPORT_REQUEST_PENDING', 'This Assistant request is still being processed. Check its result before trying again.', 409, { request: requestDto(record) });
}
async function readyMutationIndexes() {
  let timer;
  try {
    await Promise.race([Mutation.init(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Assistant indexes are not ready')), 8000); })]);
    const indexes = await Mutation.collection.indexes();
    const has = (key, partial) => indexes.some(index => index.unique === true && JSON.stringify(index.key) === JSON.stringify(key) && (!partial || JSON.stringify(index.partialFilterExpression) === JSON.stringify(partial)));
    if (!has({ ownerId: 1, requestId: 1 }) || !has({ ownerId: 1, active: 1 }, { active: true })) throw new Error('Assistant mutation uniqueness is unavailable');
  } catch (cause) {
    throw supportError('SUPPORT_MUTATION_UNAVAILABLE', 'Assistant request recovery is unavailable. Keep your message and try again shortly.', 503, { cause });
  } finally { clearTimeout(timer); }
}
async function outcome({ conversationId, userId, requestId }) {
  const id = validateRequestId(requestId);
  if (!mongoose.isObjectIdOrHexString(conversationId) || !mongoose.isObjectIdOrHexString(userId)) return null;
  if (!await Conversation.exists({ _id: conversationId, userId })) return null;
  const record = await Mutation.findOne({ ownerId: userId, conversationId, requestId: id }).select('+result').lean();
  if (!record) return null;
  const dto = requestDto(record);
  if (dto.state === 'pending' && (record.active === false || (record.leaseExpiresAt && record.leaseExpiresAt <= new Date()))) dto.state = 'retryable';
  return { request: dto, result: record.state === 'succeeded' ? record.result : null, error: record.error?.code ? record.error : null };
}

async function activeRecovery({ user, conversationId }) {
  const ownerId = user?._id || user?.id;
  if (!mongoose.isObjectIdOrHexString(ownerId) || !mongoose.isObjectIdOrHexString(conversationId)) return null;
  const record = await Mutation.findOne({ ownerId, conversationId, role: user.role, active: true, state: { $in: ['pending', 'retryable'] } }).select('+input +prepared').lean();
  if (!record || !record.input) return null;
  const body = record.action === 'escalate'
    ? { messageId: record.input.messageId, sourcePage: record.prepared?.context?.sourcePage || '', pageContext: record.prepared?.context?.pageContext || {} }
    : record.input;
  return { version: 1, ownerId: String(ownerId), role: record.role, conversationId: String(record.conversationId),
    requestId: record.requestId, action: record.action, body, createdAt: record.createdAt.getTime() };
}

async function runMutation({ conversationId, user, action, requestId, input, authSessionId }, work) {
  const guarded = requestId !== undefined;
  const id = guarded ? validateRequestId(requestId) : crypto.randomUUID();
  const ownerId = user?._id || user?.id;
  const role = String(user?.role || '').toLowerCase();
  if (!mongoose.isObjectIdOrHexString(conversationId) || !mongoose.isObjectIdOrHexString(ownerId)) return null;
  await readyMutationIndexes();
  if (!await Conversation.exists({ _id: conversationId, userId: ownerId })) return null;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical({ conversationId: String(conversationId), role, action, input }))).digest('hex');
  async function requireCurrentWriter(session) {
    if (user.authVersion !== undefined) {
      await lockActiveAccounts([ownerId], session, { ownerId, authVersion: user.authVersion });
      if (!await User.exists({ _id: ownerId, role }).session(session)) throw accountChanged();
    }
    if (authSessionId) {
      const access = await AuthSession.collection.updateOne({ userId: new mongoose.Types.ObjectId(String(ownerId)), sessionId: authSessionId, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
      if (access.modifiedCount !== 1) throw accountChanged();
    }
  }
  let record;
  const token = crypto.randomUUID(), now = new Date();
  try {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Admission claims the receipt before the account lock, matching the
        // completion transaction order. A competing owner operation conflicts
        // before waiting for its account write; private input commits only
        // after current account/session authorization succeeds.
        record = await Mutation.findOneAndUpdate({ ownerId, requestId: id }, { $setOnInsert: { ownerId, conversationId, role, requestId: id, action, fingerprint, input, state: 'pending', active: false } }, { session, upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).select(fields);
        if (!record || record.fingerprint !== fingerprint) throw supportError('SUPPORT_REQUEST_REUSED', 'This request ID belongs to different Assistant input. Check the original result.', 409);
        if (!['succeeded', 'failed'].includes(record.state)) {
          const claimed = await Mutation.findOneAndUpdate({ _id: record._id, state: { $in: ['pending', 'retryable'] }, $or: [{ active: false }, { leaseExpiresAt: { $lte: now } }] },
            { $set: { active: true, state: 'pending', claimToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS), error: { code: '', message: '' } }, $inc: { fence: 1 } }, { session, returnDocument: 'after' }).select(fields);
          if (!claimed) throw pending(record);
          record = claimed;
        }
        await requireCurrentWriter(session);
      });
    } finally { record?.$session(null); await session.endSession(); }
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await Mutation.findOne({ ownerId, requestId: id }).select(fields);
    if (existing && existing.fingerprint !== fingerprint) throw supportError('SUPPORT_REQUEST_REUSED', 'This request ID belongs to different Assistant input. Check the original result.', 409);
    if (existing?.state === 'succeeded') return success(existing, guarded, true);
    if (existing?.active && existing.state === 'pending') throw pending(existing);
    throw supportError('SUPPORT_CONVERSATION_BUSY', 'Another Assistant request is still being processed. Check that result before continuing.', 409);
  }
  if (record.state === 'succeeded') return success(record, guarded, true);
  if (record.state === 'failed') throw supportError(record.error.code || 'SUPPORT_REQUEST_FAILED', record.error.message || 'This Assistant request can no longer be completed.', 409, { request: requestDto(record) });
  const claimFilter = { _id: record._id, claimToken: token, state: 'pending', active: true };
  const context = {
    record,
    async transaction(callback) {
      const session = await mongoose.startSession();
      let value;
      try {
        await session.withTransaction(async () => {
          const locked = await Mutation.findOneAndUpdate(claimFilter, { $inc: { fence: 1 }, $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }, { session, returnDocument: 'after' }).select(fields);
          if (!locked) throw supportError('SUPPORT_REQUEST_SUPERSEDED', 'The request is being recovered elsewhere. Check its current result.', 409);
          await requireCurrentWriter(session);
          value = await callback(session, locked);
        });
        return value;
      } finally { await session.endSession(); }
    },
    async checkpoint(update) {
      return this.transaction(async (session) => {
        record = await Mutation.findOneAndUpdate(claimFilter, { $set: update }, { session, returnDocument: 'after' }).select(fields);
        this.record = record;
        return record;
      });
    },
    async complete(session, result) {
      const completed = await Mutation.findOneAndUpdate(claimFilter, { $set: { result, state: 'succeeded', active: false, phase: 'complete', claimToken: '', leaseExpiresAt: null, error: { code: '', message: '' } } }, { session, returnDocument: 'after' }).select(fields);
      if (!completed) throw supportError('SUPPORT_REQUEST_SUPERSEDED', 'The request is being recovered elsewhere. Check its current result.', 409);
      record = completed;
      return result;
    },
  };
  try {
    await work(context);
    const completed = await Mutation.findById(record._id).select(fields);
    if (completed?.state !== 'succeeded') throw supportError('SUPPORT_REQUEST_UNCONFIRMED', 'The Assistant result could not be confirmed. Check this request before trying again.', 503);
    return success(completed, guarded, false);
  } catch (error) {
    // A lost commit acknowledgment is not proof of failure. A durable success
    // wins over local errors and can always be read/replayed by the same ID.
    const latest = await Mutation.findById(record._id).select(fields).catch(() => null);
    if (latest?.state === 'succeeded') return success(latest, guarded, true);
    const terminal = ['SUPPORT_CONVERSATION_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code);
    await Mutation.updateOne(claimFilter, { $set: { state: terminal ? 'failed' : 'retryable', active: !terminal, claimToken: '', leaseExpiresAt: terminal ? null : new Date(0), error: { code: terminal ? error.code : 'SUPPORT_REQUEST_INTERRUPTED', message: terminal ? error.message : 'This request was interrupted. Retry the same request to continue safely.' } } }).catch(reportOperationalFailure("services.support.mutationService.request_recovery_marker"));
    if (error.publicCode || error.code === 'ACCOUNT_CHANGED') throw error;
    throw supportError('SUPPORT_REQUEST_INTERRUPTED', 'This request was interrupted. Check its result or retry the same request to continue safely.', 503, { cause: error, request: { id, action, state: 'retryable' } });
  }
}

module.exports = { LEASE_MS, outcome, activeRecovery, requestDto, runMutation, supportError, validateRequestId };
