import { node, button } from "./dom.mjs";
import { readReceiptHistory, receiptHistoryTitle, receiptHistoryDetail } from "./receipt-history-model.mjs";
export function createReceiptHistory(caseId, { api, signal, ownerId, selectedId, onSelect, onDenied }) {
  const root = node("section", { "data-receipt-history": "", "aria-label": "Matter receipt history" }), status = node("p", { role: "status" }), body = node("div");
  let value = null, rows = [], busy = false, locked = false, opened = false, request = null;
  const open = button("Choose another receipt", () => void load(), "matter-note-button"), cancel = button("Cancel receipt history request", () => request?.abort(), "matter-note-button");
  root.append(node("h3", { text: "Receipt history" }), node("div", { className: "matter-note-actions" }, [open, cancel]), status, body);
  function controls() { open.textContent = opened ? "Refresh receipt history" : "Choose another receipt"; open.disabled = busy || locked; cancel.hidden = !busy; body.querySelectorAll("button").forEach(item => { item.disabled = busy || locked; }); }
  function render() {
    body.replaceChildren(); if (!value) { controls(); return; }
    const extra = value.selected && !rows.some(item => item.id === value.selected.id) ? [value.selected] : [];
    body.append(node("p", { text: `${rows.length + extra.length} of ${value.total} receipt choices shown.` }));
    if (value.selection === "unavailable") body.append(node("p", { text: "The linked receipt choice is no longer recorded." }));
    const choices = [...extra, ...rows];
    if (choices.some(item => item.type === "withdrawal")) body.append(node("p", { text: "Decision amounts do not confirm payouts." }));
    const list = node("ol", { className: "av2-payment-records" });
    for (const item of choices) {
      const row = node("li", { "data-receipt-choice": item.id }, [node("h4", { text: receiptHistoryTitle(item) }), node("p", { text: receiptHistoryDetail(item, value.currency) })]);
      if (item.needsReview) row.append(node("p", { text: "The recorded withdrawal details disagree. LPC support needs to review them before a receipt can be issued." }));
      row.append(button("Review this receipt", () => { if (!busy && !locked) void onSelect(item.id); }, "matter-note-button")); list.append(row);
    }
    body.append(list); if (value.nextCursor) body.append(button("More receipt choices", () => void load(true), "matter-note-button")); controls();
  }
  async function load(append = false) {
    if (busy || locked || signal.aborted) return;
    busy = true; opened = true; request = new AbortController(); const abort = () => request?.abort(); signal.addEventListener("abort", abort, { once: true }); const timer = setTimeout(abort, 30000);
    root.dataset.state = "loading"; status.textContent = "Loading receipt history…"; if (!append) { value = null; rows = []; body.replaceChildren(); } controls();
    try {
      const id = selectedId(), next = readReceiptHistory(await api.readReceiptHistory(caseId, { ownerId, signal: request.signal, ...(append ? { cursor: value.nextCursor, revision: value.revision } : {}), ...(id ? { receiptId: id } : {}) }), caseId, ownerId, id);
      if (signal.aborted || request.signal.aborted) return;
      if (append && (next.revision !== value.revision || next.nextCursor === value.nextCursor || next.entries.some(item => rows.some(old => old.id === item.id)))) throw Object.assign(new Error("receipt_history_changed"), { status: 409 });
      rows = append ? [...rows, ...next.entries] : next.entries; value = next; status.textContent = ""; root.dataset.state = "ready"; render();
    } catch (error) {
      if (signal.aborted) return; rows = []; value = null; body.replaceChildren(); root.dataset.state = "error";
      status.textContent = error.name === "AbortError" ? "Receipt history request canceled." : error.status === 413 ? "This Matter exceeds the receipt-history review limit. Contact LPC support for help obtaining its earlier records." : error.status === 409 ? "Receipt history changed or needs review. Refresh the list before continuing." : "Receipt history couldn’t load. Try again.";
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { status.textContent = "Receipt history is no longer available to this account."; onDenied(); }
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); if (!signal.aborted) { busy = false; request = null; controls(); } }
  }
  root.setBusy = state => { locked = state; controls(); };
  root.clear = () => { request?.abort(); value = null; rows = []; body.replaceChildren(); };
  signal.addEventListener("abort", () => { request?.abort(); rows = []; value = null; root.replaceChildren(); }, { once: true }); controls(); return root;
}
