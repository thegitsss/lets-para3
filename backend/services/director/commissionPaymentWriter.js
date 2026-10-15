const { Types } = require('mongoose');
const Record = require('../../models/DirectorOutreachRecord');
const User = require('../../models/User');
const AuthSession = require('../../models/AuthSession');
const AuditLog = require('../../models/AuditLog');
const { withActiveAccountWrite, accountChanged } = require('../../utils/activeAccountWrite');
const { fingerprint } = require('../matterDraftRevision');
const evidence = require('./commissionEvidence');
const payments = require('./commissionPayments');
const exact = value => value === undefined ? { $exists: false } : value;
async function recordPayment({ recordId, body, req }) {
  const command = payments.parse(body), requestFingerprint = fingerprint(command);
  if (typeof recordId !== 'string' || !/^[a-f0-9]{24}$/i.test(recordId)) return null;
  const id = new Types.ObjectId(recordId), ownerId = String(req.user?.id || req.user?._id || '');
  let record = await Record.collection.findOne({ _id: id });
  if (!record) return null;
  const refreshed = await require('./directorPortalService').refreshDirectorRecords({ directorUserId: record.directorUserId, deferVerify: true });
  record = await Record.collection.findOne({ _id: id });
  if (!record) return null;
  const earned = refreshed.financial.records.get(recordId), view = evidence.attach(record, refreshed.financial), balance = view.commissionPayments;
  if (!earned || !balance || balance.corrupt) throw payments.error(409, 'REVIEW', 'Payment history requires review before it can be changed.');
  const previous = balance.history.find(entry => entry.id === command.requestId);
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) throw payments.error(409, 'REQUEST_REUSED', 'This request already records different details. Refresh before continuing.');
    await refreshed.financial.verify();
    return { record: view, paymentId: previous.id, replayed: true };
  }
  if (balance.revision !== command.revision) throw payments.error(409, 'CHANGED', 'The commission balance or payment history changed. Refresh and review it again.');
  if (balance.version >= payments.LIMIT) throw payments.error(413, 'HISTORY_LIMIT', 'Payment history requires review before more entries can be added.');
  if (command.action === 'payment') {
    if (command.reconcileLegacy) {
      if (balance.legacyState !== 'needs_review') throw payments.error(409, 'LEGACY', 'There is no unresolved historical paid flag.');
    } else {
      const group = balance.groups.find(group => group.currency === command.currency && group.stripeMode === command.stripeMode);
      if (balance.state === 'needs_review' || !group || group.outstandingCents === null || command.amountCents > group.outstandingCents) throw payments.error(400, 'BALANCE', 'The amount must be within the verified outstanding balance for this currency and mode.');
    }
  } else if (command.action === 'legacy_none') {
    if (balance.legacyState !== 'needs_review') throw payments.error(409, 'LEGACY', 'There is no unresolved historical paid flag.');
  } else {
    const original = balance.history.find(entry => entry.id === command.reverses);
    if (!original || original.action === 'reverse' || original.reversed) throw payments.error(409, 'REVERSED', 'This payment record cannot be reversed again.');
  }
  const entry = { ...command, id: command.requestId, requestFingerprint, reviewedRevision: command.revision, sourceRevision: refreshed.financial.revision, feeBasis: payments.basisFor(record, earned), recordedAt: new Date(), recordedBy: ownerId };
  delete entry.requestId; delete entry.revision;
  if (Buffer.byteLength(JSON.stringify([...(record.commissionPaymentLedger || []), entry])) > 8 * 1024 * 1024) throw payments.error(413, 'HISTORY_LIMIT', 'Payment history requires review before more entries can be added.');
  await withActiveAccountWrite([ownerId], async session => {
    const actor = await User.collection.findOne({ _id: new Types.ObjectId(ownerId), role: 'admin' }, { session, projection: { _id: 1 } });
    if (!actor || !req.authSessionId) throw accountChanged();
    const active = await AuthSession.collection.updateOne({ sessionId: req.authSessionId, userId: actor._id, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
    if (active.matchedCount !== 1) throw accountChanged();
    // Reverify retained fee inputs, then atomically append with the reviewed
    // ledger/referral version. Keep the precise evidence basis on the entry.
    await refreshed.financial.verify();
    const retainedFields = ['directorUserId', 'attorneyEmail', 'registeredUserId', 'firstOutreachSentAt', 'commissionLegacySnapshot', 'commissionPayoutStatus', 'commissionPaidAt', 'commissionPaidByAdminId', 'commissionPayoutNote', 'commissionPaymentVersion', 'commissionPaymentLedger'];
    const filter = { _id: id, ...Object.fromEntries(retainedFields.map(name => [name, exact(record[name])])) };
    const result = await Record.collection.updateOne(filter, { $push: { commissionPaymentLedger: entry }, $set: { commissionPaymentVersion: balance.version + 1, updatedAt: entry.recordedAt } }, { session });
    if (result.modifiedCount !== 1) throw payments.error(409, 'CHANGED', 'The commission record changed. Refresh and review it again.');
    await AuditLog.create([{ actor: actor._id, actorRole: 'admin', action: `director.commission.${command.action}`, targetType: 'payment', targetId: recordId, ip: req.ip, ua: req.headers?.['user-agent'], method: req.method, path: req.originalUrl, meta: { paymentId: entry.id, directorUserId: String(record.directorUserId), attorneyEmail: record.attorneyEmail, action: entry.action, amountCents: entry.amountCents, currency: entry.currency, stripeMode: entry.stripeMode, paidDate: entry.paidDate, reference: entry.reference, reverses: entry.reverses, sourceRevision: entry.sourceRevision, reviewedRevision: entry.reviewedRevision } }], { session });
  }, { ownerId, authVersion: req.auth?.payload?.av || 0 });
  const saved = { ...record, commissionPaymentLedger: [...(record.commissionPaymentLedger || []), entry], commissionPaymentVersion: balance.version + 1, updatedAt: entry.recordedAt };
  return { record: { ...view, commissionPayments: payments.project(saved, earned) }, paymentId: entry.id, replayed: false };
}
module.exports = { recordPayment };
