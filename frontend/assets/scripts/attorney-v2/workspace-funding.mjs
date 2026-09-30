import { node, button, link, setRecovery } from "./dom.mjs";
import { financialRefresh, financialHeading } from "./financial-section.mjs";
import { readFunding, readFundingResult, fundingBlockers, fundingMessage, fundingMoney, consumeFundingReturn } from "./funding-model.mjs";
import { timeLabel } from "./workspace-model.mjs";
import { getStripe } from "../payments.js";
import { readCheckout, readCheckoutResume, checkoutMessage } from "./checkout-model.mjs";
let returnedCase = null;
if (typeof window !== "undefined" && window.location.pathname === "/attorney-v2.html") { const returned = consumeFundingReturn(window.location.href); if (returned.present) { window.history.replaceState(window.history.state, "", returned.cleanUrl); returnedCase = returned.caseId; } }
function bounded(promise, signal) { return new Promise((resolve, reject) => { const abort = () => reject(new DOMException("Canceled", "AbortError")); signal.addEventListener("abort", abort, { once: true }); Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)); if (signal.aborted) abort(); }); }
export function createWorkspaceFunding(caseId, { api, signal, ownerId, privateState }) {
  const state = privateState.funding.get(caseId) || { pending: null, busy: false, dirty: false }; privateState.funding.set(caseId, state); state.busy = false;
  if (returnedCase === caseId) { state.pending = { action: "confirm" }; returnedCase = null; }
  const section = node("section", { "aria-label": "Matter funding", "data-workspace-funding": "" }), feedback = node("p", { role: "status" }), body = node("div"), actions = node("div", { className: "av2-actions" }), form = node("div");
  let formGeneration = 0, review = null, checkoutReview = null, controller = null, element = null, elements = null, provider = null, ready = false, complete = false, readyTimer = null, preparedRevision = null;
  const refresh = financialRefresh("Refresh funding details", () => void (review?.hasOriginalCheckout ? inspectCheckout() : load())), stop = button("Stop waiting for payment", () => controller?.abort()); stop.hidden = true;
  section.append(financialHeading("Original payment", refresh), feedback, body, actions, form, node("p", { className: "av2-actions" }, [stop]));
  const money = value => fundingMoney(value, review?.currency || null);
  function destroyForm() { formGeneration++; clearTimeout(readyTimer); readyTimer = null; try { element?.destroy(); } catch {} element = null; elements = null; provider = null; ready = false; complete = false; state.dirty = false; preparedRevision = null; form.replaceChildren(); }
  function controls() { refresh.setLabel(review?.hasOriginalCheckout ? checkoutReview ? "Refresh payment status" : "Review original Checkout" : "Refresh funding details", Boolean(review && !state.pending && (!review.hasOriginalCheckout || checkoutReview))); section.setAttribute("aria-busy", String(state.busy)); refresh.disabled = state.busy; stop.hidden = !state.busy; for (const control of [...actions.querySelectorAll("button"), ...form.querySelectorAll("button")]) control.disabled = state.busy; const pay = form.querySelector("[data-fund-matter]"); if (pay) pay.disabled = state.busy || !ready || !complete;
    setRecovery(refresh, section, { pending: Boolean(state.pending || review?.hasOriginalCheckout && !review.fundingVerified), label: "Check payment status" });
  }
  function display() {
    body.replaceChildren(); actions.replaceChildren(); if (!review) return controls();
    const fact = (label, value) => node("div", {}, [node("dt", { text: label }), node("dd", { text: value })]);
    const fundingStatus = review.fundingVerified ? review.verifiedAt ? `Verified ${timeLabel(review.verifiedAt)}` : "Original payment verified." : fundingMessage(review);
    body.append(node("p", { text: checkoutReview ? checkoutMessage(checkoutReview) : review.hasOriginalCheckout && !review.fundingVerified ? "An earlier Checkout is linked to this Matter. Review its current status before continuing." : fundingStatus, tabindex: "-1", "data-funding-message": "" }), node("dl", { className: "av2-matter-facts av2-funding-amounts" }, [fact("Matter amount", money(review.baseCents)), fact(review.feePct === null ? "Attorney platform fee" : `Attorney platform fee · ${review.feePct}%`, money(review.feeCents)), fact("Total", money(review.totalCents))]));
    const blockers = review.blockers.filter(key => !(review.hasOriginalCheckout && key === "payment_reference_needs_review") && !(review.fundingVerified && key === "payment_review"));
    if (blockers.length) body.append(node("ul", {}, blockers.map(key => node("li", { text: fundingBlockers[key] }))));
    if (review.hasOriginalCheckout) {
      if (checkoutReview?.canResume) actions.append(button("Continue with Stripe", () => void resumeCheckout(), "av2-button"));
      else if (checkoutReview && checkoutReview.state !== "verified") actions.append(link("Request a payment review", `#/help?caseId=${caseId}`));
    }
    if (review.canEditAmount) actions.append(link("Edit the posted Matter amount", `#/matters/new?caseId=${caseId}`));
    if (review.canCheck) actions.append(button("Check funding status", () => void send("check")));
    if (review.canPrepare && !state.pending && !element) actions.append(button("Review payment details", () => void send("prepare"), "av2-button"));
    if (state.pending?.action === "prepare") {
      body.append(node("p", { text: review.operation?.status === "processing" ? "Payment preparation is still being processed. Refresh its status before continuing." : review.operation?.status === "needs_review" ? "LPC needs to review the unfinished payment preparation. Another payment cannot be prepared yet." : "Payment preparation could not be confirmed. Refresh its status before opening another form." }));
      if (review.operation?.status === "not_found") actions.append(button("Start a fresh funding review", () => { state.pending = null; void load(); }));
    } else if (state.pending) body.append(node("p", { text: "Payment completion is unconfirmed. Check funding status before entering payment details again. Stopping the wait does not cancel a payment." }));
    controls();
  }
  function failed(error) { destroyForm(); review = null; checkoutReview = null; body.replaceChildren(); actions.replaceChildren(); section.dataset.state = "error"; if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { privateState.funding.delete(caseId); state.pending = null; feedback.textContent = "Funding details are no longer available to this account."; } else feedback.textContent = state.pending ? "The payment request could not be confirmed. Refresh the funding details, then check Stripe payment before taking another action." : error.status === 409 ? "The funding details changed or need review. Refresh before continuing." : "Funding details couldn’t load. Try again."; }
  async function run(work, { preserveFocus = false } = {}) {
    const focused = preserveFocus && section.contains(document.activeElement) ? document.activeElement : null;
    if (state.busy || signal.aborted) return; const current = new AbortController(); controller = current; state.busy = true; const timer = setTimeout(() => current.abort(), 90000); controls();
    try { await work({ ownerId, signal: current.signal }); }
    catch (error) { if (!signal.aborted) failed(error); }
    finally { clearTimeout(timer); if (controller === current) controller = null; state.busy = false; if (!signal.aborted) { controls(); if (focused?.isConnected && document.activeElement === document.body) focused.focus({ preventScroll: true }); } }
  }
  async function currentReview(options) { const requestId = state.pending?.requestId; const value = readFunding(await api.readFunding(caseId, { ...options, requestId }), caseId, ownerId); options.signal.throwIfAborted(); if (signal.aborted) throw new DOMException("Canceled", "AbortError"); if (requestId ? value.operation?.requestId !== requestId || value.operation.status !== "not_found" && value.operation.action !== state.pending.action : value.operation !== null) throw new Error("unconfirmed_funding_request"); return value; }
  async function inspectCheckout() {
    if (!review?.hasOriginalCheckout) return;
    await run(async options => {
      destroyForm(); checkoutReview = null; display(); feedback.textContent = "Checking the original Checkout with Stripe…";
      const value = await api.readCheckout(caseId, options); review = await currentReview(options); checkoutReview = readCheckout(value, review);
      display(); section.dataset.state = "ready"; feedback.textContent = ""; body.querySelector("[data-funding-message]")?.focus();
    });
  }
  async function resumeCheckout() {
    if (!review || !checkoutReview?.canResume) return;
    await run(async options => {
      feedback.textContent = "Verifying Checkout before opening Stripe…";
      const response = await api.resumeCheckout(caseId, checkoutReview.revision, options);
      review = await currentReview(options); const url = readCheckoutResume(response, review, checkoutReview);
      await api.verifyOwner(options); options.signal.throwIfAborted(); if (signal.aborted) return;
      if (Date.parse(checkoutReview.expiresAt) <= Date.now()) throw Object.assign(new Error("checkout_expired"), { status: 409 });
      window.location.assign(url);
    });
  }
  async function load({ quiet = false } = {}) {
    if (quiet && element) return;
    await run(async options => { let latest; if (quiet && checkoutReview && !state.pending) { latest = await currentReview(options); if (latest.revision === checkoutReview.fundingRevision) { review = latest; return; } } destroyForm(); checkoutReview = null; feedback.textContent = "Checking Matter funding…"; review = latest || await currentReview(options); if (state.pending?.action === "prepare" && ["prepared", "checked"].includes(review.operation?.status) || state.pending?.action === "check" && review.operation?.status === "checked" || review.fundingVerified) state.pending = null; display(); section.dataset.state = "ready"; feedback.textContent = ""; }, { preserveFocus: quiet });
  }
  async function mount(payment, options) {
    provider = await bounded(getStripe(), options.signal); await api.verifyOwner(options); options.signal.throwIfAborted(); if (signal.aborted) return;
    const latest = readFunding(await api.readFunding(caseId, options), caseId, ownerId); if (!latest.canPrepare || latest.revision !== review.revision) throw Object.assign(new Error("funding_changed"), { status: 409 });
    elements = provider.elements({ clientSecret: payment.clientSecret, appearance: { theme: "stripe" } }); preparedRevision = review.revision;
    const heading = node("h3", { text: `Payment for ${review.caseTitle}`, tabindex: "-1" }), host = node("div", { "data-funding-element": "" }), pay = button(`Fund Matter · ${money(review.totalCents)}`, () => void confirmFunding(), "av2-button"); pay.dataset.fundMatter = "";
    form.append(heading, node("p", { text: `This charges ${money(review.totalCents)}: ${money(review.baseCents)} for the Matter and ${money(review.feeCents)} in attorney platform fees. Assigned paralegal: ${review.paralegalName}.` }), host, node("div", { className: "av2-actions" }, [pay, button("Close payment form", () => { destroyForm(); display(); feedback.textContent = "Payment entry closed. No confirmation was sent from this form."; })]));
    const ticket = formGeneration; element = elements.create("payment"); element.on("ready", () => { if (signal.aborted || !element || ticket !== formGeneration) return; ready = true; clearTimeout(readyTimer); controls(); }); element.on("change", event => { if (signal.aborted || ticket !== formGeneration) return; complete = event.complete === true; state.dirty = !event.empty; controls(); }); element.on("loaderror", () => { if (signal.aborted || ticket !== formGeneration) return; destroyForm(); display(); feedback.textContent = "The payment form couldn’t load. Review payment details to try again."; }); element.mount(host); readyTimer = setTimeout(() => { if (!ready && !signal.aborted && ticket === formGeneration) { destroyForm(); display(); feedback.textContent = "The payment form took too long to load. Review payment details to try again."; } }, 30000); heading.focus();
  }
  async function send(action) {
    if (!review || state.busy || action === "prepare" && (!review.canPrepare || state.pending) || action === "check" && !review.canCheck) return;
    await run(async options => { destroyForm(); checkoutReview = null; state.pending = { requestId: crypto.randomUUID(), reviewedRevision: review.revision, action }; display(); feedback.textContent = action === "prepare" ? "Preparing payment details…" : "Checking the payment with Stripe…"; const value = readFundingResult(await api.writeFunding(caseId, state.pending, options), caseId, ownerId, state.pending); options.signal.throwIfAborted(); if (signal.aborted) return; review = value.funding; if (["prepared", "checked"].includes(review.operation.status)) state.pending = null; display(); section.dataset.state = "ready"; feedback.textContent = action === "check" && !review.fundingVerified ? "Stripe payment checked. Completion is not verified." : ""; if (action === "check" && review.fundingVerified) body.querySelector("[data-funding-message]")?.focus(); if (value.payment) { await mount(value.payment, options); display(); } });
  }
  async function confirmFunding() {
    if (!review || !elements || !provider || !ready || !complete || state.busy) return;
    let completed = false;
    await run(async options => { const current = readFunding(await api.readFunding(caseId, options), caseId, ownerId); if (!current.canPrepare || current.revision !== preparedRevision) throw Object.assign(new Error("funding_changed"), { status: 409 }); await api.verifyOwner(options); options.signal.throwIfAborted(); if (signal.aborted) return; state.pending = { action: "confirm" }; feedback.textContent = "Confirming the Matter payment…"; const response = await bounded(provider.confirmPayment({ elements, redirect: "if_required", confirmParams: { return_url: `${window.location.origin}/attorney-v2.html#/matters/${caseId}/financials` } }), options.signal); await api.verifyOwner(options); if (signal.aborted) return; destroyForm(); review = await currentReview(options); display(); section.dataset.state = "ready"; feedback.textContent = response?.error ? "Stripe did not confirm the payment. Check funding status before trying again." : "The payment response was received. Checking its recorded status…"; completed = !response?.error; });
    if (completed && !signal.aborted && review?.canCheck) await send("check");
  }
  section.sync = () => load({ quiet: true }); signal.addEventListener("abort", () => { controller?.abort(); destroyForm(); review = null; checkoutReview = null; state.busy = false; section.replaceChildren(); }, { once: true }); section.readiness = load(); return section;
}
