// Isolated, synthetic marketplace activity. Never accepts a production URI.
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), { performance } = require('perf_hooks');
process.env.LPC_LIFECYCLE_RANDOM_PORT = 'true';
const output = path.resolve(process.env.LPC_ADMIN_SCALE_OUTPUT || path.join(__dirname, '../../outputs/admin-os/performance')); fs.mkdirSync(output, { recursive: true });
const baseline = process.argv.includes('--baseline');
(async () => {
  let server, result;
  try {
    server = await require('../tests/helpers/financialLifecycleBrowserServer')({ includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true });
    const mongoose = require('mongoose'); assert.equal(mongoose.connection.name, server.ownedDatabaseName); assert(mongoose.connection.host === '127.0.0.1');
    const owner = await server.createUser('admin');
    const User = require('../models/User'), Case = require('../models/Case'), Operation = require('../models/PaymentOperation'), Payout = require('../models/Payout'), Income = require('../models/PlatformIncome'), Ticket = require('../models/SupportTicket');
    const now = new Date(), day = 86400000, monthStart = Date.parse(require('../services/adminExecutiveMetrics').periodFor(new Date()).from), oid = () => new mongoose.Types.ObjectId();
    const people = Array.from({ length: 5000 }, (_, i) => ({ _id: oid(), firstName: 'Synthetic', lastName: 'Member ' + i, email: `scale-${i}@example.test`, role: i < 2000 ? 'attorney' : 'paralegal', status: i < 4 ? 'pending' : 'approved', emailVerified: true, disabled: false, deleted: false, createdAt: new Date(now - (i % 180 + 1) * day), updatedAt: now, state: 'CA', barNumber: i < 2000 ? 'SYN-' + i : undefined, barState: 'CA', paralegalQualification: 'law_firm_experience', yearsExperience: 4 }));
    await User.collection.insertMany(people);
    const cases = [], operations = [], payouts = [], incomes = [];
    for (let i = 0; i < 1500; i++) {
      const id = oid(), attorney = people[4 + i % 1996]._id, para = people[2000 + i % 3000]._id;
      const completed = i < 500, active = i >= 500 && i < 1000, mode = completed && i >= 100 ? 'test' : 'live';
      const createdAt = new Date(now - 20 * day), hiredAt = new Date(now - 18 * day), at = new Date(Math.max(monthStart, now.getTime() - day)), pi = `pi_scale_${i}`;
      const row = { _id: id, title: `Synthetic Matter ${i}`, attorney, attorneyId: attorney, status: completed ? 'completed' : active ? 'in progress' : 'open', totalAmount: 40000, currency: 'usd', stripeMode: mode, feeAttorneyPct: 22, feeParalegalPct: 18, feeAttorneyAmount: 8800, feeParalegalAmount: 7200, createdAt, updatedAt: now, deadlineDate: new Date(now.getTime() + 7 * day).toISOString().slice(0, 10), moderationStatus: 'none' };
      if (completed || active) Object.assign(row, { paralegal: para, paralegalId: para, hiredAt, lockedTotalAmount: 40000, remainingAmount: 40000, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: pi, paymentIntentId: pi, paymentReleased: completed, payoutStatus: completed ? 'paid' : 'not_started' });
      if (completed || active) operations.push({ _id: oid(), caseId: id, operationKey: 'funding:' + id + ':' + pi, fingerprint: 'synthetic:' + i, kind: 'funding', status: 'succeeded', amount: 48800, currency: 'usd', stripeMode: mode, livemode: mode === 'live', stripePaymentIntentId: pi, stripeObjectId: pi, stripeChargeId: 'ch_scale_' + i, stripeBalanceTransactionId: 'txn_scale_' + i, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, evidenceVerifiedAt: createdAt, createdAt, updatedAt: now });
      if (completed) {
        const key = 'case_payout:' + id, transfer = 'tr_scale_' + i;
        Object.assign(row, { completedAt: at, paidOutAt: at, payoutTransferId: transfer });
        operations.push({ _id: oid(), caseId: id, operationKey: key, kind: 'case_payout', fingerprint: 'completion:' + i, status: 'succeeded', amount: 32800, transferAmount: 32800, currency: 'usd', stripeMode: mode, stripeTransferId: transfer, stripeObjectId: transfer, createdAt: at, updatedAt: at });
        payouts.push({ _id: oid(), caseId: id, paralegalId: para, operationKey: key, amountPaid: 32800, transferId: transfer, status: 'paid', stripeMode: mode, createdAt: at, updatedAt: at });
        incomes.push({ _id: oid(), caseId: id, attorneyId: attorney, paralegalId: para, operationKey: key, feeAmount: 16000, stripeMode: mode, createdAt: at });
      }
      cases.push(row);
    }
    for (let i = 0; i < 12000; i++) operations.push({ _id: oid(), caseId: cases[1000 + i % 500]._id, operationKey: 'history:' + i, fingerprint: 'history:' + i, kind: 'funding', status: 'canceled', stripeMode: 'test', amount: 48800, createdAt: new Date(now - (190 + i % 90) * day), updatedAt: now });
    Object.assign(cases[1400], { fundingIntegrityStatus: 'failed', escrowIntentId: 'pi_scale_failed' });
    operations.push({ _id: oid(), caseId: cases[1400]._id, operationKey: 'failure:1400', fingerprint: 'failure', kind: 'funding', status: 'needs_reconciliation', stripePaymentIntentId: 'pi_scale_failed', createdAt: now, updatedAt: now });
    await Case.collection.insertMany(cases); await Operation.collection.insertMany(operations); await Payout.collection.insertMany(payouts); await Income.collection.insertMany(incomes);
    await Ticket.collection.insertMany(Array.from({ length: 6000 }, (_, i) => ({ _id: oid(), subject: 'Synthetic support ' + i, message: 'A bounded synthetic operating history.', requestKind: i < 2 ? 'human' : 'support', requesterRole: 'attorney', requesterUserId: people[4 + i % 1996]._id, requesterEmail: `scale-${4 + i % 1996}@example.test`, status: i < 2 ? 'open' : 'resolved', urgency: 'medium', emailReplies: [], createdAt: new Date(now - (i % 120) * day), updatedAt: now })));
    const Message = require('../models/Message');
    await Message.collection.insertMany(Array.from({ length: 10000 }, (_, i) => ({ _id: oid(), caseId: cases[i % 1500]._id, senderId: people[4 + i % 1996]._id, text: 'Synthetic marketplace message history.', createdAt: new Date(now - (i % 120) * day), updatedAt: now })));
    const timings = [];
    const request = async endpoint => {
      const started = performance.now(); const response = await fetch(server.origin + endpoint, { headers: { cookie: `${owner.cookie.name}=${owner.cookie.value}` } }); const body = await response.json();
      timings.push({ endpoint: endpoint.split('?')[0], status: response.status, ms: +(performance.now() - started).toFixed(2) }); return { status: response.status, body };
    };
    const executive = await request('/api/admin/workspace/executive?expectedOwnerId=' + owner.id);
    assert.equal(executive.status, 200); assert.equal(executive.body.metrics.acquisition.attorneys.registered + executive.body.metrics.acquisition.paralegals.registered, 5000); assert.equal(executive.body.decisions.remaining, 7);
    const endpoints = ['/api/admin/workspace/flow', '/api/admin/workspace/matters?view=posted', '/api/admin/workspace/matters?view=engagements', '/api/admin/pending-users?status=pending&limit=20', '/api/admin/support/inbox-summary'];
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(endpoints.map(request));
      for (const result of results) assert.equal(result.status, 200);
    }
    if (!baseline) { assert.equal(executive.body.financial.available, true, 'The live monthly-fee summary must stay available beyond 10,000 unrelated operations'); assert.equal(executive.body.financial.earnings.available, true); assert.equal(executive.body.financial.earnings.amount, 1600000); }
    const all = timings.map(t => t.ms).sort((a, b) => a - b), p95 = all[Math.ceil(all.length * .95) - 1];
    result = { status: 'passed', mode: baseline ? 'baseline' : 'final', platform: process.platform, arch: process.arch, node: process.version, fixture: { members: 5000, matters: cases.length, paymentOperations: operations.length, payouts: payouts.length, incomeRecords: incomes.length, supportTickets: 6000, messages: 10000, pendingApplications: 4, humanRequests: 2, distinctFinancialProblems: 1 }, expectedOwnerDecisions: 7, ownerTime: executive.body.ownerTime, financial: executive.body.financial, concurrentReadClients: endpoints.length, requests: timings.length, p95Ms: p95, maxMs: all.at(-1), timings, limitations: ['Synthetic local fixture; provider calls substituted, not live Stripe/mail proof.', 'Measured on this host at five concurrent read clients; not a universal capacity guarantee.', 'Owner-time figure is a planning estimate, not observed human judgement time.'] };
  } finally { await server?.close(); }
  result.cleanupComplete = true;
  fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ status: 'passed', mode: result.mode, fixture: result.fixture, p95Ms: result.p95Ms, financialAvailable: result.financial.available, cleanupComplete: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
