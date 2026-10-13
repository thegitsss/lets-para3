// Keep response decisions with their account and application, independently of
// the dialog or inline context that currently displays them.
export function createPreEngagementDrafts({ getOwner, onSaved }) {
  const drafts = new Map();
  const key = selection => `${getOwner()}:${selection.caseId}:${selection.applicationId}`;
  function get(selection, pre) {
    const id = key(selection);
    let draft = drafts.get(id);
    const revision = Number(pre.revision || 0);
    const changed = draft && draft.requestRevision !== revision;
    if (!draft || changed && !draft.sending && !draft.pending && !draft.reading && (!draft.savedPre || revision > draft.savedPre.revision)) {
      draft = {
        key: id, ownerId: getOwner(), caseId: selection.caseId, requestRevision: revision, requestPre: { ...pre },
        confidentialityAcknowledged: changed ? false : Boolean(pre.confidentialityAcknowledged),
        conflictsResponseType: changed ? '' : String(pre.conflictsResponseType || ''),
        conflictsDisclosureText: String(draft?.conflictsDisclosureText || pre.conflictsDisclosureText || ''),
        file: null, requirementsChanged: Boolean(changed), listeners: new Set(),
      };
      drafts.set(id, draft);
    }
    if (pre.status === 'submitted' && !draft.sending && !draft.pending && !draft.reading) draft.savedPre = pre;
    return draft;
  }
  const isCurrent = draft => Boolean(draft?.ownerId && draft.ownerId === getOwner() && drafts.get(draft.key) === draft);
  function notify(draft) {
    if (!isCurrent(draft)) return;
    for (const listener of draft.listeners) if (listener(draft) === false) draft.listeners.delete(listener);
  }
  return {
    get, isCurrent, notify,
    saved(draft, pre) { if (!isCurrent(draft)) return; draft.savedPre = pre; draft.file = null; onSaved?.(); },
    observe(draft, listener) { draft.listeners.add(listener); return () => draft.listeners.delete(listener); },
    discard(selection) { for (const [id, draft] of drafts) if (isCurrent(draft) && draft.caseId === selection.caseId) { draft.file = null; draft.conflictsDisclosureText = ''; draft.listeners.clear(); drafts.delete(id); } },
    pending(selection) { return [...drafts.values()].some(draft => isCurrent(draft) && draft.caseId === selection.caseId && (draft.sending || draft.pending || draft.reading)); },
    hasDrafts() { return [...drafts.values()].some(draft => isCurrent(draft) && !draft.savedPre); },
    clear() { for (const draft of drafts.values()) { draft.file = null; draft.conflictsDisclosureText = ''; draft.listeners.clear(); } drafts.clear(); },
  };
}
