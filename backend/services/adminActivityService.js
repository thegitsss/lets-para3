const Ticket = require('../models/SupportTicket');
const Action = require('../models/AutonomousAction');
const Preference = require('../models/AutonomyPreference');
const { mailboxStatus } = require('./support/mailboxSyncService');
const { readAutomationCycleStatus } = require('./automationCycleStatus');

const POLICY_LABELS = [
  ['CCO', 'support_governed_content_approval', 'Support answers', 'Approves eligible knowledge answers. This setting does not send replies.'],
  ['CMO', 'marketing_publish', 'Marketing drafts', 'Approves eligible drafts. Publishing is a separate step.'],
  ['CSO', 'sales_outreach', 'Outreach drafts', 'Approves eligible drafts. Sending is a separate step.'],
  ['CTO', 'incident_approval', 'Production release approvals', 'Production releases require your decision. Routine automation cannot approve them.'],
];
const ACTION_LABELS = {
  ticket_reopened: 'Inquiry reopened for review', ticket_escalated: 'Inquiry escalated for review',
  incident_routed_from_support: 'Technical issue recorded', faq_candidate_created: 'Support answer drafted',
  support_insight_created: 'Support improvement recorded', ticket_resolved: 'Inquiry marked resolved',
  support_governed_content_auto_approved: 'Support answer approved', marketing_publish_auto_approved: 'Marketing draft approved',
  sales_outreach_auto_approved: 'Outreach draft approved', incident_approval_auto_approved: 'Release approval recorded',
};

function projectPolicy([role, actionType, label, description], preferences, now) {
  const policy = preferences.find(row => row.agentRole === role && row.actionType === actionType);
  const mode = role === 'CTO' ? 'manual' : policy?.mode || 'manual';
  if (mode === 'auto') {
    const used = policy.executionDay === now.toISOString().slice(0, 10) ? policy.dailyAttempts || 0 : 0;
    description += ` ${used} of ${policy.dailyAttemptLimit || 25} automatic approval attempts used today (UTC).`;
  }
  return { role, actionType, label, description, mode };
}

// Read persisted evidence only. Looking at Today must never run automation or send mail.
async function readAdminActivity({ now = new Date() } = {}) {
  const since = new Date(now.getTime() - 7 * 86400000);
  const waitingForReply = {
    status: { $in: ['waiting_on_user', 'waiting_on_info'] },
    $expr: { $not: [{ $in: [{ $ifNull: [{ $arrayElemAt: ['$emailReplies.delivery', -1] }, ''] }, ['unknown', 'disabled', 'pending']] }] },
  };
  const results = await Promise.allSettled([
    Promise.all([
      Ticket.countDocuments(waitingForReply),
      Ticket.find({ ...waitingForReply, followUpAt: { $gt: now } }).select('subject followUpAt').sort({ followUpAt: 1, _id: 1 }).limit(5).lean(),
    ]),
    Action.find({ createdAt: { $gte: since } }).select('actionType targetModel targetId status createdAt').sort({ createdAt: -1, _id: -1 }).limit(20).lean(),
    Preference.find({}).select('agentRole actionType mode dailyAttemptLimit executionDay dailyAttempts').lean(),
    mailboxStatus(),
    readAutomationCycleStatus({ now }),
  ]);
  const [waiting, handled, policies, mailbox, automation] = results;
  return {
    checkedAt: now.toISOString(), since: since.toISOString(),
    unavailable: results.map((result, index) => result.status === 'rejected' ? ['waiting', 'activity', 'policies', 'mailbox', 'automation'][index] : null).filter(Boolean),
    automation: automation.status === 'fulfilled' ? automation.value : null,
    waiting: waiting.status === 'fulfilled' ? { count: waiting.value[0], upcoming: waiting.value[1].map(row => ({ id: String(row._id), subject: row.subject, followUpAt: row.followUpAt })) } : null,
    // "Recorded" is intentional: later edits can change a target after the logged action.
    activity: handled.status === 'fulfilled' ? handled.value.map(row => ({ id: String(row._id), label: ACTION_LABELS[row.actionType] || 'Automation action recorded', status: row.status, createdAt: row.createdAt, section: row.targetModel === 'SupportTicket' ? 'support-ops' : row.targetModel === 'Incident' || row.targetModel === 'IncidentApproval' ? 'engineering' : 'approvals-workspace' })) : null,
    policies: policies.status === 'fulfilled' ? POLICY_LABELS.map(definition => projectPolicy(definition, policies.value, now)) : null,
    mailbox: mailbox.status === 'fulfilled' ? { configured: mailbox.value.configured, lastWorkerAt: mailbox.value.lastWorkerAt, lastCompletedAt: mailbox.value.lastCompletedAt, error: mailbox.value.error, backlog: mailbox.value.backlog } : null,
  };
}
module.exports = { readAdminActivity };
