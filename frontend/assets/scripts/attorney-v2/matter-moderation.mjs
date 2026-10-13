import { node, button, link } from "./dom.mjs";
import { withMatterReturn } from "./matter-return.mjs";
import { readModeration, confirmsReview, reasonText } from "./moderation-model.mjs";

export function createMatterModeration(caseId, { api, signal, privateState, ownerId, onRecorded = () => {}, current = false, embedded = false, compact = false, onTitleChange = () => {}, openNotes, route }) {
  const state = privateState.moderation.get(caseId) || {};
  privateState.moderation.set(caseId, state);
  const section = node("section", { className: "matter-notes matter-moderation", "aria-label": "Admin edit request", "data-matter-moderation": caseId });
  const feedback = node("p", { role: "status", "data-moderation-feedback": "" });
  const body = node("div", { className: "matter-moderation-body" }), review = node("div", { className: "matter-note-conflict" });
  const check = button("Check review status", () => void load({ announce: true }), "matter-note-button");
  const start = button("Review my changes", () => { if (!state.value?.canRequestReview || !loaded || busy || state.pending) return; state.review = state.value.revision; render(); review.querySelector("button")?.focus(); }, "matter-note-button matter-note-primary");
  section.append(node("h2", { text: "Admin edit request" }), feedback, body, node("div", { className: "matter-note-actions" }, [check, start]), review);
  let busy = false, loaded = false;
  const alive = () => !signal.aborted;
  function message(text, phase = "ready") { feedback.textContent = text; section.dataset.state = phase; }
  function render() {
    if (!alive()) return;
    body.replaceChildren(); review.replaceChildren(); review.hidden = !state.review && !state.pending;
    check.disabled = busy; start.disabled = !loaded || busy || !state.value?.canRequestReview || Boolean(state.pending || state.review);
    const value = state.value;
    if (compact) { check.hidden = !state.pending && !["error","uncertain","conflict"].includes(section.dataset.state); section.hidden = loaded && value?.status === "none" && !state.pending; }
    section.dataset.reviewStatus = value?.status || "unavailable";
    onTitleChange(loaded ? value?.caseTitle : null);
    start.hidden = loaded && value?.status === "none";
    if (value) {
      if (!embedded) body.append(node("h3", { text: value.caseTitle }));
      body.append(node("p", { text: reasonText(value) }));
      if (value.feedback) body.append(node("h3", { text: "Latest admin feedback" }), node("p", { className: "moderation-feedback-text", text: value.feedback }));
      else if (value.status !== "none") body.append(node("p", { text: "Earlier admin feedback may be recorded in the Matter notes." }));
      if (value.flaggedAt) body.append(node("p", { className: "matter-notes-meta", text: `Edits requested ${new Date(value.flaggedAt).toLocaleString()}` }));
      if (value.requestedAt) body.append(node("p", { className: "matter-notes-meta", text: `Review requested ${new Date(value.requestedAt).toLocaleString()}` }));
      if (value.status !== "none") {
        const actions = node("div", { className: "matter-note-actions" }, [link("Review or edit posting", current ? `/create-case.html?caseId=${caseId}` : withMatterReturn(`#/matters/new?caseId=${caseId}`, route), "matter-note-button")]);
        if (openNotes) actions.append(button("Read Matter notes", openNotes, "matter-note-button"));
        body.append(actions);
      }
    }
    if (state.pending) review.append(node("p", { text: "Check review status to find out whether your request was recorded before trying again." }));
    else if (state.review) {
      review.append(node("h3", { text: "Request admin review?" }), node("p", { text: "Confirm that you have addressed the feedback in the saved public posting. This requests a review; the admin decides whether to clear the flag." }), node("div", { className: "matter-note-actions" }, [
        button("Request admin review", () => void persist(), "matter-note-button matter-note-primary"),
        button("Keep editing", () => { delete state.review; render(); start.focus(); }, "matter-note-button"),
      ]));
      review.querySelectorAll("button").forEach(control => { control.disabled = busy || !loaded; });
    }
  }
  function denied() {
    privateState.moderation.delete(caseId); Object.keys(state).forEach(key => delete state[key]); loaded = false;
    message("This Matter's review information is no longer available. Private feedback has been cleared.", "restricted");
  }
  async function load({ announce = false } = {}) {
    if (busy || !alive()) return;
    busy = true; loaded = false; message("Checking review status…", "loading"); render();
    try {
      const value = readModeration(await api.get(`/api/cases/${caseId}/flags/review?expectedOwnerId=${ownerId}`, { signal }), caseId, ownerId);
      if (!alive()) return;
      const pending = state.pending, changed = state.review && state.review !== value.revision;
      state.value = value; loaded = true; delete state.pending;
      if (confirmsReview(value, pending)) { delete state.review; message("Your review request was recorded. The status below is current."); onRecorded(value); }
      else if (pending || changed) { delete state.review; message("The latest Matter and admin request are shown below. Review them before submitting a new request.", "conflict"); }
      else message(announce ? "Review status is up to date." : "");
    } catch (error) {
      if (!alive()) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied();
      else { delete state.value; message("Review status could not be checked. Any unconfirmed request is retained. Check again before submitting.", "error"); }
    } finally { if (alive()) { busy = false; render(); } }
  }
  async function persist() {
    if (busy || !loaded || !alive() || state.pending || !state.value?.canRequestReview || state.review !== state.value.revision) return;
    const sent = { revision: state.review, requestId: crypto.randomUUID() };
    state.pending = sent; busy = true; state.busy = true; message("Requesting admin review…", "saving"); render();
    try {
      const result = await api.requestMatterReview(caseId, sent, { signal, ownerId });
      if (!alive()) return;
      const value = readModeration(result.review, caseId, ownerId);
      if (result.ok !== true || !confirmsReview(value, sent)) throw new Error("unconfirmed_review");
      state.value = value; delete state.pending; delete state.review; message("Your review request was recorded. The flag remains until an admin clears it."); onRecorded(value);
    } catch (error) {
      if (!alive()) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied();
      else message(error.code === "NOTE_LIMIT" ? "The Matter note has reached its limit. Review and shorten it, then check review status before trying again." : "Your request was not confirmed. Check review status before trying again.", "uncertain");
    } finally { if (alive()) { busy = false; state.busy = false; render(); } }
  }
  signal.addEventListener("abort", () => { state.busy = false; }, { once: true });
  section.readiness = load(); return section;
}
