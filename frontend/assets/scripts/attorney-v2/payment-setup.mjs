import { node, button, link, page } from "./dom.mjs";
import { getStripe } from "../payments.js";
import { createHiringReturn } from "./pending-hire.mjs";
import { recoverCardSetup, retainCardSetup, clearCardSetupRecovery } from "./payment-setup-recovery.mjs";
import { readDefaultCard, readSetup, readCard, cardLabel, setupMessage, paymentSetupError, consumeSetupReturn } from "./payment-setup-model.mjs";
const p = text => node("p", { text });
let callback = null;
if (typeof window !== "undefined" && ["/attorney-v2.html", "/dashboard-attorney.html"].includes(window.location.pathname)) {
  const value = consumeSetupReturn(window.location.href);
  if (value.present) {
    const clean = new URL(value.cleanUrl, window.location.origin);
    if (clean.pathname === "/dashboard-attorney.html") { clean.searchParams.set("cardSetup", "1"); clean.searchParams.set("workspace", "legacy"); clean.hash = "funds"; }
    window.history.replaceState(window.history.state, "", clean.pathname + clean.search + clean.hash); callback = { intentId: value.intentId };
  }
}
// Bind the opaque return to the freshly verified account before presentation
// routing can leave this document. The destination still verifies it server-side.
export function retainReturnedCardSetup(ownerId) {
  if (!callback) return;
  retainCardSetup(ownerId, { ...recoverCardSetup(ownerId), ...(callback.intentId ? { intentId: callback.intentId } : {}), pending: true });
  callback = null;
}
function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Canceled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export function createPaymentSetup(_route, identity, { api, signal, privateState }) {
  const ownerId = identity.id, state = privateState.paymentSetup;
  const original = window.location.pathname === "/dashboard-attorney.html";
  const currentReturn = original || new URLSearchParams(window.location.search).get("hiringReturn") === "current";
  retainReturnedCardSetup(ownerId);
  if (!state.clearRecovery) Object.assign(state, recoverCardSetup(ownerId));
  state.clearRecovery = clearCardSetupRecovery;
  const section = page("Payment card", "Save the card you want to use for Matter funding. You will review the Matter, paralegal and charge separately before hiring.");
  section.dataset.paymentSetup = "";
  const status = node("p", { role: "status" }), body = node("div"), form = node("div"), result = node("div", { className: "av2-card-setup-result" });
  let generation = 0, readyTimer = null, operation = null, element = null, elements = null, provider = null, complete = false, ready = false, current = null, setup = null;
  const refresh = button("Check saved card and setup", () => void load());
  const start = button("Add a payment card", () => void beginSetup());
  const stop = button("Stop waiting", () => operation?.abort());
  const cardSection = node("section", { className: "av2-card", "aria-label": "Payment card details" }, [node("h2", { text: "Default payment card" }), status, body, node("div", { className: "av2-actions" }, [refresh, start, stop]), form, result]);
  section.append(cardSection, createHiringReturn({ api, signal, ownerId, privateState, hideEmpty: true, current: currentReturn }), link("Return to Payments", currentReturn ? "/dashboard-attorney.html?workspace=legacy#funds" : "#/payments"));
  function destroyForm() { generation++; clearTimeout(readyTimer); readyTimer = null; try { element?.destroy(); } catch {} element = null; elements = null; provider = null; complete = false; ready = false; state.dirty = false; form.replaceChildren(); }
  function controls() {
    cardSection.setAttribute("aria-busy", String(!!operation)); cardSection.querySelectorAll("button").forEach(control => { control.disabled = !!operation && control !== stop; }); stop.hidden = !operation;
    start.hidden = !current || current.bypass || !!element || !!setup || !!state.pending;
    start.textContent = current?.card ? "Use a different card" : "Add a payment card";
    const verify = form.querySelector("[data-verify-card]"); if (verify) verify.disabled = !!operation || !complete || !ready;
  }
  function message(text, phase) { status.textContent = text; cardSection.dataset.state = phase; }
  async function run(action) {
    if (operation || signal.aborted) return;
    const controller = new AbortController(); operation = controller; state.busy = true; const timer = setTimeout(() => controller.abort(), 90000); controls();
    try { await action({ ownerId, signal: controller.signal }); }
    catch (error) { if (!signal.aborted) { destroyForm(); current = null; setup = null; body.replaceChildren(); result.replaceChildren(); message(paymentSetupError(error), state.pending ? "uncertain" : "error"); } }
    finally { clearTimeout(timer); state.busy = false; operation = null; if (!signal.aborted) { retainCardSetup(ownerId, state); controls(); } }
  }
  function render() {
    body.replaceChildren(); result.replaceChildren();
    if (current.bypass) body.append(p("This development account uses a payment testing exception. No saved card was verified."));
    else body.append(p(current.card ? cardLabel(current.card) : "No default payment card is saved."));
    if (setup) {
      result.append(p(setupMessage(setup.status)));
      if (setup.card) {
        result.append(p(cardLabel(setup.card)));
        result.append(p("This choice applies to future Matter funding."), node("div", { className: "av2-actions" }, [button("Set this card as default", () => void setDefault()), button("Use a different card", () => { delete state.intentId; setup = null; void beginSetup(); })]));
      }
      if (["canceled", "requires_payment_method", "requires_confirmation", "requires_action"].includes(setup.status)) result.append(button("Start a new card setup", () => { delete state.intentId; setup = null; void beginSetup(); }));
    }
  }
  async function read(options) {
    const card = readDefaultCard(await api.readDefaultCard(options));
    let returned = state.intentId ? readSetup(await api.readCardSetup(state.intentId, options), ownerId, state.intentId) : null;
    if (signal.aborted) return; options.signal.throwIfAborted(); if (returned?.card && card.card?.id === returned.card.id) { delete state.intentId; returned = null; } current = card; setup = returned; delete state.pending; render();
  }
  async function load() {
    await run(async options => {
      destroyForm(); body.replaceChildren(); result.replaceChildren(); current = null; setup = null; message("Checking the saved card and any unfinished setup…", "loading");
      const recovering = !!state.pending; await read(options); if (signal.aborted) return;
      message(recovering ? "The current provider records are shown below. Review them before continuing." : "", "ready");
    });
  }
  async function beginSetup() {
    if (!current || current.bypass || operation || state.pending) return;
    await run(async options => {
      destroyForm(); result.replaceChildren(); setup = null; state.pending = true; message("Opening the card provider's form…", "loading");
      state.requestId ||= crypto.randomUUID(); retainCardSetup(ownerId, state);
      const value = await api.startCardSetup(state.requestId, options);
      if (signal.aborted) return; options.signal.throwIfAborted();
      if (!/^seti_[A-Za-z0-9]{1,200}$/.test(value?.intentId || "") || typeof value.clientSecret !== "string" || !value.clientSecret.startsWith(`${value.intentId}_secret_`)) throw new Error("invalid_setup");
      state.intentId = value.intentId; delete state.requestId; retainCardSetup(ownerId, state);
      provider = await bounded(getStripe(), options.signal); await api.verifyOwner(options); if (signal.aborted) return; options.signal.throwIfAborted();
      elements = provider.elements({ clientSecret: value.clientSecret, appearance: { theme: document.documentElement.classList.contains("theme-dark") ? "night" : "stripe" } });
      const host = node("div", { "data-card-element": "" });
      const verify = button("Verify card", () => void verifyCard()); verify.dataset.verifyCard = "";
      form.append(node("h3", { text: "Card details" }), p("Enter your card details in the payment provider's form. After verification, you can choose this card as the default."), host, node("div", { className: "av2-actions" }, [verify, button("Close card form", () => { destroyForm(); message("Card entry closed. Check the saved setup before continuing.", "ready"); void load(); })]));
      const ticket = generation; element = elements.create("payment");
      element.on("ready", () => { if (!signal.aborted && element && ticket === generation) { clearTimeout(readyTimer); readyTimer = null; ready = true; controls(); } });
      element.on("change", event => { if (!signal.aborted && element && ticket === generation) { complete = event.complete === true; state.dirty = !event.empty; controls(); } });
      element.on("loaderror", () => { if (!signal.aborted && ticket === generation) { destroyForm(); message("The card provider's form could not load. Check the saved setup before trying again.", "error"); controls(); } });
      readyTimer = setTimeout(() => { if (!signal.aborted && !ready && ticket === generation) { destroyForm(); message("The card form did not finish loading. Check the saved setup before trying again.", "error"); controls(); } }, 25000);
      element.mount(host); delete state.pending; message("", "entry");
    });
  }
  async function verifyCard() {
    if (!elements || !complete || !ready || operation) return;
    await run(async options => {
      state.pending = true; message("Verifying the card with the payment provider…", "verifying"); await api.verifyOwner(options);
      const returnPath = original ? "/dashboard-attorney.html?cardSetup=1&workspace=legacy#funds" : `/attorney-v2.html${currentReturn ? "?hiringReturn=current" : ""}#/payments/setup`;
      const response = await bounded(provider.confirmSetup({ elements, redirect: "if_required", confirmParams: { return_url: window.location.origin + returnPath } }), options.signal);
      if (signal.aborted) return; options.signal.throwIfAborted(); await api.verifyOwner(options);
      if (response?.error && ["validation_error", "card_error"].includes(response.error.type)) { delete state.pending; message("Check the card details and complete any requested authentication, then verify the card again.", "entry"); return; }
      if (response?.error || response?.setupIntent?.id !== state.intentId) throw new Error("setup_unconfirmed");
      destroyForm(); await read(options); if (!signal.aborted) message("", "ready");
    });
  }
  async function setDefault() {
    const reviewed = setup; if (!reviewed?.card || operation || state.pending) return;
    await run(async options => {
      state.pending = true; message("Saving the default payment card…", "saving");
      const value = await api.setDefaultCard(reviewed.card.id, reviewed.intentId, options);
      if (value?.ok !== true || readCard(value.paymentMethod).id !== reviewed.card.id) throw new Error("card_save_unconfirmed");
      if (signal.aborted) return; options.signal.throwIfAborted(); await read(options);
      if (!signal.aborted) message(current.card?.id === reviewed.card.id ? "Default payment card saved." : "The current default card differs from the card just saved. Review the provider records below.", "ready");
    });
  }
  signal.addEventListener("abort", () => { operation?.abort(); destroyForm(); state.busy = false; current = null; setup = null; section.replaceChildren(); }, { once: true });
  controls(); section.readiness = load(); return section;
}
