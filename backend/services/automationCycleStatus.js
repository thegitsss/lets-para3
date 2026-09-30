const { randomUUID } = require('node:crypto');
const State = require('../models/AutomationCycleState');
const TASK_LABELS = {
  automationControl: 'Automation settings', governedApprovals: 'Automatic approvals', monitoringReport: 'Service monitoring',
  timedTriggers: 'Scheduled reminders', marketingResearch: 'Marketing research', marketingCleanup: 'Marketing record cleanup',
  marketingPublishing: 'Marketing preparation', directorFollowUps: 'Director follow-ups', directorMailImport: 'Director mailbox sync',
  founderDailyPrep: 'Daily summary', expiredWithdrawals: 'Withdrawal reviews', overdueDisputes: 'Overdue dispute follow-ups',
  casePurge: 'Matter retention', personalStorageDeletion: 'Personal file removal', matterStorageRetirement: 'Matter file retention',
  cycle: 'Scheduled work',
};

// Execution evidence only. This record neither schedules work nor grants authority.
async function recordAutomationCycle(operation, { now = new Date() } = {}) {
  const runId = randomUUID();
  await State.updateOne({ _id: 'scheduled' }, { $set: { runId, status: 'running', startedAt: now, finishedAt: null, failedTasks: [] } }, { upsert: true });
  try {
    const result = await operation();
    await State.updateOne({ _id: 'scheduled', runId }, { $set: {
      status: !result.ok ? 'failed' : result.paused ? 'paused' : 'completed',
      finishedAt: new Date(), failedTasks: (result.failures || []).map(row => String(row.name).slice(0, 100)).slice(0, 50),
    } });
    return result;
  } catch (error) {
    await State.updateOne({ _id: 'scheduled', runId }, { $set: { status: 'failed', finishedAt: new Date(), failedTasks: ['cycle'] } });
    throw error;
  }
}

async function readAutomationCycleStatus({ now = new Date() } = {}) {
  const state = await State.findById('scheduled').lean();
  if (!state) return { status: 'unknown', message: 'No scheduled automation run has been recorded.', startedAt: null, finishedAt: null };
  const at = state.finishedAt || state.startedAt;
  const age = now.getTime() - new Date(at).getTime();
  const stale = !Number.isFinite(age) || age < -60000 || age > 15 * 60000;
  const status = stale ? 'stale' : state.status;
  const message = {
    stale: 'No recent scheduled automation check-in. Automatic approvals may not be running.',
    running: 'Scheduled automation is running. Completion has not been confirmed.',
    completed: 'The latest scheduled automation run completed.',
    paused: 'Scheduled automation is paused for maintenance.',
    failed: `The latest scheduled automation run needs attention. Needs review: ${[...new Set(state.failedTasks.map(name => TASK_LABELS[name] || 'Scheduled work'))].slice(0, 5).join(', ') || 'Scheduled work'}.`,
  }[status];
  return { status, message, startedAt: state.startedAt, finishedAt: state.finishedAt, failedTasks: state.failedTasks };
}

module.exports = { recordAutomationCycle, readAutomationCycleStatus };
