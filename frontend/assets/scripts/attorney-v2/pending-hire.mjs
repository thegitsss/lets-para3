import { node, button, link } from "./dom.mjs";
import { readHiringReturn, hiringReturnHref, paymentSetupError } from "./payment-setup-model.mjs";
const p = text => node("p", { text });
export function createHiringReturn({ api, signal, ownerId, privateState, caseId, paralegalId, name, hideEmpty = false, current = false, autoReview = false }) {
  const state = privateState.hiringReturn, status = node("p", { role: "status" }), body = node("div"), confirmation = node("div");
  let value = null, operation = null;
  const selected = !!caseId && !!paralegalId;
  const setupHref = current ? "/attorney-v2.html?hiringReturn=current#/payments/setup" : "#/payments/setup";
  const refresh = button("Check saved application return", () => void load());
  const stop = button("Stop waiting", () => operation?.abort());
  const title = selected ? "Payment card" : "Continue hiring";
  const refreshActions = node("div", { className: "av2-actions" }, [refresh, stop]);
  const section = node("section", { className: "av2-card", "data-hiring-return": "", "aria-label": title }, [node(selected ? "h3" : "h2", { text: title }), status, refreshActions, body, confirmation]);
  function controls() { section.setAttribute("aria-busy", String(!!operation)); section.querySelectorAll("button").forEach(control => { control.disabled = !!operation && control !== stop; }); stop.hidden = !operation; refresh.hidden = selected && !!value && !state.pending; refreshActions.hidden = refresh.hidden && stop.hidden; refresh.textContent = state.pending ? "Check saved selection" : selected ? "Review card setup" : "Refresh saved application"; }
  function message(text, phase) { status.textContent = text; section.dataset.state = phase; }
  async function run(action) {
    if (operation || signal.aborted) return;
    const controller = new AbortController(); operation = controller; state.busy = true; const timer = setTimeout(() => controller.abort(), 60000); controls();
    try { await action({ ownerId, signal: controller.signal }); }
    catch (error) { if (!signal.aborted) { section.hidden = false; value = null; body.replaceChildren(); confirmation.replaceChildren(); message(paymentSetupError(error), state.pending ? "uncertain" : "error"); } }
    finally { clearTimeout(timer); state.busy = false; operation = null; if (!signal.aborted) controls(); }
  }
  function render(keepVisible = false) {
    body.hidden = false; body.replaceChildren(); confirmation.replaceChildren(); const pending = value.pending, href = hiringReturnHref(pending, { current });
    section.hidden = hideEmpty && !caseId && !pending && !keepVisible;
    const matches = pending?.caseId === caseId && pending?.paralegalId === paralegalId && href;
    const actions = node("div", { className: "av2-actions" });
    if (selected) {
      body.append(p("Return to this application after adding a card."));
      if (matches) actions.append(link("Add payment card", setupHref, "av2-primary"));
      else if (!pending) actions.append(button("Add payment card", () => void save(false, true), "av2-primary"));
      else {
        body.append(p("Another application is saved for card setup."));
        if (href) body.append(p(`${pending.caseTitle} · ${pending.paralegalName}`));
        actions.append(button("Continue with this applicant", event => showConfirmation(false, event.currentTarget), "av2-primary"));
        if (href) actions.append(link("Return to saved application", href));
      }
      if (pending) actions.append(button("Clear saved application", event => showConfirmation(true, event.currentTarget)));
    } else {
      if (href) { body.append(p(`${pending.caseTitle} · ${pending.paralegalName}`)); actions.append(link("Return to this application", href)); }
      else body.append(p(pending ? "This saved application is no longer available. Review the Matter's applicants to continue." : "No application is saved for card setup."));
      if (pending) actions.append(button("Clear saved application", event => showConfirmation(true, event.currentTarget)));
    }
    if (actions.childElementCount) body.append(actions);
  }
  async function load() {
    return run(async options => {
      body.replaceChildren(); confirmation.replaceChildren(); message("Checking your selected application…", "loading");
      const current = readHiringReturn(await api.readPendingHire(options), ownerId); if (signal.aborted) return; options.signal.throwIfAborted();
      const recovering = !!state.pending; delete state.pending; value = current; render(recovering); message("", "ready");
    });
  }
  function showConfirmation(clear, returnFocus) {
    if (!value || operation) return;
    body.hidden = true;
    confirmation.replaceChildren(p(clear ? "Clear this selection? The Matter and application will remain available." : `Continue with ${name || "this applicant"} instead? This replaces the application saved for card setup.`), node("div", { className: "av2-actions" }, [button(clear ? "Clear selection" : "Continue to card setup", () => void save(clear, !clear), "av2-primary"), button("Cancel", () => { confirmation.replaceChildren(); body.hidden = false; returnFocus?.focus(); })])); confirmation.querySelector("button")?.focus();
  }
  async function save(clear, openSetup = false) {
    const reviewed = value; if (!reviewed || operation) return;
    let saved = false;
    await run(async options => {
      state.pending = true; body.replaceChildren(); confirmation.replaceChildren(); message(clear ? "Clearing selection…" : "Saving your selection…", "saving");
      const result = clear ? await api.clearPendingHire(reviewed.revision, options) : await api.savePendingHire(caseId, paralegalId, reviewed.revision, options);
      if (signal.aborted) return; options.signal.throwIfAborted();
      if (result?.saved !== true || result.ownerId !== ownerId || result.cleared !== clear || result.caseId !== (clear ? null : caseId) || result.paralegalId !== (clear ? null : paralegalId)) throw new Error("invalid_return_save");
      const current = readHiringReturn(await api.readPendingHire(options), ownerId); if (signal.aborted) return; options.signal.throwIfAborted();
      if (clear ? current.pending !== null : current.pending?.caseId !== caseId || current.pending?.paralegalId !== paralegalId || !hiringReturnHref(current.pending)) throw Object.assign(new Error("selection_changed"), { status: 409 });
      delete state.pending; value = current; saved = true; render(true); message("", "ready");
    });
    if (saved && openSetup && !signal.aborted) window.location.assign(setupHref);
  }
  signal.addEventListener("abort", () => { operation?.abort(); state.busy = false; value = null; section.replaceChildren(); }, { once: true });
  controls(); if (caseId && !autoReview) message(state.pending ? "Check the saved return before continuing." : "", state.pending ? "uncertain" : "idle"); else section.readiness = load();
  return section;
}
