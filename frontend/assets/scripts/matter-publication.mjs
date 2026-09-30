import { node, button, link } from "./attorney-v2/dom.mjs";
import { validDraftId, validRequestId } from "./matter-draft-contract.mjs";

export function readPublication(result) {
  const value = result?.publication;
  if (!value || !validDraftId(value.caseId) || !validDraftId(value.draftId) || !validRequestId(value.requestId) || !["posted", "removed"].includes(value.status)) throw new Error("invalid_publication");
  return value;
}
// Shared by current and V2 editors. Writes happen only after an explicit final
// confirmation. Failed writes must be resolved by a read before another attempt.
export function createPublication({ state, session, api, ownerId, signal, onChange = () => {}, buttonClass = "av2-secondary", matterHref = (id) => `/case-detail.html?caseId=${id}`, returnHref = "#/matters", reviewControl = null, onPublished, confirmationDetails = null, integratedReview = false, onCancel = null }) {
  const publication = state.publication ||= { phase: state.id ? "checking" : "initializing", requestId: crypto.randomUUID(), result: null, request: null, error: "", cleanupFailed: false };
  const root = node("section", { className: "av2-card draft-save-recovery", role: "region", "aria-label": "Publication status", tabindex: -1 });
  const footer = integratedReview ? node("div", {className:"av2-confirmation-footer"}) : null;
  let practices = [], confirmation = false;
  const visible = () => Boolean(publication.result || !["ready", "initializing"].includes(publication.phase) || confirmation || publication.error);
  const options = { ownerId, signal };
  signal.addEventListener("abort", () => {
    if (["busy", "checking", "initializing"].includes(publication.phase)) {
      publication.phase = "uncertain";
      publication.error = "The request was interrupted. Check the publication result before continuing.";
    }
  }, { once: true });
  function render() {
    if (signal.aborted) return;
    const restoreFocus = root.contains(document.activeElement) || Boolean(footer?.contains(document.activeElement));
    footer?.replaceChildren();
    root.hidden = !visible();
    root.dataset.state = publication.phase;
    root.classList.toggle('lpc-matter-outcome', Boolean(publication.result));
    root.replaceChildren(publication.result
      ? node("header", {}, [node("h1", { id: "matter-publication-title", text: publication.result.status === "posted" ? "Matter posted" : "Matter removed" })])
      : node("h2", { text: confirmation ? "Publish Matter?" : "Publish Matter" }));
    if (publication.result) {
      root.append(node("p", { role: "status", text: publication.result.status === "posted" ? "Publishing does not charge you." : "This draft can’t be published again." }));
      const actions = node("div", { className: "av2-actions" });
      if (publication.result.status === "posted") actions.append(link("Open posted Matter", matterHref(publication.result.caseId), buttonClass));
      actions.append(link("Return to Matters", returnHref, buttonClass)); root.append(actions);
      if (publication.cleanupFailed) root.append(node("p", { role: "alert", text: publication.result.status === "posted" ? "The saved draft couldn’t be removed. It can’t be published again." : "The saved draft couldn’t be removed." }), button("Retry draft cleanup", cleanup, buttonClass));
    } else {
      if (publication.error) root.append(node("p", { role: "alert", text: publication.error }));
      if (["checking", "busy"].includes(publication.phase)) root.append(node("p", { role: "status", text: publication.phase === "busy" ? "Confirming publication…" : "Checking publication…" }));
      if (publication.phase === "uncertain") root.append(button("Check publication result", check, buttonClass));
      if (publication.phase === "ready") {
        if (confirmation) {
          root.append(node("p", { text: "Paralegals can apply after publication. Compensation locks after the first application." }));
          const control = node("select", { id: "matter-publishing-practice", "aria-label": "Publishing practice area" }, [node("option", { value: "", text: "Choose a supported practice area" }), ...practices.map((value) => node("option", { value, text: value.replace(/\b\w/g, (letter) => letter.toUpperCase()) }))]);
          control.value = practices.includes(state.values.practiceArea.toLowerCase()) ? state.values.practiceArea.toLowerCase() : "";
          if (!integratedReview || !control.value) root.append(node("label", { for: control.id, text: "Publishing practice area" }), control, node("p", { text: "Choose the category paralegals will browse." }));
          const details=confirmationDetails?.();if(details)(footer || root).append(details);
          const actions=node("div",{className:"av2-actions av2-publication-actions"},[button("Keep editing draft", () => { confirmation = false; render(); onCancel?.(); }, buttonClass),button("Confirm and publish Matter", () => publish(control.value), buttonClass)]);
          (footer || root).append(actions);
        }
      }
    }
    onChange();
    if (restoreFocus && root.isConnected && (document.activeElement === document.body || document.activeElement === root)) {
      if (!root.hidden) root.focus({ preventScroll: true });
      else if (reviewControl?.isConnected && !reviewControl.disabled) reviewControl.focus();
    }
  }
  async function cleanup() {
    if (signal.aborted || !publication.result) return;
    try {
      const result = await api.cleanupMatterPublication(publication.result.requestId, options);
      if (result?.ok !== true) throw new Error("invalid_cleanup");
      if (!signal.aborted) publication.cleanupFailed = false;
    } catch { if (!signal.aborted) publication.cleanupFailed = true; }
    render();
  }
  async function accept(result) {
    publication.result = readPublication(result); publication.phase = "complete"; publication.error = "";
    state.publishedCaseId = publication.result.caseId; state.dirty = false; state.uncertain = false;
    render(); await cleanup();
    if(!signal.aborted && publication.result?.status === "posted") onPublished?.(publication.result);
  }
  async function check() {
    if (signal.aborted || publication.phase === "busy") return;
    // A fresh draft has no publication to reconcile; only options are loading.
    publication.phase = state.id || publication.request ? "checking" : "initializing"; publication.error = ""; render();
    try {
      const result = state.id ? await api.get(`/api/cases/posting/drafts/${state.id}`, { signal }) : null;
      if (signal.aborted) return;
      if (result) { await accept(result); return; }
    } catch (error) {
      if (signal.aborted) return;
      if (error.status !== 404) { publication.phase = "uncertain"; publication.error = "The publication result could not be checked. Your draft remains here."; render(); return; }
    }
    try {
      const data = await api.get("/api/cases/posting/options", { signal });
      if (signal.aborted) return;
      if (!Array.isArray(data.practiceAreas) || !data.practiceAreas.length || data.practiceAreas.some((value) => typeof value !== "string")) throw new Error("invalid_options");
      practices = data.practiceAreas; publication.phase = "ready";
      // Keep the exact request for an explicit retry: a late commit and that
      // retry are arbitrated by the durable request/source indexes.
      if (publication.request) { publication.error = "No publication was found. Review the draft before an explicit retry."; await session.check(); }
    } catch { if (signal.aborted) return; publication.phase = "uncertain"; publication.error = "Publishing options couldn’t be loaded. Check again when connected."; }
    render();
  }
  async function prepare() {
    if (publication.phase !== "ready" || state.publishedCaseId) return;
    const mayFocus = document.activeElement === document.body || document.activeElement === reviewControl || root.contains(document.activeElement);
    publication.phase = "busy"; render();
    const saved = await session.save();
    if (signal.aborted) return;
    publication.phase = "ready";
    if (saved && state.id && !state.dirty && !state.uncertain) { confirmation = true; publication.error = ""; }
    render();
    if (!root.hidden && mayFocus && (document.activeElement === document.body || document.activeElement === reviewControl || root.contains(document.activeElement))) root.focus();
  }
  async function publish(practiceArea) {
    if (publication.phase !== "ready" || !confirmation || state.busy || state.uncertain || state.dirty || !state.id) return;
    if (!practiceArea) { publication.error = "Choose a publishing practice area."; render(); return; }
    publication.phase = "busy"; render();
    const request = { requestId: publication.requestId, draftId: state.id, revision: state.revision, practiceArea };
    // A reviewed change after a definitively rejected request gets a new token;
    // unresolved network outcomes keep their original request identity.
    if (publication.request && JSON.stringify(request) !== JSON.stringify(publication.request)) request.requestId = publication.requestId = crypto.randomUUID();
    publication.request = request;
    try {
      const result = await api.publishMatter(request, options);
      if (!signal.aborted) await accept(result);
    } catch (error) {
      if (signal.aborted) return;
      publication.phase = "uncertain"; confirmation = false;
      publication.error = error.status === 400 ? (error.code === "POSTING_TASKS_INVALID" ? "Publishing requires between 1 and 25 tasks. Your draft has been retained." : "Review the publishing fields. Your draft has been retained.") : error.status === 409 ? "The draft or posting changed. Check the result, then review the saved draft." : "Publication could not be confirmed. Check its result before trying again.";
      render();
    }
  }
  return { root, footer, render, check, prepare, cancel:()=>{if(publication.phase!=="busy"){confirmation=false;render();}}, get visible() { return visible(); }, get locked() { return Boolean(publication.result || ["busy", "checking", "initializing", "uncertain"].includes(publication.phase) || confirmation); }, get result() { return publication.result; } };
}
