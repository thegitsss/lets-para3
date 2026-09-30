const { createHash } = require('crypto');

function triageSnapshot(ticket) {
  const assigned = ticket.assignedTo;
  return {
    assignedTo: assigned ? String(assigned._id || assigned.id || assigned) : null,
    followUpAt: ticket.followUpAt ? new Date(ticket.followUpAt).toISOString() : null,
    nextAction: ticket.nextAction || '',
    updatedAt: ticket.updatedAt ? new Date(ticket.updatedAt).toISOString() : null,
    status: ticket.status,
    latestUserMessage: ticket.latestUserMessage || '',
    message: ticket.message || '',
  };
}

function triageRevision(ticket) {
  return createHash('sha256').update(JSON.stringify(triageSnapshot(ticket))).digest('hex');
}

function triageFilter(ticket) {
  return Object.fromEntries(Object.keys(triageSnapshot(ticket)).map(key => [key, Object.hasOwn(ticket, key) ? ticket[key] : { $exists: false }]));
}

module.exports = { triageFilter, triageRevision };
