const idValid = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const changed = () => Object.assign(new Error('The signed-in account changed. Refresh before continuing.'), { code: 'ACCOUNT_CHANGED' });
function checkCurrent(isCurrent, signal) {
  if (signal?.aborted || !isCurrent()) throw new DOMException('The review was closed.', 'AbortError');
}
async function request(fetchImpl, path, signal, options = {}) {
  const response = await fetchImpl(path, { credentials: 'include', cache: 'no-store', redirect: 'error', signal, ...options });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw changed();
    throw Object.assign(new Error(body?.msg || body?.error || 'The posting could not be verified. Refresh before continuing.'), { confirmedFailure: response.status >= 400 && response.status < 500 });
  }
  return body;
}
async function identity(fetchImpl, signal) {
  const payload = await request(fetchImpl, '/api/auth/me', signal), user = payload?.user;
  const ownerId = String(user?.id || user?._id || '');
  if (!idValid(ownerId) || user?.role !== 'admin' || user.status !== 'approved' || user.disabled || user.deleted) throw changed();
  return ownerId;
}
function validReview(value) {
  return value && idValid(value.ownerId) && idValid(value.caseId) && typeof value.title === 'string' && value.title.trim() &&
    typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision) && typeof value.canDelete === 'boolean' && typeof value.reason === 'string';
}
export async function reviewAdminPostingDeletion(caseId, { signal, isCurrent = () => true, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  if (!idValid(caseId)) throw new Error('This posting is unavailable.');
  checkCurrent(isCurrent, signal);
  const ownerId = await identity(fetchImpl, signal); checkCurrent(isCurrent, signal);
  const payload = await request(fetchImpl, `/api/admin/cases/${caseId}/deletion?expectedOwnerId=${ownerId}`, signal);
  checkCurrent(isCurrent, signal);
  if (!validReview(payload?.deletion) || payload.deletion.ownerId !== ownerId || payload.deletion.caseId !== caseId) throw new Error('The posting review could not be verified. Refresh before continuing.');
  if (await identity(fetchImpl, signal) !== ownerId) throw changed();
  checkCurrent(isCurrent, signal);
  return Object.freeze({ ...payload.deletion });
}
export async function deleteAdminPosting(review, { reason, message, signal, isCurrent = () => true, onSending = () => {}, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  if (!validReview(review) || !review.canDelete) throw new Error('Review this posting before deleting it.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || typeof message !== 'string' || message.length > 4000) throw new Error('Enter a reason of up to 2,000 characters and an optional note of up to 4,000 characters.');
  checkCurrent(isCurrent, signal);
  if (await identity(fetchImpl, signal) !== review.ownerId) throw changed();
  checkCurrent(isCurrent, signal);
  const csrf = await request(fetchImpl, '/api/csrf', signal); checkCurrent(isCurrent, signal);
  if (typeof csrf?.csrfToken !== 'string' || !csrf.csrfToken) throw new Error('The posting could not be verified. Review it again before continuing.');
  onSending();
  try {
    const result = await request(fetchImpl, `/api/admin/cases/${review.caseId}`, signal, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken }, body: JSON.stringify({ expectedOwnerId: review.ownerId, revision: review.revision, reason: reason.trim(), message: message.trim() }) });
    if (result?.ok !== true || result.caseId !== review.caseId || result.ownerId !== review.ownerId) throw new Error('The deletion response could not be verified.');
    checkCurrent(isCurrent, signal);
    if (await identity(fetchImpl, signal) !== review.ownerId) throw changed();
    checkCurrent(isCurrent, signal);
    return result;
  } catch (error) {
    if (error.code === 'ACCOUNT_CHANGED' || error.confirmedFailure) throw error;
    throw new Error('Deletion was not confirmed. Review the posting again to check its current state.');
  }
}
