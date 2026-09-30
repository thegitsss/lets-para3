import { node, button, link, page, recoveryButton, setRecovery } from "./dom.mjs";
import { createPaymentCard, createPaymentHiringReturn } from "./payment-card.mjs";
import { readPaymentRecords, paymentAmount, fundingLabel, releaseLabel } from "./payment-records-model.mjs";
import { dateLabel, objectId } from "./workspace-model.mjs";
import { createFinancialHistory } from "./financial-history.mjs";
export function createPaymentsPage(route, identity, { api, signal }) {
  const ownerId = identity.id, options = { signal, ownerId };
  const root = page("Payments"); root.dataset.paymentsPage = "";
  const card = createPaymentCard(route, { api, signal, ownerId });
  const status = node("p", { role: "status" }), list = node("ol", { className: "av2-payment-records" }), exact = node("div");
  const filter = node("select", { id: "av2-payment-filter" });
  for (const [value, text] of [["all", "All payment records"], ["unreleased", "Payment not released"], ["released", "Payment release recorded"], ["withdrawal", "Paralegal withdrawal"]]) filter.append(node("option", { value, text }));
  filter.value = ["all", "unreleased", "released", "withdrawal"].includes(route.query.get("view")) ? route.query.get("view") : "all";
  const search = node("input", { id: "av2-payment-search", type: "search", maxlength: "100" }); search.value = (route.query.get("q") || "").slice(0, 100);
  const refresh = recoveryButton("Retry payment records", () => void load()), more = button("Show more payment records", () => void load(true)); more.hidden = true;
  const field = (control, label) => node("div", { className: "av2-payment-field" }, [node("label", { for: control.id, text: label }), control]);
  const form = node("form", { className: "av2-payment-filters" }, [field(filter, "Payment records"), field(search, "Matter title"), node("button", { type: "submit", className: "av2-secondary", text: "Filter payment records" })]);
  let rows = [], nextCursor = null, currentFilter = { view: filter.value, q: search.value.trim() }, busy = false;
  const selectedId = objectId(route.query.get("caseId") || route.query.get("highlightCase"));
  const disclosure = node("details", { className: "av2-payment-lookup" }, [node("summary", {}, [node("h2", { text: "Receipts by Matter" })]), node("p", { text: "Matter amounts exclude attorney fees. Receipts include payment and refund details." }), form, refresh, status, exact, list, more]);
  disclosure.open = Boolean(selectedId || currentFilter.view !== "all" || currentFilter.q);
  const records = node("section", { "aria-label": "Receipts by Matter", "data-payment-records": "" }, [disclosure]);
  const hiringReturn = createPaymentHiringReturn({ api, signal, ownerId });
  const financialHistory = createFinancialHistory(route, { api, signal, ownerId, onDenied: () => { rows = []; nextCursor = null; list.replaceChildren(); exact.replaceChildren(); more.hidden = true; void load(); } });
  root.append(hiringReturn, financialHistory, card, records);
  form.addEventListener("submit", event => { event.preventDefault(); if (busy) return; currentFilter = { view: filter.value, q: search.value.trim() }; void load(); });
  function controls() { refresh.disabled = busy; more.disabled = busy; for (const field of form.querySelectorAll("input,select,button")) field.disabled = busy;
    setRecovery(refresh, records);
  }
  function record(item) {
    const facts = [node("p", { text: item.paralegalName }), node("p", { text: `Matter amount: ${paymentAmount(item.matterAmount, item.currency)}` }), node("p", { text: `${fundingLabel(item.funding)} · ${releaseLabel(item.release)}` })];
    if (item.withdrawal) facts.push(node("p", { text: `Withdrawal decision: ${dateLabel(item.withdrawal.at)} · ${paymentAmount(item.withdrawal.amount, item.currency)}` }));
    if (item.earlierWithdrawals) facts.push(node("p", { text: `${item.earlierWithdrawals} earlier withdrawal decision${item.earlierWithdrawals === 1 ? "" : "s"} recorded.` }));
    if (item.fundingVerifiedAt) facts.push(node("p", { text: `Funding verified: ${dateLabel(item.fundingVerifiedAt)}` }));
    if (item.releasedAt) facts.push(node("p", { text: `Release date recorded: ${dateLabel(item.releasedAt)}` }));
    return node("li", { "data-payment-case": item.id, tabindex: "-1" }, [node("h3", {}, [link(item.title, `#/matters/${item.id}/financials`)]), ...facts, node("div", { className: "av2-actions" }, [link("Review Matter receipts", `#/matters/${item.id}/receipt`), link("Open Matter", `#/matters/${item.id}/overview`)])]);
  }
  async function load(append = false) {
    if (busy || signal.aborted || append && !nextCursor) return; busy = true; controls(); records.dataset.state = "loading"; status.textContent = "Loading payment records…";
    if (!append) { rows = []; nextCursor = null; list.replaceChildren(); exact.replaceChildren(); more.hidden = true; }
    try { const value = readPaymentRecords(await api.readPaymentRecords({ ...options, ...currentFilter, ...(append ? { cursor: nextCursor } : {}), ...(selectedId ? { caseId: selectedId } : {}) }), ownerId); if (signal.aborted) return;
      if (value.view !== currentFilter.view || value.q !== currentFilter.q || append && value.items.some(item => rows.some(previous => previous.id === item.id))) throw new Error("changed_payment_page");
      rows = append ? [...rows, ...value.items] : value.items; nextCursor = value.nextCursor; list.replaceChildren(...rows.map(record)); exact.replaceChildren();
      if (value.selected && !rows.some(item => item.id === value.selected.id)) exact.append(node("h3", { text: "Linked Matter" }), node("ol", { className: "av2-payment-records" }, [record(value.selected)]));
      status.textContent = value.selection === "unavailable" ? "The linked Matter is no longer available to this account." : value.total ? `${rows.length} of ${value.total} Matter${value.total === 1 ? "" : "s"} shown.` : "No Matters match these payment records.";
      more.hidden = !nextCursor; records.dataset.state = "ready";
      if (selectedId && !append && value.selected) requestAnimationFrame(() => { if (!signal.aborted && disclosure.open) { const target = records.querySelector(`[data-payment-case="${selectedId}"]`); target?.scrollIntoView({ block: "center" }); target?.focus({ preventScroll: true }); } });
    } catch { if (!signal.aborted) { rows = []; nextCursor = null; list.replaceChildren(); exact.replaceChildren(); more.hidden = true; disclosure.open = true; records.dataset.state = "error"; status.textContent = "Payment records couldn’t be verified. Refresh to try again."; } }
    finally { if (!signal.aborted) { busy = false; controls(); } }
  }
  signal.addEventListener("abort", () => { rows = []; root.replaceChildren(); }, { once: true });
  root.readiness = Promise.all([card.readiness, hiringReturn.readiness, financialHistory.readiness, load()]); return root;
}
