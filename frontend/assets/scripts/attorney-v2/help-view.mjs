import { createHelpCenter } from "../utils/help-center.mjs";
import { createHelpApi } from "./help-api.mjs";
import { HELP_SECTIONS, HELP_RESOURCES } from "./help-content.mjs";
import { node } from "./dom.mjs";
import { readMatter } from "./workspace-model.mjs";

export function createAttorneyHelpView(route, identity, { api, signal, privateState, onSessionLost, openAssistant }) {
  const state = privateState.help;
  if (state.ownerId !== identity.id) { state.controller?.clearDrafts(); state.api?.clear(); Object.keys(state).forEach(key => delete state[key]); state.ownerId = identity.id; }
  if (!state.controller) {
    state.api = createHelpApi({ api, getIdentity: () => state.ownerId === identity.id ? identity : null, onSessionLost });
    state.controller = createHelpCenter({ api: state.api, getIdentity: () => state.ownerId === identity.id ? identity : null, onSessionLost, openAssistant,
      getReportContext: () => {
        const context = state.reportContext;
        if (!context?.include.checked) return {};
        if (!context.ready) throw new Error("Check the related Matter or clear Include this Matter reference to send a general report.");
        return { caseId: context.caseId };
      },
      sections: HELP_SECTIONS, resources: HELP_RESOURCES, title: "Help for Attorneys", introduction: "Guidance for posting, hiring, Matter work and payments.",
      guideLabel: "Attorney Help guide", featureKey: "attorney-v2-help", routeAttribute: "data-av2-route" });
  }
  const controller = state.controller;
  signal.addEventListener("abort", () => controller.leave(), { once: true });
  const view = controller.render({ route, isCurrent: () => !signal.aborted });
  view.classList.add("av2-help");
  view.querySelector(".av2-help-context")?.remove();
  state.reportContext = null;
  const caseId = route.query.get("caseId");
  if (caseId) {
    const include = node("input", { type: "checkbox", id: "av2-help-include-matter", checked: true });
    const status = node("p", { role: "status", text: "Checking related Matter…" });
    const retry = node("button", { type: "button", text: "Check related Matter", hidden: true });
    const contextRoot = node("div", { className: "av2-help-context" }, [
      node("label", { for: include.id }, [include, node("span", { text: "Include this Matter reference" })]), status, retry,
    ]);
    view.querySelector(".v2-help-report-form").prepend(contextRoot);
    const context = state.reportContext = { caseId, include, ready: false };
    let loading = false;
    const current = () => !signal.aborted && state.reportContext === context && state.ownerId === identity.id;
    async function check() {
      if (loading || !current()) return;
      loading = true; context.ready = false; retry.hidden = true; status.textContent = "Checking related Matter…";
      try {
        if (!/^[a-f0-9]{24}$/i.test(caseId)) throw new Error("invalid_context");
        const matter = readMatter(await api.readWorkspaceMatter(caseId, { ownerId: identity.id, signal }), caseId);
        if (!current()) return;
        if (!matter.title.trim() || matter.title.length > 500) throw new Error("invalid_context");
        context.ready = true;
        status.replaceChildren(node("a", { href: `#/matters/${caseId}/overview`, "data-av2-route": "", text: matter.title }));
      } catch {
        if (!current()) return;
        status.textContent = "The related Matter could not be verified. Clear the checkbox to send a general report.";
        retry.hidden = false;
      } finally { loading = false; }
    }
    retry.addEventListener("click", () => { view.readiness = check(); });
    view.readiness = check();
  }
  return view;
}
