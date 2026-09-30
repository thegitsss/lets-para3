const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
jest.mock('../utils/email', () => jest.fn(async () => ({ accepted: ['synthetic@example.test'] })));
jest.mock('../utils/s3Client', () => ({ createS3Client: jest.fn(() => ({ send: jest.fn(async () => ({ TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }] })) })) }));
const sendEmail = require('../utils/email');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User');
const Alert = require('../models/AdminCommunicationAlert');
const Ticket = require('../models/SupportTicket');
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

test.each(['attorney', 'paralegal'])('%s signup, email verification, information request and approval preserve access boundaries', async role => {
  const payload = { firstName: 'Synthetic', lastName: 'Applicant', email: `${role}@example.test`, password: 'Synthetic applicant passphrase', role,
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
  const approved = await request(app).post(`/api/admin/users/${applicant._id}/approve`).set('Cookie', cookie(admin)).send({ note: 'Synthetic owner review complete.' });
  expect(approved.status).toBe(200);
  applicant = await User.findById(applicant._id);
  expect(applicant.status).toBe('approved');
  expect((await request(app).get(`/api/${role}/dashboard`).set('Cookie', cookie(applicant))).status).toBe(200);
  expect((await request(app).get('/api/admin/pending-users').set('Cookie', cookie(applicant))).status).toBe(403);
});
