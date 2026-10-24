'use strict';
const mongoose = require('mongoose'), crypto = require('node:crypto');
const Case = require('../../models/Case'), Operation = require('../../models/PaymentOperation'), Audit = require('../../models/AuditLog'), Delivery = require('../../models/WebhookEvent');
const { fingerprint } = require('../../services/matterDraftRevision');
module.exports = function install(stripe) {
  const entries = new Map(), reads = [], originals = [];
  const replace = (resource, method, fn) => { originals.push([resource, method, stripe[resource][method]]); stripe[resource][method] = async (...args) => { reads.push({ method: `${resource}.${method}`, args: structuredClone(args) }); return structuredClone(await fn(...args)); }; };
  const find = (field, value) => { const entry = [...entries.values()].find(row => row[field].id === value); if (!entry) throw Error('Unknown owned synthetic payment attention reference'); return entry; };
  replace('events', 'retrieve', id => { const row = entries.get(id); if (!row) throw Error('Unknown owned synthetic event'); return row.event; });
  replace('refunds', 'retrieve', id => find('refund', id).refund);
  replace('refunds', 'list', args => ({ data: [find('charge', args.charge).refund], has_more: false }));
  replace('charges', 'retrieve', id => find('charge', id).charge);
  replace('paymentIntents', 'retrieve', id => find('intent', id).intent);
  return { reads, entries, restore() { for (const [resource, method, fn] of originals) stripe[resource][method] = fn; }, async seed({ attorneyId, paralegalId, category = 'processing', status = 'processed' }) {
    const suffix = crypto.randomUUID().replaceAll('-', ''), now = new Date();
    const matter = await Case.create({ title: `Synthetic recovered refund ${suffix}`, details: 'Reserved synthetic local refund accounting.', attorney: attorneyId, attorneyId, paralegal: paralegalId, paralegalId, status: 'closed', totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, feeParalegalPct: 18, currency: 'usd', stripeMode: 'test', paymentIntentId: `pi_attention_${suffix}`, escrowIntentId: `pi_attention_${suffix}`, escrowStatus: 'refunded', paymentStatus: 'refunded', fundingIntegrityStatus: 'verified', paymentReleased: false, payoutStatus: 'not_started' });
    const refund = { id: `re_attention_${suffix}`, object: 'refund', status: 'succeeded', amount: 48800, currency: 'usd', charge: `ch_attention_${suffix}`, payment_intent: matter.paymentIntentId, created: 1788951600, metadata: { caseId: String(matter._id) } };
    const charge = { id: refund.charge, object: 'charge', payment_intent: matter.paymentIntentId, amount: 48800, amount_captured: 48800, amount_refunded: 48800, paid: true, captured: true, refunded: true, disputed: false, status: 'succeeded', currency: 'usd', livemode: false };
    const intent = { id: matter.paymentIntentId, object: 'payment_intent', status: 'succeeded', amount: 48800, amount_received: 48800, currency: 'usd', livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(attorneyId) }, latest_charge: charge };
    const event = { id: `evt_attention_${suffix}`, type: 'refund.created', livemode: false, created: 1788955200, api_version: '2026-09-30.endive', data: { object: refund } };
    const operation = await Operation.create({ caseId: matter._id, kind: 'dispute_settlement', operationKey: `dispute_settlement:${matter._id}:${suffix}`, fingerprint: suffix, status: 'succeeded', amount: 40000, currency: 'usd', stripeMode: 'test', stripeObjectId: refund.id, stripeRefundId: refund.id, stripePaymentIntentId: intent.id, stripeChargeId: charge.id, refundAmount: 48800, refundStatus: 'succeeded', refundEvidenceStatus: 'verified', refundVerifiedAt: now });
    const audit = await Audit.create({ _id: new mongoose.Types.ObjectId(fingerprint(['stripe_refund_event', event.id]).slice(0, 24)), actor: null, actorRole: 'system', action: event.type, targetType: 'payment', case: matter._id, method: 'POST', path: '/api/webhooks/stripe', meta: { eventId: event.id, eventHash: fingerprint([event.id, event.type, event.created, event.livemode, event.account, event.request, event.data.object]), kind: 'refund_observation', externalRef: refund.id, outcome: 'refunded', associationProblem: null, confirmedRefundAmount: 48800, refundCount: 1, currency: 'usd' } });
    const delivery = await Delivery.create({ eventId: event.id, type: event.type, stripeMode: 'test', status, attentionRequired: true, attentionCategory: category, attempts: 3, lastError: '', lastAttemptAt: now });
    const entry = { matter, operation, audit, delivery, refund, charge, intent, event }; entries.set(event.id, entry); return entry;
  } };
};
