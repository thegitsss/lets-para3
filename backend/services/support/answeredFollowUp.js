const WAITING = ['waiting_on_user', 'waiting_on_info'];

// A reply satisfies a reminder to hear from the requester. Preserve unrelated
// work and any owner schedule made after the message was received.
function cancelsFollowUp(ticket, receivedAt) {
  const received = new Date(receivedAt).getTime();
  const reviewed = ticket?.updatedAt ? new Date(ticket.updatedAt).getTime() : NaN;
  return Boolean(ticket?.followUpAt && WAITING.includes(ticket.status) &&
    Number.isFinite(received) && Number.isFinite(reviewed) && reviewed <= received);
}

// Evaluate against the saved record in the same atomic update that reopens it.
function followUpAfterMail(receivedAt) {
  return { $cond: [
    { $and: [
      { $in: ['$status', WAITING] },
      { $eq: [{ $type: '$updatedAt' }, 'date'] },
      { $lte: ['$updatedAt', receivedAt] },
    ] },
    null,
    { $ifNull: ['$followUpAt', null] },
  ] };
}

module.exports = { cancelsFollowUp, followUpAfterMail };
