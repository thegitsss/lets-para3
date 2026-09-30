const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function readArchive(value, caseId, ownerId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value.caseId !== caseId || typeof value.caseTitle !== "string" || typeof value.status !== "string" || !hash(value.revision) || !["ready", "retention", "final", "unsupported", "assigned", "processing", "history"].includes(value.reason) || !["active", "applications", "archived", "draft"].includes(value.restoredView)) throw new Error("invalid_archive");
  if (["archived", "targetArchived", "canChange", "legacyReopen", "readOnly"].some(key => typeof value[key] !== "boolean") || value.targetArchived === value.archived || value.canChange !== (value.reason === "ready") || (value.legacyReopen && (!value.archived || value.status !== ""))) throw new Error("invalid_archive_permissions");
  const receipt = value.receipt;
  if (receipt && (!uuid(receipt.requestId) || !hash(receipt.revision) || typeof receipt.archived !== "boolean" || typeof receipt.at !== "string" || !Number.isFinite(new Date(receipt.at).getTime()))) throw new Error("invalid_archive_receipt");
  return value;
}
export const confirmsArchive = (value, sent) => Boolean(sent && value?.receipt?.requestId === sent.requestId && value.receipt.revision === sent.revision && value.receipt.archived === sent.archived);
export const archiveReason = value => ({ ready: value.archived ? "This Matter has been manually archived." : "This Matter has not been manually archived.", retention: "This Matter is subject to a retention or deletion process. Archive changes are unavailable.", final: "Completed and closed Matters remain in history. Archive controls cannot reopen them.", unsupported: "This older Matter's status needs review before its archive state can be changed.", assigned: "A Matter with an assigned paralegal cannot be archived here.", processing: "Hiring, funding or completion is being processed. Check again after that process is resolved.", history: "This paused Matter appears in Archived because of its lifecycle status. Continue its existing workflow to determine whether it can be relisted." })[value.reason];
export const archiveStatus = value => ({ open: "Open", "in progress": "In progress", paused: "Paused", disputed: "Disputed", completed: "Completed", closed: "Closed", draft: "Draft", "": "Legacy status not recorded" })[value.status] || "Status unavailable";
export const archiveAction = value => !value.archived ? "Archive Matter" : value.status === "draft" ? "Restore draft" : value.legacyReopen ? "Restore as open posting" : value.restoredView === "archived" ? "Remove manual archive" : "Restore Matter";
export function archiveEffect(value) {
  if (!value.archived) return "The Matter will move to Archived and leave open listings. Its applications, invitations, files and payment history remain recorded. New applications and invitation responses are blocked while it is archived.";
  if (value.status === "draft") return `The Matter will return to Drafts and stay private${value.readOnly ? " with its read-only restrictions" : ""}. Review and publish it from the draft editor when it is ready.`;
  if (value.legacyReopen) return "This older draft will reopen as an open posting under the existing legacy restore rule. Review its Matter details before confirming.";
  return `The manual archive flag will be removed. The Matter keeps its ${archiveStatus(value).toLowerCase()} status${value.readOnly ? " and read-only restrictions" : ""} and will appear in ${value.restoredView === "applications" ? "Applications" : value.restoredView === "archived" ? "Archived until its lifecycle permits relisting" : "Active Matters"}. Existing workflow requirements still apply.`;
}
