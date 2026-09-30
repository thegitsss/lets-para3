const path = require('path');
if (require.main === module) require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const State = require('../models/AdminMailboxState');
const { reconcileAlerts, processAlerts } = require('../services/adminAlertService');
const { processNotices } = require('../services/matterFileNotifications');
const { processNotices: processWorkNotices } = require('../services/matterWorkNotifications');
const { processNotices: processPaymentNotices } = require('../services/matterPaymentNotifications');
const { processNotices: processWithdrawalNotices } = require('../services/matterWithdrawalNotifications');
const { processNotices: processApplicationNotices } = require('../services/matterApplicationNotifications');
const { processNotices: processInvitationNotices } = require('../services/matterInvitationNotifications');
const { processNotices: processPostingNotices } = require('../services/matterPostingNotifications');
const { processNotices: processPreEngagementNotices } = require('../services/matterPreEngagementNotifications');
const { processNotices: processReviewNotices } = require('../services/matterReviewNotifications');
const { syncMailbox } = require('../services/support/mailboxSyncService');
const { createLogger } = require('../utils/logger');
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require('../utils/mongooseOperationPolicy');
const { assertAdminCommunicationsConfiguration } = require('../utils/workerProductionConfig');
const { ensureCommunicationIndexes } = require('./admin-communications-indexes');
const logger = createLogger('admin-communications-worker');

async function runOnce({ shouldStop = () => false, mailboxOptions = {} } = {}) {
  let lastHeartbeat = 0;
  const heartbeat = async (force = false) => {
    if (!force && Date.now() - lastHeartbeat < 15000) return;
    await State.updateOne({ _id: 'communications-worker' }, { $set: { lastWorkerAt: new Date() } }, { upsert: true });
    lastHeartbeat = Date.now();
  };
  const workOptions = { shouldStop, onProgress: heartbeat };
  await heartbeat(true);
  let fileNotices;
  try { fileNotices = { processed: await processNotices(workOptions) }; }
  catch (_) {
    fileNotices = { failed: true };
    logger.warn('File notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let workNotices;
  try { workNotices = { processed: await processWorkNotices(workOptions) }; }
  catch (_) {
    workNotices = { failed: true };
    logger.warn('Work notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let paymentNotices;
  try { paymentNotices = { processed: await processPaymentNotices(workOptions) }; }
  catch (_) {
    paymentNotices = { failed: true };
    logger.warn('Payment notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let withdrawalNotices;
  try { withdrawalNotices = { processed: await processWithdrawalNotices(workOptions) }; }
  catch (_) {
    withdrawalNotices = { failed: true };
    logger.warn('Withdrawal notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let reviewNotices;
  try { reviewNotices = { processed: await processReviewNotices(workOptions) }; }
  catch (_) {
    reviewNotices = { failed: true };
    logger.warn('Review notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let applicationNotices;
  try { applicationNotices = { processed: await processApplicationNotices(workOptions) }; }
  catch (_) {
    applicationNotices = { failed: true };
    logger.warn('Application notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let invitationNotices;
  try { invitationNotices = { processed: await processInvitationNotices(workOptions) }; }
  catch (_) {
    invitationNotices = { failed: true };
    logger.warn('Invitation notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let preEngagementNotices;
  try { preEngagementNotices = { processed: await processPreEngagementNotices(workOptions) }; }
  catch (_) {
    preEngagementNotices = { failed: true };
    logger.warn('Pre-engagement notification delivery needs another cycle; saved notices remain reviewable.');
  }
  let postingNotices;
  try { postingNotices = { processed: await processPostingNotices(workOptions) }; }
  catch (_) {
    postingNotices = { failed: true };
    logger.warn('Posting notification delivery needs another cycle; saved notices remain reviewable.');
  }
  await reconcileAlerts(workOptions);
  if (shouldStop()) return { ok: true, paused: true };
  const alertsBefore = await processAlerts(workOptions);
  if (shouldStop()) return { ok: true, paused: true, alertsBefore };
  let mailbox;
  try {
    mailbox = await syncMailbox({ ...mailboxOptions, ...workOptions });
  } catch (_) {
    mailbox = { failed: true };
    logger.warn('Support mailbox sync unavailable; the next cycle will retry.');
  }
  const alertsAfter = shouldStop() ? 0 : await processAlerts(workOptions);
  await heartbeat(true);
  return { ok: !mailbox.failed && !fileNotices.failed && !workNotices.failed && !paymentNotices.failed && !withdrawalNotices.failed && !reviewNotices.failed && !applicationNotices.failed && !invitationNotices.failed && !preEngagementNotices.failed && !postingNotices.failed, paused: shouldStop(), mailbox, fileNotices, workNotices, paymentNotices, withdrawalNotices, reviewNotices, applicationNotices, invitationNotices, preEngagementNotices, postingNotices, alertsBefore, alertsAfter };
}

async function main() {
  assertAdminCommunicationsConfiguration();
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await mongoose.connect(requireMongoUri(process.env.MONGO_URI), { ...MONGO_OPERATION_OPTIONS, autoCreate: false });
    await ensureCommunicationIndexes();
    while (!stopping) {
      let ok = false;
      try { ok = (await runOnce({ shouldStop: () => stopping })).ok; }
      catch (_) { logger.error('Admin communication cycle failed; persisted work will be retried.'); }
      if (process.argv.includes('--once')) { if (!ok) process.exitCode = 1; break; }
      if (stopping) break;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 60000);
        wake = () => { clearTimeout(timer); resolve(); };
        if (stopping) wake();
      });
      wake = null;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    require('../utils/email').transporter?.close();
    await mongoose.disconnect();
  }
}
if (require.main === module) main().catch(error => {
  // Only configuration errors are safe to print; provider/connection errors can contain secrets.
  logger.error(String(error.message || '').startsWith('[config]') ? error.message : 'Admin communications worker could not start. Check database and index configuration.');
  process.exitCode = 1;
});
module.exports = { runOnce, main };
