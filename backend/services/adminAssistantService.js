const User = require('../models/User');
const Preference = require('../models/AutonomyPreference');
const AuditLog = require('../models/AuditLog');
const { lockActiveAccounts } = require('../utils/activeAccountWrite');

// A server-owned allowlist. Model output, page text and client role hints cannot
// introduce an action. Enabling automation, money, sends and releases stay out.
const PAUSE_SCOPES = Object.freeze({
  support: { agentRole: 'CCO', actionType: 'support_governed_content_approval', label: 'support answers' },
  marketing: { agentRole: 'CMO', actionType: 'marketing_publish', label: 'marketing drafts' },
  outreach: { agentRole: 'CSO', actionType: 'sales_outreach', label: 'outreach drafts' },
});
function parseAdminPause(text = '') {
  const match = String(text).trim().match(/^(?:please\s+)?pause\s+(support|marketing|outreach|all)\s+(?:automatic\s+)?approvals(?:\s+please)?[.!]?$/i);
  if (match) return match[1].toLowerCase();
  return /^(?:please\s+)?pause\s+(?:all\s+)?automatic\s+messages(?:\s+please)?[.!]?$/i.test(String(text).trim()) ? 'messages' : null;
}
async function requireAdmin(user, session = null) {
  const id = user?._id || user?.id;
  if (user?.role !== 'admin' || !id || !await User.exists({ _id: id, role: 'admin', status: 'approved', disabled: { $ne: true }, deleted: { $ne: true } }).session(session)) {
    throw Object.assign(new Error('Verify your admin account before continuing.'), { statusCode: 403, code: 'ADMIN_ACCOUNT_CHANGED' });
  }
  return id;
}
async function pauseAdminApprovals({ user, text, session, requestId }) {
  const scope = parseAdminPause(text);
  if (!scope || !session?.inTransaction()) throw new Error('A supported pause request and active transaction are required.');
  const id = await requireAdmin(user, session);
  // Serialize against account changes as well as the automatic worker's writes
  // to these same preference records. The caller commits the chat receipt too.
  await lockActiveAccounts([id], session, { ownerId: id, authVersion: user.authVersion });
  const selected = scope === 'messages' ? Object.values(require('./support/automaticCorrespondence').POLICIES).map(actionType => ({agentRole:'CCO',actionType})) : scope === 'all' ? Object.values(PAUSE_SCOPES) : [PAUSE_SCOPES[scope]];
  const result = await Preference.updateMany({ mode: 'auto', $or: selected.map(({ agentRole, actionType }) => ({ agentRole, actionType })) }, {
    $set: { mode: 'manual', lastPromptedAt: new Date() }, $inc: { executionRevision: 1, ...(scope === 'messages' ? {outboundConfigurationRevision:1} : {}) },
  }, { session });
  await AuditLog.create([{ actor: id, actorRole: 'admin', action: scope === 'messages' ? 'admin.assistant.correspondence_paused' : 'admin.assistant.approvals_paused', targetType: 'other', targetId: scope,
    meta: { requestId, changed: result.modifiedCount, categories: selected.map(row => row.actionType) },
  }], { session });
  if (scope === 'messages') return {scope,changed:result.modifiedCount,reply:result.modifiedCount?'Automatic messages are paused. A message already underway may still finish.':'Automatic messages are already off.'};
  const label = scope === 'all' ? 'support answers, marketing drafts and outreach drafts' : PAUSE_SCOPES[scope].label;
  return { scope, changed: result.modifiedCount, reply: result.modifiedCount
    ? `Automatic approval is paused for ${label}. An action already underway may still finish.`
    : `Automatic approval is already off for ${label}.` };
}
function isAdminAutomationQuestion(text = '') {
  return /^(?:please\s+)?(?:what (?:is (?:the )?(?:ai|assistant|automation) doing|has (?:the )?(?:ai|assistant|automation) (?:done|handled))|(?:is|are) (?:the )?(?:automation|background work|background services) (?:running|working)|show (?:me )?(?:automation|background) status)(?:\s+(?:today|now|right now))?[?.!]*$/i.test(String(text).trim());
}
async function readAdminAutomation({ text, user }) {
  if (!isAdminAutomationQuestion(text)) return null;
  await requireAdmin(user);
  try {
    const data = await require('./adminActivityService').readAdminActivity();
    const parts = [data.automation?.message || 'I couldn’t check the background service.'];
    if (data.mailbox?.workerHealth?.ok !== true) parts.push(data.mailbox?.workerHealth?.message || 'I couldn’t verify the message service. Open System to check it.');
    if (data.policies) {
      const automatic = data.policies.filter(row => row.mode === 'auto').map(row => row.label.toLowerCase());
      parts.push(automatic.length ? `Automatic approval: ${automatic.join(', ')}. Approval does not send or publish anything.` : 'Draft approvals currently need your review.');
    }
    if (data.correspondence) {
      const automatic = data.correspondence.policies.filter(row => row.mode === 'auto').map(row => row.label.toLowerCase());
      parts.push(automatic.length ? `Automatic messages enabled: ${automatic.join(', ')}. Delivery still depends on current eligibility and the message worker.` : 'Automatic messages are off.');
      const counts = data.correspondence.counts || {};
      if (counts.accepted) parts.push(`${counts.accepted} automatic message attempts accepted by the mail provider; inbox receipt is not confirmed.`);
      if (counts.failed || counts.unknown) parts.push(`${(counts.failed || 0) + (counts.unknown || 0)} automatic message attempts need delivery review in System.`);
    }
    if (/\bhas\b/i.test(text) && data.activity) {
      const recent = data.activity.slice(0, 3);
      parts.push(recent.length ? `Recent records: ${recent.map(row => `${row.label} (${row.status})`).join('; ')}.` : 'No automation actions were recorded in the last seven days.');
    }
    if (data.recovery?.blocked) parts.push(`${data.recovery.blocked} recorded decisions need technical follow-up.`);
    if (data.unavailable?.length) parts.push('Some checks are unavailable. Open System for details.');
    return { reply: parts.join(' '), available: !data.unavailable?.length && Boolean(data.automation), checkedAt: data.checkedAt,
      automation: data.automation, policies: data.policies, recovery: data.recovery, correspondence: data.correspondence };
  } catch (_) {
    return { reply: 'I couldn’t check background work just now. Open System to try again.', available: false };
  }
}
module.exports = { parseAdminPause, pauseAdminApprovals, readAdminAutomation };
