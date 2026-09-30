const referenceId = value => String(value?._id || value || '').toLowerCase();

// Compare logical identities without rewriting retained BSON fields. A failed
// Mongoose cast is an unreadable recorded alias, not an absent legacy alias.
function participantPair(doc, role, viewerId) {
  const fields = [role, `${role}Id`];
  const ids = fields.map(field => referenceId(doc[field]));
  const unreadable = fields.some((field, index) => doc.$errors?.[field] || ids[index] && !/^[a-f0-9]{24}$/.test(ids[index]));
  return {
    matches: !!viewerId && ids.includes(viewerId),
    conflict: !!unreadable || !!(ids[0] && ids[1] && ids[0] !== ids[1]),
  };
}

function caseParticipantIdentity(doc, userId) {
  const viewerId = referenceId(userId);
  const attorney = participantPair(doc, 'attorney', viewerId);
  const paralegal = participantPair(doc, 'paralegal', viewerId);
  return {
    isAttorney: attorney.matches,
    isParalegal: paralegal.matches,
    identityConflict: attorney.matches && attorney.conflict || paralegal.matches && paralegal.conflict,
  };
}

const conflictMessage = 'Matter participant records need review before continuing.';
module.exports = { caseParticipantIdentity, conflictMessage };
