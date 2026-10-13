const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
jest.mock('../utils/email', () => jest.fn(async recipient => ({ accepted: [recipient] })));
jest.mock('../utils/s3Client', () => ({ createS3Client: jest.fn(() => ({ send: jest.fn(async () => ({ TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }] })) })) }));
const sendEmail = require('../utils/email');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User');
const { currentPolicyMetadata } = require('../utils/legalDocuments');
const Alert = require('../models/AdminCommunicationAlert');
const Ticket = require('../models/SupportTicket');
const { admissionRevision } = require('../services/admissionReview');
process.env.S3_BUCKET = 'synthetic-admissions';
const app = express();
app.use(cookieParser()); app.use(express.json());
app.use('/api/auth', require('../routes/auth'));
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/attorney/dashboard', require('../routes/attorneyDashboard'));
app.use('/api/paralegal/dashboard', require('../routes/paralegalDashboard'));
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let admin;
beforeAll(connect);
beforeEach(async () => {
  await clearDatabase(); sendEmail.mockClear();
  admin = await User.create({ firstName: 'Synthetic', lastName: 'Owner', email: 'owner@example.test', password: 'Synthetic admin password', role: 'admin', status: 'approved', emailVerified: true });
});
afterAll(closeDatabase);

test('20 concurrent mixed-role applications remain distinct and reachable while admitted members use their dashboards', async () => {
  // Functional burst evidence only: this harness isolates mail/storage and does
  // not reproduce deployment capacity, Turnstile or the server's per-IP limits.
  const admitted = await Promise.all(['attorney', 'paralegal'].map(role => User.create({
    firstName: 'Synthetic', lastName: 'Member', email: `admitted-${role}@example.test`,
    password: 'Synthetic admitted member passphrase', role, status: 'approved', emailVerified: true,
  })));
  const documents = currentPolicyMetadata();
  const emails = Array.from({ length: 20 }, (_, index) => `launch-burst-${index}@example.test`);
  const registrations = emails.map((email, index) => {
    const role = index % 2 ? 'paralegal' : 'attorney';
    const payload = { firstName: 'Synthetic', lastName: `Applicant ${index}`, email,
      password: 'Synthetic launch applicant passphrase', role, state: 'CA', timezone: 'America/Los_Angeles',
      termsAccepted: true, privacyAcknowledged: true, termsHash: documents.terms.hash, privacyHash: documents.privacy.hash,
      barNumber: `CA-${index}`, barState: 'CA', lawFirm: 'Example', attorneyPricingAccepted: true,
      yearsExperience: 3, paralegalQualification: 'law_firm_experience' };
    let registration = request(app).post('/api/auth/register');
    if (role === 'attorney') return registration.send(payload);
    for (const [key, value] of Object.entries(payload)) registration = registration.field(key, String(value));
    return registration.attach('resume', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'), { filename: 'resume.pdf', contentType: 'application/pdf' });
  });
  const dashboardReads = admitted.flatMap(member => Array.from({ length: 3 }, () =>
    request(app).get(`/api/${member.role}/dashboard`).set('Cookie', cookie(member))));
  const responses = await Promise.all([...registrations, ...dashboardReads]);
  expect(responses.map(response => response.status)).toEqual(Array(26).fill(200));
  const applicants = await User.find({ email: { $in: emails } }).select('+policyAcknowledgements').lean();
  expect(applicants).toHaveLength(20);
  expect(new Set(applicants.map(applicant => String(applicant._id))).size).toBe(20);
  expect(applicants.filter(applicant => applicant.role === 'attorney')).toHaveLength(10);
  expect(applicants.filter(applicant => applicant.role === 'paralegal')).toHaveLength(10);
  for (const applicant of applicants) {
    expect(applicant).toMatchObject({ status: 'pending', emailVerified: false,
      termsDocumentHash: documents.terms.hash, privacyDocumentHash: documents.privacy.hash });
    expect(applicant.policyAcknowledgements).toHaveLength(1);
    expect(sendEmail.mock.calls.filter(call => call[0] === applicant.email && call[1] === 'Verify your email')).toHaveLength(1);
    expect(await Alert.countDocuments({ key: `signup:${applicant._id}` })).toBe(1);
  }
  const queue = await request(app).get('/api/admin/workspace/flow').set('Cookie', cookie(admin));
  expect(queue.status).toBe(200);
  expect(queue.body.total).toBe(20);
  expect(queue.body.items.map(item => item.id).sort()).toEqual(applicants.map(applicant => String(applicant._id)).sort());
  expect(queue.body.items.every(item => !('password' in item))).toBe(true);
});

test.each(['attorney', 'paralegal'])('%s signup, email verification, information request and approval preserve access boundaries', async role => {
  const payload = { firstName: 'Synthetic', lastName: 'Applicant', email: `${role}@example.test`, password: 'Synthetic applicant passphrase', role,
    termsHash: currentPolicyMetadata().terms.hash, privacyHash: currentPolicyMetadata().privacy.hash,
    barNumber: 'CA-12345', barState: 'CA', lawFirm: 'Example', attorneyPricingAccepted: true,
    termsAccepted: true, privacyAcknowledged: true, state: 'CA', timezone: 'America/Los_Angeles', yearsExperience: 3 };
  let registration = request(app).post('/api/auth/register');
  if (role === 'paralegal') {
    payload.paralegalQualification = 'law_firm_experience';
    for (const [key, value] of Object.entries(payload)) registration = registration.field(key, String(value));
    registration = registration.attach('resume', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'), { filename: 'resume.pdf', contentType: 'application/pdf' });
  } else registration = registration.send(payload);
  const registered = await registration;
  expect(registered.status).toBe(200);
  let applicant = await User.findOne({ email: payload.email });
  expect(applicant).toMatchObject({ role, status: 'pending', emailVerified: false });
  expect(await Alert.findOne({ key: `signup:${applicant._id}` })).toBeTruthy();
  const verificationEmail = sendEmail.mock.calls.find(call => call[1] === 'Verify your email');
  const token = decodeURIComponent(verificationEmail[2].match(/token=([^&\s"'<>]+)/i)[1]);
  expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(200);
  applicant = await User.findById(applicant._id);
  const pendingAccess = await request(app).get(`/api/${role}/dashboard`).set('Cookie', cookie(applicant));
  expect(pendingAccess.status).toBe(403);
  const pending = await request(app).get('/api/admin/pending-users').set('Cookie', cookie(admin));
  expect(JSON.stringify(pending.body)).toContain(String(applicant._id));
  const info = await request(app).post(`/api/admin/workspace/accounts/${applicant._id}/information-request`).set('Cookie', cookie(admin)).send({ requestId: randomUUID(), text: 'Please clarify your experience.' });
  expect(info.status).toBe(200); expect(info.body.delivery).toBe('accepted');
  expect((await User.findById(applicant._id)).status).toBe('pending');
  expect(await Ticket.countDocuments({ requesterUserId: applicant._id })).toBe(1);
  applicant = await User.findById(applicant._id);
  const approved = await request(app).post(`/api/admin/users/${applicant._id}/approve`).set('Cookie', cookie(admin)).send({
    note: 'Synthetic owner review complete.', reviewedRevision: admissionRevision(applicant),
    ...(role === 'paralegal' ? { qualificationReview: { confirmed: true, qualification: 'law_firm_experience', method: 'employer_contact', evidence: 'Synthetic independent employer contact confirmed the role and dates.' } } : {}),
  });
  expect(approved.status).toBe(200);
  applicant = await User.findById(applicant._id);
  expect(applicant.status).toBe('approved');
  expect((await request(app).get(`/api/${role}/dashboard`).set('Cookie', cookie(applicant))).status).toBe(200);
  expect((await request(app).get('/api/admin/pending-users').set('Cookie', cookie(applicant))).status).toBe(403);
});

async function pendingParalegal() {
  const applicant = new User({ firstName: 'Synthetic', lastName: 'Applicant',
    email: 'review-applicant@example.test', password: 'Synthetic applicant passphrase',
    role: 'paralegal', status: 'pending', emailVerified: true, yearsExperience: 3,
    paralegalQualification: 'law_firm_experience' });
  applicant.resumeURL = `paralegal-resumes/${applicant._id}/resume.pdf`;
  await applicant.save();
  return applicant;
}
const qualificationReview = { confirmed: true, qualification: 'law_firm_experience',
  method: 'employer_contact', evidence: 'Synthetic independently sourced employer contact confirmed three years of law-firm employment.' };
const decide = (applicant, action, body) => request(app).post(`/api/admin/users/${applicant._id}/${action}`).set('Cookie', cookie(admin)).send(body);

test('paralegal approval requires a current application and recorded credential verification', async () => {
  const applicant = await pendingParalegal();
  expect((await decide(applicant, 'approve', { note: 'Documents looked safe.' })).status).toBe(409);
  const revision = admissionRevision(applicant);
  expect((await decide(applicant, 'approve', { reviewedRevision: revision })).status).toBe(409);
  expect((await decide(applicant, 'approve', { reviewedRevision: revision, qualificationReview: { ...qualificationReview, confirmed: false } })).status).toBe(409);
  expect((await decide(applicant, 'approve', { reviewedRevision: revision, qualificationReview: { ...qualificationReview, qualification: 'certificate' } })).status).toBe(409);
  expect((await User.findById(applicant._id)).status).toBe('pending');
  expect(sendEmail).not.toHaveBeenCalled();
});

test('changed admission evidence invalidates the reviewed application without approving', async () => {
  const applicant = await pendingParalegal(), revision = admissionRevision(applicant);
  await User.updateOne({ _id: applicant._id }, { $set: { resumeURL: `paralegal-resumes/${applicant._id}/replacement.pdf` } });
  expect((await decide(applicant, 'approve', { reviewedRevision: revision, qualificationReview })).status).toBe(409);
  expect((await User.findById(applicant._id)).audit).toHaveLength(0);
});

test('a successful reviewed decision stores verification once and a retry does not repeat mail or audits', async () => {
  const applicant = await pendingParalegal(), revision = admissionRevision(applicant);
  const body = { reviewedRevision: revision, qualificationReview };
  const first = await decide(applicant, 'approve', body);
  const retry = await decide(applicant, 'approve', body);
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(first.body.notification).toEqual({ delivery: 'accepted', recorded: true });
  expect(retry.body.notification).toEqual(first.body.notification);
  const saved = await User.findById(applicant._id);
  expect(saved.audit).toHaveLength(1);
  expect(saved.audit[0].qualificationReview.toObject()).toEqual({ qualification: qualificationReview.qualification,
    method: qualificationReview.method, evidence: qualificationReview.evidence, reviewedRevision: revision });
  expect(saved.preferences.hideProfile).toBe(true);
  expect(sendEmail.mock.calls.filter(call => call[0] === applicant.email)).toHaveLength(1);
});

test('conflicting simultaneous decisions cannot both change the reviewed application', async () => {
  const applicant = await pendingParalegal(), revision = admissionRevision(applicant);
  const results = await Promise.all([
    decide(applicant, 'approve', { reviewedRevision: revision, qualificationReview }),
    decide(applicant, 'deny', { reviewedRevision: revision, note: 'Synthetic conflicting owner decision.' }),
  ]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect((await User.findById(applicant._id)).audit).toHaveLength(1);
  expect(sendEmail.mock.calls.filter(call => call[0] === applicant.email)).toHaveLength(1);
});

test('a lost email receipt preserves the committed admission and does not repeat mail on recovery', async () => {
  const AuditLog = require('../models/AuditLog');
  const original = AuditLog.logFromReq;
  const write = jest.spyOn(AuditLog, 'logFromReq').mockImplementation((req, action, data) =>
    action === 'admin.user.notification_recorded' ? Promise.reject(new Error('Synthetic receipt-write failure')) : original.call(AuditLog, req, action, data));
  try {
    const applicant = await pendingParalegal();
    const body = { reviewedRevision: admissionRevision(applicant), qualificationReview };
    const decision = await decide(applicant, 'approve', body);
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({ user: { status: 'approved' }, notification: { delivery: 'accepted', recorded: false } });
    const saved = await User.findById(applicant._id);
    expect(saved.audit).toHaveLength(1);
    expect(saved.audit[0].qualificationReview.evidence).toBe(qualificationReview.evidence);
    write.mockRestore();
    const recovered = await decide(applicant, 'approve', body);
    expect(recovered.status).toBe(200);
    expect(recovered.body.notification).toEqual({ delivery: 'unconfirmed', recorded: false });
    expect(sendEmail.mock.calls.filter(call => call[0] === applicant.email)).toHaveLength(1);
    expect((await User.findById(applicant._id)).audit).toHaveLength(1);
  } finally { write.mockRestore(); }
});

test('qualification evidence cannot approve a disabled or ineligible applicant', async () => {
  const applicant = await pendingParalegal();
  applicant.yearsExperience = 0.5; await applicant.save();
  expect((await decide(applicant, 'approve', { reviewedRevision: admissionRevision(applicant), qualificationReview })).status).toBe(409);
  applicant.yearsExperience = 3; applicant.disabled = true; await applicant.save();
  expect((await decide(applicant, 'approve', { reviewedRevision: admissionRevision(applicant), qualificationReview })).status).toBe(409);
  expect((await User.findById(applicant._id)).status).toBe('pending');
});
