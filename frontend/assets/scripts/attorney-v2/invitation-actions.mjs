import { node, button, link } from "./dom.mjs";
import { readInvitationOptions, readInvitationReview, confirmInvitation, invitationAmount, invitationReason, invitationActionError } from "./invitation-action-model.mjs";
import { invitationStatus } from "./invitation-model.mjs";
const p = text => node("p", { text });
export function createInvitationActions(paralegalId, { api, signal, ownerId, privateState, caseId = "" }) {
  const states = privateState.invitations;
  if (!states.has(paralegalId)) states.set(paralegalId, {});
  const state = states.get(paralegalId);
  if (!state.pending && caseId) state.caseId = caseId;
  let review = null, operation = null, cursor = "", previous = [], next = null;
  const status = node("p", { role: "status" }), body = node("div"), choices = node("div"), confirmation = node("div");
  const check = button("Review invitation", () => void (state.caseId ? load() : list()));
  const choose = button("Choose a Matter", () => { cursor = ""; previous = []; void list(); });
  const cancel = button("Stop waiting", () => operation?.abort());
  const introduction = p("Choose the Matter and review its amount before sending an invitation.");
  const section = node("section", { className: "av2-card", "data-invitation-actions": paralegalId, "aria-label": "Invite to a Matter" }, [node("h2", { text: "Invite to a Matter" }), introduction, status, node("div", { className: "av2-actions" }, [check, choose, cancel]), choices, body, confirmation]);
  const alive = () => !signal.aborted;
  function message(text, phase) { status.textContent = text; section.dataset.state = phase; }
  function controls() {
    const confirming = confirmation.childElementCount > 0;
    for (const element of [introduction, check, choose, choices, body]) element.hidden = confirming;
    section.setAttribute("aria-busy", String(!!operation)); check.disabled = !!operation; choose.disabled = !!operation || !!state.pending; cancel.hidden = !operation;
    check.textContent = state.pending ? "Check saved invitation" : review ? "Refresh invitation review" : "Review invitation";
    [...body.querySelectorAll("button"), ...choices.querySelectorAll("button"), ...confirmation.querySelectorAll("button")].forEach(control => { control.disabled = !!operation; });
  }
  function begin() { operation = new AbortController(); state.busy = true; const controller = operation, timer = setTimeout(() => controller.abort(), 60000); controls(); return { controller, finish() { clearTimeout(timer); state.busy = false; if (operation === controller) operation = null; if (alive()) controls(); } }; }
  async function list() {
    if (!alive() || operation || state.pending) return;
    const run = begin(); review = null; body.replaceChildren(); choices.replaceChildren(); confirmation.replaceChildren(); message("Loading Matters for invitation review…", "loading");
    try {
      const value = readInvitationOptions(await api.readInvitationOptions(paralegalId, { ownerId, signal: run.controller.signal, cursor }), ownerId, paralegalId, cursor);
      if (!alive()) return; run.controller.signal.throwIfAborted(); next = value.next;
      choices.append(p(value.matters.length ? "Choose a Matter to check whether it permits this invitation." : "No further Matters are available on this page."));
      const items = value.matters.map(item => node("li", {}, [button(item.title, () => { state.caseId = item.caseId; choices.replaceChildren(); void load(); })])); choices.append(node("ul", {}, items));
      choices.append(node("div", { className: "av2-actions" }, [...(previous.length ? [button("Previous Matters", () => { cursor = previous.pop() || ""; void list(); })] : []), ...(next ? [button("Next Matters", () => { previous.push(cursor); cursor = next; void list(); })] : [])])); message("", "choosing");
    } catch (error) { if (alive()) message(invitationActionError(error), "error"); }
    finally { run.finish(); }
  }
  function render() {
    body.replaceChildren(); confirmation.replaceChildren(); if (!review) return;
    body.append(node("h3", { text: review.caseTitle }), p(review.name), p(`Matter amount: ${invitationAmount(review)}`));
    if (review.relisted) body.append(p(`Remaining Matter amount: ${invitationAmount({ ...review, amountCents: review.remainingCents })}`), p("This invitation concerns replacement work within the remaining Matter amount. The original recorded amount stays in the Matter history."));
    else body.append(p(review.amountLocked ? "The Matter amount is already locked. Sending this invitation retains that amount." : "Sending this invitation locks the Matter amount shown above. Hiring and funding happen after the paralegal accepts."));
    if (review.invitation) body.append(p(invitationStatus(review.invitation.status)), p(review.invitation.invitedAt ? `Invited ${new Date(review.invitation.invitedAt).toLocaleString()}` : "Invitation date not recorded."), ...(review.invitation.respondedAt ? [p(`Responded ${new Date(review.invitation.respondedAt).toLocaleString()}`)] : []));
    if (!review.canInvite) body.append(p(invitationReason(review.reason)));
    if (review.canInvite && !state.pending) body.append(button("Review invitation before sending", showConfirmation));
    body.append(node("div", { className: "av2-actions" }, [link("View this Matter's invitations", `#/matters/${review.caseId}/invitations`), link("Review this Matter's applications", `#/matters/${review.caseId}/applications`)])); controls();
  }
  async function load(savedMessage = "") {
    if (!alive() || operation || !state.caseId) return;
    const run = begin(), recovering = !!state.pending; review = null; choices.replaceChildren(); body.replaceChildren(); confirmation.replaceChildren(); message("Checking the Matter amount and invitation status…", "loading");
    try {
      const value = await api.readInvitationReview(state.caseId, paralegalId, { ownerId, signal: run.controller.signal });
      if (!alive()) return; run.controller.signal.throwIfAborted(); review = readInvitationReview(value, state.caseId, ownerId, paralegalId); delete state.pending;
      message(savedMessage || (recovering ? "The current invitation status is shown below. Review it before sending again; this does not confirm the result of the earlier request." : ""), "ready"); render();
    } catch (error) { if (alive()) message(invitationActionError(error), state.pending ? "uncertain" : "error"); }
    finally { run.finish(); }
  }
  function showConfirmation() {
    if (!review?.canInvite || state.pending || operation) return;
    confirmation.replaceChildren(node("h3", { text: "Send this invitation?" }), p(`${review.name} · ${review.caseTitle}`), p(`Recorded Matter amount: ${invitationAmount(review)}`), ...(review.relisted ? [p(`Remaining Matter amount for replacement work: ${invitationAmount({ ...review, amountCents: review.remainingCents })}`)] : []), p(review.relisted ? "The paralegal will receive an invitation for replacement work on this Matter." : review.amountLocked ? "The paralegal will receive an invitation at the Matter's locked amount." : "Sending locks the Matter amount shown here and notifies this paralegal."), p("Accepting an invitation does not hire the paralegal or fund the Matter."), node("div", { className: "av2-actions" }, [button("Send invitation", () => void send()), button("Return to invitation review", () => { confirmation.replaceChildren(); controls(); body.querySelector("button")?.focus(); })])); controls(); confirmation.querySelector("button")?.focus();
  }
  async function send() {
    if (!alive() || operation || state.pending || !review?.canInvite) return;
    const sent = review; state.pending = { caseId: state.caseId }; const run = begin(); message("Sending the Matter invitation…", "saving"); let saved = false;
    try {
      const result = await api.sendReviewedInvitation(sent.caseId, paralegalId, sent.revision, { ownerId, signal: run.controller.signal });
      if (!alive()) return; run.controller.signal.throwIfAborted(); confirmInvitation(result, sent); delete state.pending; saved = true;
    } catch (error) { if (alive()) { review = null; body.replaceChildren(); confirmation.replaceChildren(); message(invitationActionError(error), "uncertain"); } }
    finally { run.finish(); }
    if (saved && alive()) await load("Invitation sent. The current response status is shown below.");
  }
  signal.addEventListener("abort", () => { operation?.abort(); state.busy = false; review = null; section.replaceChildren(); }, { once: true });
  message(state.pending ? "An earlier invitation was not confirmed. Check its saved status before continuing." : "", state.pending ? "uncertain" : "idle"); controls(); return section;
}
