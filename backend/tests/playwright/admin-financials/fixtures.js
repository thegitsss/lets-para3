const { MongoClient, ObjectId } = require('mongoose').mongo;
const ACTIVE = '650000000000000000001001', DONE = '650000000000000000001002';
const ATTORNEY = '650000000000000000002001', PARA = '650000000000000000002002';
const caseIds = [ACTIVE, DONE].map(id => new ObjectId(id));
// This database exists only inside this config's owned disposable replica.
// Fixed loopback origin/port and exact synthetic IDs prevent arbitrary seeding.
async function database(fn) {
  const client = new MongoClient('mongodb://127.0.0.1:5875/control-room-playwright?directConnection=true', { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try { return await fn(client.db('control-room-playwright')); } finally { await client.close(); }
}
async function seed({ mixed = false, allEuro = false, empty = false, review = false, long = false } = {}) {
  return database(async db => {
    for (const collection of ['paymentoperations', 'payouts', 'platformincomes', 'financialadjustments']) await db.collection(collection).deleteMany({ caseId: { $in: caseIds } });
    await db.collection('cases').deleteMany({ _id: { $in: caseIds } });
    if (empty) return;
    const now = new Date();
    for (const [userId, role, firstName] of [[ATTORNEY, 'attorney', 'Avery'], [PARA, 'paralegal', 'Bailey']]) await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { firstName, lastName: long ? 'Montgomery Harrington Rivera-Santiago' : 'Lane', email: `${role}@admin-financial-browser.test`, role, status: 'approved', disabled: false, deleted: false, authVersion: 0, createdAt: now } }, { upsert: true });
    for (let i = 0; i < caseIds.length; i++) {
      const caseId = caseIds[i], done = i === 1, currency = allEuro || mixed && done ? 'eur' : 'usd', providerMode = mixed && done ? 'live' : 'test', suffix = String(caseId);
      await db.collection('cases').insertOne({ _id: caseId, title: done ? 'Contract review' : long ? 'Discovery response support for Montgomery Harrington Rivera-Santiago and associated entities' : 'Discovery response support', details: 'Synthetic retained financial evidence for browser acceptance.', attorney: new ObjectId(ATTORNEY), attorneyId: new ObjectId(ATTORNEY), paralegal: new ObjectId(PARA), paralegalId: new ObjectId(PARA), totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, feeParalegalPct: 18, currency, stripeMode: providerMode, status: done ? 'completed' : 'in progress', moderationStatus: 'approved', escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: `pi_browser_${suffix}`, paymentIntentId: `pi_browser_${suffix}`, paymentReleased: done, payoutStatus: done ? 'paid' : 'not_started', ...(done ? { payoutTransferId: `tr_browser_${suffix}`, completedAt: now, paidOutAt: now } : {}), createdAt: now, updatedAt: now, tasks: [], withdrawalHistory: [], disputes: [], flags: [], applicants: [], files: [], archived: false });
      await db.collection('paymentoperations').insertOne({ caseId, operationKey: `funding:${suffix}:pi_browser_${suffix}`, kind: 'funding', fingerprint: suffix, status: review && !done ? 'needs_reconciliation' : 'succeeded', amount: 48800, currency, stripeMode: providerMode, livemode: providerMode === 'live', stripePaymentIntentId: `pi_browser_${suffix}`, stripeObjectId: `pi_browser_${suffix}`, stripeChargeId: `ch_browser_${suffix}`, stripeBalanceTransactionId: `txn_browser_${suffix}`, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, evidenceVerifiedAt: now, createdAt: now });
      if (done) {
        const key = `case_payout:${suffix}`;
        await db.collection('payouts').insertOne({ caseId, operationKey: key, paralegalId: new ObjectId(PARA), amountPaid: 32800, transferId: `tr_browser_${suffix}`, status: 'paid', stripeMode: providerMode, createdAt: now });
        await db.collection('paymentoperations').insertOne({ caseId, operationKey: key, kind: 'case_payout', fingerprint: suffix, status: 'succeeded', amount: 32800, transferAmount: 32800, currency, stripeMode: providerMode, stripeTransferId: `tr_browser_${suffix}`, stripeObjectId: `tr_browser_${suffix}`, createdAt: now });
        await db.collection('platformincomes').insertOne({ caseId, operationKey: key, attorneyId: new ObjectId(ATTORNEY), paralegalId: new ObjectId(PARA), feeAmount: 16000, stripeMode: providerMode, createdAt: now });
      }
    }
  });
}
async function seedChargebacks(count = 1) {
  return database(async db => {
    for (let index = 0; index < count; index++) {
      const operationId = new ObjectId(`65000000000000000000${String(4000 + index)}`), suffix = String(operationId), caseId = new ObjectId(ACTIVE), now = new Date();
      await db.collection('paymentoperations').insertOne({ _id: operationId, caseId, kind: 'chargeback', operationKey: `chargeback:${suffix}`, fingerprint: suffix, amount: 48800, currency: 'usd', stripeMode: 'test', livemode: false, status: 'succeeded', evidenceStatus: 'verified', administrativeStatus: 'pending_review', processorStatus: 'needs_response', payoutPosition: 'pre_payout', stripeDisputeId: `dp_${suffix}`, stripeChargeId: `ch_${suffix}`, stripeEventId: `evt_${suffix}`, createdAt: now, updatedAt: now });
      for (const [type, amount] of [['chargeback_principal', 48800], ['processor_dispute_fee', 1400]]) await db.collection('financialadjustments').insertOne({ idempotencyKey: `${suffix}:${type}`, paymentOperationId: operationId, caseId, amount, direction: 'debit', adjustmentType: type, currency: 'usd', stripeMode: 'test', stripeDisputeId: `dp_${suffix}`, stripeChargeId: `ch_${suffix}`, stripeBalanceTransactionId: `txn_${suffix}`, stripeEventId: `evt_${suffix}` });
    }
  });
}
module.exports = { seed, seedChargebacks, database, ACTIVE, DONE };
