const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');
jest.mock('../utils/email', () => jest.fn(async () => ({
  accepted: ['visitor@example.test']
})));
jest.mock('../services/lpcEvents/publishEventService', () => ({
  publishEventSafe: jest.fn(async () => ({
    ok: true
  }))
}));
jest.mock('../utils/stripe', () => ({
  accounts: {
    retrieve: jest.fn()
  }
}));
const sendEmail = require('../utils/email');
const User = require('../models/User');
const Case = require('../models/Case');
const SupportTicket = require('../models/SupportTicket');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const SupportMutation = require('../models/SupportMutation');
const Incident = require('../models/Incident');
const {
  connect,
  clearDatabase,
  closeDatabase
} = require('./helpers/db');
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/public', require('../routes/public'));
app.use('/api/support', require('../routes/support'));
app.use('/api/admin/support', require('../routes/adminSupport'));
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use('/api/admin', require('../routes/admin'));
app.use((e, req, res, next) => res.status(e.statusCode || 500).json({
  error: e.message
}));
let admin, attorney, paralegal;
const cookie = u => `token=${jwt.sign({
  id: String(u._id),
  role: u.role,
  email: u.email,
  status: u.status
}, process.env.JWT_SECRET, {
  expiresIn: '1h'
})}`;
const makeUser = (role, email) => User.create({
  firstName: 'Inbox',
  lastName: role,
  email,
  password: 'Example123!Strong',
  role,
  status: 'approved',
  emailVerified: true,
  state: 'CA'
});
beforeAll(async () => {
  await connect();
}, 90000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({
    accepted: ['visitor@example.test']
  });
  admin = await makeUser('admin', 'admin@example.test');
  attorney = await makeUser('attorney', 'attorney@example.test');
  paralegal = await makeUser('paralegal', 'para@example.test');
});
test('inbox filters reject query operators instead of passing them to MongoDB', async () => {
  const response = await request(app)
    .get('/api/admin/support/inbox?status%5B%24ne%5D=resolved')
    .set('Cookie', cookie(admin));
  expect(response.status).toBe(400);
});
test('every contact form inquiry is persisted even if the notification email fails', async () => {
  sendEmail.mockRejectedValueOnce(new Error('mail unavailable'));
  const response = await request(app).post('/api/public/contact').send({
    name: 'Visitor Name',
    email: 'visitor@example.test',
    subject: 'Partnership inquiry',
    message: 'I would like to discuss a partnership.',
    role: 'other'
  });
  expect(response.status).toBe(200);
  expect(response.body.reference).toMatch(/^SUP-/);
  const saved = await SupportTicket.findOne({
    requestKind: 'contact'
  });
  expect(saved.message).toContain('partnership');
  expect(saved.contextSnapshot.requesterName).toBe('Visitor Name');
  expect(saved.requesterRole).toBe('visitor');
  const inbox = await request(app).get('/api/admin/support/inbox?source=contact').set('Cookie', cookie(admin));
  expect(inbox.body.total).toBe(1);
});
test.each(['attorney', 'paralegal'])('%s can request a human, add context, and receive an admin reply in the same chat', async role => {
  const u = role === 'attorney' ? attorney : paralegal;
  const conversation = await SupportConversation.create({
    userId: u._id,
    role,
    status: 'open'
  });
  const prefix = `/api/support/conversation/${conversation._id}`;
  let result = await request(app).post(`${prefix}/messages`).set('Cookie', cookie(u)).send({
    text: role === 'attorney' ? 'human' : 'representative'
  });
  expect(result.status).toBe(201);
  expect(result.body.assistantMessage.text).toContain('sent to the LPC team');
  expect(result.body.conversation.escalation.ticketId).toBeTruthy();
  const ticket = await SupportTicket.findOne({
    conversationId: conversation._id
  });
  expect(ticket.requestKind).toBe('human');
  const byReference = await request(app).get(`/api/admin/support/inbox?q=SUP-${String(ticket._id).slice(-6)}`).set('Cookie', cookie(admin));
  expect(byReference.body.tickets.map(item => item.id)).toContain(String(ticket._id));
  const byName = await request(app).get('/api/admin/support/inbox?q=Inbox').set('Cookie', cookie(admin));
  expect(byName.body.tickets.map(item => item.id)).toContain(String(ticket._id));
  result = await request(app).post(`${prefix}/messages`).set('Cookie', cookie(u)).send({
    text: 'Here is the question I want to ask.'
  });
  expect(result.status).toBe(201);
  expect(await SupportTicket.countDocuments({
    conversationId: conversation._id
  })).toBe(1);
  const reply = await request(app).post(`/api/admin/support/tickets/${ticket._id}/reply`).set('Cookie', cookie(admin)).send({
    text: 'Samantha here. I can help with your question.',
    status: 'waiting_on_user'
  });
  expect(reply.status).toBe(201);
  expect((await request(app).get('/api/admin/support/inbox-summary').set('Cookie', cookie(admin))).body.human).toBe(0);
  await SupportTicket.updateOne({ _id: ticket._id }, { $set: { followUpAt: new Date(Date.now() + 86400000), nextAction: 'Review the reply', assignedTo: admin._id } });
  const followup = await request(app).post(`${prefix}/messages`).set('Cookie', cookie(u)).send({ text: 'Thank you. I have one more question.' });
  expect(followup.body.assistantReply.provider).toBe('human_handoff');
  const afterReply = await SupportTicket.findById(ticket._id);
  expect(afterReply.followUpAt).toBeNull();
  expect(String(afterReply.assignedTo)).toBe(String(admin._id));
  expect(afterReply.nextAction).toBe('Review the reply');
  expect((await request(app).get('/api/admin/support/inbox-summary').set('Cookie', cookie(admin))).body.human).toBe(1);
  const messages = await request(app).get(`${prefix}/messages`).set('Cookie', cookie(u));
  expect(JSON.stringify(messages.body)).toContain('Samantha here.');
  expect(sendEmail).not.toHaveBeenCalled();
  const other = role === 'attorney' ? paralegal : attorney;
  expect((await request(app).get(`${prefix}/messages`).set('Cookie', cookie(other))).status).toBe(404);
});
test('concurrent human requests retain both inputs after explicit retry, share one ticket, and keep internal notes private', async () => {
  const conversation = await SupportConversation.create({
    userId: attorney._id,
    role: 'attorney',
    status: 'open'
  });
  const inputs = ['human', 'representative'].map(text => ({ text, requestId: require('crypto').randomUUID() }));
  const send = input => request(app).post(`/api/support/conversation/${conversation._id}/messages`).set('Cookie', cookie(attorney)).send(input);
  const responses = await Promise.all(inputs.map(send));
  expect(responses.some(response => response.status === 201)).toBe(true);
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    if (response.status === 409) {
      expect(response.body.code).toBe('SUPPORT_CONVERSATION_BUSY');
      expect(await SupportMutation.countDocuments({ ownerId: attorney._id, requestId: inputs[index].requestId })).toBe(0);
      expect((await send(inputs[index])).status).toBe(201);
    } else expect(response.status).toBe(201);
  }
  const saved = await SupportMutation.find({ ownerId: attorney._id, conversationId: conversation._id }).select('+input').lean();
  expect(saved).toHaveLength(2);
  expect(saved.every(record => record.state === 'succeeded' && record.active === false)).toBe(true);
  expect(saved.map(record => record.input.text).sort()).toEqual(['human', 'representative']);
  for (const input of inputs) expect((await send(input)).status).toBe(201);
  expect(await SupportMessage.countDocuments({ conversationId: conversation._id, sender: 'user' })).toBe(2);
  expect(await SupportTicket.countDocuments({
    conversationId: conversation._id
  })).toBe(1);
  const ticket = await SupportTicket.findOne({
    conversationId: conversation._id
  });
  const note = await request(app).post(`/api/admin/support/tickets/${ticket._id}/note`).set('Cookie', cookie(admin)).send({
    text: 'Private admin context'
  });
  expect(note.status).toBe(201);
  expect((await SupportTicket.findById(ticket._id).lean()).internalNotes).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Private admin context' })]));
  const result = await request(app).get(`/api/support/conversation/${conversation._id}/messages`).set('Cookie', cookie(attorney));
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).not.toContain('Private admin context');
});
test('email reply requests are recorded and cannot be sent twice on retry', async () => {
  const ticket = await SupportTicket.create({
    subject: 'Question',
    message: 'Hello',
    requestKind: 'contact',
    sourceSurface: 'public',
    requesterEmail: 'visitor@example.test'
  });
  const body = {
    text: 'Thanks for your question.',
    requestId: '12345678-1234-4234-8234-123456789abc',
    status: 'waiting_on_user'
  };
  const [a, b] = await Promise.all([1, 2].map(() => request(app).post(`/api/admin/support/tickets/${ticket._id}/reply`).set('Cookie', cookie(admin)).send(body)));
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  const saved = await SupportTicket.findById(ticket._id);
  expect(saved.emailReplies).toHaveLength(1);
  expect(saved.emailReplies[0].delivery).toBe('accepted');
  expect(saved.status).toBe('waiting_on_user');
});
test('unknown email outcomes remain visible and do not mark the inquiry answered', async () => {
  sendEmail.mockRejectedValue(new Error('timeout'));
  const ticket = await SupportTicket.create({
    subject: 'Question',
    message: 'Hello',
    sourceSurface: 'public',
    requesterEmail: 'visitor@example.test'
  });
  const body = {
    text: 'A reply',
    requestId: '12345678-1234-4234-8234-123456789abc'
  };
  const first = await request(app).post(`/api/admin/support/tickets/${ticket._id}/reply`).set('Cookie', cookie(admin)).send(body);
  expect(first.body.delivery).toBe('unknown');
  await request(app).post(`/api/admin/support/tickets/${ticket._id}/reply`).set('Cookie', cookie(admin)).send(body);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect((await SupportTicket.findById(ticket._id)).status).toBe('open');
});
test('inbox and account pagination reach records beyond the first batch and escape search text', async () => {
  await SupportTicket.insertMany(Array.from({
    length: 55
  }, (_, i) => ({
    subject: `Question ${i}`,
    message: 'Hello',
    requestKind: 'contact',
    sourceSurface: 'public',
    requesterEmail: 'visitor@example.test'
  })));
  const first = await request(app).get('/api/admin/support/inbox?source=contact&page=1').set('Cookie', cookie(admin));
  const last = await request(app).get('/api/admin/support/inbox?source=contact&page=3').set('Cookie', cookie(admin));
  expect(first.body.total).toBe(55);
  expect(last.body.tickets).toHaveLength(15);
  expect((await request(app).get('/api/admin/support/inbox?q=%5B').set('Cookie', cookie(admin))).status).toBe(200);
  expect((await request(app).get('/api/admin/support/inbox').set('Cookie', cookie(attorney))).status).toBe(403);
  await User.insertMany(Array.from({
    length: 55
  }, (_, i) => ({
    firstName: 'Applicant',
    lastName: String(i),
    email: `pending${i}@example.test`,
    password: 'Example123!Strong',
    role: 'paralegal',
    status: 'pending',
    state: 'CA'
  })));
  const users = await request(app).get('/api/admin/pending-users?status=pending&limit=5&page=11').set('Cookie', cookie(admin));
  expect(users.body.total).toBe(55);
  expect(users.body.users).toHaveLength(5);
  attorney.disabled = true;
  await attorney.save();
  const suspended = await request(app).get('/api/admin/pending-users?status=suspended').set('Cookie', cookie(admin));
  expect(suspended.body.users.map(u => u.email)).toContain(attorney.email);
});
test('matter detail excludes attorney-private notes and is admin-only', async () => {
  const matter = await Case.create({
    title: 'Admin review matter',
    attorney: attorney._id,
    status: 'open',
    totalAmount: 10000,
    notes: 'Attorney-private note',
    details: 'Shared scope'
  });
  const result = await request(app).get(`/api/admin/workspace/matters/${matter._id}`).set('Cookie', cookie(admin));
  expect(result.status).toBe(200);
  expect(result.body.matter.description).toBe('Shared scope');
  expect(JSON.stringify(result.body)).not.toContain('Attorney-private note');
  expect((await request(app).get(`/api/admin/workspace/matters/${matter._id}`).set('Cookie', cookie(paralegal))).status).toBe(403);
});

test('an engineering resolution does not close an unanswered human request', async () => {
  const incident = await Incident.create({
    publicId: 'INC-20260906-999001', source: 'inline_help',
    summary: 'A repaired product issue', originalReportText: 'The page was unavailable.',
    state: 'resolved', context: { surface: 'attorney' }
  });
  const ticket = await SupportTicket.create({
    subject: 'Still need a person', message: 'I have another question.',
    requestKind: 'human', status: 'open', linkedIncidentIds: [incident._id],
    requesterUserId: attorney._id, requesterRole: 'attorney'
  });
  const response = await request(app).get(`/api/admin/support/tickets/${ticket._id}`).set('Cookie', cookie(admin));
  expect(response.status).toBe(200);
  expect(response.body.ticket.status).toBe('open');
  expect((await request(app).get('/api/admin/support/inbox-summary').set('Cookie', cookie(admin))).body.human).toBe(1);
});

test('default inbox and counts exclude explicitly marked harness records without deleting them', async () => {
  const real = await SupportTicket.create({subject:'Real request mentioning cr-e2e-', message:'Please help.', requesterEmail:'real@example.test', requestKind:'human', status:'open'});
  const synthetic = await SupportTicket.create({subject:'Control Room autonomous reopen cr-e2e-example', message:'Test.', requesterEmail:'test@example.test', requestKind:'human', status:'open', sourceLabel:'Control Room e2e harness'});
  const list = await request(app).get('/api/admin/support/inbox?source=human').set('Cookie', cookie(admin));
  expect(list.status).toBe(200);
  expect(list.body.total).toBe(1);
  expect(list.body.tickets[0].id).toBe(String(real._id));
  const summary = await request(app).get('/api/admin/support/inbox-summary').set('Cookie', cookie(admin));
  expect(summary.body.human).toBe(1);
  const inclusive = await request(app).get('/api/admin/support/inbox?source=human&includeTests=true&limit=1').set('Cookie', cookie(admin));
  expect(inclusive.body.total).toBe(2);
  expect(inclusive.body.pages).toBe(2);
  expect(await SupportTicket.exists({_id:synthetic._id})).toBeTruthy();
});


test('a changed inquiry cannot send a reply prepared from a stale record', async () => {
  const ticket = await SupportTicket.create({ subject: 'Question', message: 'Original question', requestKind: 'contact', sourceSurface: 'public', requesterEmail: 'visitor@example.test' });
  await SupportTicket.updateOne({ _id: ticket._id }, { $set: { message: 'Corrected question' } }, { timestamps: false });
  await expect(require('../services/support/adminInboxService').replyByEmail({ ticket, adminUser: admin, text: 'Old answer', requestId: require('crypto').randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
  expect(sendEmail).not.toHaveBeenCalled();
  expect((await SupportTicket.findById(ticket._id)).emailReplies).toHaveLength(0);
});

test('delivery evidence preserves a newer inquiry state while email is in flight', async () => {
  const ticket = await SupportTicket.create({ subject: 'Question', message: 'Hello', requestKind: 'contact', sourceSurface: 'public', requesterEmail: 'visitor@example.test' });
  sendEmail.mockImplementationOnce(async () => {
    await SupportTicket.updateOne({ _id: ticket._id }, { $set: { status: 'closed' } }, { timestamps: false });
    return { accepted: ['visitor@example.test'] };
  });
  const result = await require('../services/support/adminInboxService').replyByEmail({ ticket, adminUser: admin, text: 'Reviewed answer', status: 'waiting_on_user', requestId: require('crypto').randomUUID() });
  expect(result.delivery).toBe('accepted');
  const saved = await SupportTicket.findById(ticket._id);
  expect(saved.status).toBe('closed');
  expect(saved.emailReplies[0].delivery).toBe('accepted');
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
