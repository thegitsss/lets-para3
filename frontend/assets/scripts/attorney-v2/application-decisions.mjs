import { node, button } from "./dom.mjs";
import { readDecision, readDecisionResult, decisionLabels, decisionReason, decisionEffect, decisionSaved, decisionError } from "./application-decision-model.mjs";

export function createApplicationDecisions(caseId, item, { api, signal, ownerId, privateState, onSaved }) {
  const key = `${caseId}:${item.applicantId}`, states = privateState.applicationDecisions;
  if (!states.has(key)) states.set(key, {});
  const state = states.get(key);
  let value = null, chosen = null, busy = false;
  const status = node("p", { role: "status" }), controls = node("div", { className: "av2-actions" }), confirmation = node("div");
  const check = button("Review application decisions", () => void (state.pending ? checkResult() : load()));
  const section = node("section", { "data-application-decisions": item.applicantId, "aria-label": "Application decisions" }, [node("h3", { text: "Application decisions" }), status, check, controls, confirmation]);
  const alive = () => !signal.aborted;
  function render() {
    check.disabled = busy; check.textContent = state.pending ? "Check decision result" : value ? "Refresh decision review" : "Review application decisions";
    section.setAttribute("aria-busy", String(busy)); controls.replaceChildren(); confirmation.replaceChildren();
    if (!state.pending && value) {
      if (!value.actions.length) controls.append(node("p", { text: decisionReason(value.reason) }));
      else if (!chosen) value.actions.forEach(action => controls.append(button(decisionLabels[action], () => { chosen = action; render(); confirmation.querySelector("button")?.focus(); })));
      if (chosen) confirmation.append(node("h4", { text: `${decisionLabels[chosen]}?` }), node("p", { text: `${value.name} · ${value.caseTitle}` }), node("p", { text: decisionEffect(chosen) }), node("div", { className: "av2-actions" }, [button(chosen === "reject" ? "Confirm rejection" : "Save application decision", () => void save()), button("Keep application unchanged", () => { chosen = null; render(); check.focus(); })]));
    }
    [...controls.querySelectorAll("button"), ...confirmation.querySelectorAll("button")].forEach(control => { control.disabled = busy; });
  }
  function message(text, phase) { status.textContent = text; section.dataset.state = phase; }
  async function load() {
    if (busy || !alive() || state.pending) return;
    busy = true; value = null; chosen = null; message("Checking the application before a decision…", "loading"); render();
    try {
      const result = await api.readApplicationDecision(caseId, item.applicantId, { signal, ownerId });
      if (!alive()) return;
      value = readDecision(result, caseId, ownerId, item); message("", "ready");
    } catch (error) { if (alive()) message(decisionError(error), "error"); }
    finally { if (alive()) { busy = false; render(); } }
  }
  function recorded(result) {
    const text = decisionSaved(result.action); delete state.pending; state.busy = false; chosen = null; value = null;
    message(text, "saved"); onSaved(text, { kind: "application_decision", applicantId: item.applicantId, applicationId: item.applicationId, ...result });
  }
  async function checkResult() {
    if (busy || !alive() || !state.pending) return;
    busy = true; message("Checking the saved application decision…", "loading"); render();
    try {
      const result = readDecisionResult(await api.readApplicationDecisionResult(caseId, item.applicantId, state.pending.requestId, { signal, ownerId }), caseId, ownerId, item, state.pending);
      if (!alive()) return;
      if (result) recorded(result);
      else { delete state.pending; chosen = null; value = null; message("No saved decision was found. Review the current application before deciding again.", "unconfirmed"); }
    } catch (error) { if (alive()) message(decisionError(error), "uncertain"); }
    finally { if (alive()) { busy = false; render(); } }
  }
  async function save() {
    if (busy || !alive() || state.pending || !value?.actions.includes(chosen)) return;
    const sent = { requestId: crypto.randomUUID(), revision: value.revision, action: chosen, applicationId: item.applicationId, status: value.status, starred: value.starred };
    state.pending = sent; state.busy = true; busy = true; message("Recording the application decision…", "saving"); render();
    try {
      const response = await api.saveApplicationDecision(caseId, item.applicantId, { requestId: sent.requestId, revision: sent.revision, action: sent.action }, { signal, ownerId });
      if (!alive()) return;
      const result = readDecisionResult(response, caseId, ownerId, item, sent); if (!result) throw new Error("unconfirmed_decision"); recorded(result);
    } catch (error) {
      if (!alive()) return;
      if ([400, 403, 404].includes(error.status) || error.kind === "authentication") { delete state.pending; value = null; chosen = null; message(decisionError(error), "error"); }
      else message("The decision was not confirmed. Check its saved result before making another decision.", "uncertain");
    } finally { state.busy = false; if (alive()) { busy = false; render(); } }
  }
  signal.addEventListener("abort", () => { state.busy = false; section.replaceChildren(); }, { once: true });
  message(state.pending ? "An earlier application decision has not been confirmed. Check its saved result." : "", state.pending ? "uncertain" : "idle"); render(); return section;
}
