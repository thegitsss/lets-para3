// A page-memory decision survives closing details, but never account loss.
// Unknown writes require an explicit read before another confirmed decision.
export function createEarlierApplicationWithdrawal({ getOwner, post, get, resolveAdditionalAction }) {
  const states = new Map();
  let generation = 0;
  const notify = current => { for (const listener of current.listeners) if (listener(current) === false) current.listeners.delete(listener); };
  const key = application => `${getOwner()}:${application.caseId}`;
  function state(application) {
    const selected = key(application);
    if (!states.has(selected)) states.set(selected, { application, pending: false, review: false, saved: false, message: '', listeners: new Set() });
    return states.get(selected);
  }
  async function act(application) {
    const current = state(application), ownerId = getOwner(), selectedGeneration = generation;
    if (!ownerId || current.pending || current.saved) return current;
    const valid = () => getOwner() === ownerId && generation === selectedGeneration;
    current.pending = true;
    notify(current);
    try {
      if (current.review) {
        const rows = await get(`/api/applications/my?expectedOwnerId=${encodeURIComponent(ownerId)}`);
        if (!valid()) return null;
        if (!Array.isArray(rows)) throw new Error('Saved applications could not load. Try again.');
        const matches = rows.filter(row => String(row.caseId || '') === String(application.caseId));
        if (matches.length !== 1) throw new Error('This application is no longer available. Close these details and refresh your applications.');
        current.application = matches[0];
        current.saved = matches[0].status === 'withdrawn';
        current.review = false;
        current.message = current.saved ? 'Application withdrawn.' : (matches[0].applicationSource === 'case_applicant' && matches[0].withdrawal?.available === true || resolveAdditionalAction?.(matches[0]))
          ? 'Review the updated application before withdrawing.' : 'This application can no longer be withdrawn here.';
      } else {
        const selected = current.application;
        const additional = selected.applicationSource === 'case_applicant' ? null : resolveAdditionalAction?.(selected);
        if (!additional && (selected.applicationSource !== 'case_applicant' || selected.withdrawal?.available !== true || !/^[a-f0-9]{64}$/.test(selected.withdrawal?.revision || ''))) {
          current.review = true;
          current.message = 'Review the saved application before continuing.';
          return current;
        }
        const response = await post(additional?.url || `/api/applications/earlier/${encodeURIComponent(selected.caseId)}/revoke`, additional?.body || { expectedOwnerId: ownerId, expectedRevision: selected.withdrawal.revision });
        if (!valid()) return null;
        if (additional ? !additional.verify(response) : response?.success !== true || response.status !== 'withdrawn' || String(response.caseId) !== String(selected.caseId) || typeof response.alreadyRevoked !== 'boolean') throw new Error('The withdrawal result could not be confirmed.');
        current.saved = true;
        current.message = 'Application withdrawn.';
      }
    } catch (error) {
      if (!valid()) return null;
      current.review = true;
      current.message = error?.message || 'The withdrawal result could not be confirmed. Review the saved application.';
    } finally {
      current.pending = false;
      if (valid()) notify(current);
    }
    return valid() ? current : null;
  }
  return { state, act, observe(application, listener) { const selected = state(application); selected.listeners.add(listener); listener(selected); return () => selected.listeners.delete(listener); }, clear() { generation++; for (const current of states.values()) current.listeners.clear(); states.clear(); } };
}
