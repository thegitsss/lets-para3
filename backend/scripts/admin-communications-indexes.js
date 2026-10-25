const path = require('path');
if (require.main === module) require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require('../utils/mongooseOperationPolicy');

// Existing production indexes may have operator-assigned names. Reuse an
// equivalent index name; MongoDB rejects identical definitions under a new name.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function equivalentIndex(existing, keys, options) {
  if (JSON.stringify(existing.key) !== JSON.stringify(keys)) return false;
  if (['unique', 'sparse', 'hidden'].some(key => Boolean(existing[key]) !== Boolean(options[key]))) return false;
  return ['partialFilterExpression', 'expireAfterSeconds', 'collation', 'wildcardProjection', 'weights', 'default_language', 'language_override'].every(key =>
    JSON.stringify(canonical(existing[key] ?? null)) === JSON.stringify(canonical(options[key] ?? null)));
}
async function ensureModelIndexes(Model) {
  let existing;
  try { existing = await Model.collection.indexes(); }
  catch (error) { if (error.code !== 26) throw error; existing = []; }
  for (const [keys, options] of Model.schema.indexes()) {
    const retained = existing.find(index => equivalentIndex(index, keys, options));
    await Model.collection.createIndex(keys, retained ? { ...options, name: retained.name } : options);
  }
}

async function ensureReviewNoticeIndexes() {
  const Notice = require('../models/MatterReviewNotification');
  // Missing kind is the original opening event. Normalize before creating the
  // expanded unique key, and retain every delivery state and receipt.
  await Notice.updateMany({ kind: { $exists: false } }, { $set: { kind: 'opened' } });
  await ensureModelIndexes(Notice);
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
  for (const name of ['AdmissionDecisionNotification', 'SignupReviewNotification', 'AutonomyPreference', 'SupportTicket', 'KnowledgeItem', 'KnowledgeRevision', 'KnowledgeCollection', 'OpsMonitorState', 'Message', 'MatterMessageNotification', 'AdminCommunicationAlert', 'AdminMailboxState', 'AdminInboundMail', 'AdminDraft', 'SupportMessage', 'MatterFileNotification', 'MatterWorkNotification', 'MatterPaymentNotification', 'MatterWithdrawalNotification', 'MatterApplicationNotification', 'MatterInvitationNotification', 'MatterPreEngagementNotification', 'MatterPostingNotification']) {
    await ensureModelIndexes(require(`../models/${name}`));
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
module.exports = { ensureCommunicationIndexes, ensureReviewNoticeIndexes, ensureModelIndexes, equivalentIndex };
