"use strict";

const id = value => String(value?._id || value?.id || value || "");
const statusOf = value => String(value || "").toLowerCase().replace(/_/g, " ").trim();

// Explanation only. Existing handlers and policy checks retain all write authority.
function buildMatterJourney(matter, context) {
  const { isAttorney, isParalegal, isApplicant, preEngagement, completionPolicy, pendingApplicationCount = 0 } = context;
  if (!isAttorney && !isParalegal && !isApplicant) return null;
  const result = (code, kind, responsible, title, detail, tab, label) => ({
    code, kind, responsible, title, detail,
    action: tab ? { tab, label } : null,
  });
  const status = statusOf(matter.status);
  const terminal = ["completed", "closed", "cancelled", "canceled", "expired", "archived"].includes(status);
  const assigned = id(matter.paralegal || matter.paralegalId);
  if (terminal || matter.archived || matter.readOnly || matter.paymentReleased === true) {
    if (isApplicant && !isParalegal && !isAttorney) return result("application_closed", "information", "none", "This opportunity has ended", "Your saved application remains available. This does not confirm hiring or payment.", "applications", "View application");
    return result("retained", "information", "none", terminal ? "Retained Matter record" : "Read-only Matter record",
      matter.paymentReleased === true ? "LPC records the payment release. Bank arrival is a separate Stripe status; keep any records you need." : "Review the recorded outcome and financial history. A closed or archived Matter does not by itself confirm payment.", "financials", "View financial records");
  }
  if (["disputed", "paused"].includes(status)) return result("review", "information", status === "disputed" ? "lpc" : "unknown", status === "disputed" ? "LPC review in progress" : "This Matter is paused", "Review the saved activity and financial records before taking another work or payment action.", "activity", "View Matter status");

  if (!assigned || (isApplicant && !isParalegal && !isAttorney)) {
    const application = (context.applications || [])[0];
    if (!isAttorney && ["withdrawn", "rejected", "denied", "not_selected"].includes(application?.status)) return result("application_ended", "information", "none", "Your application has ended", "Review the recorded application outcome. No hire or payment has been inferred.", "applications", "View application");
    if (!isAttorney && application?.status === "invited") return result("invitation", "action", "you", "An invitation is ready for review", "Review the scope and requirements before responding. Accepting an invitation does not confirm hiring or funding.", "applications", "Review invitation");
    const pre = isAttorney ? matter.preEngagement : preEngagement;
    const preStatus = statusOf(pre?.status);
    if (["requested", "changes requested"].includes(preStatus)) return result("preparation_requested", isAttorney ? "waiting" : "action", isAttorney ? "paralegal" : "you", isAttorney ? "Waiting for requested information" : "Information needed before hiring", "The requested information must be submitted and reviewed before hiring can continue. No work has started.", "applications", isAttorney ? "Review request" : "Provide requested information");
    if (preStatus === "submitted") return result("preparation_review", isAttorney ? "action" : "waiting", isAttorney ? "you" : "attorney", isAttorney ? "Requested information is ready for review" : "Your information is with the attorney", "Submitting information does not confirm a hire. The attorney reviews it before continuing.", "applications", isAttorney ? "Review information" : "View submitted information");
    if (isAttorney) return pendingApplicationCount > 0
      ? result("applications", "action", "you", "Applications are ready for review", "Review candidates and any pre-engagement requirements. Hiring and funding remain separate decisions.", "applications", "Review applications")
      : result("posting", "information", "none", status === "draft" ? "Prepare your Matter" : "Your posting is available for review", "A posting or invitation does not start an engagement. Review the scope before selecting and funding a hire.", "overview", "View posting");
    return result("application_waiting", "waiting", "attorney", "Waiting for the attorney", "Your application or invitation response is recorded. It is not a confirmed hire; work begins only after hiring and verified funding.", "applications", "View application");
  }
  if (matter.escrowStatus !== "funded" || !matter.escrowIntentId || !["in progress", "active", "funded in progress"].includes(status)) return result("funding", "unavailable", "unknown", "Check hiring and funding before work begins", "Assignment alone does not confirm that work can start. Review the current hiring and funding records; do not make another payment based on this summary.", "financials", "Review funding");

  const files = (Array.isArray(matter.files) ? matter.files : []).filter(file => file.uploadedByRole === "paralegal" && !file.replacedAt && (!id(file.userId || file.uploadedBy) || id(file.userId || file.uploadedBy) === assigned));
  const revisions = files.filter(file => file.status === "attorney_revision" && !file.revisionResolution && !files.some(response =>
    id(response.revisionOfFileId) && id(response.revisionOfFileId) === id(file._id || file.id) && response.revisionRequestAt && new Date(response.revisionRequestAt).getTime() === new Date(file.revisionRequestedAt).getTime() && Number(response.revisionOfVersion) === Number(file.version || 1) && Number.isSafeInteger(Number(response.version)) && Number(response.version) > Number(file.version || 1) && response.status === "pending_review"
  )).length;
  const waiting = files.filter(file => file.status === "pending_review").length;
  if (revisions && isParalegal) return result("revisions", "action", "you", "Revision requests need your review", "Open the requested file version, review the attorney's instructions, and respond through the existing revision workflow. Other submitted files may still be under review.", "files", "Review revisions");
  if (waiting) return result("submitted", isAttorney ? "action" : "waiting", isAttorney ? "you" : "attorney", isAttorney ? "Submitted work is ready for review" : "Your submitted work is with the attorney", `${waiting} submitted ${waiting === 1 ? "file awaits" : "files await"} review. File approval, Matter completion, and payment release are separate steps.`, "files", isAttorney ? "Review submitted work" : "View submitted work");
  if (revisions) return result("revisions_waiting", "waiting", "paralegal", "Waiting for a revision response", "The revision request is recorded. Review its file/version and any response in Files.", "files", "View revision requests");
  const tasks = Array.isArray(matter.tasks) ? matter.tasks : [];
  const allComplete = tasks.length > 0 && tasks.every(task => (task.completed ?? task.done) === true);
  if (allComplete) return result("completion", isAttorney ? "action" : "waiting", isAttorney ? "you" : "attorney", isAttorney ? "Review the final Matter outcome" : "Waiting for final attorney review", completionPolicy?.ready === true ? "The recorded prerequisites allow a completion review. Completing the Matter and releasing payment still require the attorney's explicit confirmation." : "Work items are marked complete. Review remaining document and payment prerequisites before confirming completion; payment has not been inferred.", isAttorney ? "financials" : "work", isAttorney ? "Review completion" : "View agreed work");
  return result("work", isAttorney ? "waiting" : "action", isAttorney ? "paralegal" : "you", isAttorney ? "Work is with your paralegal" : "Continue your agreed work", "Use the agreed scope, Files, and Messages to coordinate. Submitted work returns to the attorney for review before completion and payment release.", "work", "View agreed work");
}

module.exports = { buildMatterJourney };
