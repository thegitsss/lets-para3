// Use the shared readiness result. Never turn a review-only or unknown check into
// a requirement for the applicant, and never interpret uploaded text as policy.
const FIELD_REQUESTS = {
  first_name: 'Add your first name.', last_name: 'Add your last name.', email: 'Add your email address.',
  email_verification: 'Confirm your email using the verification link.',
  state: 'Add your state.', bar_number: 'Add your bar number.', bar_state: 'Add the state where you are admitted to the bar.',
};
const PROFILE_REQUESTS = { bio: 'Add a short professional bio.', skills: 'Add your skills.', practice_areas: 'Add your practice areas.', resume: 'Attach your current résumé to your reply.' };
function prepareApplication(user, readiness) {
  const items = [];
  if (user.status === 'pending' && !user.disabled && !user.deleted) {
    for (const reason of readiness.reasons || []) {
      if (!['missing', 'incomplete'].includes(reason.status)) continue;
      for (const field of reason.fields || []) if (FIELD_REQUESTS[field]) items.push(FIELD_REQUESTS[field]);
      if (PROFILE_REQUESTS[reason.key]) items.push(PROFILE_REQUESTS[reason.key]);
    }
  }
  const missing = [...new Set(items)];
  return {
    missing,
    summary: missing.length ? `${missing.length} saved profile ${missing.length === 1 ? 'detail needs' : 'details need'} attention. A request is prepared below for you to review.` : 'No request was prepared from the saved profile checks. Your application review is still needed.',
    requestText: missing.length ? `Hi${user.firstName ? ` ${String(user.firstName).replace(/[\r\n]/g, ' ').slice(0, 100)}` : ''},\n\nThank you for your interest in Let’s-ParaConnect. Please reply with the following information so we can continue reviewing your application:\n\n${missing.map(item => `• ${item}`).join('\n')}\n\nIf you’ve already provided this information or need help, please let us know.\n\nThank you,\nLet’s-ParaConnect` : '',
  };
}
module.exports = { prepareApplication };

async function prepareInquiry(id) {
  const Ticket = require('../models/SupportTicket');
  const ticket = await Ticket.findById(id).select('subject message latestUserMessage requesterRole status updatedAt linkedIncidentIds').lean();
  if (!ticket) throw Object.assign(new Error('This inquiry could not be found.'), { statusCode: 404 });
  const query = `${ticket.subject}\n${ticket.latestUserMessage || ticket.message}`;
  const base = { sourceRevision: ticket.updatedAt.toISOString(), checkedAt: new Date().toISOString(), text: '', sources: [] };
  if (!['open', 'in_review', 'waiting_on_user', 'waiting_on_info'].includes(ticket.status)) return { ...base, reason: 'This inquiry is closed. Reopen it before preparing another reply.' };
  if (ticket.linkedIncidentIds?.length || /\b(refund|dispute|chargeback|payout|payment|lawsuit|settlement|guarantee|compensation)\b/i.test(query)) return { ...base, reason: 'This needs a closer review of its specific records. No routine reply was prepared.' };
  const cards = await require('./knowledge/retrievalService').retrieveSupportKnowledge({ query, role: ticket.requesterRole, limit: 1 });
  const card = cards[0];
  if (!card?.answer) return { ...base, reason: 'I couldn’t find a matching approved answer. You can write a reply or use a saved response.' };
  // Confirm the request did not change while knowledge was being retrieved.
  if (!await Ticket.exists({ _id: id, updatedAt: ticket.updatedAt, subject: ticket.subject, message: ticket.message, latestUserMessage: ticket.latestUserMessage, requesterRole: ticket.requesterRole, status: ticket.status, linkedIncidentIds: ticket.linkedIncidentIds })) throw Object.assign(new Error('This inquiry changed. Refresh it before preparing a reply.'), { statusCode: 409 });
  return { ...base, text: `Thanks for reaching out.\n\n${card.answer}`.slice(0, 12000), reason: 'Prepared from an approved answer for this person’s role. Please check that it answers their question.', sources: [{ key: card.key, title: card.title }] };
}
module.exports.prepareInquiry = prepareInquiry;
