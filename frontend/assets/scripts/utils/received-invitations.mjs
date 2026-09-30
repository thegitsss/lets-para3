const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error('Invitations could not be verified. Refresh to try again.'); };
export function readInvitationPage(value, ownerId, { offset = 0, revision = null } = {}) {
  if (!id(ownerId) || value?.ownerId !== ownerId || !hash(value.revision) || revision && value.revision !== revision || !Array.isArray(value.items)) invalid();
  const page = value.page;
  if (!page || !integer(page.total) || !integer(page.limit) || page.limit < 1 || page.limit > 200 || page.offset !== offset || offset > page.total || value.items.length !== Math.min(page.limit, page.total - offset)) invalid();
  const end = offset + value.items.length;
  if (page.hasMore !== (end < page.total) || page.nextCursor !== (page.hasMore ? `${value.revision}:${end}` : null)) invalid();
  const seen = new Set();
  for (const item of value.items) {
    const caseId = String(item?.caseId || item?.id || item?._id || '');
    if (!id(caseId) || seen.has(caseId) || item.inviteStatus !== 'pending' || typeof item.title !== 'string' || item.inviteInvitedAt !== null && (typeof item.inviteInvitedAt !== 'string' || !Number.isFinite(Date.parse(item.inviteInvitedAt)))) invalid();
    seen.add(caseId);
  }
  return value;
}
export async function loadReceivedInvitations(api, ownerId, { signal, isCurrent = () => true } = {}) {
  const current = () => { if (signal?.aborted || !isCurrent()) throw new DOMException('View changed', 'AbortError'); };
  current(); if (!id(ownerId)) invalid();
  let cursor = null, revision = null, offset = 0, total = null;
  const items = [], seen = new Set();
  do {
    current();
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 30000);
    let value;
    try {
      value = await api.get(cursor ? `/api/cases/invited-to?${new URLSearchParams({ cursor, expectedOwnerId: ownerId })}` : '/api/cases/invited-to', { signal: controller.signal });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    current();
    const page = readInvitationPage(value, ownerId, { offset, revision });
    if (total !== null && page.page.total !== total) invalid();
    for (const item of page.items) { const key = String(item.caseId || item.id || item._id); if (seen.has(key)) invalid(); seen.add(key); items.push(item); }
    total = page.page.total; revision = page.revision; cursor = page.page.nextCursor; offset += page.items.length;
  } while (cursor);
  const payload = await api.get('/api/auth/me', { signal }); current();
  const user = payload?.user;
  if (String(user?.id || user?._id || '') !== ownerId || user.role !== 'paralegal' || user.status !== 'approved' || user.disabled || user.deleted) throw Object.assign(new Error('The workspace account changed.'), { status: 403 });
  return { ownerId, revision, items };
}
