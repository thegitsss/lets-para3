import { node, button, link, setRecovery } from "./dom.mjs";
import { financialRefresh, financialHeading, localFinancialReview } from "./financial-section.mjs";
import { readDisputes, disputeStatus, disputeNotice, disputeAmount, disputeLink } from "./disputes-model.mjs";
import { timeLabel } from "./workspace-model.mjs";
export function createWorkspaceDisputes(caseId, { api, signal, ownerId, route, privateState }) {
  const state = privateState.disputes.get(caseId) || { opening: "", comments: {}, pending: null, busy: false }; privateState.disputes.set(caseId, state); state.busy = false;
  const section = node("section", { "aria-label": "Dispute review", "data-workspace-disputes": "" }), feedback = node("p", { role: "status" }), history = node("div"), discussion = node("div"), editor = node("div");
  const commentEditor = node("div");
  const refresh = financialRefresh("Refresh dispute review", () => void load()), stop = button("Stop waiting", () => { recoverFocus = true; controller?.abort(); }); stop.hidden = true;
  section.append(financialHeading("Dispute review", refresh), feedback, history, discussion, editor, stop);
  let review = null, items = [], comments = [], listCursor = null, commentCursor = null, confirming = false, reading = false, quietReading = false, stale = false, controller = null, timer = null, sequence = 0, recoverFocus = false;
  let selectedId = route.query.get("disputeId") || null;
  const options = { ownerId, signal };
  function controls() {
    if (!state.busy && document.activeElement === stop) recoverFocus = true;
    refresh.disabled = reading || state.busy; refresh.setLabel(state.pending ? "Check saved dispute" : "Refresh dispute review", Boolean(review && !state.pending && !stale)); stop.hidden = !state.busy;
    for (const input of section.querySelectorAll("textarea, button[data-dispute-action]")) input.disabled = state.busy || stale || reading && !input.hasAttribute("data-financial-local-review") && (input.tagName !== "TEXTAREA" || !quietReading);
    if (recoverFocus && !refresh.disabled) {
      recoverFocus = false;
      if (!signal.aborted && [stop, document.body, document.documentElement, section.closest("main")].includes(document.activeElement)) refresh.focus({ preventScroll: true });
    }

    setRecovery(refresh, section, { pending: Boolean(state.pending || stale), label: "Check dispute status" });
  }
  const action = (name, callback, local = false) => { const value = button(name, callback); value.dataset.disputeAction = ""; return local ? localFinancialReview(value) : value; };
  function retainedText(label, value) {
    return node("details", { className: "av2-preview av2-dispute-draft" }, [node("summary", { text: label }), node("p", { className: "av2-preserve-lines", text: value })]);
  }
  function renderCommentEditor() {
    commentEditor.replaceChildren();
    const selected = review?.selected;
    if (!selected) return;
    const draft = state.comments[selected.id] || "";
    if (stale || !selected.canComment || state.pending) {
      if (draft.trim()) commentEditor.append(retainedText("Your comment text", draft));
      return;
    }
    const text = node("textarea", { id: `dispute-comment-${caseId}`, rows: "5", maxlength: "10000" }); text.value = draft; text.addEventListener("input", () => { state.comments[selected.id] = text.value; });
    commentEditor.append(node("label", { for: text.id, text: "Add a comment" }), text, node("p", { className: "av2-muted", text: "Shared with the Matter participants and administrators." }), action("Record comment", () => void save("comment")));
  }
  function recoverEditors() {
    recoverFocus = recoverFocus || editor.contains(document.activeElement) || commentEditor.contains(document.activeElement);
    history.querySelector("[data-dispute-empty]")?.remove();
    renderCommentEditor(); renderEditor(); controls();
  }
  function renderHistory() {
    history.replaceChildren(); if (!review) return;
    const onlySelected = review.total === 1 && items.length === 1 && items[0].id && items[0].id === review.selected?.id && !listCursor;
    if (!review.total && !review.canOpen) history.append(node("p", { "data-dispute-empty": "", text: "No dispute has been opened for this Matter." }));
    else if (review.total && !onlySelected) {
      history.append(node("p", { text: `${review.total} ${review.total === 1 ? "dispute" : "disputes"} recorded` }), node("ol", { className: "av2-matter-timeline" }, items.map(value => node("li", {}, [value.id ? link(`${disputeStatus(value.status)} · ${timeLabel(value.createdAt)}`, disputeLink(caseId, value.id)) : node("strong", { text: "Earlier dispute without an identifier" }), node("p", { text: value.message.length > 180 ? `${value.message.slice(0, 180)}…` : value.message })]))));
      if (listCursor) history.append(action("Show earlier disputes", () => void load({ more: "disputes" })));
    }
    const notice = disputeNotice(review.reason); if (notice && !(review.total && review.reason === "funded_work_required")) history.append(node("p", { text: notice }));
    if (review.selection === "unavailable") history.append(node("p", { text: "The linked dispute is no longer available on this Matter." }));
  }
  function renderDiscussion() {
    discussion.replaceChildren(); const selected = review?.selected; if (!selected) return;
    discussion.append(node("h3", { text: disputeStatus(selected.status) }), node("p", { text: `Reported by ${selected.raisedBy.name} · ${timeLabel(selected.createdAt)}` }), node("p", { className: "av2-preserve-lines", text: selected.message }));
    if (selected.requestedAmount !== null) discussion.append(node("p", { text: `Amount requested by the reporting participant: ${disputeAmount(selected.requestedAmount, review.currency)}. This is a request, not a recorded payment.` }));
    if (selected.id) discussion.append(link("Link to this dispute", disputeLink(caseId, selected.id)));
    if (selected.decision) {
      const value = selected.decision, label = { refund: "Refund", release_full: "Full release", release_partial: "Partial release" }[value.action];
      discussion.append(node("h4", { text: "Recorded administrator decision" }), node("p", { text: `${label} · ${timeLabel(value.at)}` }), node("p", { text: `Payment decision recorded. Refund in the decision: ${disputeAmount(value.refundCents, review.currency)}.` }), node("p", { text: "The decision does not by itself confirm a completed transfer or refund. Check the payment record and receipt for their current status." }), link("Review Matter receipt", `#/matters/${caseId}/receipt`));
    }
    discussion.append(node("h4", { text: selected.commentCount ? `Discussion · ${selected.commentCount} ${selected.commentCount === 1 ? "comment" : "comments"}` : "Discussion" }));
    const commentRow = value => node("li", { ...(value.id ? { "data-dispute-comment": value.id, tabindex: "-1" } : {}) }, [node("strong", { text: value.by.name }), node("time", { text: timeLabel(value.createdAt) }), node("p", { className: "av2-preserve-lines", text: value.text })]);
    if (selected.selectedComment && !comments.some(value => value.id === selected.selectedComment.id)) discussion.append(node("p", { text: "Linked earlier comment" }), node("ol", { className: "av2-matter-timeline" }, [commentRow(selected.selectedComment)]));
    discussion.append(node("ol", { className: "av2-matter-timeline" }, comments.map(commentRow)));
    if (!selected.commentCount) discussion.append(node("p", { text: "No comments have been recorded." }));
    if (selected.commentSelection === "unavailable") discussion.append(node("p", { text: "The linked comment is no longer available in this discussion." }));
    if (commentCursor) discussion.append(action("Show earlier comments", () => void load({ more: "comments" })));
    renderCommentEditor(); discussion.append(commentEditor);
    if (!selected.canComment) discussion.append(node("p", { text: "This earlier dispute cannot accept a comment because its identifier could not be verified." }));
    const linkedId = route.query.get("commentId"); if (linkedId) requestAnimationFrame(() => { if (!signal.aborted) discussion.querySelector(`[data-dispute-comment="${CSS.escape(linkedId)}"]`)?.focus({ preventScroll: true }); });
  }
  function renderEditor() {
    editor.replaceChildren(); if (!review) return;
    if (state.pending) {
      if (state.pending.action === "open") editor.append(retainedText("Your dispute details", state.pending.text));
      if (review.operation?.status === "not_found") editor.append(action("Try recording this request again", () => void save(state.pending.action, true)));
      return;
    }
    if (stale || !review.canOpen) {
      if (state.opening.trim()) editor.append(retainedText("Your dispute details", state.opening));
      return;
    }
    const entry = node("details", { className: "av2-preview", "data-dispute-entry": "" }, [node("summary", { text: "Report a disagreement" })]);
    entry.open = Boolean(state.editorOpen || state.opening);
    editor.append(entry);
    const text = node("textarea", { id: `dispute-opening-${caseId}`, rows: "6", maxlength: "20000" }); text.value = state.opening; text.addEventListener("input", () => { state.opening = text.value; confirming = false; renderConfirmation(); });
    entry.append(node("label", { for: text.id, text: "Dispute details" }), text);
    const decisions = node("div", { className: "av2-actions" }); entry.append(decisions);
    entry.addEventListener("toggle", () => { state.editorOpen = entry.open; if (!entry.open) { confirming = false; renderConfirmation(); } });
    function renderConfirmation() {
      decisions.replaceChildren();
      if (confirming) {
        requestAnimationFrame(() => { if (!signal.aborted) decisions.querySelector("[data-dispute-confirmation]")?.focus(); });
        decisions.append(node("p", { "data-dispute-confirmation": "", tabindex: "-1", text: `Opening a dispute for “${review.caseTitle}” pauses further work while an administrator reviews it. Your details are shared with the Matter participants and administrators. This action does not automatically release or refund a payment.` }), action("Keep editing", () => { confirming = false; renderConfirmation(); text.focus(); }, true), action("Open dispute review", () => void save("open")));
      } else decisions.append(action("Review dispute request", () => { if (!state.opening.trim()) { feedback.textContent = "Describe the disagreement before requesting review."; text.focus(); return; } confirming = true; renderConfirmation(); }, true));
      controls();
    }
    renderConfirmation();
  }
  function render() { renderHistory(); renderDiscussion(); renderEditor(); controls(); }
  function failed(error) {
    review = null; items = []; comments = []; confirming = false; history.replaceChildren(); discussion.replaceChildren(); editor.replaceChildren(); section.dataset.state = "error";
    if ([401, 403, 404].includes(error.status)) { state.opening = ""; state.comments = {}; state.pending = null; privateState.disputes.delete(caseId); feedback.textContent = "Dispute records are no longer available to this account."; }
    else feedback.textContent = "Dispute review couldn’t load. Refresh it before continuing.";
  }
  async function load({ quiet = false, more = null } = {}) {
    if (reading || state.busy || signal.aborted) return;
    const hadEditorFocus = editor.contains(document.activeElement) || commentEditor.contains(document.activeElement);
    reading = true; quietReading = quiet; const ticket = ++sequence, currentController = new AbortController(); controller = currentController; timer = setTimeout(() => currentController.abort(), 30000); controls(); if (!quiet) feedback.textContent = "Loading dispute review…";
    try {
      const next = readDisputes(await api.readDisputes(caseId, { ...options, signal: currentController.signal, disputeId: selectedId, commentId: route.query.get("commentId") || null, requestId: state.pending?.requestId, ...(more === "disputes" ? { cursor: listCursor } : more === "comments" ? { commentCursor } : {}) }), caseId, ownerId);
      if (signal.aborted || ticket !== sequence) return;
      // Follow current decisions when no editor or earlier history page needs
      // preservation. A draft typed during the read still prevents replacement.
      const followReview = Boolean(quiet && !more && review && next.revision !== review.revision && !state.pending && !confirming && !hadEditorFocus && !editor.contains(document.activeElement) && !commentEditor.contains(document.activeElement) && !state.opening.trim() && !Object.values(state.comments).some(text => text.trim()) && !route.query.get("commentId") && (!selectedId || next.selected?.id === selectedId) && items.length === review.items.length && comments.length === (review.selected?.comments.length || 0));
      if ((quiet || more) && review && next.revision !== review.revision && !state.pending && !followReview) {
        const firstChange = !stale;
        stale = true; confirming = false; feedback.textContent = "The dispute discussion or decision changed. Refresh it to read the current record.";
        if (firstChange) recoverEditors();
        return;
      }
      if (quiet && review && !state.pending && !followReview) return;
      stale = false; confirming = false; review = next;
      if (more === "disputes") items.push(...next.items); else if (more !== "comments") items = next.items;
      if (more === "comments") comments.push(...next.selected.comments); else if (more !== "disputes") comments = next.selected?.comments || [];
      if (more !== "comments") listCursor = next.nextCursor; if (more !== "disputes") commentCursor = next.selected?.nextCommentCursor || null;
      if (!selectedId) selectedId = next.selected?.id || null;
      if (next.operation?.status === "recorded" && state.pending) {
        const pending = state.pending;
        if (pending.action === "open" && state.opening.trim() === pending.text.trim()) state.opening = "";
        if (pending.action === "comment" && (state.comments[pending.disputeId] || "").trim() === pending.text.trim()) state.comments[pending.disputeId] = "";
        state.pending = null; feedback.textContent = `${next.operation.action === "open" ? "Dispute review opened" : "Comment recorded"}.${next.operation.changedSinceSave ? " That record has since changed; review its current discussion." : ""}`;
      } else if (next.operation?.status === "not_found") feedback.textContent = "This request has no recorded outcome yet. Check again or explicitly retry the same request.";
      else if (!quiet || followReview) feedback.textContent = "";
      section.dataset.state = "ready"; if (!quiet || next.operation || followReview) render();
    } catch (error) { if (!signal.aborted && ticket === sequence) failed(error); }
    finally { if (ticket === sequence) { clearTimeout(timer); timer = null; controller = null; reading = false; quietReading = false; controls(); } }
  }
  async function save(actionName, retry = false) {
    if (reading || state.busy || stale || signal.aborted || !review) return;
    if (!retry) {
      if (state.pending || actionName === "open" && (!confirming || !review.canOpen) || actionName === "comment" && !review.selected?.canComment) return;
      const text = actionName === "open" ? state.opening : state.comments[review.selected.id] || "";
      if (!text.trim()) { feedback.textContent = "Write the details you want to record."; return; }
      state.pending = { action: actionName, text, requestId: crypto.randomUUID(), reviewedRevision: review.revision, ...(actionName === "comment" ? { disputeId: review.selected.id, reviewedDisputeRevision: review.selected.revision } : {}) };
    }
    state.busy = true; controls(); feedback.textContent = actionName === "open" ? "Opening dispute review…" : "Recording comment…";
    const currentController = new AbortController(); controller = currentController; timer = setTimeout(() => currentController.abort(), 45000); let confirmed = false;
    try {
      const value = await api.recordDispute(caseId, state.pending, { ...options, signal: currentController.signal }); if (signal.aborted) return;
      if (value.caseId !== caseId || value.ownerId !== ownerId || value.operation?.status !== "recorded") throw new Error("Invalid dispute acknowledgement");
      selectedId = value.operation.disputeId; confirmed = true;
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) failed(error);
      else { if (error.status === 409) state.pending = null; stale = true; confirming = false; recoverFocus = true; feedback.textContent = error.status === 409 ? "The dispute or Matter changed. Your text is retained; refresh before recording it." : "This request could not be confirmed. Your text is retained. Check the saved dispute before trying again."; recoverEditors(); }
    } finally { clearTimeout(timer); timer = null; controller = null; state.busy = false; controls(); }
    if (confirmed && !signal.aborted) await load();
  }
  section.sync = () => load({ quiet: true });
  signal.addEventListener("abort", () => { sequence++; controller?.abort(); clearTimeout(timer); state.busy = false; review = null; section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
