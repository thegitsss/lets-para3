const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/stripe", () => ({}));
jest.mock("../utils/email", () => jest.fn(async () => ({})));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_id, _type, _payload, options = {}) => options.deferDispatch ? async () => {} : ({})) }));
const Case = require("../models/Case"), User = require("../models/User"), Block = require("../models/Block");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@invitation-actions.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved", ...(name === "para" ? { stripeAccountId: "acct_synthetic", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "Synthetic invitation Matter", details: "Invitation review and amount preservation", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40001, tasks: [{ title: "Prepare exhibits" }] });
});
afterEach(() => jest.restoreAllMocks());
const read = (actor = owner) => request(app).get(`/api/cases/${matter._id}/invitation-review/${para._id}?expectedOwnerId=${actor._id}`).set("Cookie", cookie(actor));
const send = (review, profile = false) => request(app).post(`/api/cases/${matter._id}/invite${profile ? "" : `/${para._id}`}`).set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), reviewedRevision: review.revision, ...(profile ? { paralegalId: String(para._id) } : {}) });

const respond = (decision, route = 'respond-invite') => request(app).post(`/api/cases/${matter._id}/${route === 'respond-invite' ? route : `invite/${decision}`}`).set('Cookie',cookie(para)).send({decision});
const received = () => request(app).get('/api/cases/invited-to').set('Cookie',cookie(para));
test.each(['respond-invite', 'invite'].flatMap(route => ['accept', 'decline'].flatMap(decision => [false, true].map(mixed => [route, decision, mixed]))))('legacy %s %s with mixed history=%s responds once and preserves its recorded invitation date', async (route, decision, mixed) => {
  const invitedAt = new Date('2025-02-03T12:00:00Z');
  await Case.collection.updateOne({_id:matter._id},{$set:{invites:mixed?[{paralegalId:other._id,status:'declined',invitedAt:new Date('2025-01-01')}]:[],pendingParalegalId:para._id,pendingParalegalInvitedAt:invitedAt}});
  const before=await Case.collection.findOne({_id:matter._id});
  const listing=await received();expect(listing.status).toBe(200);expect(listing.body.items.map(item=>item.id)).toContain(String(matter._id));expect(await Case.collection.findOne({_id:matter._id})).toEqual(before);
  const first=await respond(decision, route);expect(first.status).toBe(200);
  const saved=await Case.collection.findOne({_id:matter._id}), own=saved.invites.filter(item=>String(item.paralegalId)===String(para._id));
  expect(own).toHaveLength(1);expect(own[0]).toMatchObject({status:decision==='accept'?'accepted':'declined',invitedAt});expect(own[0].respondedAt).toBeInstanceOf(Date);expect(saved.paralegal||saved.paralegalId).toBeFalsy();expect(saved.paymentReleased).not.toBe(true);
  const again=await respond(decision, route);expect(again.status).toBe(200);const latest=await Case.collection.findOne({_id:matter._id});expect(latest.invites).toEqual(saved.invites);expect(latest.applicants).toEqual(saved.applicants);expect((await received()).body.items).toHaveLength(0);
});

test.each(['respond-invite', 'invite'].flatMap(route => ['accept', 'decline'].flatMap(decision => ['missing', 'null', 'string-pending', 'string-embedded'].map(format => [route, decision, format]))))('%s %s preserves an unknown date and responds to %s without inventing history', async (route, decision, format) => {
  const update = {$set:{pendingParalegalId:format === 'string-pending' ? String(para._id) : para._id, pendingParalegalInvitedAt:null}};
  if(format === 'missing') update.$unset={invites:''};
  else update.$set.invites = format === 'null' ? null : format === 'string-embedded' ? [{paralegalId:String(para._id),status:'pending',invitedAt:null}] : [];
  await Case.collection.updateOne({_id:matter._id},update);
  expect((await received()).body.items).toHaveLength(1);
  const response=await respond(decision, route);expect(response.status).toBe(200);
  const saved=await Case.collection.findOne({_id:matter._id});expect(saved.invites).toHaveLength(1);expect(saved.invites[0].invitedAt).toBeNull();expect(saved.invites[0].status).toBe(decision==='accept'?'accepted':'declined');expect(saved.invites[0].paralegalId).toBeInstanceOf(Types.ObjectId);
});

test.each(['scope','deadline','practice','experience','amount','owner','pending','history','archive','assignment','claim','closure'])('legacy acceptance rejects a concurrent %s change without locking the earlier amount or adding an application', async kind => {
  await Case.collection.updateOne({_id:matter._id},{$set:{invites:[],pendingParalegalId:para._id,pendingParalegalInvitedAt:new Date('2025-01-01')}});
  const updates={scope:{tasks:[{title:'Changed scope'}]},deadline:{deadlineDate:'2027-09-20'},practice:{practiceArea:'Probate'},experience:{minimumYearsExperience:5},amount:{totalAmount:50001},owner:{attorneyId:other._id},pending:{pendingParalegalId:other._id},history:{invites:[{paralegalId:para._id,status:'expired'}]},archive:{archived:true},assignment:{paralegalId:other._id},claim:{hiringClaimToken:'another-claim'},closure:{status:'closed'}};
  const original=Case.collection.updateOne.bind(Case.collection);let changed=false;
  jest.spyOn(Case.collection,'updateOne').mockImplementation(async(filter,update,options)=>{
    if(!changed && update.$push?.invites){changed=true;await original({_id:matter._id},{$set:updates[kind]});}
    return original(filter,update,options);
  });
  const response=await respond('accept');expect(changed).toBe(true);expect(response.status).toBe(409);
  const saved=await Case.collection.findOne({_id:matter._id});expect(saved.invites).toEqual(updates[kind].invites || []);expect(saved.applicants).toHaveLength(0);expect(saved.lockedTotalAmount).toBeNull();
});

test.each(['disabled','authVersion','resumeURL'])('legacy acceptance rejects a concurrent %s account change', async field => {
  await Case.collection.updateOne({_id:matter._id},{$set:{invites:[],pendingParalegalId:para._id}});
  const original=User.collection.updateOne.bind(User.collection);let changed=false;
  jest.spyOn(User.collection,'updateOne').mockImplementation(async(filter,update,options)=>{
    if(!changed && options?.session && update.$inc?.__v){changed=true;await original({_id:para._id},{$set:{[field]:field==='disabled'?true:field==='authVersion'?1:'new-resume-reference.pdf'}});}
    return original(filter,update,options);
  });
  const response=await respond('accept');expect([403,409]).toContain(response.status);expect(changed).toBe(true);
  const saved=await Case.collection.findOne({_id:matter._id});expect(saved.invites).toEqual([]);expect(saved.applicants).toHaveLength(0);expect(saved.lockedTotalAmount).toBeNull();
});

test.each(['unknown','missing-status','non-array','duplicate'])('ambiguous %s records expose an error rather than inventing a pending invitation', async kind => {
  const invites=kind==='unknown'?[{paralegalId:para._id,status:'unknown'}]:kind==='missing-status'?[{paralegalId:para._id}]:kind==='non-array'?{paralegalId:para._id,status:'pending'}:[{paralegalId:para._id,status:'declined'},{paralegalId:para._id,status:'pending'}];
  await Case.collection.updateOne({_id:matter._id},{$set:{invites,pendingParalegalId:para._id}});const before=await Case.collection.findOne({_id:matter._id});
  expect((await received()).status).toBe(409);expect((await respond('accept')).status).toBe(409);expect(await Case.collection.findOne({_id:matter._id})).toEqual(before);
});

test.each(['respond-invite','invite'])('%s rolls back the legacy response and amount when retaining the first application fails', async route => {
  await Case.collection.updateOne({_id:matter._id},{$set:{invites:[],pendingParalegalId:para._id}});
  const before=await Case.collection.findOne({_id:matter._id}), userBefore=await User.collection.findOne({_id:para._id});
  const original=Case.collection.updateOne.bind(Case.collection);let attempted=false;
  jest.spyOn(Case.collection,'updateOne').mockImplementation(async(filter,update,options)=>{
    if(options?.session && update.$push?.applicants){attempted=true;throw new Error('Synthetic first application failure');}
    return original(filter,update,options);
  });
  expect((await respond('accept',route)).status).toBe(500);expect(attempted).toBe(true);
  expect(await Case.collection.findOne({_id:matter._id})).toEqual(before);expect(await User.collection.findOne({_id:para._id})).toEqual(userBefore);
});

test.each(['respond-invite','invite'].flatMap(route=>['blocked','no-tasks','payout-incomplete','other-person','archived'].map(guard=>[route,guard])))('%s preserves the %s legacy acceptance guard',async(route,guard)=>{
  await Case.collection.updateOne({_id:matter._id},{$set:{invites:[],pendingParalegalId:guard==='other-person'?other._id:para._id,...(guard==='no-tasks'?{tasks:[]}:{}),...(guard==='archived'?{archived:true}:{})}});
  if(guard==='blocked')await Block.create({blockerId:para._id,blockedId:owner._id,active:true});
  if(guard==='payout-incomplete')await User.updateOne({_id:para._id},{$set:{stripeAccountId:''}});
  const before=await Case.collection.findOne({_id:matter._id});expect([400,403,409]).toContain((await respond('accept',route)).status);expect(await Case.collection.findOne({_id:matter._id})).toEqual(before);
});


test('mandatory Matter requirements are confirmed and retained when accepting an invitation',async()=>{
 await Case.updateOne({_id:matter._id},{$set:{requirements:['Clio proficiency'],invites:[{paralegalId:para._id,status:'pending',invitedAt:new Date()}]}});
 const missing=await request(app).post(`/api/cases/${matter._id}/invite/accept`).set('Cookie',cookie(para)).send({});expect(missing.status).toBe(400);
 expect((await Case.findById(matter._id)).invites[0].status).toBe('pending');
 const accepted=await request(app).post(`/api/cases/${matter._id}/invite/accept`).set('Cookie',cookie(para)).send({requirementAnswers:[{requirement:'Clio proficiency',meets:true}]});
 expect(accepted.status).toBe(200);
 expect((await Case.findById(matter._id)).applicants[0].requirementConfirmations.map(item=>({requirement:item.requirement,meets:item.meets}))).toEqual([{requirement:'Clio proficiency',meets:true}]);
});
