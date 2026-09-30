import { node, button, link, page, recoveryButton, setRecovery } from "./dom.mjs";
import { financialRefresh, financialHeading } from "./financial-section.mjs";
import { matterReturnHref, withMatterReturn } from "./matter-return.mjs";
import { readReceipt, receiptStatuses, receiptReason, receiptMoney, receiptDate } from "./receipt-model.mjs";
import { fileName } from "./download-model.mjs";
import { createReceiptHistory } from "./receipt-history.mjs";
import { receiptSelection } from "./receipt-history-model.mjs";

export function createMatterReceipt(caseId, { api, signal, ownerId, current = false, showMatterTitle = true, receiptId, onTitleChange, route, compact = false }) {
  const section = node("section", { className: "matter-notes matter-receipt", "data-matter-receipt": caseId, "aria-label": "Matter receipt" });
  const feedback = node("p", { role: "status", "data-receipt-feedback": "" }), body = node("div");
  const refresh = compact ? financialRefresh("Refresh receipt", () => void load()) : recoveryButton("Retry receipt", () => void load(), "matter-note-button");
  const download = button("Download receipt", () => void save(), compact ? "matter-note-button" : "matter-note-button matter-note-primary");
  const cancel = button("Cancel download", () => transfer?.abort(), "matter-note-button");
  const heading = compact ? financialHeading("Receipt", refresh) : null, notices = node("div");
  const details = compact ? node("details", { className: "av2-financial-receipt-details" }, [node("summary", { text: "Details" }), body]) : null;
  section.append(...(heading ? [heading] : []), feedback, notices, details || body, node("div", { className: "matter-note-actions" }, [download, ...(!compact ? [refresh] : []), cancel]));
  let value = null, busy = false, transfer = null, selectedId = receiptId;
  const history = createReceiptHistory(caseId, { api, signal, ownerId, selectedId: () => receiptSelection(selectedId) ? selectedId : undefined, onSelect: id => {
    selectedId = id;
    const target = withMatterReturn(`#/matters/${caseId}/receipt?receiptId=${id}`, route);
    if (!current && window.location.hash !== target) { window.location.hash = target; return; }
    return load();
  }, onDenied: () => { restricted(); render(); } });
  (details || section).append(history);
  const urls = new Set(), alive = () => !signal.aborted;
  const message = (text, state) => { feedback.textContent = text; section.dataset.state = state; };
  function row(list, label, detail) { list.append(node("dt", { text: label }), node("dd", { text: detail })); }
  function render() {
    if (!alive()) return;
    body.replaceChildren(); notices.replaceChildren(); download.hidden = !value?.receipt; download.disabled = busy; refresh.disabled = busy; cancel.hidden = !transfer;
    if (compact) { refresh.setLabel("Refresh receipt", Boolean(value && section.dataset.state === "ready")); heading.querySelector("h2").textContent = value?.receipt?.type === "withdrawal" ? "Withdrawal receipt" : "Receipt"; }
    history.setBusy(busy);
    onTitleChange?.(value?.receipt ? value.receipt.type === "withdrawal" ? "Withdrawal receipt" : "Payment receipt" : "Receipt");
    setRecovery(refresh, section);
    if (!value) return;
    if (showMatterTitle) body.append(node("h2", { text: value.caseTitle }));
    if (!value.receipt) { (compact ? notices : body).append(node("p", { text: receiptReason(value.reason) })); body.append(link("View Payments", current ? "/dashboard-attorney.html#funds" : "#/payments")); return; }
    const r = value.receipt, details = node("dl", { className: "matter-receipt-details" });
    if (!onTitleChange && !compact) body.append(node("h3", { text: r.type === "withdrawal" ? "Withdrawal receipt" : "Payment receipt" }));
    const summaryOutside = compact && r.status !== "received";
    if (summaryOutside) {
      const totalLabel = r.total.label === "Payment less processed refunds" ? "Net payment" : r.total.label;
      notices.append(node("p", { text: `${r.status === "no_payout" ? "" : `${receiptStatuses[r.status]} · `}${totalLabel}: ${receiptMoney(r.total.amount, r.currency)}` }));
    }
    if (r.stripeMode === "test") (compact ? notices : body).append(node("p", { text: "Test record - no money moved" }));
    if (!summaryOutside) row(details, "Status", receiptStatuses[r.status]);
    row(details, r.dateLabel === "Payout recorded" ? "Payout date" : r.dateLabel, receiptDate(r.issuedAt)); row(details, r.type === "withdrawal" ? "Attorney" : "Billed to", r.partyName); row(details, "Receipt number", r.id); row(details, "Currency", r.currency);
    if (r.status !== "no_payout") for (const line of r.lines) row(details, line.label, receiptMoney(line.amount, r.currency));
    if (!summaryOutside) row(details, r.total.label, receiptMoney(r.total.amount, r.currency));
    if (r.status !== "no_payout") row(details, "Payment method", r.method); body.append(details);
    if (r.status === "refund_pending") (compact ? notices : body).append(node("p", { text: compact ? "Refunds still processing are not deducted from this total." : "Pending refunds are shown separately. The total subtracts only refunds already processed." }));
    if (r.status === "payout_recorded" && r.stripeMode !== "test") (compact ? notices : body).append(node("p", { text: "Arrival in the paralegal’s bank account has not been confirmed." }));

  }
  function restricted() { value = null; message("This account can no longer access the receipt. Sign in again to verify access.", "restricted"); }
  async function load({ quiet = false } = {}) {
    if (busy || !alive()) return;
    const previous = value;
    if (!quiet) { value = null; message("Checking the payment details…", "loading"); }
    busy = true; render();
    try {
      if (selectedId !== undefined && !receiptSelection(selectedId)) throw Object.assign(new Error("invalid_receipt_selection"), { code: "RECEIPT_SELECTION_UNAVAILABLE" });
      const next = readReceipt(await api.readMatterReceipt(caseId, { signal, ownerId, receiptId: selectedId }), caseId, ownerId, selectedId);
      if (!alive()) return;
      value = next;
      if (!quiet || !previous || JSON.stringify(previous) !== JSON.stringify(next)) message("", "ready");
    } catch (error) {
      if (!alive()) return;
      value = null;
      if (error.code === "RECEIPT_SELECTION_UNAVAILABLE") message("The linked receipt choice is no longer recorded. Choose another receipt from this Matter's history.", "error");
      else if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { history.clear(); restricted(); }
      else message(error.code === "RECEIPT_CHANGED" ? "The payment details changed. Refresh the receipt to check them again." : "The receipt couldn’t be loaded. Choose Retry receipt to try again.", "error");
    } finally { if (alive()) { busy = false; render(); } }
  }
  section.sync = () => load({ quiet: true });
  async function save() {
    if (busy || !alive() || !value?.receipt) return;
    const reviewed = value;
    busy = true; transfer = new AbortController(); message("Preparing the receipt…", "downloading"); render();
    try {
      const blob = await api.downloadMatterReceipt(caseId, reviewed.revision, { signal: transfer.signal, ownerId, receiptId: selectedId });
      if (!alive() || transfer.signal.aborted) return;
      const url = URL.createObjectURL(blob); urls.add(url);
      const name = fileName(reviewed.receipt.filename), anchor = node("a", { href: url, download: name, hidden: true }); section.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
      message("Download requested. Check your browser’s downloads.", "ready");
    } catch (error) {
      if (!alive()) return;
      if (error.name === "AbortError") message("Receipt download canceled.", "ready");
      else if (error.code === "RECEIPT_SELECTION_UNAVAILABLE") { value = null; message("This receipt choice is no longer recorded. Refresh the receipt history before continuing.", "error"); }
      else if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { history.clear(); restricted(); }
      else if (["RECEIPT_CHANGED", "RECEIPT_NOT_READY"].includes(error.code)) { value = null; message("The payment details changed. Refresh the receipt before downloading.", "error"); }
      else message("The receipt couldn’t be downloaded. No download was sent to your browser. Try again when you’re ready.", "error");
    } finally { if (alive()) { busy = false; transfer = null; render(); } }
  }
  signal.addEventListener("abort", () => { transfer?.abort(); value = null; urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
export function createReceiptPage(route, identity, context) {
  const section = page("Receipt");
  section.firstChild.append(link("Back to Matters", matterReturnHref(route)));
  const receipt = createMatterReceipt(route.caseId, { ...context, route, ownerId: identity.id, onTitleChange: title => { section.querySelector("h1").textContent = title; }, ...(route.query.has("receiptId") ? { receiptId: route.query.get("receiptId") } : {}) }); section.append(receipt); section.readiness = receipt.readiness; return section;
}
