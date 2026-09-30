const path = require('path');
if (require.main === module) require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require('../utils/mongooseOperationPolicy');

async function ensureReviewNoticeIndexes() {
  const Notice = require('../models/MatterReviewNotification');
  // Missing kind is the original opening event. Normalize before creating the
  // expanded unique key, and retain every delivery state and receipt.
  await Notice.updateMany({ kind: { $exists: false } }, { $set: { kind: 'opened' } });
  await Notice.createIndexes();
  const indexes = await Notice.collection.indexes();
  const legacy = indexes.find(index => index.unique && JSON.stringify(index.key) === JSON.stringify({ caseId: 1, disputeId: 1, userId: 1 }));
  if (legacy) {
    try { await Notice.collection.dropIndex(legacy.name); }
    catch (error) { if (error.code !== 27) throw error; }
  }
  await require('../services/matterReviewNotifications').ready();
}
async function ensureCommunicationIndexes() {
  // Create required indexes; only the named legacy review key is replaced below.
  // Duplicate existing records fail this release step instead of silently losing deduplication.
  for (const name of ['AdminCommunicationAlert', 'AdminMailboxState', 'AdminInboundMail', 'AdminDraft', 'SupportMessage', 'MatterFileNotification', 'MatterWorkNotification', 'MatterPaymentNotification', 'MatterWithdrawalNotification', 'MatterApplicationNotification', 'MatterInvitationNotification', 'MatterPreEngagementNotification', 'MatterPostingNotification']) {
    await require(`../models/${name}`).createIndexes();
  }
  await ensureReviewNoticeIndexes();
}
async function main() {
  try {
    await mongoose.connect(requireMongoUri(process.env.MONGO_URI), { ...MONGO_OPERATION_OPTIONS, autoCreate: false });
    await ensureCommunicationIndexes();
    console.log('[admin-communications] Required indexes are ready.');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => {
  console.error('[admin-communications] Index preparation failed. Review database connectivity and duplicate records before release.');
  process.exitCode = 1;
});
module.exports = { ensureCommunicationIndexes, ensureReviewNoticeIndexes };
