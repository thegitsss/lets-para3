const { createHash } = require('node:crypto');
function receivedInvitations(ownerId, input = [], query = new URLSearchParams()) {
  const items = (Array.isArray(input) ? input : input.items || []).map(item => ({ ...item, inviteStatus: item.inviteStatus || 'pending', inviteInvitedAt: item.inviteInvitedAt || null }));
  const revision = createHash('sha256').update(JSON.stringify([ownerId, items])).digest('hex');
  const limit = Number(query.get('limit') || 50), offset = Number((query.get('cursor') || '').split(':')[1] || 0), end = offset + limit;
  return { ownerId, revision, items: items.slice(offset,end), page: { total: items.length, offset, limit, hasMore: end < items.length, nextCursor: end < items.length ? `${revision}:${end}` : null } };
}
module.exports = { receivedInvitations };
