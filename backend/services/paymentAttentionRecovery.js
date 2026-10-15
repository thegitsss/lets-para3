'use strict';
const mongoose = require('mongoose');
const Delivery = require('../models/WebhookEvent'), Audit = require('../models/AuditLog'), Case = require('../models/Case');
const authority = require('./adminAdmissionDecision');
const refunds = require('./attorneyRefundEvents');
const { fingerprint } = require('./matterDraftRevision');
const { currentStripeMode } = require('../utils/stripeMode');
const { publishCaseProjectionRefresh } = require('../utils/caseProjectionEvents');
const types = new Set(['charge.refunded', 'charge.refund.updated', 'refund.created', 'refund.updated', 'refund.failed']);
const id = value => String(value?._id || value || '');
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function fail(status, suffix, message) { throw Object.assign(new Error(message), { status, statusCode: status, publicCode: `PAYMENT_ATTENTION_${suffix}` }); }
const changed = () => fail(409, 'CHANGED', 'The payment evidence changed. Review this alert again before resolving it.');
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const safeReceipt = row => ({ id: id(row._id), eventId: row.eventId, type: row.type, status: row.status, stripeMode: row.stripeMode, attentionRequired: row.attentionRequired === true, category: row.attentionCategory, attempts: row.attempts, lastAttemptAt: iso(row.lastAttemptAt), updatedAt: iso(row.updatedAt) });
function query(req) { if (Object.keys(req.query || {}).some(key => key !== 'expectedOwnerId')) fail(400, 'INVALID', 'Invalid payment alert request.'); }
async function actor(req) { query(req); return authority.verify(req); }
async function verifySources(proof, session) {
  try { await refunds.verifyRefundSources(proof, session); }
  catch (error) { if (['The Matter refund records changed during provider verification.', 'The refund references changed during verification.'].includes(error.message)) changed(); throw error; }
}
async function write(req, work) {
  try { return await authority.write(req, work); }
  catch (error) {
    // A known aborted conflict can be caused by a winning session/account
    // revocation. Preserve that precise current denial; other source conflicts
    // remain409 and unknown commit acknowledgements remain unconfirmed.
    if (error.publicCode === 'ACCOUNT_WRITE_CHANGED') await actor(req);
    throw error;
  }
}
async function receipt(req, session) {
  if (!validId(req.params.receiptId)) fail(400, 'INVALID', 'Invalid payment alert.');
  const row = await Delivery.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.receiptId) }, { session });
  if (!row) fail(404, 'NOT_FOUND', 'This payment alert is no longer available.');
  return row;
}
async function list(req) {
  const owner = await actor(req);
  const rows = await Delivery.collection.find({ attentionRequired: true }).sort({ updatedAt: -1, _id: 1 }).limit(1001).toArray();
  if (rows.length > 1000) fail(413, 'TOO_LARGE', 'The payment alert inventory exceeds the review limit. Contact LPC support.');
  const current = await Delivery.collection.find({ attentionRequired: true }).sort({ updatedAt: -1, _id: 1 }).limit(1001).toArray();
  if (fingerprint(rows) !== fingerprint(current)) changed();
  await actor(req);
  return { ownerId: owner.ownerId, revision: fingerprint([owner, rows]), items: rows.map(safeReceipt) };
}
async function inspect(req, stripe) {
  const owner = await actor(req), row = await receipt(req);
  const view = { ownerId: owner.ownerId, receipt: safeReceipt(row), caseId: null, caseTitle: null, canResolve: false, reason: '', evidence: null };
  let proof = null, audit = null, event = null;
  if (!row.attentionRequired) view.reason = 'This alert has already been resolved.';
  else if (row.status !== 'processed') view.reason = 'Processing is not complete. This alert cannot be resolved while delivery is pending or failed.';
  else if (row.attentionCategory !== 'processing' || !types.has(row.type)) view.reason = 'This alert needs its substantive payment review. It cannot be cleared as a recovered processing failure.';
  else {
    event = await stripe.events.retrieve(row.eventId);
    const mode = event.livemode === true ? 'live' : event.livemode === false ? 'test' : 'unknown';
    if (event.id !== row.eventId || event.type !== row.type || event.account || mode === 'unknown' || row.stripeMode !== mode || currentStripeMode() !== mode) fail(409, 'PROVIDER_MISMATCH', 'The current provider account or event does not match this alert.');
    proof = await refunds.reviewAttention({ event, stripe });
    audit = await Audit.collection.findOne({ _id: new mongoose.Types.ObjectId(fingerprint(['stripe_refund_event', event.id]).slice(0, 24)) });
    const recorded = audit && audit.action === event.type && audit.actorRole === 'system' && audit.meta?.kind === 'refund_observation' && audit.meta.eventId === event.id && audit.meta.externalRef === event.data.object.id && audit.meta.eventHash === fingerprint([event.id, event.type, event.created, event.livemode, event.account, event.request, event.data.object]) && !audit.meta.associationProblem && proof.projected && audit.meta.outcome === proof.projected.paymentStatus && audit.meta.confirmedRefundAmount === proof.projected.confirmedTotal && audit.meta.refundCount === proof.refunds.length && audit.meta.currency === proof.intent.currency && id(audit.case) === id(proof.view.raw._id);
    if (!proof.ready || !recorded) view.reason = 'Current refund, accounting, and original event evidence do not all agree. Keep this alert open for payment review.';
    else {
      view.canResolve = true; view.reason = 'The provider refund is settled and the saved accounting agrees. Only the recovered processing alert will be resolved.';
      view.caseId = id(proof.view.raw._id); view.caseTitle = proof.view.raw.title || 'Untitled Matter';
      view.evidence = { refundCents: proof.projected.confirmedTotal, currency: proof.intent.currency.toUpperCase(), stripeMode: mode, refundCount: proof.refunds.length, outcome: proof.projected.paymentStatus, providerEventId: event.id };
    }
    if (proof.view) await verifySources(proof);
  }
  if (fingerprint(row) !== fingerprint(await receipt(req))) changed();
  if (audit && fingerprint(audit) !== fingerprint(await Audit.collection.findOne({ _id: audit._id }))) changed();
  await actor(req);
  const revision = fingerprint([owner, row, event, proof, audit]);
  return { value: { ...view, revision }, row, proof, audit };
}
async function review(req, stripe) { return (await inspect(req, stripe)).value; }
const resolutionId = (owner, requestId) => new mongoose.Types.ObjectId(fingerprint(['payment_attention_resolution', owner, requestId]).slice(0, 24));
function matchesPrior(row, req, owner) { return row.actorRole === 'admin' && id(row.actor) === owner && row.action === 'payment.attention.resolved' && row.targetType === 'event' && row.targetId === req.params.receiptId && row.meta?.reviewedRevision === req.body.revision; }
async function resolve(req, stripe) {
  const owner = await actor(req), body = req.body || {};
  if (Object.keys(body).sort().join(',') !== 'expectedOwnerId,requestId,revision' || !uuid(body.requestId) || !/^[a-f0-9]{64}$/.test(body.revision || '')) fail(400, 'INVALID', 'Review this payment alert before resolving it.');
  const auditId = resolutionId(owner.ownerId, body.requestId), previous = await Audit.collection.findOne({ _id: auditId });
  if (previous) {
    if (!matchesPrior(previous, req, owner.ownerId)) changed();
    return write(req, async session => {
      const saved = await Audit.collection.findOne({ _id: auditId }, { session });
      if (!saved || !matchesPrior(saved, req, owner.ownerId)) changed();
      const current = await receipt(req, session);
      return { ownerId: owner.ownerId, recorded: true, recovered: true, resolved: current.attentionRequired === false, receiptId: id(current._id) };
    });
  }
  const inspected = await inspect(req, stripe);
  if (inspected.value.revision !== body.revision) changed();
  if (!inspected.value.canResolve) fail(409, 'REVIEW_REQUIRED', inspected.value.reason);
  const { row, proof, audit } = inspected;
  const result = await write(req, async session => {
    if (await Audit.collection.findOne({ _id: auditId }, { session })) changed();
    await verifySources(proof, session);
    if (fingerprint(audit) !== fingerprint(await Audit.collection.findOne({ _id: audit._id }, { session }))) changed();
    const raw = proof.view.raw;
    // This version-only write serializes this review with a competing Matter
    // financial write. No amount, status, scope, payout, or refund is changed.
    const guard = await Case.collection.updateOne({ _id: raw._id, __v: raw.__v === undefined ? { $exists: false } : raw.__v }, { $inc: { __v: 1 } }, { session });
    if (guard.matchedCount !== 1 || guard.modifiedCount !== 1) changed();
    const saved = await Delivery.collection.updateOne({ _id: row._id, eventId: row.eventId, status: 'processed', attentionRequired: true, attentionCategory: 'processing', attempts: row.attempts, lastAttemptAt: row.lastAttemptAt, updatedAt: row.updatedAt }, { $set: { attentionRequired: false, attentionCategory: '', updatedAt: new Date() } }, { session });
    if (saved.matchedCount !== 1 || saved.modifiedCount !== 1) changed();
    await Audit.create([{ _id: auditId, actor: owner.ownerId, actorRole: 'admin', action: 'payment.attention.resolved', targetType: 'event', targetId: id(row._id), case: raw._id, method: 'POST', path: req.originalUrl?.split('?')[0], meta: { eventId: row.eventId, reviewedRevision: body.revision, sourceRevision: fingerprint([proof.view, proof.references, audit]), evidence: inspected.value.evidence, priorCategory: 'processing', priorAttempt: row.attempts, caseVersionBefore: raw.__v ?? null, caseVersionAfter: Number(raw.__v || 0) + 1 } }], { session });
    return { ownerId: owner.ownerId, recorded: true, recovered: false, resolved: true, receiptId: id(row._id) };
  });
  await actor(req);
  publishCaseProjectionRefresh(proof.view.raw, 'payment_attention_resolved');
  return result;
}
module.exports = { list, review, resolve };
