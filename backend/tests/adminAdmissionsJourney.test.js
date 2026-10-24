const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
jest.mock('../utils/email', () => jest.fn(async recipient => ({ accepted: [recipient] })));
jest.mock('../utils/s3Client', () => ({ S3_REQUEST_TIMEOUT_MS: jest.requireActual('../utils/s3Client').S3_REQUEST_TIMEOUT_MS, createS3Client: jest.fn(() => ({ send: jest.fn(async () => ({ TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }] })) })) }));
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
let admin, managedAdminCookie;
const cookie = user => String(user._id) === String(admin?._id) && managedAdminCookie ? managedAdminCookie :
  `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
beforeAll(connect);
beforeEach(async () => {
  await clearDatabase(); sendEmail.mockClear();
  admin = await User.create({ firstName: 'Synthetic', lastName: 'Owner', email: 'owner@example.test', password: 'Synthetic admin password', role: 'admin', status: 'approved', emailVerified: true });
  const session = await require('../services/authSessionService').createAuthSession(admin, { headers: {}, ip: '192.0.2.21' });
  managedAdminCookie = `token=${jwt.sign({ id: String(admin._id), role: admin.role, status: admin.status, sid: session.sessionId, av: admin.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
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
      barNumber: `CA-${index}`, barState: 'CA', lawFirm: 'Example', attorneyPricingAccepted: true, attorneyGoodStanding: true,
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
    barNumber: 'CA-12345', barState: 'CA', lawFirm: 'Example', attorneyPricingAccepted: true, attorneyGoodStanding: true,
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
    expectedOwnerId: String(admin._id),
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
const decide = (applicant, action, body) => request(app).post(`/api/admin/users/${applicant._id}/${action}`).set('Cookie', cookie(admin)).send({ expectedOwnerId: String(admin._id), ...body });

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

// The decision and its mail obligation must survive independently of HTTP/SMTP.
test.each(['approve', 'deny'])('%s email retries a confirmed rejection once without repeating the account decision', async action => {
  const Notice = require('../models/AdmissionDecisionNotification');
  const mail = require('../services/admissionDecisionNotifications');
  const applicant = await pendingParalegal();
  const body = { reviewedRevision: admissionRevision(applicant), ...(action === 'approve' ? { qualificationReview } : {}) };
  sendEmail.mockRejectedValueOnce(Object.assign(new Error('Synthetic temporary rejection'), { responseCode: 451 }));
  const response = await decide(applicant, action, body);
  expect(response.status).toBe(200);
  expect(response.body.notification).toEqual({ delivery: 'unconfirmed', recorded: true });
  let notice = await Notice.findOne({ userId: applicant._id });
  expect(notice).toMatchObject({ decision: action === 'approve' ? 'approved' : 'denied', status: 'failed', attempts: 1 });
  expect((await mail.noticeStatus()).recent).toEqual([]); // Temporary failures recover without owner intervention.
  expect(await mail.processNotices()).toBe(0);
  await Notice.updateOne({ _id: notice._id }, { $set: { nextAttemptAt: new Date(0) } });
  await Promise.all([mail.processNotices(), mail.processNotices()]);
  notice = await Notice.findById(notice._id);
  expect(notice).toMatchObject({ status: 'accepted', attempts: 2 });
  expect(sendEmail.mock.calls.filter(call => call[0] === applicant.email)).toHaveLength(2);
  const calls = sendEmail.mock.calls.filter(call => call[0] === applicant.email);
  expect(calls[0][3].messageId).toBe(calls[1][3].messageId);
  expect((await decide(applicant, action, body)).status).toBe(200);
  expect((await User.findById(applicant._id)).audit).toHaveLength(1);
  expect(await Notice.countDocuments({ userId: applicant._id })).toBe(1);
  expect(sendEmail.mock.calls.filter(call => call[0] === applicant.email)).toHaveLength(2);
});

test('failure to save the mail obligation rolls back the admission decision and sends nothing', async () => {
  const notices = require('../services/admissionDecisionNotifications');
  const applicant = await pendingParalegal();
  const stage = jest.spyOn(notices, 'stage').mockRejectedValueOnce(new Error('Synthetic outbox write failure'));
  try {
    expect((await decide(applicant, 'approve', { reviewedRevision: admissionRevision(applicant), qualificationReview })).status).toBe(500);
    expect(await User.findById(applicant._id)).toMatchObject({ status: 'pending', audit: [] });
    expect(await require('../models/AdmissionDecisionNotification').countDocuments()).toBe(0);
    expect(await require('../models/AuditLog').countDocuments({ action: 'admin.user.approved', targetId: String(applicant._id) })).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  } finally { stage.mockRestore(); }
});

test('only exhausted or uncertain admission mail needs owner attention and deliberate retry is revision guarded', async () => {
  const Notice = require('../models/AdmissionDecisionNotification');
  const applicant = await pendingParalegal();
  await decide(applicant, 'deny', { reviewedRevision: admissionRevision(applicant) });
  const notice = await Notice.findOne({ userId: applicant._id });
  await Notice.updateOne({ _id: notice._id }, { $set: { status: 'unknown', failure: 'Synthetic uncertain delivery' } });
  const status = await request(app).get('/api/admin/workspace/communications').set('Cookie', cookie(admin));
  expect(status.status).toBe(200);
  const row = status.body.admissionNotices.recent[0];
  expect(row).toMatchObject({ decision: 'denied', status: 'unknown' });
  const endpoint = `/api/admin/workspace/communications/admission-decisions/${notice._id}/retry`;
  expect((await request(app).post(endpoint).set('Cookie', cookie(admin)).send({ confirmed: false, revision: row.revision })).status).toBe(400);
  expect((await request(app).post(endpoint).set('Cookie', cookie(admin)).send({ confirmed: true, revision: 'a'.repeat(64) })).status).toBe(409);
  expect((await request(app).post(endpoint).set('Cookie', cookie(admin)).send({ confirmed: true, revision: row.revision })).status).toBe(200);
  expect(await Notice.findById(notice._id)).toMatchObject({ status: 'pending', attempts: 0 });
});


test.each(['attorney', 'paralegal'])('%s approval before verification emails a usable verification action, then allows first sign-in', async role => {
  const applicant = new User({ firstName: 'Synthetic', lastName: 'Applicant', email: `unverified-${role}@example.test`,
    password: 'Synthetic applicant passphrase', role, status: 'pending', emailVerified: false, yearsExperience: 3,
    paralegalQualification: 'law_firm_experience', barNumber: 'CA-12345', barState: 'CA', attorneyGoodStanding: true });
  applicant.resumeURL = `paralegal-resumes/${applicant._id}/resume.pdf`;
  await applicant.save();
  const response = await decide(applicant, 'approve', { reviewedRevision: admissionRevision(applicant),
    ...(role === 'paralegal' ? { qualificationReview } : {}) });
  expect(response.status).toBe(200);
  const email = sendEmail.mock.calls.find(call => call[0] === applicant.email && call[1] === 'Welcome to Let’s-ParaConnect');
  expect(email).toBeTruthy();
  expect(email[2]).toContain('>Verify your email</a>');
  expect(email[2]).not.toContain('>Sign in</a>');
  const token = decodeURIComponent(email[2].match(/token=([^&\s"'<>]+)/)[1]);
  expect(jwt.decode(token)).not.toHaveProperty('exp');
  expect(email[2]).toContain('Privacy Policy');
  const login = () => request(app).post('/api/auth/login').send({ email: applicant.email, password: 'Synthetic applicant passphrase' });
  expect((await login()).status).toBe(403);
  expect((await request(app).post('/api/auth/verify-email').send({ token })).body).toMatchObject({ ok: true, accountStatus: 'approved' });
  expect((await login()).status).toBe(200);
});
