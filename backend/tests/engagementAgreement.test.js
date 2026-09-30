const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/stripe", () => ({
  customers: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() }, paymentMethods: { retrieve: jest.fn() },
  paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() }, refunds: { create: jest.fn(), list: jest.fn(async () => ({ data: [], has_more: false })) },
  accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(() => ({ transferable: true, charge: { id: "ch_synthetic", paid: true, status: "succeeded", amount: 48801, amount_refunded: 0 } })),
  getPaymentIntentCharge: jest.fn(() => ({ id: "ch_synthetic", paid: true, status: "succeeded", amount: 48801, amount_refunded: 0 })),
  stripeIdempotencyKey: jest.fn((...parts) => parts.join("_")), sanitizeStripeError: jest.fn((_err, fallback) => fallback), caseTransferGroup: jest.fn(caseId => `case_${caseId}`),
}));
const User = require("../models/User"), Case = require("../models/Case"), Block = require("../models/Block"), PaymentOperation = require("../models/PaymentOperation"), stripe = require("../utils/stripe");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, loser, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, loser] = await User.create(["owner", "other", "para", "loser"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@hiring.test`, password: "Synthetic123!", role: ["para", "loser"].includes(name) ? "paralegal" : "attorney", status: "approved", stripeCustomerId: "cus_synthetic", stripeAccountId: "acct_synthetic", stripeOnboarded: true, stripePayoutsEnabled: true })));
  matter = await Case.create({ title: "Synthetic reviewed hiring", details: "Reviewed hiring verification", attorney: owner._id, attorneyId: owner._id, totalAmount: 40001, lockedTotalAmount: 40001, feeAttorneyPct: 22, feeParalegalPct: 18, tasks: [{ title: "Prepare exhibits" }], applicants: [{ paralegalId: para._id, status: "pending" }, { paralegalId: loser._id, status: "pending" }] });
  stripe.customers.retrieve.mockResolvedValue({ id: "cus_synthetic", invoice_settings: { default_payment_method: "pm_synthetic" } });
  stripe.paymentMethods.retrieve.mockResolvedValue({ id: "pm_synthetic", type: "card", customer: "cus_synthetic", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } });
  stripe.paymentIntents.create.mockImplementation(async data => ({ id: "pi_synthetic", status: "succeeded", livemode: false, amount_received: data.amount, ...data }));
  stripe.paymentIntents.retrieve.mockImplementation(async () => intent()); stripe.paymentIntents.cancel.mockImplementation(async () => intent({ status: "canceled", amount_received: 0 })); stripe.refunds.create.mockResolvedValue({ id: "re_synthetic", status: "succeeded" });
});
afterEach(() => jest.restoreAllMocks());
function intent(patch = {}) { return { id: "pi_synthetic", status: "succeeded", amount: 48801, amount_received: 48801, currency: "usd", customer: "cus_synthetic", metadata: { caseId: String(matter._id), attorneyId: String(owner._id), paralegalId: String(para._id) }, transfer_group: `case_${matter._id}`, livemode: false, ...patch }; }
const read = () => request(app).get(`/api/cases/${matter._id}/hiring-review/${para._id}?expectedOwnerId=${owner._id}`).set("Cookie", cookie(owner));
const hire = revision => request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), reviewedRevision: revision });

const Job = require('../models/Job'), Application = require('../models/Application'), Notification = require('../models/Notification');
app.use('/api/applications', require('../routes/applications'));
app.use('/api/paralegal/dashboard', require('../routes/paralegalDashboard'));
app.use('/api/notifications', require('../routes/notifications'));
const logical = value => String(value?._id || value).toLowerCase();
const getAs = (path, actor = owner, query = {}) => request(app).get(path).query(query).set('Cookie', cookie(actor));
let admin, earlier, invitee, jobId, applicationIds;
beforeEach(async () => {
  [admin, earlier, invitee] = await User.create(['admin', 'earlier', 'invitee'].map(name => ({ firstName:'Synthetic', lastName:name, email:`${name}@combined-hiring.test`, password:'Synthetic123!', role:name==='admin'?'admin':'paralegal', status:'approved' })));
  jobId = new Types.ObjectId(); applicationIds=[new Types.ObjectId(),new Types.ObjectId(),new Types.ObjectId()];
  await Job.collection.insertOne({ _id:jobId, caseId:matter._id, attorneyId:owner._id, title:matter.title, status:'open', applicantsCount:2 });
  await Case.collection.updateOne({ _id:matter._id }, {$set:{ jobId,job:jobId,invites:[{paralegalId:invitee._id,status:'pending',invitedAt:new Date('2026-08-01')}] }});
  await Application.collection.insertMany([
    { _id:applicationIds[0],jobId,paralegalId:para._id,status:'submitted',syncStatus:'synced',coverLetter:'Winner saved letter',createdAt:new Date('2026-08-01') },
    { _id:applicationIds[1],jobId,paralegalId:loser._id,status:'shortlisted',syncStatus:'synced',coverLetter:'Other saved letter',createdAt:new Date('2026-08-02') },
    { _id:applicationIds[2],jobId,paralegalId:earlier._id,status:'withdrawn',syncStatus:'synced',coverLetter:'Withdrawn saved letter',statusHistory:[{to:'withdrawn',reason:'paralegal_withdrawn',at:new Date('2026-08-03')}],createdAt:new Date('2026-08-03') },
  ]);
});
async function startHire(client) {
  if (client==='current') return request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set('Cookie',cookie(owner)).send({});
  const review=await read();expect(review.status).toBe(200);expect(review.body.canHire).toBe(true);return hire(review.body.revision);
}
async function applicationHistory(actor) {
  const response=await getAs('/api/applications/my',actor);expect(response.status).toBe(200);
  return response.body.find(item=>logical(item.job?._id || item.jobId || item.job)===logical(jobId));
}
test.each(['canonical', 'earlier accepted-invitation'])('%s own application exposes the exact saved requirements revision to its paralegal', async source => {
  if (source !== 'canonical') {
    await Application.collection.deleteOne({ _id: applicationIds[0] });
    await Case.collection.updateOne({ _id: matter._id }, { $push: { invites: { paralegalId: para._id, status: 'accepted', invitedAt: new Date('2026-08-01'), respondedAt: new Date('2026-08-02') } } });
  }
  await Case.collection.updateOne({ _id: matter._id }, { $set: { preEngagement: { revision: 7, status: 'requested', requestedParalegalId: para._id, conflictsCheckRequired: true, conflictsDetails: 'Synthetic current parties.' } } });
  const before = await Case.collection.findOne({ _id: matter._id });
  expect((await applicationHistory(para)).preEngagement).toMatchObject({ revision: 7, requestedParalegalId: logical(para._id), conflictsDetails: 'Synthetic current parties.' });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
async function expectPostHireViews() {
  for(const [path,actor] of [['/api/cases/my',owner],['/api/cases/my-active',owner],['/api/cases/admin',admin]]) {
    const response=await getAs(path,actor);expect(response.status).toBe(200);
    const rows=Array.isArray(response.body)?response.body:response.body.items||response.body.cases;
    const row=rows.find(item=>logical(item._id||item.id)===logical(matter._id));expect(row).toBeDefined();expect(row.applicantsCount).toBe(0);
  }
  const inventory=await getAs('/api/cases/inventory',owner,{expectedOwnerId:logical(owner._id),view:'active'});
  expect(inventory.status).toBe(200);expect(inventory.body.counts.applications).toBe(0);expect(inventory.body.items[0].applicantsCount).toBe(0);
  for (const actor of [para, loser]) {
    const home = await getAs('/api/paralegal/dashboard', actor, { expectedOwnerId: logical(actor._id) });
    expect(home.status).toBe(200); expect(home.body.metrics.pendingApplications).toBe(0);
    expect(home.body.metrics.activeCases).toBe(actor === para ? 1 : 0);
    expect(home.body.activeCases.map(value => logical(value.caseId))).toEqual(actor === para ? [logical(matter._id)] : []);
    expect(home.body.myApplications.find(value => logical(value.caseId) === logical(matter._id)).status).toBe(actor === para ? 'accepted' : 'rejected');
  }
  const currentWinner=await getAs(`/api/cases/${matter._id}`,para);expect(currentWinner.status).toBe(200);
  expect([403,404]).toContain((await getAs(`/api/cases/${matter._id}`,loser)).status);
}
test.each(['reviewed','current'].flatMap(client=>['object','lowercase','uppercase'].map(references=>({client,references}))))('$client hire reconciles $references canonical identities and all role counts',async ({client,references})=>{
  if(references!=='object') for(const actor of [para,loser,earlier]) await Application.collection.updateMany({paralegalId:actor._id},{$set:{jobId:references==='uppercase'?logical(jobId).toUpperCase():logical(jobId),paralegalId:references==='uppercase'?logical(actor._id).toUpperCase():logical(actor._id)}});
  const earlierBefore=await Application.collection.findOne({_id:applicationIds[2]});
  const result=await startHire(client);expect(result.status).toBe(200);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);expect(stripe.paymentIntents.create.mock.calls[0][0].amount).toBe(48801);
  const saved=await Case.collection.findOne({_id:matter._id});expect(logical(saved.paralegalId)).toBe(logical(para._id));expect(saved.status).toBe('in progress');
  expect((await Application.collection.findOne({_id:applicationIds[0]})).status).toBe('accepted');
  expect((await Application.collection.findOne({_id:applicationIds[1]})).status).toBe('rejected');
  expect(await Application.collection.findOne({_id:applicationIds[2]})).toEqual(earlierBefore);
  const posting=await Job.collection.findOne({_id:jobId});expect(posting.status).toBe('assigned');expect(posting.applicantsCount).toBe(0);
  expect((await applicationHistory(para)).status).toBe('accepted');expect((await applicationHistory(loser)).status).toBe('rejected');expect((await applicationHistory(earlier)).status).toBe('withdrawn');
  await expectPostHireViews();
});
test('an applicant winner receives one useful funded-work outcome and withdrawn applicants receive none',async()=>{
  expect((await startHire('reviewed')).status).toBe(200);
  const winner=await Notification.find({userId:para._id,type:{$in:['application_accepted','case_work_ready']}}).lean();
  expect(winner).toHaveLength(1);expect(winner[0].type).toBe('case_work_ready');
  expect(await Notification.countDocuments({userId:earlier._id})).toBe(0);
});
test('a nonwinner invitation does not say it was accepted after someone else is hired',async()=>{
  expect((await startHire('reviewed')).status).toBe(200);
  const notice=await Notification.findOne({userId:invitee._id,type:'case_invite_response'}).lean();expect(notice).not.toBeNull();
  expect(notice.payload.response).toBe('filled');expect(notice.message.toLowerCase()).not.toContain('accepted');expect(notice.message.toLowerCase()).toContain('filled');
});
test('an individual rejection does not announce a filled role when nobody was hired',async()=>{
  const path=`/api/cases/${matter._id}/application-review/${loser._id}/decision`;
  const review=await getAs(path,owner,{expectedOwnerId:logical(owner._id)});expect(review.status).toBe(200);
  // Use the existing application-decision revision and request receipt contract.
  const body={expectedOwnerId:logical(owner._id),action:'reject',revision:review.body.revision,requestId:require('crypto').randomUUID()};
  const result=await request(app).post(path).set('Cookie',cookie(owner)).send(body);expect(result.status).toBe(200);
  const notice=await Notification.findOne({userId:loser._id,type:'application_denied'}).lean();expect(notice).not.toBeNull();expect(notice.message.toLowerCase()).not.toContain('filled');
  const presented=require('../services/notificationPresentation').presentNotification(notice,{viewer:loser.toObject(),caseDoc:await Case.collection.findOne({_id:matter._id})});
  expect(presented.message.toLowerCase()).not.toContain('filled');expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});


test('current hire recognizes a canonical-only uppercase candidate and notifies the other canonical applicant', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { applicants: [] } });
  await Application.collection.updateMany({ jobId }, { $set: { jobId: logical(jobId).toUpperCase() } });
  for (const actor of [para, loser]) await Application.collection.updateOne({ paralegalId: actor._id }, { $set: { paralegalId: logical(actor._id).toUpperCase() } });
  expect((await startHire('current')).status).toBe(200);
  expect((await Application.collection.findOne({ _id: applicationIds[0] })).status).toBe('accepted');
  expect(await Notification.countDocuments({ userId: loser._id, type: 'application_denied' })).toBe(1);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});

test.each(['rejected', 'withdrawn'])('earlier %s evidence is not rewritten or notified as a new rejection', async status => {
  await Application.collection.updateOne({ _id: applicationIds[2] }, { $set: { status } });
  const mirror = { paralegalId: earlier._id, status: status === 'withdrawn' ? 'pending' : status, note: 'Retain earlier application evidence', retainedField: 'Keep this earlier value' };
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: mirror } });
  const before = await Application.collection.findOne({ _id: applicationIds[2] });
  expect((await startHire('reviewed')).status).toBe(200);
  expect(await Application.collection.findOne({ _id: applicationIds[2] })).toEqual(before);
  const saved = await Case.collection.findOne({ _id: matter._id });
  expect(saved.applicants.find(item => logical(item.paralegalId) === logical(earlier._id))).toEqual(mirror);
  expect(await Notification.countDocuments({ userId: earlier._id })).toBe(0);
});

test('participant refresh is published after canonical outcomes and the persisted posting count are written', async () => {
  const signals = [], observations = [];
  const unsubscribe = require('../utils/notificationEvents').addSubscriber(owner._id, { write: message => { if (message.includes('matter_hired_refresh')) signals.push(message); } });
  const original = Application.collection.updateOne.bind(Application.collection);
  jest.spyOn(Application.collection, 'updateOne').mockImplementation(async (...args) => {
    if (args[1]?.$set?.status === 'accepted') observations.push(signals.length);
    return original(...args);
  });
  try {
    expect((await startHire('reviewed')).status).toBe(200);
    expect(observations).toEqual([0]);
    expect(signals).toHaveLength(1);
    expect((await Job.collection.findOne({ _id: jobId })).applicantsCount).toBe(0);
  } finally { unsubscribe(); }
});


async function finalizedReplacement() {
  const at = new Date('2026-09-02T12:00:00Z'), operationKey = `partial_payout:${matter._id}:retained`;
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'paused', pausedReason: 'paralegal_withdrew', pausedAt: new Date('2026-09-01'), withdrawnParalegalId: earlier._id, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', partialPayoutAmount: 28001, remainingAmount: 12000, payoutTransferId: 'tr_retained_hiring', payoutStatus: 'paid', paidOutAt: at, stripeMode: 'test', escrowIntentId: 'pi_synthetic', escrowStatus: 'funded', fundingIntegrityStatus: 'verified' } });
  await require('../models/Payout').collection.insertOne({ caseId: matter._id, paralegalId: earlier._id, operationKey, amountPaid: 22961, transferId: 'tr_retained_hiring', stripeMode: 'test', livemode: false, status: 'paid', createdAt: at });
  await PaymentOperation.collection.insertOne({ caseId: matter._id, operationKey, kind: 'partial_payout', status: 'succeeded', amount: 22961, transferAmount: 22961, currency: 'usd', stripeMode: 'test', livemode: false, stripeTransferId: 'tr_retained_hiring', completedAt: at });
}

test.each(['reviewed', 'current'].flatMap(client => ['object', 'uppercase'].map(references => ({ client, references }))))('$client replacement reconciles $references application outcomes using only retained funds', async ({ client, references }) => {
  await finalizedReplacement();
  if (references === 'uppercase') for (const actor of [para, loser, earlier]) await Application.collection.updateMany({ paralegalId: actor._id }, { $set: { jobId: logical(jobId).toUpperCase(), paralegalId: logical(actor._id).toUpperCase() } });
  const priorApplication = await Application.collection.findOne({ _id: applicationIds[2] });
  const priorPayout = await require('../models/Payout').collection.findOne({ caseId: matter._id });
  expect((await startHire(client)).status).toBe(200);
  expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  const saved = await Case.collection.findOne({ _id: matter._id });
  expect(logical(saved.paralegalId)).toBe(logical(para._id)); expect(saved.remainingAmount).toBe(12000);
  expect((await Application.collection.findOne({ _id: applicationIds[0] })).status).toBe('accepted');
  expect((await Application.collection.findOne({ _id: applicationIds[1] })).status).toBe('rejected');
  expect(await Application.collection.findOne({ _id: applicationIds[2] })).toEqual(priorApplication);
  expect(await require('../models/Payout').collection.findOne({ _id: priorPayout._id })).toEqual(priorPayout);
  expect((await Job.collection.findOne({ _id: jobId })).applicantsCount).toBe(0);
  expect(await Notification.countDocuments({ userId: para._id, type: { $in: ['application_accepted', 'case_work_ready'] } })).toBe(1);
  await expectPostHireViews();
});

test.each(['original', 'replacement'])('an interrupted %s application update keeps the whole assignment pending and can finish without another charge', async kind => {
  if (kind === 'replacement') await finalizedReplacement();
  const beforeApplications = await Application.collection.find({ jobId }).sort({ _id: 1 }).toArray();
  const beforeJob = await Job.collection.findOne({ _id: jobId });
  const original = Application.collection.updateMany.bind(Application.collection);
  let interrupted = false;
  jest.spyOn(Application.collection, 'updateMany').mockImplementation(async (...args) => {
    if (!interrupted && args[1]?.$set?.status === 'rejected') { interrupted = true; throw new Error('Synthetic interrupted application finalization'); }
    return original(...args);
  });
  const result = await startHire('reviewed');
  expect(result.status).toBe(500);
  const pending = await Case.collection.findOne({ _id: matter._id });
  expect(pending.paralegalId).toBeNull();
  expect(pending.status).toBe(kind === 'replacement' ? 'paused' : 'open');
  expect(await Application.collection.find({ jobId }).sort({ _id: 1 }).toArray()).toEqual(beforeApplications);
  expect(await Job.collection.findOne({ _id: jobId })).toEqual(beforeJob);
  expect(await Notification.countDocuments({ userId: para._id, type: 'case_work_ready' })).toBe(0);
  const fresh = await read(); expect(fresh.status).toBe(200);
  expect(kind === 'replacement' ? fresh.body.canHire : fresh.body.canResume).toBe(true);
  expect((await hire(fresh.body.revision)).status).toBe(200);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(kind === 'replacement' ? 0 : 1);
  expect((await Application.collection.findOne({ _id: applicationIds[0] })).status).toBe('accepted');
  expect((await Application.collection.findOne({ _id: applicationIds[1] })).status).toBe('rejected');
  expect((await Job.collection.findOne({ _id: jobId })).applicantsCount).toBe(0);
  expect(await Notification.countDocuments({ userId: para._id, type: 'case_work_ready' })).toBe(1);
});


test('current-client uncertain successful charge stays recoverable without a second charge', async () => {
  stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error('Synthetic lost provider response'), { payment_intent: intent() }));
  const first = await startHire('current');
  expect(first.status).toBe(409);
  const saved = await Case.collection.findOne({ _id: matter._id });
  expect(saved.hiringClaimStatus).toBe('needs_reconciliation'); expect(saved.hiringClaimPaymentIntentId).toBe('pi_synthetic');
  expect(saved.paralegalId).toBeNull();
  const review = await read(); expect(review.status).toBe(200); expect(review.body.canResume).toBe(true);
  expect((await hire(review.body.revision)).status).toBe(200);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  expect((await Application.collection.findOne({ _id: applicationIds[0] })).status).toBe('accepted');
  expect(await Notification.countDocuments({ userId: para._id, type: 'case_work_ready' })).toBe(1);
});

test('current-client card failure cancels the matching unpaid intent before offering another attempt', async () => {
  const declined = intent({ status: 'requires_payment_method', amount_received: 0 });
  stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error('Synthetic declined card'), { payment_intent: declined }));
  stripe.paymentIntents.retrieve.mockResolvedValue(declined);
  const response = await startHire('current'); expect(response.status).toBe(402);
  expect(response.body.code).toBe('HIRING_CARD_NOT_CHARGED');
  expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_synthetic');
  expect((await Case.collection.findOne({ _id: matter._id })).paralegalId).toBeNull();
  const review = await read(); expect(review.status).toBe(200); expect(review.body.canHire).toBe(true);
  expect(await Notification.countDocuments({ userId: para._id, type: 'case_work_ready' })).toBe(0);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});


test('current-client unknown charge without a provider reference cannot submit another charge', async () => {
  stripe.paymentIntents.create.mockRejectedValueOnce(new Error('Synthetic provider connection loss'));
  const first = await startHire('current'); expect(first.status).toBe(409);
  const saved = await Case.collection.findOne({ _id: matter._id });
  expect(saved.hiringClaimStatus).toBe('needs_reconciliation'); expect(saved.paralegalId).toBeNull();
  const review = await read(); expect(review.status).toBe(200); expect(review.body.canHire).toBe(false); expect(review.body.canResume).toBe(false);
  expect([400, 409]).toContain((await startHire('current')).status);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  expect(await Notification.countDocuments({ userId: para._id, type: 'case_work_ready' })).toBe(0);
});


test.each(['current', 'reviewed'])('%s hire preserves physical string Job and Application identities', async client => {
  const posting = await Job.collection.findOne({ _id: jobId });
  await Job.collection.deleteOne({ _id: jobId });
  await Job.collection.insertOne({ ...posting, _id: logical(jobId).toUpperCase() });
  for (const applicationId of applicationIds) {
    const record = await Application.collection.findOne({ _id: applicationId });
    await Application.collection.deleteOne({ _id: applicationId });
    await Application.collection.insertOne({ ...record, _id: logical(applicationId).toUpperCase(), jobId: logical(jobId).toUpperCase(), paralegalId: logical(record.paralegalId).toUpperCase() });
  }
  const result = await startHire(client); expect(result.status).toBe(200);
  expect((await Job.collection.findOne({ _id: logical(jobId).toUpperCase() })).status).toBe('assigned');
  expect((await Application.collection.findOne({ _id: logical(applicationIds[0]).toUpperCase() })).status).toBe('accepted');
  expect((await Application.collection.findOne({ _id: logical(applicationIds[1]).toUpperCase() })).status).toBe('rejected');
  expect((await Application.collection.findOne({ _id: logical(applicationIds[2]).toUpperCase() })).status).toBe('withdrawn');
  expect(await Job.collection.findOne({ _id: jobId })).toBeNull();
  expect(await Application.collection.findOne({ _id: applicationIds[0] })).toBeNull();
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test.each(['current', 'reviewed'])('%s hire assigns the reverse-linked posting for earlier-only applicants', async client => {
  await Case.collection.updateOne({ _id: matter._id }, { $unset: { job: '', jobId: '' } });
  await Application.deleteMany({});
  const result = await startHire(client); expect(result.status).toBe(200);
  const posting = await Job.collection.findOne({ _id: jobId });
  expect(posting.status).toBe('assigned'); expect(posting.applicantsCount).toBe(0);
  expect(await Application.countDocuments()).toBe(0);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test.each(['lowercase', 'uppercase'])('hiring preserves a physical %s string Matter without charging through the unsupported writer', async kind => {
  const raw = await Case.collection.findOne({ _id: matter._id });
  const physicalId = kind === 'uppercase' ? logical(matter._id).toUpperCase() : logical(matter._id);
  await Case.collection.deleteOne({ _id: matter._id });
  await Case.collection.insertOne({ ...raw, _id: physicalId });
  const before = await Case.collection.findOne({ _id: physicalId });
  // The shared Case authorization still reads ObjectId primary keys. This is
  // safe refusal evidence, not acceptance of string-primary Matter migration.
  expect((await read()).status).toBe(404);
  expect((await hire('a'.repeat(64))).status).toBe(404);
  expect((await startHire('current')).status).toBe(404);
  expect(await Case.collection.findOne({ _id: physicalId })).toEqual(before);
  expect(await Case.collection.findOne({ _id: matter._id })).toBeNull();
  expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  expect(await Notification.countDocuments()).toBe(0);
});
test.each(['current', 'reviewed'])('%s hire uses uppercase owner references without replacing their saved form', async client => {
  const ownerRef = logical(owner._id).toUpperCase();
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: ownerRef, attorneyId: ownerRef } });
  await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: ownerRef } });
  const result = await startHire(client); expect(result.status).toBe(200);
  const saved = await Case.collection.findOne({ _id: matter._id });
  expect(saved.attorney).toBe(ownerRef); expect(saved.attorneyId).toBe(ownerRef);
  expect((await Job.collection.findOne({ _id: jobId })).attorneyId).toBe(ownerRef);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  const assigned = await read(); expect(assigned.status).toBe(200); expect(assigned.body).toMatchObject({ reason: 'assigned', assigned: true, fundingVerified: true });
});
test.each(['duplicate_case', 'duplicate_job', 'duplicate_application', 'wrong_posting_owner'])('%s prevents current hiring before any charge or outcome change', async kind => {
  const model = { duplicate_case: Case, duplicate_job: Job, duplicate_application: Application }[kind];
  const key = { duplicate_case: matter._id, duplicate_job: jobId, duplicate_application: applicationIds[0] }[kind];
  if (model) { const record = await model.collection.findOne({ _id: key }); await model.collection.insertOne({ ...record, _id: logical(key).toUpperCase(), ...(kind === 'duplicate_job' ? { caseId: logical(matter._id).toUpperCase() } : kind === 'duplicate_application' ? { jobId: logical(jobId).toUpperCase(), paralegalId: logical(para._id).toUpperCase() } : {}) }); }
  else await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: other._id } });
  const before = await Promise.all([Case.collection.find({}).sort({ _id: 1 }).toArray(), Job.collection.find({}).sort({ _id: 1 }).toArray(), Application.collection.find({}).sort({ _id: 1 }).toArray()]);
  const result = await startHire('current'); expect([400,403,404,409,503]).toContain(result.status);
  expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  expect(await Promise.all([Case.collection.find({}).sort({ _id: 1 }).toArray(), Job.collection.find({}).sort({ _id: 1 }).toArray(), Application.collection.find({}).sort({ _id: 1 }).toArray()])).toEqual(before);
  expect(await Notification.countDocuments({ type: 'case_work_ready' })).toBe(0);
});


test.each(['original', 'replacement'].flatMap(kind => ['case_work_ready', 'application_denied'].map(type => ({ kind, type }))))('$kind hire keeps notification write failure for $type recoverable with the assignment', async ({ kind, type }) => {
  if (kind === 'replacement') await finalizedReplacement();
  const create = Notification.create.bind(Notification); let failed = false;
  jest.spyOn(Notification, 'create').mockImplementation(async (...args) => {
    const value = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!failed && value?.type === type) { failed = true; throw new Error('Synthetic interrupted engagement notification'); }
    return create(...args);
  });
  const result = await startHire('reviewed'); expect(result.status).toBe(500);
  const pending = await Case.collection.findOne({ _id: matter._id });
  expect(pending.paralegalId).toBeNull();
  expect((await Application.collection.findOne({ _id: applicationIds[0] })).status).toBe('submitted');
  expect((await Job.collection.findOne({ _id: jobId })).status).toBe('open');
  expect(await Notification.countDocuments({})).toBe(0);
  expect(require('../utils/email')).not.toHaveBeenCalled();
  const review = await read(); expect(review.status).toBe(200); expect(kind === 'replacement' ? review.body.canHire : review.body.canResume).toBe(true);
  expect((await hire(review.body.revision)).status).toBe(200);
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(kind === 'replacement' ? 0 : 1);
  expect(await Notification.countDocuments({ userId: para._id, type: 'case_work_ready' })).toBe(1);
  expect(await Notification.countDocuments({ userId: loser._id, type: 'application_denied' })).toBe(1);
});


test('a winner who disabled notices still receives the assigned Home state without notification records or email', async () => {
  await User.collection.updateMany({ _id: { $in: [para._id, loser._id, invitee._id] } }, { $set: { notificationPrefs: { inApp: false, email: false } } });
  const events = [], off = require('../utils/notificationEvents').addSubscriber(logical(para._id), { write: value => events.push(String(value)) });
  try {
    expect((await startHire('reviewed')).status).toBe(200);
    expect(await Notification.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
    expect(events.some(value => value.includes('case_work_ready_refresh'))).toBe(true);
    await expectPostHireViews();
  } finally { off(); }
});


test('a nonwinner who also has a pending invitation receives only one relevant outcome', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $push: { invites: { paralegalId: loser._id, status: 'pending', invitedAt: new Date() } } });
  expect((await startHire('reviewed')).status).toBe(200);
  const notices = await Notification.find({ userId: loser._id }).lean();
  expect(notices).toHaveLength(1); expect(notices[0].type).toBe('application_denied'); expect(notices[0].payload.outcome).toBe('matter_filled');
});


test('actual notification feeds lead winners to work and nonwinners to their own available history', async () => {
  expect((await startHire('reviewed')).status).toBe(200);
  for (const [actor, type, href] of [[para, 'case_work_ready', `/case-detail.html?caseId=${matter._id}&tab=work`], [loser, 'application_denied', '/dashboard-paralegal.html#cases'], [invitee, 'case_invite_response', '/browse-jobs.html']]) {
    const response = await getAs('/api/notifications', actor); expect(response.status).toBe(200);
    const notices = response.body.filter(value => value.type === type); expect(notices).toHaveLength(1);
    expect(notices[0].available).toBe(true); expect(notices[0].action.href).toBe(href);
    expect(notices[0].context.caseId).toBe(logical(matter._id));
  }
  expect((await getAs('/api/notifications', other)).body).toEqual([]);
});
