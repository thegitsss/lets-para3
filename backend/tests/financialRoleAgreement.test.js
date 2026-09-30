const express=require('express'),request=require('supertest'),cookieParser=require('cookie-parser'),jwt=require('jsonwebtoken');
process.env.STRIPE_SECRET_KEY='sk_test_financial_role_fixture';
jest.mock('../utils/email',()=>jest.fn(async()=>({ok:true})));
const User=require('../models/User'),Case=require('../models/Case'),Payout=require('../models/Payout'),Operation=require('../models/PaymentOperation');
const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
const app=express();app.use(cookieParser(),express.json());app.use('/api/payments',require('../routes/payments'));app.use('/api/paralegal/dashboard',require('../routes/paralegalDashboard'));app.use('/api/admin',require('../routes/admin'));
let attorney,para,admin,matter,payout,operation;
const cookie=person=>`token=${jwt.sign({id:String(person._id),role:person.role,av:0},process.env.JWT_SECRET,{expiresIn:'1h'})}`;
const get=(person,path,query={})=>request(app).get(path).query(query).set('Cookie',cookie(person));
const history=()=>get(attorney,'/api/payments/attorney-financial-history',{expectedOwnerId:String(attorney._id)});
const dashboard=(query={})=>get(para,'/api/paralegal/dashboard',query);
const adminPayouts=()=>get(admin,'/api/admin/payouts');
const analytics=()=>get(admin,'/api/admin/analytics');
beforeAll(connect);afterAll(closeDatabase);afterEach(()=>jest.restoreAllMocks());
beforeEach(async()=>{
 const stripe=require('../utils/stripe');for(const resource of ['customers','paymentIntents','charges','transfers','refunds','paymentMethods'])for(const method of ['create','retrieve','list','update'])if(typeof stripe[resource]?.[method]==='function')jest.spyOn(stripe[resource],method).mockImplementation(async()=>{throw Error('Provider calls are outside retained role-agreement reads');});
 await clearDatabase();[attorney,para,admin]=await User.create(['attorney','paralegal','admin'].map(role=>({firstName:'Synthetic',lastName:role,email:`${role}@financial-agreement.test`,password:'Synthetic123!',role,status:'approved'})));
 const paidAt=new Date(Date.now()-10000);matter=await Case.create({title:'River Street financial agreement',details:'Same retained financial evidence across all roles.',attorney:attorney._id,attorneyId:attorney._id,paralegal:para._id,paralegalId:para._id,status:'completed',paymentReleased:true,payoutStatus:'paid',payoutTransferId:'tr_agreement',paidOutAt:paidAt,totalAmount:40000,lockedTotalAmount:40000,feeParalegalPct:18,currency:'usd',stripeMode:'test'});
 payout=await Payout.create({caseId:matter._id,paralegalId:para._id,operationKey:`case_payout:${matter._id}`,amountPaid:32800,transferId:'tr_agreement',status:'paid',stripeMode:'test',createdAt:paidAt});
 operation=await Operation.create({caseId:matter._id,operationKey:payout.operationKey,kind:'case_payout',fingerprint:'financial_agreement',amount:32800,transferAmount:32800,currency:'usd',status:'succeeded',stripeTransferId:payout.transferId,stripeObjectId:payout.transferId,stripeMode:'test'});
});
test('all three roles agree on an actual retained USD payout',async()=>{
 const a=await history(),p=await dashboard(),o=await adminPayouts();expect([a.status,p.status,o.status]).toEqual([200,200,200]);expect(a.body.entries.find(row=>row.type==='payout')).toMatchObject({state:'recorded',currency:'USD',amount:32800});expect(p.body.metrics.earningsTotal).toBe(328);expect(o.body.totalAmount).toBe(32800);
 const summary=await analytics();expect(summary.status).toBe(200);expect(summary.body.payoutMetrics.totalRecorded).toBe(32800);expect(summary.body.ledger.find(row=>row.type==='payout')).toMatchObject({amount:32800,currency:'USD',status:'Recorded'});
});
test.each(['reversed_matter','unresolved_operation','wrong_amount','foreign_transfer_reference','quarantined_operation','unresolved_matter','duplicate_transfer_operation'])('admin does not count an older paid flag when the same payout requires review: %s',async scenario=>{
 if(scenario==='reversed_matter')await Case.collection.updateOne({_id:matter._id},{$set:{payoutStatus:'reversed'}});
 if(scenario==='unresolved_operation')await Operation.collection.updateOne({_id:operation._id},{$set:{status:'needs_reconciliation'}});
 if(scenario==='quarantined_operation')await Operation.collection.updateOne({_id:operation._id},{$set:{evidenceStatus:'quarantined'}});
 if(scenario==='unresolved_matter')await Case.collection.updateOne({_id:matter._id},{$set:{payoutStatus:'needs_reconciliation'}});
 if(scenario==='duplicate_transfer_operation')await Operation.create({caseId:matter._id,operationKey:'duplicate_agreement',kind:'case_payout',fingerprint:'duplicate',amount:32800,status:'succeeded',stripeTransferId:payout.transferId,stripeMode:'test'});
 if(scenario==='wrong_amount')await Operation.collection.updateOne({_id:operation._id},{$set:{amount:1,transferAmount:1}});
 if(scenario==='foreign_transfer_reference')await Operation.create({caseId:new (require('mongoose').Types.ObjectId)(),operationKey:'foreign_financial_record',kind:'case_payout',fingerprint:'foreign',amount:32800,status:'succeeded',stripeTransferId:payout.transferId});
 const a=await history(),p=await dashboard(),o=await adminPayouts();expect(a.status).toBe(200);expect(p.status).toBe(200);expect(o.status).toBe(200);expect(a.body.entries.find(row=>row.type==='payout').state).not.toBe('recorded');expect(p.body.metrics.earningsTotal).toBe(0);expect(o.body.totalAmount).toBe(0);
 const summary=await analytics();expect(summary.status).toBe(200);expect(summary.body.payoutMetrics.totalRecorded).toBe(0);expect(summary.body.payoutMetrics.states.needs_review).toBe(1);expect(summary.body.ledger.filter(row=>row.type==='payout' && row.state==='recorded')).toEqual([]);expect(summary.body.ledger.filter(row=>row.type==='payout')).toEqual([expect.objectContaining({state:'needs_review',amount:null,requestedAmount:32800})]);
 expect((await require('../services/completionPayoutEvidence').inspect(await Case.collection.findOne({_id:matter._id}))).state).toBe('needs_review');
});
test('a EUR payout cannot become a dollar admin total',async()=>{
 await Case.collection.updateOne({_id:matter._id},{$set:{currency:'eur'}});await Operation.collection.updateOne({_id:operation._id},{$set:{currency:'eur'}});
 const a=await history(),o=await adminPayouts();expect(a.body.entries.find(row=>row.type==='payout')).toMatchObject({state:'recorded',currency:'EUR',amount:32800});expect(o.status).toBe(200);expect(o.body.totalAmount).not.toBe(32800);
 expect(o.body.currencies).toEqual([{currency:'EUR',stripeMode:'test',totalRecorded:32800,count:1}]);const summary=await analytics();expect(summary.status).toBe(200);expect(summary.body.payoutMetrics.totalRecorded).toBeNull();expect(summary.body.ledger.find(row=>row.type==='payout')).toMatchObject({amount:32800,currency:'EUR'});
});
test('the paralegal dashboard rejects a different expected signed-in owner',async()=>{
 const response=await dashboard({expectedOwnerId:String(attorney._id)});expect(response.status).toBe(403);expect(response.body.metrics).toBeUndefined();
});
test('account revocation during payout inventory prevents a stale paralegal dashboard response',async()=>{
 const find=Payout.collection.find.bind(Payout.collection);let changed=false;jest.spyOn(Payout.collection,'find').mockImplementation((...args)=>{const cursor=find(...args),toArray=cursor.toArray.bind(cursor);cursor.toArray=async()=>{const rows=await toArray();if(!changed){changed=true;await User.collection.updateOne({_id:para._id},{$inc:{authVersion:1}});}return rows;};return cursor;});
 const response=await dashboard();expect({changed,status:response.status,body:response.body}).toEqual(expect.objectContaining({changed:true,status:403}));expect(response.body.metrics).toBeUndefined();
});
test('expected compensation for a replacement uses the remaining assignment budget',async()=>{
 const former=await User.create({firstName:'Synthetic',lastName:'Former',email:'former@financial-agreement.test',password:'Synthetic123!',role:'paralegal',status:'approved'}),key=`partial_payout:${matter._id}:earlier`,paidAt=payout.createdAt;
 await Payout.collection.updateOne({_id:payout._id},{$set:{paralegalId:former._id,operationKey:key,amountPaid:8200}});await Operation.collection.updateOne({_id:operation._id},{$set:{operationKey:key,kind:'partial_payout',amount:8200,transferAmount:8200}});
 await Case.collection.updateOne({_id:matter._id},{$set:{status:'in progress',paymentReleased:false,payoutTransferId:'',payoutStatus:'not_started',paidOutAt:null,remainingAmount:30000,feeParalegalAmount:7200,escrowStatus:'funded',fundingIntegrityStatus:'verified',escrowIntentId:'pi_agreement',paymentIntentId:'pi_agreement',feeAttorneyPct:22,feeAttorneyAmount:8800,hiredAt:new Date(),withdrawalHistory:[{withdrawnParalegalId:former._id,partialPayoutAmount:10000,payoutFinalizedAt:paidAt,payoutFinalizedType:'partial_attorney',payoutTransferId:payout.transferId,pausedAt:new Date(paidAt.getTime()-1000)}]}});
 await Operation.create({caseId:matter._id,operationKey:`funding:${matter._id}:pi_agreement`,kind:'funding',fingerprint:'agreement_funding',status:'succeeded',amount:48800,currency:'usd',stripePaymentIntentId:'pi_agreement',stripeObjectId:'pi_agreement',stripeChargeId:'ch_agreement',stripeBalanceTransactionId:'txn_agreement',grossAmount:48800,processingFeeAmount:1400,netAmount:47400,stripeMode:'test',livemode:false,evidenceVerifiedAt:paidAt});
 const funds=await get(attorney,'/api/payments/escrow/active',{expectedOwnerId:String(attorney._id)});expect(funds.status).toBe(200);expect(funds.body.items.find(row=>String(row.caseId)===String(matter._id)).amountHeld).toBe(30000);
 const response=await dashboard();expect(response.status).toBe(200);expect(response.body.metrics.expectedPayouts).toBe(246);
 const clientUrl=require('url').pathToFileURL(require('path').resolve(__dirname,'../../frontend/assets/scripts/utils/paralegal-financials.mjs')).href;
 require('child_process').execFileSync(process.execPath,['--input-type=module','--eval',`import {readExpectedCompensation} from ${JSON.stringify(clientUrl)};import fs from 'node:fs';const v=JSON.parse(fs.readFileSync(0,'utf8'));readExpectedCompensation(v.report,v.ownerId);`],{input:JSON.stringify({report:response.body.metrics.expectedCompensation,ownerId:String(para._id)}),stdio:['pipe','pipe','pipe']});
});
test('admin payout reports verify the expected owner and current role after inventory',async()=>{
 const other=await get(admin,'/api/admin/payouts',{expectedOwnerId:String(para._id)});expect(other.status).toBe(403);expect(other.body.code).toBe('FINANCIAL_ACCOUNT_CHANGED');
 const find=Payout.collection.find.bind(Payout.collection);let changed=false;jest.spyOn(Payout.collection,'find').mockImplementation((...args)=>{const cursor=find(...args),array=cursor.toArray.bind(cursor);cursor.toArray=async()=>{const rows=await array();if(!changed){changed=true;await User.collection.updateOne({_id:admin._id},{$set:{role:'paralegal'}});}return rows;};return cursor;});
 const response=await adminPayouts();expect({changed,status:response.status}).toEqual({changed:true,status:403});expect(response.body.items).toBeUndefined();
});
test('a change to the first assignment while a later estimate is prepared invalidates the complete forecast',async()=>{
 const make=async ordinal=>{const doc=await Case.create({title:`Active forecast ${ordinal}`,details:'Private retained forecast.',attorney:attorney._id,attorneyId:attorney._id,paralegal:para._id,paralegalId:para._id,status:'in progress',paymentReleased:false,totalAmount:40000,lockedTotalAmount:40000,remainingAmount:40000,feeParalegalPct:18,feeAttorneyPct:22,feeAttorneyAmount:8800,currency:'usd',stripeMode:'test',escrowStatus:'funded',fundingIntegrityStatus:'verified',escrowIntentId:`pi_forecast${ordinal}`,paymentIntentId:`pi_forecast${ordinal}`,createdAt:new Date(Date.now()-ordinal*10000)});await Operation.create({caseId:doc._id,operationKey:`funding:${doc._id}:pi_forecast${ordinal}`,kind:'funding',fingerprint:`forecast${ordinal}`,status:'succeeded',amount:48800,currency:'usd',stripePaymentIntentId:`pi_forecast${ordinal}`,stripeObjectId:`pi_forecast${ordinal}`,stripeChargeId:`ch_forecast${ordinal}`,stripeBalanceTransactionId:`txn_forecast${ordinal}`,grossAmount:48800,processingFeeAmount:1400,netAmount:47400,stripeMode:'test',livemode:false,evidenceVerifiedAt:new Date()});return doc;};
 const first=await make(1),second=await make(2),find=Case.collection.find.bind(Case.collection),visited=[];let changed=false;
 jest.spyOn(Case.collection,'find').mockImplementation((...args)=>{const cursor=find(...args),array=cursor.toArray.bind(cursor);cursor.toArray=async()=>{const rows=await array(),caseId=String(args[0]?._id||'');if([String(first._id),String(second._id)].includes(caseId))visited.push(caseId);if(caseId===String(second._id)&&!changed){changed=true;await Case.collection.updateOne({_id:first._id},{$set:{remainingAmount:29999}});}return rows;};return cursor;});
 const response=await dashboard();expect(changed).toBe(true);expect(visited.slice(0,2)).toEqual([String(first._id),String(second._id)]);expect(response.status).toBe(409);expect(response.body.metrics).toBeUndefined();
});
test.each([
 ['conflicting known modes','unknown','test','live',false],
 ['no provider mode','test','unknown','unknown',false],
 ['a mode retained only on the operation','unknown','unknown','test',true],
 ['a mode retained only on the payout','unknown','test','unknown',true],
 ['matching live records','live','live','live',true],
])('payout mode agreement is shared by history, earnings, admin and completion: %s',async(_label,caseMode,payoutMode,operationMode,recorded)=>{
 await Case.collection.updateOne({_id:matter._id},{$set:{stripeMode:caseMode}});await Payout.collection.updateOne({_id:payout._id},{$set:{stripeMode:payoutMode}});await Operation.collection.updateOne({_id:operation._id},{$set:{stripeMode:operationMode}});
 const a=await history(),p=await dashboard(),o=await adminPayouts(),decision=await require('../services/completionPayoutEvidence').inspect(await Case.collection.findOne({_id:matter._id}));
 expect([a.status,p.status,o.status]).toEqual([200,200,200]);expect(a.body.entries.find(row=>row.type==='payout').state).toBe(recorded?'recorded':'needs_review');expect(p.body.metrics.earningsTotal).toBe(recorded?328:0);expect(o.body.totalAmount).toBe(recorded?32800:0);expect(decision.state).toBe(recorded?'recorded':'needs_review');
 if(recorded)expect(o.body.currencies[0].stripeMode).toBe(payoutMode==='unknown'?operationMode:payoutMode);
});
test('the reporting month uses UTC boundaries instead of the server local time zone',async()=>{
 await Payout.collection.updateOne({_id:payout._id},{$set:{createdAt:new Date('2026-09-30T23:59:00Z')}});
 const value=await require('../services/retainedPayoutProjection').read(para._id,{now:new Date('2026-10-01T00:30:00Z')});expect(value.currencies).toEqual([{currency:'USD',month:0,last30:32800,total:32800}]);
});

test.each([[null,false,true],['test',true,false],['unknown',false,true],['unknown','false',false]])('provider livemode evidence %s/%s agrees across the shared readers',async(mode,livemode,recorded)=>{
 await Case.collection.updateOne({_id:matter._id},{$set:{stripeMode:'unknown'}});await Payout.collection.updateOne({_id:payout._id},{$set:{stripeMode:'unknown'}});await Operation.collection.updateOne({_id:operation._id},{$set:{stripeMode:mode,livemode}});
 const before=await Operation.collection.findOne({_id:operation._id}),a=await history(),p=await dashboard(),o=await adminPayouts(),decision=await require('../services/completionPayoutEvidence').inspect(await Case.collection.findOne({_id:matter._id}));
 expect([a.status,p.status,o.status]).toEqual([200,200,200]);expect(a.body.entries.find(row=>row.type==='payout').state).toBe(recorded?'recorded':'needs_review');expect(p.body.metrics.earningsTotal).toBe(recorded?328:0);expect(o.body.totalAmount).toBe(recorded?32800:0);expect(decision.state).toBe(recorded?'recorded':'needs_review');expect(await Operation.collection.findOne({_id:operation._id})).toEqual(before);
});
