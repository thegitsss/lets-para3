import { compactFilters } from "./presentation.mjs";
import { node, button, link, recoveryButton, setRecovery } from "./dom.mjs";
import { readFinancialHistory, financialTypes, financialStates, financialBases, financialMoney, financialDate, financialError } from "./financial-history-model.mjs";
import { objectId } from "./workspace-model.mjs";
export function createFinancialHistory(route, { api, signal, ownerId, onDenied, routeBase = '' }) {
  const href = path => `${routeBase}${path}`;
  const root = node("section", { "data-financial-history": "", "aria-label": "Financial history" }), status = node("p", { role: "status" }), totals = node("div"), list = node("ol", { className: "av2-payment-records" });
  const view = node("select", { id: "av2-financial-view" }); for (const [value, text] of [["all", "All financial records"], ["funding", "Matter funding"], ["payout", "Paralegal payouts"], ["refund", "Refunds"], ["withdrawal", "Withdrawal decisions"], ["chargeback", "Card-provider disputes"], ["review", "Status needs review"]]) view.append(node("option", { value, text }));
  const search = node("input", { id: "av2-financial-search", type: "search", maxlength: "100" }); search.value = (route.query.get("q") || "").slice(0, 100);
  const field = (control, label) => node("div", { className: "av2-payment-field" }, [node("label", { for: control.id, text: label }), control]);
  const form = node("form", { className: "av2-payment-filters" }, [field(view, "Record type"), field(search, "Matter title"), node("button", { type: "submit", className: "av2-secondary", text: "Apply filters" })]);
  if (!routeBase) compactFilters(form, {placeholder:"Search transactions…", signal});
  const selectedCase = objectId(route.query.get("caseId") || route.query.get("highlightCase"));
  let filters = { view: "all", q: search.value.trim(), ...(selectedCase ? { caseId: selectedCase } : {}) }, value = null, rows = [], busy = false, request = null;
  const urls = new Set(), refresh = recoveryButton("Retry", () => void load()), more = button("More records", () => void load(true)), save = button("Download CSV", () => void download()), cancel = button("Cancel request", () => request?.abort());
  refresh.setAttribute("aria-label", "Retry financial history"); refresh.dataset.retryLabel = "Retry financial history";
  root.append(node("h2", { text: selectedCase ? "Financial history for the linked Matter" : "Financial history" }), form, node("div", { className: "av2-actions" }, [refresh, save, cancel]), status, node("div", {className:"av2-transaction-columns", "aria-hidden":"true"}, ["Matter", "Record", "Amount", "Date"].map(text=>node("span",{text}))), list, more, node("details", {className:"av2-secondary-disclosure"}, [node("summary",{text:"Recorded totals"}), totals]));
  if (selectedCase) root.append(link("View financial history for all Matters", href("#/payments")));
  function controls() { for (const control of form.querySelectorAll("input,select,button")) control.disabled = busy; refresh.disabled = busy; save.disabled = busy || !value; more.disabled = busy; more.hidden = !value?.nextCursor; cancel.hidden = !busy;
    setRecovery(refresh, root, { pending: Boolean(value?.summary.pending || value?.summary.requiresReview), label: "Check payment status" });
  }
  function clear() { value = null; rows = []; list.replaceChildren(); totals.replaceChildren(); controls(); }
  form.addEventListener("submit", event => { event.preventDefault(); if (busy) return; filters = { ...filters, view: view.value, q: search.value.trim() }; void load(); });
  function render() {
    totals.replaceChildren();
    if (value.summary.currencies.length) {
      const facts = node("dl", { className: "matter-receipt-details" });
      for (const group of value.summary.currencies) {
        if (group.fundingRecords || group.fundingUnverified) facts.append(node("dt", { text: `Original funding · ${group.currency}` }), node("dd", { text: `${group.fundingRecords ? financialMoney(group.originalFunding, group.currency) : "No verified funding amount"}${group.fundingUnverified ? ` · ${group.fundingUnverified} funding record${group.fundingUnverified === 1 ? " needs" : "s need"} verification` : ""}` }));
        if (group.refundRecords || group.refundsUnverified) facts.append(node("dt", { text: `Recorded refunds · ${group.currency}` }), node("dd", { text: `${group.refundRecords ? financialMoney(group.refunds, group.currency) : "No verified completed refund"}${group.refundsUnverified ? ` · ${group.refundsUnverified} refund record${group.refundsUnverified === 1 ? "" : "s"} not included` : ""}` }));
      }
      if (facts.children.length) totals.append(node("h3", { text: "Recorded totals" }), facts);
    }
    if (value.summary.requiresReview) totals.append(node("p", { text: `${value.summary.requiresReview} record${value.summary.requiresReview === 1 ? " needs" : "s need"} a current status check or review.` }));
    if (value.summary.pending) totals.append(node("p", { text: `${value.summary.pending} request${value.summary.pending === 1 ? " is" : "s are"} still recorded as pending.` }));
    list.replaceChildren(...rows.map(item => {
      const stateLabel = item.type === "withdrawal" && item.state === "decision_recorded" ? "Withdrawal decision recorded" : `${financialTypes[item.type]} · ${financialStates[item.state]}`;
      const identity = node("div", {className:"av2-transaction-identity"}, [node("h3", {}, [link(item.caseTitle, href(`#/matters/${item.caseId}/financials`))])]);
      if (item.paralegalName) identity.append(node("p", {className:"av2-muted", text:item.paralegalName}));
      const record = node("div", {}, [node("p", {text:stateLabel})]);
      if (item.receiptId) record.append(link("View receipt", href(`#/matters/${item.caseId}/receipt?receiptId=${item.receiptId}`)));
      const amountLabel = item.type === "payout" ? "See Matter release" : financialMoney(item.amount,item.currency);
      const basis = item.type === "payout" ? "" : item.basis === "funding_to_verify" ? "Funding unconfirmed" : item.type === "withdrawal" ? "Withdrawal decision" : item.type === "funding" ? "Original funding" : financialBases[item.basis];
      const amountCell = node("div", {}, [node("p", {text:amountLabel}),node("p", {className:"av2-muted",text:basis})]);
      if (item.type === "funding" && ["needs_review","unconfirmed","requires_action"].includes(item.state)) amountCell.append(link("Check funding", href(`#/matters/${item.caseId}/financials`)));
      return node("li", { "data-financial-record": item.id }, [identity,record,amountCell,node("time", {text:item.recordedAt ? financialDate(item.recordedAt) : "Date not recorded"})]);
    }));
    status.textContent = value.total ? "" : "No financial records match this selection."; controls();
  }
  async function action(work) {
    busy = true; request = new AbortController(); const abort = () => request?.abort(); signal.addEventListener("abort", abort, { once: true }); const timer = setTimeout(abort, 45000); controls();
    try { await work(request.signal); }
    catch (error) { if (!signal.aborted) { clear(); root.dataset.state = "error"; status.textContent = financialError(error); if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { status.textContent = "These financial records are no longer available to this account."; onDenied?.(); } } }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); if (!signal.aborted) { busy = false; request = null; controls(); } }
  }
  async function load(append = false) {
    if (busy || signal.aborted || append && !value?.nextCursor) return;
    if (!append) clear(); root.dataset.state = "loading"; status.textContent = "Loading financial history…";
    await action(async checkedSignal => {
      const next = readFinancialHistory(await api.readFinancialHistory({ ...filters, ownerId, signal: checkedSignal, ...(append ? { cursor: value.nextCursor, revision: value.revision } : {}) }), ownerId, filters);
      if (signal.aborted || checkedSignal.aborted) return;
      if (append && (next.revision !== value.revision || next.nextCursor === value.nextCursor || next.total !== value.total || next.entries.some(item => rows.some(old => old.id === item.id)))) throw Object.assign(new Error("financial_history_changed"), { status: 409 });
      rows = append ? [...rows, ...next.entries] : next.entries; value = next; root.dataset.state = "ready"; render();
    });
  }
  async function download() {
    if (busy || signal.aborted || !value) return;
    status.textContent = `Checking all ${value.total} records in this selection for the CSV…`;
    await action(async checkedSignal => {
      const blob = await api.downloadFinancialCsv(value.revision, { ...filters, ownerId, signal: checkedSignal }); if (signal.aborted || checkedSignal.aborted) return;
      const url = URL.createObjectURL(blob); urls.add(url); const anchor = node("a", { href: url, download: "LPC-payment-history.csv", hidden: true }); root.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
      status.textContent = "Check your downloads for the CSV.";
    });
  }
  signal.addEventListener("abort", () => { request?.abort(); urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); rows = []; value = null; root.replaceChildren(); }, { once: true }); controls(); root.readiness = load(); return root;
}
