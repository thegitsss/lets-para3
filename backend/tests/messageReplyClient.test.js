let target, same, query, createApiClient, createPrivateState;
beforeAll(async () => {
  ({ messageReplyTarget: target, sameMessageRequest: same, messageReplyQuery: query } = await import('../../frontend/assets/scripts/utils/message-reply.mjs'));
  ({ createApiClient } = await import('../../frontend/assets/scripts/attorney-v2/api-client.mjs'));
  ({ createPrivateState } = await import('../../frontend/assets/scripts/attorney-v2/private-state.mjs'));
});
const ownerId = 'a'.repeat(24), caseId = 'b'.repeat(24), messageId = 'c'.repeat(24);
test('reply navigation replaces a previous target and retains the exact Matter return context', () => {
  const original = new URLSearchParams({ messageId: ownerId, returnTo: '#/matters?view=active', matter: caseId });
  const next = query(original, messageId);
  expect(next.getAll('messageId')).toEqual([messageId]); expect(next.get('matter')).toBe(caseId); expect(next.get('returnTo')).toBe(original.get('returnTo')); expect(original.get('messageId')).toBe(ownerId);
  expect(() => query(original, 'invalid')).toThrow();
});
test('reply selection stores identity and sender only, rejects pending/deleted records, and binds retries to their original context', () => {
  expect(target({ id: messageId, sender: 'Other participant', text: 'Do not copy private source text' })).toEqual({ id: messageId, sender: 'Other participant' });
  expect(target({ _id: messageId, deleted: true })).toBeNull(); expect(target({ _id: messageId, pending: true })).toBeNull(); expect(target({ _id: 'pending-local' })).toBeNull();
  const pending = { id: 'synthetic-request-0001', text: 'Unsent reply', replyTo: messageId };
  expect(same(pending, 'Unsent reply', messageId)).toBe(true); expect(same(pending, 'Unsent reply', ownerId)).toBe(false); expect(same(pending, 'Edited reply', messageId)).toBe(false);
});
test('an empty-text reply selection counts as unfinished private work and account clearing removes it', () => {
  const state = createPrivateState(); state.conversations.set(caseId, { text: '', reply: { id: messageId, sender: 'Other participant' } });
  expect(state.hasUnsaved()).toBe(true); state.conversations.get(caseId).reply = null; expect(state.hasUnsaved()).toBe(false);
  state.conversations.get(caseId).reply = { id: messageId }; state.clear(); expect(state.hasUnsaved()).toBe(false); expect(state.conversations.size).toBe(0);
});
test('the authenticated message-send method includes only a validated optional parent and never copies source content', async () => {
  const calls = [], api = createApiClient({ fetchImpl: async (path, options) => {
    if (path === '/api/auth/me') return Response.json({ user: { id: ownerId, role: 'attorney', status: 'approved' } });
    if (path === '/api/csrf') return Response.json({ csrfToken: 'local-synthetic-token' });
    calls.push({ path, body: JSON.parse(options.body) }); return Response.json({ message: { _id: messageId, caseId, senderId: ownerId, type: 'text', replyTo: messageId } });
  } });
  await api.sendWorkspaceMessage(caseId, 'Reply text', 'synthetic-request-0001', { ownerId, replyTo: messageId });
  expect(calls).toEqual([{ path: `/api/messages/${caseId}`, body: { text: 'Reply text', clientMessageId: 'synthetic-request-0001', replyTo: messageId, expectedOwnerId: ownerId } }]);
  expect(() => api.sendWorkspaceMessage(caseId, 'Reply text', 'synthetic-request-0002', { ownerId, replyTo: 'invalid' })).toThrow();
});
