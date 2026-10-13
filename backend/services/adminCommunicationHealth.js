const State = require('../models/AdminMailboxState');
const { releaseCommit } = require('../utils/releaseIdentity');

async function checkAdminCommunicationHealth({ now = new Date(), env = process.env } = {}) {
  try {
    const worker = await State.findById('communications-worker').select('lastWorkerAt lastWorkerCommit lastCycleOk lastCompletedCycleAt').lean();
    const age = now.getTime() - new Date(worker?.lastWorkerAt || 0).getTime();
    if (!worker || !Number.isFinite(age) || age < -60000 || age > 300000) {
      return { ok: false, code: 'communications_worker_stopped', message: 'The communication worker has no recent check-in. Application alerts, Matter notices, and support intake need attention.' };
    }
    const expected = releaseCommit(env);
    if (!expected || worker.lastWorkerCommit !== expected) {
      return { ok: false, code: 'communications_worker_release_mismatch', message: 'The communication worker cannot be verified against this release. Check its deployed version.' };
    }
    if (worker.lastCycleOk !== true || !worker.lastCompletedCycleAt) {
      return { ok: false, code: 'communications_worker_cycle_failed', message: 'The communication worker has not completed a successful cycle. Check delivery and mailbox status.' };
    }
    const completedAge = now.getTime() - new Date(worker.lastCompletedCycleAt).getTime();
    if (!Number.isFinite(completedAge) || completedAge < -60000 || completedAge > 300000) {
      return { ok: false, code: 'communications_worker_stalled', message: 'The communication worker is checking in but has not finished a recent cycle.' };
    }
    return { ok: true, code: 'communications_worker_ok', message: 'The communication worker is current and completed its latest cycle.' };
  } catch (_) {
    return { ok: false, code: 'communications_worker_check_failed', message: 'The communication worker status could not be checked.' };
  }
}

module.exports = { checkAdminCommunicationHealth };
