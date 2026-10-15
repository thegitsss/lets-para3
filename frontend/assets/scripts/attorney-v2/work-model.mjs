import { objectId } from "./workspace-model.mjs";
export function readWork(value, caseId) {
  if (value?.caseId !== caseId || typeof value.title !== "string" || !/^[a-f0-9]{64}$/.test(value.revision || "") || !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 0 || !Array.isArray(value.items) || typeof value.canToggle !== "boolean" || typeof value.canEditScope !== "boolean" || typeof value.completedLocked !== "boolean" || !["ready", "closed", "assignment_required", "decision_pending", "work_unavailable"].includes(value.reason)) throw new Error("invalid_work_review");
  const ids = new Set();
  if (value.items.some((item, index) => {
    if (item.index !== index || !item.title || typeof item.title !== "string" || typeof item.completed !== "boolean" || typeof item.canToggle !== "boolean" || item.id !== null && (!objectId(item.id) || ids.has(item.id))) return true;
    if (item.id) ids.add(item.id);
    return item.canToggle && (!value.canToggle || value.completedLocked && item.completed);
  })) throw new Error("invalid_work_items");
  return value;
}
export function workNotice(value) {
  if (value.reason === "decision_pending") return "A hiring or completion decision is being recorded. Work cannot be changed while that decision is pending.";
  if (value.reason === "closed") return "This Matter's work is retained for reference and cannot be changed.";
  if (value.reason === "assignment_required") return "Review work here after a paralegal is assigned and Matter funding is confirmed.";
  if (value.reason === "work_unavailable") return "Work cannot be changed in this Matter's current status.";
  return value.completedLocked ? "Completed work is locked after a withdrawal and rehire. You can review the remaining items." : "Mark work complete after reviewing the paralegal's submission.";
}
