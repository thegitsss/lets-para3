import { node, button, link, page, recoveryButton, setRecovery } from "./dom.mjs";
import { matterReturnHref } from "./matter-return.mjs";
import { readExport, exportReasons, exportDate } from "./export-model.mjs";
import { fileName } from "./download-model.mjs";

export function createMatterExport(caseId, { api, signal, ownerId, route }) {
  const section = node("section", { className: "matter-notes matter-export", "data-matter-export": caseId, "aria-label": "Matter records download" });
  const feedback = node("p", { role: "status", "data-export-feedback": "" }), body = node("div");
  const refresh = recoveryButton("Retry archive details", () => void load(), "matter-note-button");
  const download = button("Download matter records", () => void save(), "matter-note-button matter-note-primary");
  const cancel = button("Cancel download", () => transfer?.abort(), "matter-note-button");
  section.append(feedback, body, node("div", { className: "matter-note-actions" }, [download, refresh, cancel]));
  let value = null, busy = false, transfer = null;
  const urls = new Set(), alive = () => !signal.aborted;
  const message = (text, state) => { feedback.textContent = text; section.dataset.state = state; };
  function render() {
    if (!alive()) return;
    body.replaceChildren(); download.hidden = value?.access !== "available"; download.disabled = busy; refresh.disabled = busy; cancel.hidden = !transfer;
    setRecovery(refresh, section);
    if (!value) return;
    body.append(node("h2", { text: value.caseTitle }));
    if (value.access !== "available") { body.append(node("p", { text: exportReasons[value.access] })); if (["too_large", "needs_review", "retention_unconfirmed"].includes(value.access)) body.append(link("Contact support", route ? `#/help?caseId=${caseId}` : "/help.html")); return; }
    body.append(node("p", { text: "The ZIP includes your matter details, conversation, documents and earlier versions, confidentiality documents, attorney notes, and available payment receipts." }));
    const details = node("dl", { className: "matter-export-details" });
    for (const [label, detail] of [["Receipts", value.counts.receipts ?? 0], ["Attorney notes", value.counts.notes ?? 0], ["Retained messages", value.counts.messages], ["Documents", value.counts.documents], ["Prior file versions included", value.counts.priorVersions], ["Confidentiality documents included", value.counts.confidentialityDocuments], ["Download available until", exportDate(value.retentionEndsAt)]]) details.append(node("dt", { text: label }), node("dd", { text: String(detail) }));
    body.append(details, node("p", { text: "Deleted messages and files are not included." }));

  }
  function restricted() { value = null; message("This account can no longer access the archive. Sign in again to verify access.", "restricted"); }
  async function load() {
    if (busy || !alive()) return;
    value = null; busy = true; message("Checking the Matter’s archive contents…", "loading"); render();
    try { const next = readExport(await api.readMatterExport(caseId, { signal, ownerId }), caseId, ownerId); if (!alive()) return; value = next; message("", "ready"); }
    catch (error) { if (!alive()) return; if ([401, 403, 404].includes(error.status) || error.kind === "authentication") restricted(); else message(error.code === "EXPORT_RECEIPTS_UNAVAILABLE" ? "A payment receipt needs review before all matter records can be downloaded. Check Payments or contact support." : "The archive details couldn’t be loaded. Refresh them to try again.", "error"); }
    finally { if (alive()) { busy = false; render(); } }
  }
  async function save() {
    if (busy || !alive() || value?.access !== "available") return;
    const reviewed = value; busy = true; transfer = new AbortController(); message("Preparing the Matter archive…", "downloading"); render();
    try {
      const blob = await api.downloadMatterExport(caseId, reviewed.revision, { signal: transfer.signal, ownerId });
      if (!alive() || transfer.signal.aborted) return;
      const url = URL.createObjectURL(blob); urls.add(url);
      const name = fileName(reviewed.filename), anchor = node("a", { href: url, download: name, hidden: true }); section.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
      message(`Download requested for “${name}”. Check your browser’s downloads list for its progress.`, "ready");
    } catch (error) {
      if (!alive()) return;
      if (error.name === "AbortError") message("Archive download canceled.", "ready");
      else if (["EXPORT_EXPIRED", "EXPORT_PURGED", "EXPORT_TOO_LARGE"].includes(error.code)) { value = null; message(exportReasons[({ EXPORT_EXPIRED: "expired", EXPORT_PURGED: "purged", EXPORT_TOO_LARGE: "too_large" })[error.code]], "error"); }
      else if (["EXPORT_CHANGED", "EXPORT_SOURCE_CHANGED", "EXPORT_SOURCE_MISSING", "EXPORT_SOURCE_INVALID", "EXPORT_NOT_READY"].includes(error.code)) { value = null; message("The archive contents changed or are unavailable. Refresh the details before downloading.", "error"); }
      else if ([401, 403, 404].includes(error.status) || error.kind === "authentication") restricted();
      else message(({ EXPORT_RECEIPTS_UNAVAILABLE: "A payment receipt needs review. Check Payments or contact support before downloading all matter records.", EXPORT_SCAN_PENDING: "A document is still being checked for security. Try the archive again after the check finishes.", EXPORT_BLOCKED: "A document did not pass its security check. The archive was not downloaded.", EXPORT_SCAN_ERROR: "A document’s security check could not be completed. The archive was not downloaded." })[error.code] || "The archive couldn’t be downloaded. No download was sent to your browser. Try again when you’re ready.", "error");
    } finally { if (alive()) { busy = false; transfer = null; render(); } }
  }
  signal.addEventListener("abort", () => { transfer?.abort(); value = null; urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
export function createMatterExportBatch(caseIds, options) {
  const section = node("section", { "data-export-batch": "", "aria-label": "Selected Matter archives" }), position = node("p", { role: "status" }), host = node("div");
  let index = 0, child = null;
  const previous = button("Previous Matter", () => show(index - 1), "matter-note-button"), next = button("Next Matter", () => show(index + 1), "matter-note-button");
  section.append(position, host, node("div", { className: "matter-note-actions" }, [previous, next]));
  function show(target) {
    if (options.signal.aborted || target < 0 || target >= caseIds.length) return;
    child?.abort(); child = new AbortController(); index = target; position.textContent = `Matter ${index + 1} of ${caseIds.length}`; previous.disabled = index === 0; next.disabled = index === caseIds.length - 1;
    const archive = createMatterExport(caseIds[index], { ...options, signal: child.signal }); host.replaceChildren(archive); return archive.readiness;
  }
  options.signal.addEventListener("abort", () => { child?.abort(); section.replaceChildren(); }, { once: true }); section.readiness = show(0); return section;
}
export function createExportPage(route, identity, context) {
  const section = page("Download matter records", "Review its contents and retention date before downloading."); section.firstChild.append(link("Back to Matters", matterReturnHref(route)));
  const archive = createMatterExport(route.caseId, { ...context, route, ownerId: identity.id }); section.append(archive); section.readiness = archive.readiness; return section;
}
