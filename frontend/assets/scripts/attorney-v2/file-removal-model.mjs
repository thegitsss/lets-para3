const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readRemoval(value, fileId) {
  if (!value || value.status !== "removed" || value.fileId !== fileId || typeof value.exactRequest !== "boolean" || !["pending", "retained", "deleted", "needs_review"].includes(value.cleanup) || typeof value.removedAt !== "string" || !Number.isFinite(new Date(value.removedAt).getTime())) throw new Error("invalid_file_removal");
  return { status: "removed", fileId, exactRequest: value.exactRequest, cleanup: value.cleanup, removedAt: value.removedAt };
}
export function readRemovalReview(value, caseId, ownerId, fileId) {
  if (!value || value.caseId !== caseId || value.ownerId !== ownerId || typeof value.canRemove !== "boolean" || !Object.hasOwn(value, "file") || !Object.hasOwn(value, "removal")) throw new Error("invalid_file_removal_review");
  let file = null;
  if (value.file) {
    const raw = value.file;
    if (raw.id !== fileId || typeof raw.name !== "string" || !raw.name || !digest(raw.reviewRevision) || !digest(value.revision) || raw.version !== null && (!Number.isSafeInteger(raw.version) || raw.version < 1)) throw new Error("invalid_file_removal_target");
    file = { id: fileId, name: raw.name, version: raw.version, reviewRevision: raw.reviewRevision };
  } else if (value.file !== null || value.revision !== null || value.canRemove) throw new Error("invalid_file_removal_target");
  const removal = value.removal === null ? null : readRemoval(value.removal, fileId);
  if (file && removal || removal && value.canRemove) throw new Error("invalid_file_removal_target");
  return { caseId, ownerId, file, revision: value.revision, canRemove: value.canRemove, removal };
}
export const removalNotice = result => `${result.exactRequest ? "Document removed from Files." : "This document was removed by another request."} ${result.cleanup === "retained" ? "A stored copy remains because it is still referenced in this Matter." : result.cleanup === "deleted" ? "Cleanup of the current stored copy is complete. Earlier document history follows the Matter’s retention period." : result.cleanup === "needs_review" ? "Storage cleanup needs review. Retained Matter records have been preserved." : "Storage cleanup is pending. Copies referenced in correspondence or document history remain under the Matter’s retention period."}`;
