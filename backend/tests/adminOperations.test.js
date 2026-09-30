const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const crypto = require('crypto');
jest.mock('../utils/email', () => jest.fn(async () => ({
  accepted: ['applicant@example.test']
})));
jest.mock('../utils/stripe', () => ({
  accounts: {
    retrieve: jest.fn()
  },
  paymentIntents: {
    retrieve: jest.fn()
  }
}));
const sendEmail = require('../utils/email');
const stripe = require('../utils/stripe');
const User = require('../models/User');
const Case = require('../models/Case');
const Event = require('../models/Event');
const CaseFile = require('../models/CaseFile');
const PaymentOperation = require('../models/PaymentOperation');
const AuditLog = require('../models/AuditLog');
const SupportTicket = require('../models/SupportTicket');
const {
  previewDispute,
  disputeRevision
} = require('../services/disputePreviewService');
const {
  connect,
  clearDatabase,
  closeDatabase
} = require('./helpers/db');
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin/support', require('../routes/adminSupport'));
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/payments', require('../routes/payments'));
app.use('/api/disputes', require('../routes/disputes'));
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({
  error: error.message
}));
let admin, attorney, paralegal;
const cookie = u => `token=${jwt.sign({
  id: String(u._id),
  role: u.role,
  status: u.status
}, process.env.JWT_SECRET, {
  expiresIn: '1h'
})}`;
const get = url => request(app).get(url).set('Cookie', cookie(admin));
const user = (role, email, status = 'approved') => User.create({
  firstName: 'Review',
  lastName: role,
  email,
  password: 'Example123!Strong',
  role,
  status,
  emailVerified: true,
  state: 'CA'
});
const matter = (extra = {}) => Case.create({
  title: 'Review matter',
  details: 'Shared scope',
  attorney: attorney._id,
  paralegal: paralegal._id,
  status: 'open',
  totalAmount: 10000,
  ...extra
});
beforeAll(async () => {
  await connect();
  await SupportTicket.init();
}, 90000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  jest.clearAllMocks();
  admin = await user('admin', 'admin@example.test');
  attorney = await user('attorney', 'attorney@example.test');
  paralegal = await user('paralegal', 'paralegal@example.test');
});
test('operators can assign a follow-up; the exact overdue and mine queues match its audit record', async () => {
  const t = await SupportTicket.create({
    subject: 'Human help',
    message: 'Question',
    requestKind: 'human'
  });
  const url = `/api/admin/support/tickets/${t._id}/triage`;
  const body = {
    revision: (await get(`/api/admin/support/tickets/${t._id}`)).body.ticket.triageRevision,
    assignedTo: String(admin._id),
    followUpAt: '2026-01-01T12:00:00Z',
    nextAction: 'Review the shared file.'
  };
  expect((await request(app).patch(url).set('Cookie', cookie(attorney)).send(body)).status).toBe(403);
  expect((await request(app).patch(url).set('Cookie', cookie(admin)).send({
    ...body,
    assignedTo: String(attorney._id)
  })).status).toBe(400);
  const saved = await request(app).patch(url).set('Cookie', cookie(admin)).send(body);
  expect(saved.status).toBe(200);
  expect((await get('/api/admin/support/inbox?assignment=mine&followUp=overdue')).body.total).toBe(1);
  expect((await get('/api/admin/support/inbox?assignment=unassigned')).body.total).toBe(0);
  expect((await get('/api/admin/support/inbox-summary')).body.overdue).toBe(1);
  expect(await AuditLog.countDocuments({
    targetId: String(t._id)
  })).toBe(1);
});
test('follow-up saves reject missing and stale revisions, including same-millisecond edits', async () => {
  const t = await SupportTicket.create({ subject: 'Follow-up', message: 'Please review', nextAction: 'Original' });
  const url = `/api/admin/support/tickets/${t._id}/triage`;
  const body = { assignedTo: String(admin._id), followUpAt: null, nextAction: 'Older tab edit' };
  const patch = data => request(app).patch(url).set('Cookie', cookie(admin)).send(data);
  expect((await patch(body)).status).toBe(428);
  const revision = (await get(`/api/admin/support/tickets/${t._id}`)).body.ticket.triageRevision;
  await SupportTicket.collection.updateOne({ _id: t._id }, { $set: { nextAction: 'Newer owner edit' } });
  expect((await patch({ ...body, revision })).status).toBe(409);
  expect((await SupportTicket.findById(t._id)).nextAction).toBe('Newer owner edit');
  expect(await AuditLog.countDocuments({ targetId: String(t._id) })).toBe(0);
  const fresh = (await get(`/api/admin/support/tickets/${t._id}`)).body.ticket.triageRevision;
  expect((await patch({ ...body, revision: fresh })).status).toBe(200);
});

test('application information requests persist communication and retry without sending twice', async () => {
  const applicant = await user('paralegal', 'applicant@example.test', 'pending');
  const url = `/api/admin/workspace/accounts/${applicant._id}/information-request`;
  const body = {
    requestId: crypto.randomUUID(),
    text: 'Please clarify your experience.'
  };
  const [first, second] = await Promise.all([request(app).post(url).set('Cookie', cookie(admin)).send(body), request(app).post(url).set('Cookie', cookie(admin)).send(body)]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(await SupportTicket.countDocuments({
    requesterUserId: applicant._id
  })).toBe(1);
  const context = (await get(`/api/admin/workspace/accounts/${applicant._id}`)).body;
  expect(context.reviewState).toBe('information_requested');
  expect(context.readiness.ready).toBe(false);
  expect(context.admissionRequests[0].emailReplies).toHaveLength(1);
  const recorded = await SupportTicket.findOne({ requesterUserId: applicant._id }).lean();
  expect((await request(app).post(url).set('Cookie', cookie(admin)).send(body)).status).toBe(200);
  const repeated = await SupportTicket.findById(recorded._id).lean();
  expect(repeated.updatedAt).toEqual(recorded.updatedAt);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect((await User.findById(applicant._id)).status).toBe('pending');
  expect((await request(app).post(url).set('Cookie', cookie(admin)).send({
    ...body,
    text: 'Changed request'
  })).status).toBe(409);
});
test('account notes and access actions are audited with the operator reason', async () => {
  const id = attorney._id;
  expect((await request(app).post(`/api/admin/workspace/accounts/${id}/note`).set('Cookie', cookie(admin)).send({
    text: 'Reviewed existing matters.'
  })).status).toBe(200);
  expect((await request(app).post(`/api/admin/disable/${id}`).set('Cookie', cookie(admin)).send({
    reason: 'Identity review'
  })).status).toBe(200);
  expect((await User.findById(id)).disabled).toBe(true);
  expect((await request(app).post(`/api/admin/enable/${id}`).set('Cookie', cookie(admin)).send({
    reason: 'Review complete'
  })).status).toBe(200);
  const logs = await AuditLog.find({
    targetType: 'user',
    targetId: String(id)
  }).lean();
  expect(JSON.stringify(logs)).toContain('Reviewed existing matters.');
  expect(JSON.stringify(logs)).toContain('Review complete');
});
test('finance export reaches every filtered record and escapes spreadsheet formulas', async () => {
  const c = await matter({
    title: '=HYPERLINK("example")'
  });
  await PaymentOperation.insertMany(Array.from({
    length: 55
  }, (_, i) => ({
    caseId: c._id,
    operationKey: `record-${i}`,
    fingerprint: 'test',
    kind: 'funding',
    amount: 10000,
    status: i === 54 ? 'failed' : 'succeeded',
    stripeTransferId: `tr_test_${i}`
  })));
  expect((await get('/api/admin/workspace/finance/records?page=3')).body.items).toHaveLength(5);
  expect((await get('/api/admin/workspace/finance/records?status=exceptions')).body.total).toBe(1);
  const csv = await get('/api/admin/workspace/finance/export');
  expect(csv.status).toBe(200);
  expect(csv.text.trim().split('\n')).toHaveLength(56);
  expect(csv.text).toContain("'=HYPERLINK");
  expect((await get('/api/admin/workspace/finance/records?from=2026-02-31')).status).toBe(400);
  expect((await get('/api/admin/workspace/finance/records?q=%5B')).body.total).toBe(0);
  expect((await get('/api/admin/workspace/search?q=tr_test_54')).body.payments).toHaveLength(1);
  expect((await request(app).get('/api/admin/workspace/finance/export').set('Cookie', cookie(paralegal))).status).toBe(403);
});
test('chargebacks beyond the former cap and all unreleased matters remain reachable', async () => {
  await PaymentOperation.insertMany(Array.from({
    length: 205
  }, (_, i) => ({
    operationKey: `chargeback-${i}`,
    fingerprint: 'test',
    kind: 'chargeback',
    amount: 100,
    status: 'needs_reconciliation',
    administrativeStatus: 'pending_review'
  })));
  const queue = await get('/api/admin/chargebacks?page=9&limit=25');
  expect(queue.body.total).toBe(205);
  expect(queue.body.items || queue.body.chargebacks).toHaveLength(5);
  await Promise.all(Array.from({
    length: 7
  }, () => matter({
    status: 'completed',
    escrowStatus: 'funded'
  })));
  const records = await get('/api/admin/workspace/finance/records?kind=pending');
  expect(records.body.total).toBe(7);
  expect((await get('/api/admin/workspace/attention')).body.chargebacks).toBe(205);
});
test('matter work records paginate, distinguish scan state, and exclude private calendar and notes', async () => {
  const c = await matter({
    notes: 'PRIVATE SENTINEL',
    deadlineDate: '2026-01-01'
  });
  await Event.create([{
    title: 'Private sentinel',
    start: new Date(),
    owner: attorney._id,
    caseId: c._id,
    visibility: 'private'
  }, {
    title: 'Shared court date',
    start: new Date(),
    owner: attorney._id,
    caseId: c._id,
    visibility: 'case_team',
    isAllDay: true
  }]);
  await CaseFile.collection.insertMany(Array.from({
    length: 25
  }, (_, i) => ({
    caseId: c._id,
    originalName: `File ${i}`,
    status: 'pending_review',
    securityStatus: 'clean',
    createdAt: new Date()
  })));
  const deadlines = (await get(`/api/admin/workspace/matters/${c._id}/records?type=deadlines`)).body;
  expect(deadlines.total).toBe(1);
  expect(deadlines.items[0].isAllDay).toBe(true);
  expect(JSON.stringify(deadlines)).not.toContain('Private sentinel');
  const files = (await get(`/api/admin/workspace/matters/${c._id}/records?type=files&page=2`)).body;
  expect(files.items).toHaveLength(5);
  expect(files.items[0].securityStatus).toBe('clean');
  expect(JSON.stringify((await get(`/api/admin/workspace/matters/${c._id}`)).body)).not.toContain('PRIVATE SENTINEL');
  expect((await get('/api/admin/workspace/matters?filter=overdue')).body.total).toBe(1);
});
test.each([['release_full', undefined, 9000, 0], ['release_partial', 4500, 4500, 5500], ['refund', undefined, 0, 11000]])('settlement preview %s shows recorded fees and verified charge consequences without mutation', async (action, payoutAmountCents, payout, refund) => {
  const disputeId = crypto.randomUUID();
  const c = await matter({
    status: 'disputed',
    lockedTotalAmount: 10000,
    feeParalegalPct: 10,
    feeAttorneyPct: 10,
    escrowIntentId: 'pi_preview',
    disputes: [{
      disputeId,
      status: 'open',
      raisedBy: attorney._id,
      message: 'Review issue'
    }]
  });
  stripe.paymentIntents.retrieve.mockResolvedValue({
    amount: 11000,
    latest_charge: {
      amount: 11000,
      amount_refunded: 0
    }
  });
  const revision = disputeRevision(c);
  const preview = await previewDispute({
    caseId: c._id,
    disputeId,
    action,
    payoutAmountCents
  });
  expect(preview.payoutAmount).toBe(payout);
  expect(preview.refundAmount).toBe(refund);
  expect(preview.previewRevision).toBe(revision);
  expect(disputeRevision(await Case.findById(c._id))).toBe(revision);
  expect(await PaymentOperation.countDocuments()).toBe(0);
  c.totalAmount = 12000;
  c.lockedTotalAmount = 12000;
  await c.save();
  expect(disputeRevision(c)).not.toBe(revision);
  const stale = await request(app).post(`/api/payments/dispute/settle/${c._id}`).set('Cookie', cookie(admin)).send({
    action,
    disputeId,
    payoutAmountCents,
    previewRevision: revision
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error).toContain('changed after the preview');
});
test('withdrawal zero payout retains funds and provider failures never invent a preview', async () => {
  const disputeId = crypto.randomUUID();
  const c = await matter({
    status: 'disputed',
    paralegal: null,
    paralegalId: null,
    withdrawnParalegalId: paralegal._id,
    remainingAmount: 10000,
    disputes: [{
      disputeId,
      status: 'open',
      raisedBy: attorney._id,
      message: 'Review issue'
    }]
  });
  const preview = await previewDispute({
    caseId: c._id,
    disputeId,
    action: 'refund'
  });
  expect(preview.refundAmount).toBe(0);
  expect(preview.remainingForMatter).toBe(10000);
  expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  c.paralegal = paralegal._id;
  c.escrowIntentId = 'pi_test';
  await c.save();
  stripe.paymentIntents.retrieve.mockRejectedValue(new Error('Offline'));
  await expect(previewDispute({
    caseId: c._id,
    disputeId,
    action: 'refund'
  })).rejects.toThrow('could not be checked');
});
