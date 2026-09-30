import { node, button } from "./dom.mjs";
import { safeSignedUrl } from "./candidate-model.mjs";
import { readPreEngagement, preEngagementStatus, preEngagementReason, preEngagementError, requestProblem } from "./pre-engagement-model.mjs";
const p = text => node("p", { text });
const when = value => value ? new Date(value).toLocaleString() : "Date not recorded";
export function createPreEngagement(caseId, item, { api, signal, ownerId, privateState, autoReview = false, onContinue, onRecorded }) {
  const key = `${caseId}:${item.applicantId}`, states = privateState.preEngagement;
  if (!states.has(key)) states.set(key, {});
  const state = states.get(key);
  let review = null, chosen = null, operation = null, expiration;
  const status = node("p", { role: "status" }), body = node("div"), confirmation = node("div"), documents = node("div");
  const refresh = button("Review pre-engagement requirements", () => void load());
  const cancel = button("Stop waiting", () => { operation?.abort(); });
  const section = node("section", { "data-pre-engagement": item.applicantId, "aria-label": "Pre-engagement requirements" }, [node("h3", { text: "Pre-engagement requirements" }), status, node("div", { className: "av2-actions" }, [refresh, cancel]), body, confirmation, documents]);
  const alive = () => !signal.aborted;
  function message(text, phase) {
    status.textContent = text; section.dataset.state = phase;
    status.classList.toggle("matter-application-announcement", phase === "ready" && ["Pre-engagement requirements sent.", "Pre-engagement response approved. Hiring and funding have not been performed.", "Response changes requested from the paralegal."].includes(text));
  }
  function clearDocument() { clearTimeout(expiration); documents.replaceChildren(); }
  function controls() {
    section.setAttribute("aria-busy", String(!!operation)); refresh.disabled = !!operation; cancel.hidden = !operation;
    refresh.hidden = !!chosen && !state.pending;
    refresh.textContent = state.pending ? "Check saved requirements" : review ? "Refresh saved requirements" : "Review pre-engagement requirements";
    [...body.querySelectorAll("button, input, textarea"), ...confirmation.querySelectorAll("button")].forEach(control => { control.disabled = !!operation; });
  }
  function begin() { operation = new AbortController(); const controller = operation; state.busy = true; clearDocument(); controls(); const timer = setTimeout(() => controller.abort(), 90000); return { controller, finish() { clearTimeout(timer); state.busy = false; if (operation === controller) operation = null; if (alive()) controls(); } }; }
  async function load(savedMessage = "") {
    if (operation || !alive()) return;
    const recovering = !!state.pending, run = begin(); review = null; chosen = null; body.replaceChildren(); confirmation.replaceChildren(); message("Checking the saved pre-engagement requirements…", "loading");
    try {
      const value = await api.readPreEngagement(caseId, item.applicantId, { signal: run.controller.signal, ownerId });
      if (!alive()) return;
      run.controller.signal.throwIfAborted();
      review = readPreEngagement(value, caseId, ownerId, item.applicantId); delete state.pending;
      message(savedMessage || (recovering ? "The current saved requirements are shown below. Review them and any documents before making another change; this does not confirm the result of the earlier request." : ""), "ready"); render();
    } catch (error) { if (alive()) message(run.controller.signal.aborted ? "The review stopped before it could be confirmed. Refresh the saved requirements to try again." : preEngagementError(error), state.pending ? "uncertain" : "error"); }
    finally { run.finish(); }
  }
  function choose(action) {
    if (action === "request") { const problem = requestProblem(state.draft, review); if (problem) { message(problem, "invalid"); return; } }
    chosen = action; body.hidden = true; confirmation.replaceChildren(); clearDocument();
    const title = action === "request" ? "Send these pre-engagement requirements?" : action === "approve" ? "Approve this pre-engagement response?" : "Ask the paralegal to revise this response?";
    const effect = action === "request" ? "The paralegal will receive these requirements before hiring can continue." : action === "approve" ? "This records your approval of the displayed confidentiality and conflicts response. Hiring and funding are separate actions." : "The response will return to the paralegal for revision. Hiring remains unavailable until the response is approved.";
    confirmation.append(node("h4", { text: title }), p(`${review.name} · ${review.caseTitle}`), p(effect));
    if (action === "request") {
      if (review.request && !review.selectedRequest) confirmation.append(p("This replaces the pending pre-engagement request for another applicant on this Matter."));
      if (state.draft.confidentiality) confirmation.append(p(`Confidentiality agreement: ${state.draft.file?.name || review.request.documents.find(doc => doc.kind === "attorney")?.name}`));
      if (state.draft.conflicts) confirmation.append(p(`Conflicts check: ${state.draft.details}`));
    }
    const confirm = button(action === "request" ? "Send requirements" : action === "approve" ? "Confirm pre-engagement approval" : "Request response changes", () => void save());
    confirm.classList.add("av2-primary");
    confirmation.append(node("div", { className: "av2-actions" }, [confirm, button("Return to review", () => { chosen = null; body.hidden = false; confirmation.replaceChildren(); controls(); refresh.focus(); })]));
    controls(); confirmation.querySelector("button")?.focus();
  }
  function render() {
    body.hidden = false; body.replaceChildren(); confirmation.replaceChildren();
    if (!review) return;
    body.append(p(`${review.name} · ${review.caseTitle}`));
    const request = review.request;
    if (request && review.selectedRequest) {
      body.append(node("h4", { text: preEngagementStatus(request.status) }), p(`Requested ${when(request.requestedAt)}`));
      if (request.confidentialityRequired && (request.acknowledged || request.status !== "requested")) body.append(p(request.acknowledged ? `Confidentiality agreement acknowledged ${when(request.acknowledgedAt)}` : "Confidentiality agreement acknowledgement not recorded."));
      if (request.conflictsRequired) {
        body.append(node("h4", { text: "Conflicts check" }), p(request.conflictsDetails));
        if (request.conflictsResponse || request.status !== "requested") body.append(p(request.conflictsResponse === "none_known" ? "The paralegal reported no known conflicts." : request.conflictsResponse === "disclosure" ? "The paralegal disclosed the following:" : "A conflicts response has not been verified."));
        if (request.disclosure) body.append(p(request.disclosure));
      }
      if (request.submittedAt) body.append(p(`Response submitted ${when(request.submittedAt)}`));
      if (request.reviewedAt) body.append(p(`Attorney review recorded ${when(request.reviewedAt)}`));
      for (const doc of request.documents) {
        body.append(p(`${doc.kind === "attorney" ? "Requested agreement" : "Paralegal's document"}: ${doc.name}`));
        body.append(doc.key ? button(`Prepare ${doc.kind === "attorney" ? "requested agreement" : "paralegal document"}`, () => void prepareDocument(doc)) : p("This document's saved reference could not be verified."));
      }
    } else body.append(p(request ? "The Matter has a pre-engagement request for another applicant." : "No pre-engagement requirements have been recorded for this Matter."));
    if (review.reason !== "ready") body.append(p(preEngagementReason(review.reason)));
    if (review.canRequest && !state.pending) {
      if (request && review.selectedRequest) {
        const editor = node("details", { "data-preengagement-editor": "" }, [node("summary", { text: "Edit requirements" })]);
        editor.open = !!state.draft?.dirty;
        body.append(editor); requestForm(editor);
      } else requestForm(body);
    }
    if (review.canReview && !state.pending) {
      if (!review.canApprove) body.append(p("The response is missing a required acknowledgement, conflicts response, or document reference. Request changes before approving it."));
      body.append(node("div", { className: "av2-actions" }, [...(review.canApprove ? [button("Approve pre-engagement response", () => choose("approve"))] : []), button("Ask for response changes", () => choose("request_changes"))]));
    }
    if (onContinue) {
      const next = button("Continue to hiring review", onContinue); next.dataset.preengagementContinue = ""; next.hidden = !canContinue(); body.append(next);
    }
    controls();
  }
  function canContinue() {
    return review && (review.selectedRequest && review.request?.status === "approved" || !review.request && review.reason === "ready" && !state.draft?.confidentiality && !state.draft?.conflicts);
  }
  function requestForm(container) {
    const request = review.selectedRequest ? review.request : null;
    state.draft ||= { confidentiality: request?.confidentialityRequired || false, conflicts: request?.conflictsRequired || false, details: request?.conflictsDetails || "", file: null };
    const draft = state.draft, confidentiality = node("input", { type: "checkbox" }), conflicts = node("input", { type: "checkbox" }), details = node("textarea", { rows: "5", maxlength: "5000" }), file = node("input", { type: "file", accept: ".pdf,.doc,.docx" });
    confidentiality.checked = draft.confidentiality; conflicts.checked = draft.conflicts; details.value = draft.details;
    if (draft.file) { const selection = new window.DataTransfer(); selection.items.add(draft.file); file.files = selection.files; }
    const fileHelp = `PDF, DOC or DOCX, up to 10 MB.${request?.documents.some(doc => doc.kind === "attorney" && doc.key) ? " Leave empty to reuse the saved agreement." : ""}`;
    const fileStatus = p(fileHelp); fileStatus.hidden = !!draft.file;
    const agreementFields = node("div", {}, [node("label", {}, [p("Confidentiality agreement file"), file]), fileStatus]);
    const conflictFields = node("div", {}, [node("label", {}, [p("Parties and details for the conflicts check"), details])]);
    const discard = button("Discard unsent requirements", () => { delete state.draft; chosen = null; render(); message("Unsent requirements discarded. The saved request is unchanged.", "ready"); refresh.focus(); });
    function visibility() {
      agreementFields.hidden = !draft.confidentiality; conflictFields.hidden = !draft.conflicts; discard.hidden = !draft.dirty;
      const next = section.querySelector('[data-preengagement-continue]'); if (next) next.hidden = !canContinue();
    }
    const changed = () => { draft.dirty = true; chosen = null; confirmation.replaceChildren(); visibility(); };
    confidentiality.addEventListener("change", () => { draft.confidentiality = confidentiality.checked; changed(); });
    conflicts.addEventListener("change", () => { draft.conflicts = conflicts.checked; changed(); });
    details.addEventListener("input", () => { draft.details = details.value; changed(); });
    file.addEventListener("change", () => { draft.file = file.files[0] || null; fileStatus.hidden = !!draft.file; changed(); });
    container.append(node("fieldset", {}, [node("legend", { text: "Requirements to send" }), node("label", {}, [confidentiality, document.createTextNode(" Require confidentiality agreement")]), agreementFields, node("label", {}, [conflicts, document.createTextNode(" Require conflicts check")]), conflictFields, node("div", { className: "av2-actions" }, [button("Review requirements before sending", () => choose("request")), discard])]));
    visibility();
  }
  async function save() {
    if (operation || !alive() || !chosen || state.pending || !review) return;
    const action = chosen, sentRevision = (review.request?.revision || 0) + 1;
    if (action === "request" && requestProblem(state.draft, review)) return;
    const input = { reviewedRevision: review.revision };
    if (action === "request") Object.assign(input, { confidentialityAgreementRequired: state.draft.confidentiality, conflictsCheckRequired: state.draft.conflicts, conflictsDetails: state.draft.details, file: state.draft.confidentiality ? state.draft.file : null });
    else input.action = action;
    state.pending = { action }; const run = begin(); message(action === "request" ? "Sending pre-engagement requirements…" : "Recording your pre-engagement review…", "saving");
    let saved = "";
    try {
      const result = action === "request" ? await api.requestPreEngagement(caseId, item.applicantId, input, { signal: run.controller.signal, ownerId }) : await api.reviewPreEngagement(caseId, item.applicantId, input, { signal: run.controller.signal, ownerId });
      if (!alive()) return;
      run.controller.signal.throwIfAborted();
      const expected = { request: "requested", approve: "approved", request_changes: "changes_requested" }[action];
      if (result?.success !== true || result.preEngagement?.status !== expected || result.preEngagement?.revision !== sentRevision || String(result.preEngagement?.requestedParalegalId) !== item.applicantId) throw new Error("unconfirmed_pre_engagement");
      delete state.pending; delete state.draft; saved = action === "request" ? "Pre-engagement requirements sent." : action === "approve" ? "Pre-engagement response approved. Hiring and funding have not been performed." : "Response changes requested from the paralegal.";
    } catch (error) { if (alive()) { review = null; chosen = null; body.replaceChildren(); confirmation.replaceChildren(); message(`${preEngagementError(error)} Check the saved requirements before sending another request.`, "uncertain"); } }
    finally { run.finish(); }
    if (saved && alive()) { onRecorded?.({ caseId, applicantId: item.applicantId, action }); await load(saved); }
  }
  async function prepareDocument(doc) {
    if (operation || !alive() || !review) return;
    const run = begin(); message("Checking the saved document and preparing access…", "loading");
    try {
      const started = Date.now(), result = await api.openPreEngagementDocument(caseId, item.applicantId, review.revision, doc.key, { signal: run.controller.signal, ownerId });
      if (!alive()) return;
      run.controller.signal.throwIfAborted();
      const remaining = 55000 - (Date.now() - started); if (remaining < 1000) throw new Error("expired_document_address");
      const href = safeSignedUrl(result?.url, location.origin); if (!href) throw new Error("invalid_document_address");
      documents.append(node("a", { href, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer", text: `Open ${doc.name} (new tab)` }));
      message("Document access is ready briefly. Prepare it again if the link expires.", "ready"); expiration = setTimeout(() => { clearDocument(); if (alive()) message("The document link expired. Prepare the document again to open it.", "ready"); }, remaining);
    } catch (error) { if (alive()) message(preEngagementError(error), "error"); }
    finally { run.finish(); }
  }
  signal.addEventListener("abort", () => { operation?.abort(); state.busy = false; review = null; clearDocument(); section.replaceChildren(); }, { once: true });
  message(state.pending ? "An earlier pre-engagement action was not confirmed. Check the saved requirements before continuing." : "", state.pending ? "uncertain" : "idle"); controls(); if ((autoReview || state.draft?.dirty) && !state.pending) section.readiness = load(); return section;
}
