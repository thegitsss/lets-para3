export function readMatterNote(value, caseId) {
  if (value?.caseId !== caseId || typeof value.note !== "string" || !/^[a-f0-9]{64}$/.test(value.revision || "") || (value.updatedAt && !Number.isFinite(new Date(value.updatedAt).getTime()))) throw new Error("invalid_matter_note");
  // Oversize historical notes remain readable; the editor explains the save limit.
  return { caseTitle: typeof value.caseTitle === "string" ? value.caseTitle : "Untitled Matter", note: value.note, revision: value.revision, updatedAt: value.updatedAt || null };
}
export function noteDraft(server) { return { ...server, baseline: server.note, dirty: false, uncertain: false, busy: false, sent: null, conflict: null }; }
export function editNote(draft, text) { draft.note = text; draft.dirty = draft.note !== draft.baseline; }
export function adoptNote(draft, server, keep = false) {
  if (!keep) draft.note = server.note;
  draft.caseTitle = server.caseTitle || draft.caseTitle;
  draft.baseline = server.note; draft.revision = server.revision; draft.updatedAt = server.updatedAt;
  draft.dirty = draft.note !== draft.baseline; draft.uncertain = false; draft.sent = null; draft.conflict = null;
}
export function reconcileNote(draft, server) {
  if (draft.sent && server.note === draft.sent.note) { adoptNote(draft, server, true); return "confirmed"; }
  if (server.note === draft.note) { adoptNote(draft, server, true); return "current"; }
  if (server.revision === draft.revision) { adoptNote(draft, server, true); return "retained"; }
  if (!draft.dirty && !draft.sent && !draft.uncertain) { adoptNote(draft, server); return "current"; }
  draft.conflict = server; return "conflict";
}
