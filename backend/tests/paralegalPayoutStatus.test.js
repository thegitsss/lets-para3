const {projectReceipts} = require('../services/paralegalHistoryProjection');
const owner = '64b000000000000000000001', caseId = '64b000000000000000000101', attorney = '64b000000000000000000201';
function snapshot(changes = {}) {
  return {cases:[{_id:caseId, attorney, attorneyId:attorney, paralegal:owner, paralegalId:owner, status:'closed', currency:'usd', escrowStatus:'funded', paymentReleased:false, ...changes}], people:[{_id:owner}], payouts:[], operations:[], payoutReferences:[], transferReferences:[]};
}
function receipt(value) { return projectReceipts(value, owner, {includeCompletion:true})[0]; }
test('closed funded work with no release identifies the recorded payment issue', () => {
  expect(receipt(snapshot())).toMatchObject({payoutState:'unconfirmed', payoutReason:'payment_not_released', paymentAmount:null, receiptAvailable:false});
});
test('a missing payout record does not assert that money was never sent', () => {
  expect(receipt(snapshot({escrowStatus:null}))).toMatchObject({payoutState:'unconfirmed', payoutReason:'payout_record_missing', paymentAmount:null});
});
test('missing transfer and settlement records produce an explanation without crashing or exposing amounts', () => {
  const value = snapshot();
  const payout = {_id:'64b000000000000000000301',caseId,paralegalId:owner,operationKey:`case_payout:${caseId}`,status:'paid',amountPaid:1000};
  value.payouts = [payout];value.payoutReferences = [payout];
  expect(receipt(value)).toMatchObject({payoutState:'needs_review', payoutReason:'transfer_missing', paymentAmount:null, receiptAvailable:false});
});
