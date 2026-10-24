const { createHash } = require('crypto');
const Notice = require('../models/AdmissionDecisionNotification');
const User = require('../models/User');
const accountEmails = require('../email/accountTemplates');
const { createEmailVerificationLink } = require('../utils/emailVerification');
const { revision } = require('./communicationRetry');
const emailHash = value => createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');

async function stage(user, decision, session) {
  if (!session?.inTransaction()) throw new Error('Admission mail requires the account decision transaction.');
  await Notice.updateOne({ userId: user._id, auditIndex: user.audit.length }, {
    $setOnInsert: { decision, emailHash: emailHash(user.email) },
  }, { upsert: true, session });
}
async function prepare(notice) {
  const user = await User.findById(notice.userId).select('email emailVerified firstName lastName role status audit disabled deleted suspended').lean();
  if (!user || user.disabled || user.deleted || user.suspended || user.status !== notice.decision ||
      !['attorney', 'paralegal'].includes(user.role) || emailHash(user.email) !== notice.emailHash ||
      user.audit?.[notice.auditIndex - 1]?.action !== notice.decision ||
      user.audit.slice(notice.auditIndex).some(entry => ['approved', 'denied'].includes(entry.action))) return null;
  const loginUrl = `${(process.env.EMAIL_BASE_URL || 'https://www.lets-paraconnect.com').replace(/\/$/, '')}/login.html`;
  const verificationUrl = notice.decision === 'approved' && user.emailVerified === false
    ? await createEmailVerificationLink({ user, email: user.email }) : undefined;
  return { to: user.email, ...(notice.decision === 'approved'
    ? accountEmails.applicationApproved(user, loginUrl, verificationUrl) : accountEmails.applicationDenied(user)) };
}
const delivery = require('./emailNoticeDelivery').createEmailNoticeDelivery({ Notice, prepare, prefix: 'admission-decision' });
async function sendForDecision(user) {
  const notice = await Notice.findOne({ userId: user._id, auditIndex: user.audit.length }).lean();
  if (!notice) throw new Error('The committed admission mail notice is missing.');
  // A route may deliver only its own notice; it must not drain other applicants' mail.
  await delivery.processNotices({ noticeId: notice._id, limit: 1 });
  const saved = await Notice.findById(notice._id).select('status').lean();
  return saved?.status === 'accepted' ? 'accepted' : saved?.status === 'disabled' ? 'disabled' : 'unconfirmed';
}
async function noticeStatus() {
  const [counts, recent] = await Promise.all([
    Notice.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Notice.find({ $or: [{ status: { $in: ['unknown', 'disabled'] } }, { status: 'failed', attempts: { $gte: 5 } }] })
      .sort({ updatedAt: -1, _id: -1 }).limit(10).select('userId decision status attempts failure updatedAt claim').lean(),
  ]);
  return { counts: Object.fromEntries(counts.map(row => [row._id, row.count])),
    recent: recent.map(({ claim, ...record }) => ({ ...record, revision: revision({ ...record, claim }) })) };
}
module.exports = { stage, prepare, sendForDecision, processNotices: delivery.processNotices, noticeStatus };
