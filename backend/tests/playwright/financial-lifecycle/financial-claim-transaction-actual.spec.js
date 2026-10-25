'use strict';
const {test,expect,start,snapshot}=require('./financial-api-model-observation.cjs');
const mongoose=require('mongoose'),crypto=require('node:crypto');
const Operation=require('../../../models/PaymentOperation');
const {claimPaymentOperation,failPaymentOperation,succeedPaymentOperation,STALE_PENDING_MS}=require('../../../services/paymentOperationService');
let server;
test.beforeAll(async()=>{test.setTimeout(180000);server=await start({port:0});});
test.beforeEach(async()=>server.reset());
test.afterAll(async()=>server?.close());
const input=()=>{const caseId=new mongoose.Types.ObjectId();return {operationKey:`dispute_settlement:${caseId}:${crypto.randomUUID()}`,caseId,kind:'dispute_settlement',fingerprint:{action:'release_full',amount:40000},amount:40000,currency:'usd'};};
async function session(){const value=await mongoose.startSession();value.startTransaction({readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:10000});return value;}
async function close(value){if(value.inTransaction())await value.abortTransaction();await value.endSession();}
async function record(observation,kind){observation.stages.push({index:observation.stages.length,kind,at:new Date().toISOString(),models:await snapshot()});}

test('transactional payment claim is invisible until commit and abort leaves no operation',async({financialStrictObservation})=>{
 const args=input(),s=await session();
 try{const claim=await claimPaymentOperation(args,{session:s});expect(claim.acquired).toBe(true);expect(await Operation.countDocuments({operationKey:args.operationKey})).toBe(0);expect(await Operation.countDocuments({operationKey:args.operationKey}).session(s)).toBe(1);await s.abortTransaction();expect(await Operation.countDocuments({operationKey:args.operationKey})).toBe(0);await record(financialStrictObservation,'actual-aborted-claim-conserves-no-reservation');}finally{await close(s);}
});

test('transactional existing claims preserve conflict, pending and succeeded idempotency',async({financialStrictObservation})=>{
 const args=input(),first=await claimPaymentOperation(args),s=await session();
 try{expect((await claimPaymentOperation(args,{session:s})).inProgress).toBe(true);expect((await claimPaymentOperation({...args,fingerprint:{action:'release_partial',amount:30000}},{session:s})).conflict).toBe(true);await s.commitTransaction();}finally{await close(s);}
 await succeedPaymentOperation(first.operation,'tr_retained_claim');
 const next=await session();try{const replay=await claimPaymentOperation(args,{session:next});expect(replay.completed).toBe(true);expect(replay.operation.stripeObjectId).toBe('tr_retained_claim');await next.commitTransaction();}finally{await close(next);}
 expect(await Operation.countDocuments({operationKey:args.operationKey})).toBe(1);await record(financialStrictObservation,'actual-conflict-pending-succeeded-claim-conservation');
});

test('transactional failed and stale reclaims conserve attempts and abort rolls a reclaim back',async({financialStrictObservation})=>{
 const args=input(),first=await claimPaymentOperation(args);await failPaymentOperation(first.operation,new Error('Owned recoverable fixture failure'));
 const s=await session();try{const claim=await claimPaymentOperation(args,{session:s});expect(claim.retry).toBe(true);expect(claim.operation.attempts).toBe(2);await s.abortTransaction();}finally{await close(s);}
 expect((await Operation.findById(first.operation._id)).attempts).toBe(1);expect((await Operation.findById(first.operation._id)).status).toBe('failed');
 await Operation.updateOne({_id:first.operation._id},{$set:{status:'pending',lastAttemptAt:new Date(Date.now()-STALE_PENDING_MS-1000)}});
 const next=await session();try{const claim=await claimPaymentOperation(args,{session:next});expect(claim.retry).toBe(true);expect(claim.operation.attempts).toBe(2);await next.commitTransaction();}finally{await close(next);}
 expect((await Operation.findById(first.operation._id)).attempts).toBe(2);await record(financialStrictObservation,'actual-reclaim-rollback-and-stale-commit');
});

test('competing transactional duplicate fails safely and default concurrent claims still reserve once',async({financialStrictObservation})=>{
 const args=input(),s1=await session(),s2=await session();
 try{
  const first=await claimPaymentOperation(args,{session:s1});expect(first.acquired).toBe(true);
  // Establish the competing transaction snapshot before the winner commits.
  expect(await Operation.findOne({operationKey:args.operationKey}).session(s2)).toBeNull();
  await s1.commitTransaction();
  let failure;try{await claimPaymentOperation(args,{session:s2});}catch(error){failure=error;}
  expect(Boolean(failure)).toBe(true);expect([11000,112].includes(failure.code)||failure.hasErrorLabel?.('TransientTransactionError')).toBe(true);
 }finally{await close(s1);await close(s2);}
 expect(await Operation.countDocuments({operationKey:args.operationKey})).toBe(1);
 const other=input(),claims=await Promise.all([claimPaymentOperation(other),claimPaymentOperation(other)]);
 expect(claims.filter(row=>row.acquired)).toHaveLength(1);expect(claims.filter(row=>row.inProgress)).toHaveLength(1);expect(await Operation.countDocuments({operationKey:other.operationKey})).toBe(1);
 await record(financialStrictObservation,'actual-transaction-duplicate-and-default-once-reservation');
});
