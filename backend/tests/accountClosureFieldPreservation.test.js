const User = require('../models/User');
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const service = process.env.LPC_CLOSURE_ORIGINAL_CHARACTERIZATION === '1'
  ? require('../services/userDeletionOriginalFixture') : require('../services/userDeletion');
const at = new Date('2026-09-01T12:00:00Z');
const financial = {
  currency: 'usd', totalAmount: 40000, lockedTotalAmount: 42000, amountLockedAt: at,
  partialPayoutAmount: 5000, remainingAmount: 35000,
  feeAttorneyPct: 8, feeParalegalPct: 18, feeAttorneyAmount: 3200, feeParalegalAmount: 7200,
  escrowIntentId: 'pi_synthetic_historical', escrowSessionId: 'cs_synthetic_historical',
  paymentIntentId: 'pi_synthetic_historical', stripeMode: 'test',
  fundingIntegrityStatus: 'verified', fundingIntegrityFailure: '', fundingVerifiedAt: at,
  payoutStatus: 'paid', payoutFailureReason: '', payoutTransferId: 'tr_synthetic_historical',
  fundingRequestKey: '', fundingRequestFingerprint: 'synthetic-retained-pricing-fingerprint',
  disputeSettlement: { action: 'release_partial', grossAmount: 5000, feeAttorneyAmount: 400,
    feeParalegalAmount: 900, feeAttorneyPct: 8, feeParalegalPct: 18, payoutAmount: 4100,
    refundAmount: 0, transferId: 'tr_synthetic_previous', refundId: '', resolvedAt: at, disputeId: 'synthetic-resolved' },
};
const expectedChanges = new Set(['__v', 'updatedAt', 'applicants', 'invites', 'pendingParalegalId', 'pendingParalegalInvitedAt', 'paralegal', 'paralegalId', 'paralegalNameSnapshot', 'hiredAt', 'tasksLocked']);
const unchanged = (doc, role) => Object.fromEntries(Object.entries(doc).filter(([key]) => !expectedChanges.has(key) && !(role === 'attorney' && ['status', 'archived', 'escrowStatus', 'paymentStatus'].includes(key))));
async function createUser(role, name) { return User.create({firstName: name,lastName:'Fixture',email:`${name}@closure-money.example.test`,password:'Synthetic closure retained fields passphrase',role,status:'approved',state:'CA',emailVerified:true}); }
beforeAll(connect, 240000); afterAll(closeDatabase); beforeEach(clearDatabase);
for (const role of ['attorney', 'paralegal']) {
  for (const alias of ['both', 'canonical', 'legacy']) {
    test(`${role} ${alias} participation preserves all stored financial and unrelated Case fields`, async () => {
      const employer = await createUser('attorney', 'employer'), reporter = await createUser('paralegal', 'reporter'), other = await createUser('paralegal', 'other');
      const selected = alias === 'legacy', status = alias === 'canonical' ? 'submitted' : 'accepted';
      const matter = await Case.create({ title:'Retained pricing posting', details:'Review exhibits.', practiceArea:'probate', attorney:employer._id,attorneyId:employer._id,
        paralegal:selected?reporter._id:null,paralegalId:selected?reporter._id:null,pendingParalegalId:reporter._id,
        status:'open',escrowStatus:'awaiting_funding',paymentStatus:'pending',paymentReleased:false,
        applicants:[{paralegalId:reporter._id,status:status==='accepted'?'accepted':'pending',note:'Keep submitted note',resumeURL:'paralegal/resumes/synthetic-retained.pdf'},{paralegalId:other._id,status:'pending',note:'Another applicant'}],
        invites:[{paralegalId:reporter._id,status:status==='accepted'?'accepted':'pending'}], ...financial });
      const job = await Job.create({attorneyId:employer._id,caseId:matter._id,title:matter.title,description:matter.details,practiceArea:'probate',budget:400,status:'open',applicantsCount:2});
      const application = await Application.create({jobId:job._id,paralegalId:reporter._id,status,coverLetter:'Keep the original application',resumeURL:'paralegal/resumes/synthetic-retained.pdf'});
      const otherApplication = await Application.create({jobId:job._id,paralegalId:other._id,status:'submitted',coverLetter:'Retain another applicant'});
      // Characterize retained alias-only records without Mongoose normalizing them back to both fields.
      if(alias==='canonical') await Case.collection.updateOne({_id:matter._id},{$unset:{attorney:'',paralegal:''}});
      if(alias==='legacy') await Case.collection.updateOne({_id:matter._id},{$unset:{attorneyId:'',paralegalId:''}});
      await Case.collection.updateOne({_id:matter._id},{$set:{retainedPricingEvidence:{version:1,gross:42000,feeSchedule:'historical-synthetic'},retainedUnrelatedValue:'Do not rewrite'}});
      const before=await Case.collection.findOne({_id:matter._id});
      expect(before.totalAmount).toBe(40000);expect(before.feeAttorneyAmount).toBe(3200);expect(before.feeParalegalAmount).toBe(7200);
      const owner=role==='attorney'?employer:reporter;
      expect((await service.getAccountDeactivationEligibility(owner._id)).canDeactivate).toBe(true);
      const result=await service.deactivateUserAccount(owner._id);
      expect(result).toMatchObject({userId:owner._id,role});
      expect((await User.findById(owner._id)).disabled).toBe(true);
      const after=await Case.collection.findOne({_id:matter._id});
      console.log(JSON.stringify({role,alias,before:{totalAmount:before.totalAmount,feeAttorneyAmount:before.feeAttorneyAmount,feeParalegalAmount:before.feeParalegalAmount,disputeSettlement:before.disputeSettlement},after:{totalAmount:after.totalAmount,feeAttorneyAmount:after.feeAttorneyAmount,feeParalegalAmount:after.feeParalegalAmount,disputeSettlement:after.disputeSettlement}}));
      expect(unchanged(after,role)).toEqual(unchanged(before,role));
      for(const field of Object.keys(financial)) expect(after[field]).toEqual(before[field]);
      expect(after.applicants[0]).toMatchObject({status:'rejected',note:before.applicants[0].note,resumeURL:before.applicants[0].resumeURL});
      expect(after.invites[0].status).toBe('expired');
      expect(after.status).toBe(role==='attorney'?'closed':'open');expect((await Job.findById(job._id)).status).toBe(role==='attorney'?'closed':'open');
      expect((await Application.findById(application._id)).status).toBe(role==='attorney'?status:'rejected');
      expect((await Application.findById(otherApplication._id)).status).toBe('submitted');
      expect((await User.findById(role==='attorney'?reporter._id:employer._id)).disabled).toBe(false);
    });
  }
}
