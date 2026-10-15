const mongoose = require('mongoose');
const Case = require('../models/Case');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const MONEY = ['totalAmount','lockedTotalAmount','partialPayoutAmount','remainingAmount','feeAttorneyAmount','feeParalegalAmount'];
const SETTLEMENT = ['grossAmount','feeAttorneyAmount','feeParalegalAmount','payoutAmount','refundAmount'];
const values = {totalAmount:40000,lockedTotalAmount:42000,partialPayoutAmount:5000,remainingAmount:35000,feeAttorneyAmount:3200,feeParalegalAmount:7200,disputeSettlement:{action:'release_partial',grossAmount:5000,feeAttorneyAmount:400,feeParalegalAmount:900,payoutAmount:4100,refundAmount:100}};
function money(doc) { return { ...Object.fromEntries(MONEY.map(key=>[key,doc[key]])), disputeSettlement:Object.fromEntries(SETTLEMENT.map(key=>[key,doc.disputeSettlement?.[key]])) }; }
async function fixture() { return Case.create({title:'Projected money fixture',details:'Synthetic normalization evidence',practiceArea:'probate',attorney:new mongoose.Types.ObjectId(),status:'open',...values}); }
const raw = id => Case.collection.findOne({_id:id});
beforeAll(connect,240000);afterAll(closeDatabase);beforeEach(clearDatabase);

test('saving an unrelated projected path does not change any unloaded amount',async()=>{
 const created=await fixture(),before=money(await raw(created._id));
 const selected=await Case.findById(created._id).select('title');selected.title='Reviewed title';await selected.save({validateBeforeSave:false});
 expect(money(await raw(created._id))).toEqual(before);
});
test('projection-excluded missing amounts stay absent instead of acquiring invented zero values',async()=>{
 const created=await fixture();await Case.collection.updateOne({_id:created._id},{$unset:{totalAmount:'',feeAttorneyAmount:'',feeParalegalAmount:'','disputeSettlement.grossAmount':'','disputeSettlement.feeAttorneyAmount':'','disputeSettlement.feeParalegalAmount':'','disputeSettlement.payoutAmount':'','disputeSettlement.refundAmount':''}});
 const before=money(await raw(created._id));const selected=await Case.findById(created._id).select('title');selected.title='Metadata only';await selected.save({validateBeforeSave:false});
 expect(money(await raw(created._id))).toEqual(before);
});
test('a selected nested settlement amount normalizes without rewriting its unloaded siblings',async()=>{
 const created=await fixture(),before=money(await raw(created._id));
 const selected=await Case.findById(created._id).select('disputeSettlement.grossAmount');selected.disputeSettlement.grossAmount=5001.6;await selected.save({validateBeforeSave:false});
 before.disputeSettlement.grossAmount=5002;expect(money(await raw(created._id))).toEqual(before);
});
test('intentional assignment to a previously unselected top-level amount still normalizes',async()=>{
 const created=await fixture(),before=money(await raw(created._id));const selected=await Case.findById(created._id).select('title');selected.feeAttorneyAmount=3201.6;await selected.save({validateBeforeSave:false});
 before.feeAttorneyAmount=3202;expect(money(await raw(created._id))).toEqual(before);
});
test('intentional assignment to a previously unselected nested amount still normalizes',async()=>{
 const created=await fixture(),before=money(await raw(created._id));const selected=await Case.findById(created._id).select('title');selected.set('disputeSettlement.payoutAmount',4101.6);await selected.save({validateBeforeSave:false});
 before.disputeSettlement.payoutAmount=4102;expect(money(await raw(created._id))).toEqual(before);
});
test('new documents retain integer-cent normalization and optional null semantics',async()=>{
 const doc=new Case({title:'New money fixture',details:'Synthetic new normalization',practiceArea:'probate',attorney:new mongoose.Types.ObjectId(),status:'open',totalAmount:40000.6,feeAttorneyAmount:3200.4,feeParalegalAmount:7200.5,lockedTotalAmount:null,partialPayoutAmount:null,remainingAmount:null,disputeSettlement:{grossAmount:5000.6,feeAttorneyAmount:400.4,feeParalegalAmount:900.5,payoutAmount:4100.6,refundAmount:0}});
 await doc.save();expect(money(await raw(doc._id))).toEqual({totalAmount:40001,feeAttorneyAmount:3200,feeParalegalAmount:7201,lockedTotalAmount:null,partialPayoutAmount:null,remainingAmount:null,disputeSettlement:{grossAmount:5001,feeAttorneyAmount:400,feeParalegalAmount:901,payoutAmount:4101,refundAmount:0}});
});
test('fully loaded saves retain the established normalization of stored fractional cents',async()=>{
 const created=await fixture();const changes=Object.fromEntries(MONEY.map(key=>[key,values[key]+0.6]));for(const key of SETTLEMENT)changes[`disputeSettlement.${key}`]=values.disputeSettlement[key]+0.6;
 await Case.collection.updateOne({_id:created._id},{$set:changes});const loaded=await Case.findById(created._id);loaded.title='Ordinary full-document write';await loaded.save();
 const expected=money(values);for(const key of MONEY)expected[key]+=1;for(const key of SETTLEMENT)expected.disputeSettlement[key]+=1;expect(money(await raw(created._id))).toEqual(expected);
});
test('normal validation still rejects negative amounts and bypass-validation normalization still clamps them',async()=>{
 const created=await fixture();const selected=await Case.findById(created._id).select('title totalAmount status');selected.totalAmount=-1;await expect(selected.save()).rejects.toThrow(/totalAmount/);
 expect((await raw(created._id)).totalAmount).toBe(40000);await selected.save({validateBeforeSave:false});expect((await raw(created._id)).totalAmount).toBe(0);
});

test('full-document null settlement keeps the established zero-subtree normalization',async()=>{
 const created=await fixture();await Case.collection.updateOne({_id:created._id},{$set:{disputeSettlement:null}});
 const loaded=await Case.findById(created._id);loaded.title='Preserve absent settlement';await loaded.save();
 expect((await raw(created._id)).disputeSettlement).toEqual({grossAmount:0,feeAttorneyAmount:0,feeParalegalAmount:0,payoutAmount:0,refundAmount:0});
});

test('a projected save leaves a retained null settlement untouched',async()=>{
 const created=await fixture();await Case.collection.updateOne({_id:created._id},{$set:{disputeSettlement:null}});
 const selected=await Case.findById(created._id).select('title');selected.title='Unrelated projected title';await selected.save({validateBeforeSave:false});
 expect((await raw(created._id)).disputeSettlement).toBeNull();
});
test('intentional replacement of an unselected settlement parent normalizes its children only',async()=>{
 const created=await fixture(),before=money(await raw(created._id));const selected=await Case.findById(created._id).select('title');
 selected.set('disputeSettlement',{grossAmount:5001.6,feeAttorneyAmount:100.6});
 expect(selected.isSelected('disputeSettlement.grossAmount')).toBe(false);expect(selected.isModified('disputeSettlement.grossAmount')).toBe(true);
 await selected.save({validateBeforeSave:false});before.disputeSettlement={grossAmount:5002,feeAttorneyAmount:101,feeParalegalAmount:0,payoutAmount:0,refundAmount:0};
 expect(money(await raw(created._id))).toEqual(before);
});
