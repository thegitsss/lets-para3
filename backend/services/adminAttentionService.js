const User = require('../models/User');
const { nextAdminTask } = require('./adminFlowService');

const isAttentionQuestion = text => /^(?:please\s+)?(?:what\s+(?:actually\s+)?needs\s+(?:me|my attention|attention)|what\s+should\s+i\s+(?:review|check|do)|what(?:['’]s| is)\s+next|show\s+(?:me\s+)?(?:my\s+|the\s+)?(?:daily\s+)?(?:work|review|attention)\s+queue)(?:\s+(?:today|right now|now|next|first))?[?.!]*$/i.test(String(text || '').trim());

async function readAdminAttention({ text, user = {} }) {
  if (user.role !== 'admin' || !isAttentionQuestion(text)) return null;
  // Recheck the account; page context and role hints never grant admin access.
  const id = user._id || user.id;
  if (!id || !await User.exists({ _id: id, role: 'admin', status: 'approved', disabled: { $ne: true }, deleted: { $ne: true } })) return null;
  try {
    const queue = await nextAdminTask({ owner: id });
    const count = queue.remaining;
    const parts = [count ? `You have ${count} ${count === 1 ? 'item' : 'items'} ready for review.` : 'No items need review in your checked queues right now.'];
    if (queue.task) parts.push(`Start with “${queue.task.name}.” ${queue.task.reason}`);
    if (queue.deferred) parts.push(`${queue.deferred} ${queue.deferred === 1 ? 'item is' : 'items are'} set for later.`);
    if (queue.waiting) parts.push(`Waiting for ${queue.waiting} ${queue.waiting === 1 ? 'applicant to reply' : 'applicants to reply'}.`);
    parts.push(`Checked: ${queue.scope.toLowerCase()}.`);
    return { reply: parts.join(' '), available: true, checkedAt: queue.checkedAt, counts: queue.counts, remaining: count, deferred: queue.deferred, waiting: queue.waiting, nextKey: queue.task?.key || null, scope: queue.scope };
  } catch (_) {
    return { reply: 'I couldn’t check your work queue just now. Please try again before assuming everything is up to date.', available: false };
  }
}

module.exports = { readAdminAttention, isAttentionQuestion };
