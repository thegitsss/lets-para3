import { applicationError } from "./application-model.mjs";

export function readApplicationResume(value, caseId, ownerId, item) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value.caseId !== caseId || value.applicantId !== item.applicantId || value.applicationId !== item.applicationId || value.name !== "Application resume.pdf" || !Number.isSafeInteger(value.size) || value.size < 5 || value.size > 10 * 1024 * 1024 || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error("invalid_application_resume");
  return { name: value.name, size: value.size, revision: value.revision };
}
export function applicationResumeError(error) {
  const messages = {
    NOT_RECORDED: "No résumé is recorded with this application. Refresh the applications to check its details.",
    MISSING: "The résumé recorded with this application is no longer in document storage. A current profile résumé may be a different file.",
    REFERENCE_INVALID: "The résumé reference recorded with this application cannot be opened here. Contact support to review the reference.",
    CHANGED: "The application or résumé changed during review. Refresh the applications before downloading.",
    SCAN_PENDING: "The résumé’s security check has not finished. Check it again later.",
    BLOCKED: "The résumé was blocked by its security check and cannot be downloaded.",
    SCAN_ERROR: "The résumé’s security check could not be verified. Check it again later.",
    TOO_LARGE: "The recorded résumé exceeds the 10 MB download limit. Contact support for help reviewing it.",
    INVALID_FILE: "The recorded file could not be verified as a PDF résumé. Contact support for help reviewing it.",
  };
  const suffix = error.code?.replace(/^APPLICATION_REVIEW_RESUME_/, "");
  if (messages[suffix]) return messages[suffix];
  if (error.kind === "authentication" || error.kind === "authorization" || error.code?.startsWith("APPLICATION_REVIEW_") && !error.code.startsWith("APPLICATION_REVIEW_RESUME_")) return applicationError(error);
  return "The recorded résumé couldn’t be opened. Refresh the applications before trying again.";
}
