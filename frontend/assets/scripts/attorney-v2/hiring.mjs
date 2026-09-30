import { node, button, link } from "./dom.mjs";
import { createHiringReturn } from "./pending-hire.mjs";
import { cardLabel } from "./payment-setup-model.mjs";
import { readHiringReview, hiringMoney, confirmHiring, hiringReason, hiringError } from "./hiring-model.mjs";
const p = text => node("p", { text });
export function createHiring(caseId, item, { api, signal, ownerId, privateState, onSaved, current = false, autoReview = false, onRequirements, onReviewed }) {
  const applicantId = item.applicantId, key = `${caseId}:${applicantId}`;
  if (!privateState.hiring.has(key)) privateState.hiring.set(key, {});
  const state = privateState.hiring.get(key), status = node("p", { role: "status" }), body = node("div"), confirmation = node("div");
  let review = null, operation = null, returnController = null;
  const refresh = button("Review hiring and funding", () => void load());
  const stop = button("Stop waiting", () => operation?.abort());
  const section = node("section", { className: "av2-card", "aria-label": "Hiring and funding", "data-hiring": applicantId }, [node("h3", { text: "Hiring and funding" }), status, node("div", { className: "av2-actions" }, [refresh, stop]), body, confirmation]);
  function clearBody() { returnController?.abort(); returnController = null; body.replaceChildren(); }
  function controls() { section.setAttribute("aria-busy", String(!!operation)); section.querySelectorAll("button").forEach(control => { control.disabled = !!operation && control !== stop; }); stop.hidden = !operation; refresh.hidden = !!confirmation.childElementCount; refresh.textContent = state.pending ? "Check saved hiring details" : review ? "Refresh hiring review" : "Review hiring and funding"; }
  function message(text, phase) { status.textContent = text; section.dataset.state = phase; }
  async function run(action) {
    if (operation || signal.aborted) return;
    const controller = new AbortController(); operation = controller; state.busy = true; const timer = setTimeout(() => controller.abort(), 90000); controls();
    try { await action({ ownerId, signal: controller.signal }); }
    catch (error) { if (!signal.aborted) { review = null; clearBody(); confirmation.replaceChildren(); message(!state.pending && error?.status >= 500 ? "Hiring details are unavailable. Refresh the review to try again." : hiringError(error), state.pending ? "uncertain" : "error"); } }
    finally { clearTimeout(timer); operation = null; state.busy = false; if (!signal.aborted) controls(); }
  }
  function figures(target, value) {
    target.append(p(`Recorded Matter amount: ${hiringMoney(value, value.budgetCents)}`));
    if (value.relisted) {
      target.append(p(`Remaining amount for replacement work: ${hiringMoney(value, value.remainingCents)}`));
      if (value.canHire) target.append(p("Uses the Matter's remaining funding. No new card charge."));
    }
    else if (value.canResume) target.append(p(`Earlier charge verified: ${hiringMoney(value, value.chargeCents)}`), p("Finish recording this selected hire using the verified charge. No new card charge will be made."));
    else if (!value.assigned) target.append(p(`Attorney platform fee: ${hiringMoney(value, value.feeCents)}`), p(`Total card charge: ${hiringMoney(value, value.chargeCents)}`));
    if (value.card) target.append(p(`Payment card: ${cardLabel(value.card)}`));
  }
  function render() {
    clearBody(); confirmation.replaceChildren(); body.append(node("h4", { text: review.caseTitle }), p(review.name)); figures(body, review);
    const explanation = hiringReason(review); if (explanation && !(current && review.reason === "card_required")) body.append(p(explanation));
    if (review.canHire || review.canResume) body.append(button(review.canResume ? "Review recorded charge and hire" : "Review hiring confirmation", showConfirmation, "av2-primary"));
    if (onRequirements && !review.assigned && !review.canResume && ["ready", "pre_engagement_required", "card_required"].includes(review.reason)) body.append(button("Review pre-engagement requirements", onRequirements));
    if (review.reason === "card_required") {
      if (current) { returnController = new AbortController(); body.append(createHiringReturn({ api, signal: returnController.signal, ownerId, privateState, caseId, paralegalId: applicantId, name: review.name, current: true, autoReview: true })); }
    }
    if (["reconciliation", "processing", "withdrawal_review_required"].includes(review.reason)) body.append(link("Help with this Matter", current ? `/help.html?caseId=${caseId}` : `#/help?caseId=${caseId}`));
    if (review.assigned) body.append(link("Open this Matter", current ? `/case-detail.html?caseId=${caseId}` : `#/matters/${caseId}/overview`));
    controls();
  }
  async function load() {
    await run(async options => {
      clearBody(); confirmation.replaceChildren(); message("Checking the application, requirements, Matter amount and funding…", "loading");
      const value = readHiringReview(await api.readHiringReview(caseId, applicantId, options), caseId, ownerId, applicantId);
      if (signal.aborted) return; options.signal.throwIfAborted(); const recovering = !!state.pending; delete state.pending; review = value; render(); onReviewed?.(value); message(recovering ? "The current hiring and funding records are shown below. Review them before continuing." : "", "ready");
    });
  }
  function showConfirmation() {
    if (!review || operation || state.pending || !review.canHire && !review.canResume) return;
    clearBody();
    confirmation.replaceChildren(...(current ? [] : [node("h4", { text: review.canResume ? "Finish this recorded hire?" : "Confirm this hire?" })]), p(`${review.caseTitle} · ${review.name}`)); figures(confirmation, review);
    confirmation.append(p("The selected paralegal will be assigned to this Matter. Other applicants will not be selected, and pending invitations will close."), node("div", { className: "av2-actions" }, [button(review.canResume ? "Finish hire using recorded charge" : review.relisted ? "Hire replacement paralegal" : `Hire and charge ${hiringMoney(review, review.chargeCents)}`, () => void submit(), "av2-primary"), button("Return to hiring review", () => { render(); body.querySelector("button")?.focus(); })])); controls(); confirmation.querySelector("button")?.focus();
  }
  async function submit() {
    if (!review || operation || state.pending || !review.canHire && !review.canResume) return;
    const displayed = review; let saved = false;
    await run(async options => {
      state.pending = { caseId, applicantId }; message(displayed.canResume ? "Finishing the hire using the recorded charge…" : displayed.relisted ? "Assigning the replacement paralegal…" : "Submitting the reviewed hire and charge…", "saving");
      const value = await api.hireReviewedApplicant(caseId, applicantId, displayed.revision, options);
      if (signal.aborted) return; options.signal.throwIfAborted(); confirmHiring(value, displayed); delete state.pending; saved = true;
    });
    if (saved && !signal.aborted) {
      state.confirmed = true;
      if (onSaved) onSaved("Hire recorded. Review the assigned paralegal and Matter funding below."); else await load();
    }
  }
  signal.addEventListener("abort", () => { operation?.abort(); returnController?.abort(); state.busy = false; review = null; section.replaceChildren(); }, { once: true });
  controls(); message(state.pending ? "An earlier hiring result was not confirmed. Check its saved details before continuing." : "", state.pending ? "uncertain" : "idle");
  if (state.confirmed || autoReview && !state.pending) { delete state.confirmed; section.readiness = load(); }
  return section;
}
