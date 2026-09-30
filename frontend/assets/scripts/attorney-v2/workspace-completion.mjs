import { createSaveParalegal } from "./saved-paralegals.mjs";
import { node, button, link, setRecovery } from "./dom.mjs";
import { financialRefresh, financialHeading, localFinancialReview } from "./financial-section.mjs";
import { readCompletion, completionMoney, completionConfirmation, blockerText, outcomeText } from "./completion-model.mjs";
import { timeLabel } from "./workspace-model.mjs";
const recordedSummary = review => review?.completedAt && review.payoutState === "recorded" && (!review.operation || review.operation.status === "recorded") ? `${review.closed ? "Closed" : "Completed"} ${timeLabel(review.completedAt)}. Payout recorded.` : null;
export function createWorkspaceCompletion(caseId, { api, signal, ownerId, privateState, hasArchiveLink = false }) {
  const section = node("section", { "aria-label": "Matter completion", "data-workspace-completion": "" });
  const feedback = node("p", { role: "status" }), body = node("div"), actions = node("div", { className: "av2-actions" });
  const state = privateState.completions.get(caseId) || { pending: null, busy: false }; privateState.completions.set(caseId, state); state.busy = false;
  let savedPrompt = null, savedPromptId = null;
  let review = null, confirming = false, reading = false, controller = null, timer = null, sequence = 0, recoverFocus = false;
  const refresh = financialRefresh("Refresh completion details", () => void load());
  const stop = button("Stop waiting", () => { recoverFocus = true; controller?.abort(); }); stop.hidden = true;
  section.append(financialHeading("Paralegal payment", refresh), feedback, body, actions, stop);
  const options = { ownerId, signal };
  function buttons() {
    if (!state.busy && document.activeElement === stop) recoverFocus = true;
    refresh.disabled = state.busy || reading; refresh.setLabel(state.pending || state.lastRequestId ? "Check completion status" : "Refresh completion details", Boolean(review && !state.pending)); stop.hidden = !state.busy;
    // Opening or canceling this local review does not move money. A background
    // read must not swallow those clicks; the release action still waits.
    for (const control of actions.querySelectorAll("button")) control.disabled = state.busy || reading && !control.hasAttribute("data-financial-local-review");
    if (recoverFocus && !refresh.disabled) {
      recoverFocus = false;
      if (!signal.aborted && [stop, document.body, document.documentElement, section.closest("main")].includes(document.activeElement)) refresh.focus({ preventScroll: true });
    }

    setRecovery(refresh, section, { pending: Boolean(state.pending || state.lastRequestId && review?.operation?.status !== 'recorded'), label: "Check completion status" });
  }
  function display() {
    body.replaceChildren(); actions.replaceChildren();
    section.hidden = Boolean(review?.withdrawalActive && !review.closed && !review.completedAt && !state.pending && !state.lastRequestId && !review.blockers.some(key => key.startsWith("completion_")));
    if (!review) { buttons(); return; }
    const fact = (label, text) => node("div", {}, [node("dt", { text: label }), node("dd", { text })]);
    const retained = review.closed || Boolean(review.completedAt) && !review.canComplete;
    if (!retained) {
      body.append(node("p", { text: `${review.work.complete} of ${review.work.total} agreed work items complete.` }));
      const counts = [[review.documents.approved, "approved"], [review.documents.awaitingReview, "awaiting review"], [review.documents.revisions, "with revisions requested"]].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
      body.append(node("p", { text: review.documents.total ? `${review.documents.total} documents${counts.length ? `: ${counts.join(", ")}` : ""}.` : "No documents are recorded." }));
    }
    if (review.documents.securityPending) body.append(node("p", { text: `${review.documents.securityPending} documents need a security check before they can be included in the archive.` }));
    if (review.closed && review.payoutState === "none") body.append(node("p", { text: "No completion payout is recorded." }));
    else body.append(node("dl", { className: "av2-matter-facts av2-completion-amounts" }, [fact("Agreed amount for this assignment", completionMoney(review.grossCents, review.currency)), ]));
    const visibleBlockers = review.blockers.filter(key => (key !== "completed" || !review.completedAt) && (key !== "active_matter_required" || !review.closed));
    if (visibleBlockers.length) body.append(node("ul", {}, visibleBlockers.map(key => node("li", { text: blockerText(key) }))));
    if (!retained) {
      actions.append(link("Review agreed work", `#/matters/${caseId}/work`));
      if (review.documents.total) actions.append(link("Review documents", `#/matters/${caseId}/files`));
    }
    if (review.completedAt && !recordedSummary(review)) body.append(node("p", { text: `${review.closed ? "Closed" : "Completed"} ${timeLabel(review.completedAt)}` }));
    if (review.purgeAt) body.append(node("p", { text: `Archive available until ${timeLabel(review.purgeAt)}` }));
    if (review.archiveReady && !hasArchiveLink) { const archive = link("Download Matter archive", `#/matters/${caseId}/export`); archive.dataset.completionArchive = ""; actions.append(archive); }
    if (state.pending) {
      if (review.canComplete && ["not_found", "not_completed"].includes(review.operation?.status)) actions.append(button("Review completion again", () => { state.pending = null; state.lastRequestId = null; confirming = false; void load(); }));
    } else if (review.canComplete) {
      if (confirming) {
        const heading = node("h3", { text: `Confirm completion of ${review.caseTitle}`, tabindex: "-1", "data-completion-confirmation": "" });
        body.append(heading, node("p", { text: review.mode === "finish_completion" ? "The paralegal payment is already recorded. This action finishes closing the Matter without creating another transfer." : `Completing this Matter releases the agreed payment to ${review.paralegalName} from the existing Matter funds. No new card charge is made.` }), node("p", { text: `The Matter will close to further work, the paralegal’s workspace access will end, and its archive will be retained for ${review.retentionMonths} months after completion. Download your copy during that period. Review any outstanding document instructions before continuing.` }));
        const keepOpen = localFinancialReview(button("Keep Matter open", () => { confirming = false; display(); actions.querySelector("[data-review-completion]")?.focus(); }));
        actions.append(keepOpen, button(review.mode === "finish_completion" ? "Finish Matter completion" : "Complete Matter and release payment", () => void send(), "av2-button"));
        requestAnimationFrame(() => { if (!signal.aborted && confirming) heading.focus({ preventScroll: true }); });
      } else { const begin = localFinancialReview(button("Review completion", () => { confirming = true; display(); }, "av2-button")); begin.dataset.reviewCompletion = ""; actions.append(begin); }
    }
    if (review.completedAt && review.paralegalId && review.payoutState === 'recorded') {
      if (savedPromptId !== review.paralegalId) {
        savedPromptId = review.paralegalId;
        savedPrompt = createSaveParalegal(savedPromptId, { api, signal, ownerId, prompt: true });
      }
      body.append(savedPrompt);
    }
    buttons();
  }
  function failed(error) {
    review = null; confirming = false; section.hidden = false; body.replaceChildren(); actions.replaceChildren(); section.dataset.state = "error";
    if ([401, 403, 404].includes(error.status)) { state.pending = null; state.lastRequestId = null; privateState.completions.delete(caseId); feedback.textContent = "Completion records are no longer available to this account."; }
    else feedback.textContent = "Completion details couldn’t load. Check the current Matter before continuing.";
  }
  async function load({ quiet = false } = {}) {
    if (reading || state.busy || signal.aborted) return;
    reading = true; const ticket = ++sequence, currentController = new AbortController(); controller = currentController; timer = setTimeout(() => currentController.abort(), 30000); buttons(); if (!quiet) feedback.textContent = "Checking work and payment records…";
    try {
      const next = readCompletion(await api.readCompletion(caseId, { ...options, signal: currentController.signal, requestId: state.pending?.requestId || state.lastRequestId }), caseId, ownerId);
      if (signal.aborted || ticket !== sequence) return;
      const changed = review?.revision !== next.revision, hadConfirmation = confirming; if (changed) confirming = false; review = next; section.dataset.state = "ready";
      if (["recorded", "recorded_needs_review"].includes(next.operation?.status) && state.pending) { state.lastRequestId = state.pending.requestId; state.pending = null; }
      if (changed || !quiet || next.operation) display();
      if (recordedSummary(next) || next.operation) feedback.textContent = recordedSummary(next) || outcomeText(next.operation); else if (!quiet) feedback.textContent = ""; else if (changed) feedback.textContent = hadConfirmation ? "Completion details changed. Review the current work and payment records." : "";
    } catch (error) { if (!signal.aborted && ticket === sequence) failed(error); }
    finally { if (ticket === sequence) { clearTimeout(timer); timer = null; controller = null; reading = false; buttons(); } }
  }
  async function send() {
    if (!review?.canComplete || !confirming || reading || state.busy || signal.aborted) return;
    state.pending = { requestId: crypto.randomUUID(), confirmation: completionConfirmation(review) }; state.busy = true; confirming = false; buttons(); feedback.textContent = "Preparing the archive and recording Matter completion…";
    const currentController = new AbortController(); controller = currentController; timer = setTimeout(() => currentController.abort(), 120000);
    let confirmed = false;
    try {
      const result = await api.completeMatter(caseId, state.pending, { ...options, signal: currentController.signal });
      if (signal.aborted) return;
      if (result.completionRecorded === true && result.requestId === state.pending.requestId || result.recovered === true) confirmed = true;
      else throw new Error("Completion acknowledgement unavailable");
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) failed(error);
      else { review = null; recoverFocus = true; display(); feedback.textContent = "Completion could not be confirmed. Stopping the wait does not cancel a payment. Check completion status before taking another action."; }
    } finally { clearTimeout(timer); timer = null; controller = null; state.busy = false; buttons(); }
    if (confirmed && !signal.aborted) await load();
  }
  section.sync = () => load({ quiet: true });
  signal.addEventListener("abort", () => { sequence++; controller?.abort(); clearTimeout(timer); state.busy = false; review = null; section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
