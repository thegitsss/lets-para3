import { node, button, link } from "./dom.mjs";
import { readEarlierFiles, earlierFileLabel, earlierFileDetail, earlierFileError } from "./earlier-files-model.mjs";
import { fileName } from "./download-model.mjs";
export function createWorkspaceEarlierFiles(caseId, { api, signal, ownerId, route, onDenied }) {
  const root = node("section", { "aria-label": "Earlier Matter files", "data-earlier-files": "" }), feedback = node("p", { role: "status" }), body = node("div");
  let value = null, entries = [], opened = false, busy = false, controller = null, objectUrl = null, sequence = 0;
  const open = button("Earlier Matter files", () => void load()), stop = button("Cancel earlier-file request", () => controller?.abort());
  root.append(node("h3", { text: "Earlier Matter files" }), node("p", { text: "Find earlier attachments and history retained after a document was removed. Current documents have their own Document history controls." }), node("div", { className: "av2-actions" }, [open, stop]), feedback, body);
  function controls() { open.disabled = busy; open.textContent = opened ? "Refresh earlier files" : "View earlier files"; stop.hidden = !busy; body.querySelectorAll("button").forEach(control => { control.disabled = busy; }); }
  function clear() { sequence++; controller?.abort(); controller = null; busy = false; value = null; entries = []; body.replaceChildren(); if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; }
  function denied(error) { clear(); root.dataset.state = "restricted"; feedback.textContent = "Earlier files are no longer available to this account."; onDenied?.(error); }
  function render() {
    body.replaceChildren(); controls(); if (!value) return;
    if (value.access !== "available") {
      body.append(node("p", { text: value.access === "archive_only" ? "Individual files are closed for this Matter. Review its retained archive." : value.access === "purged" ? "The Matter's retained files have been removed." : "Earlier files are unavailable in this Matter's current state." }));
      if (value.access === "archive_only") body.append(link("Review Matter archive", `#/matters/${caseId}/export`)); return;
    }
    const selected = value.selected && !entries.some(entry => entry.id === value.selected.id) ? [value.selected] : [];
    body.append(node("p", { text: `${entries.length + selected.length} of ${value.total} earlier file records shown.` }));
    if (value.selection === "unavailable") body.append(node("p", { text: "The linked earlier file is no longer available." }));
    const list = node("ul", { className: "av2-file-list" });
    for (const entry of [...selected, ...entries]) {
      const row = node("li", { "data-earlier-file": entry.id }, [node("h4", { text: earlierFileLabel(entry) }), node("p", { text: earlierFileDetail(entry) })]);
      if (entry.kind !== "earlier_attachment") row.append(node("p", { className: "av2-muted", text: "The retained link identifies its document record. The original filename, size and version number may not have been recorded." }));
      row.append(entry.available ? button("Download earlier file", () => void download(entry)) : node("p", { text: "The stored reference needs review before this file can be downloaded." })); list.append(row);
    }
    body.append(list);
    if (!entries.length) body.append(node("p", { text: "No separate earlier attachments or removed-document history are recorded for this Matter." }));
    if (value.nextCursor !== null) body.append(button("More earlier files", () => void load({ append: true }))); controls();
  }
  async function load({ append = false, quiet = false } = {}) {
    if (busy || signal.aborted || quiet && (!opened || root.contains(document.activeElement))) return;
    busy = true; opened = true; controller = new AbortController(); const ticket = ++sequence, cursor = append ? value?.nextCursor : null;
    feedback.textContent = append ? "Loading more earlier files…" : "Loading earlier Matter files…"; root.dataset.state = "loading"; controls();
    try {
      let result = readEarlierFiles(await api.readEarlierFiles(caseId, { ownerId, signal: controller.signal, cursor, revision: append ? value.revision : null, referenceId: route.query.get("earlierFileId") || "" }), caseId, ownerId, route.query.get("earlierFileId") || "");
      if (signal.aborted || ticket !== sequence || controller.signal.aborted) return;
      if (append && (result.revision !== value.revision || result.nextCursor === cursor || result.entries.some(entry => entries.some(old => old.id === entry.id)))) throw Object.assign(new Error("earlier_files_changed"), { status: 409 });
      if (quiet && value?.revision === result.revision) { feedback.textContent = ""; root.dataset.state = "ready"; return; }
      let loaded = result.entries;
      if (quiet && entries.length > loaded.length) {
        const target = entries.length, seen = new Set();
        while (result.nextCursor !== null && loaded.length < target) {
          if (seen.has(result.nextCursor)) throw new Error("earlier_page_repeated"); seen.add(result.nextCursor);
          const next = readEarlierFiles(await api.readEarlierFiles(caseId, { ownerId, signal: controller.signal, cursor: result.nextCursor, revision: result.revision, referenceId: route.query.get("earlierFileId") || "" }), caseId, ownerId, route.query.get("earlierFileId") || "");
          if (signal.aborted || ticket !== sequence || controller.signal.aborted) return;
          if (next.revision !== result.revision || next.entries.some(entry => loaded.some(old => old.id === entry.id))) throw Object.assign(new Error("earlier_files_changed"), { status: 409 });
          loaded = [...loaded, ...next.entries]; result = next;
        }
      }
      entries = append ? [...entries, ...loaded] : loaded; value = result; feedback.textContent = ""; root.dataset.state = "ready"; render();
      if (!quiet && result.selected) { const row = body.querySelector(`[data-earlier-file="${result.selected.id}"]`); if (row) requestAnimationFrame(() => { if (!signal.aborted && row.isConnected) { row.tabIndex = -1; row.focus(); } }); }
    } catch (error) {
      if (signal.aborted || ticket !== sequence) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied(error);
      else { value = null; entries = []; body.replaceChildren(); feedback.textContent = earlierFileError(error); root.dataset.state = "error"; }
    } finally { if (!signal.aborted && ticket === sequence) { busy = false; controller = null; controls(); } }
  }
  async function download(entry) {
    if (busy || signal.aborted || !entry.available) return; busy = true; controller = new AbortController(); const ticket = ++sequence; feedback.textContent = "Checking and preparing the earlier file…"; controls();
    try {
      const blob = await api.downloadEarlierFile(caseId, entry.id, entry.revision, { ownerId, signal: controller.signal });
      if (signal.aborted || controller.signal.aborted || ticket !== sequence) return;
      objectUrl = URL.createObjectURL(blob); const anchor = node("a", { href: objectUrl, download: fileName(entry.kind === "earlier_attachment" ? entry.name : "Earlier document"), hidden: true }); root.append(anchor); anchor.click(); anchor.remove();
      const url = objectUrl; setTimeout(() => { URL.revokeObjectURL(url); if (objectUrl === url) objectUrl = null; }, 1000);
      feedback.textContent = "The earlier file was handed to your browser. Check its downloads list to confirm where it was saved.";
    } catch (error) {
      if (signal.aborted || ticket !== sequence) return;
      if ([401, 403].includes(error.status) || error.kind === "authentication") denied(error);
      else { if ([404, 409].includes(error.status)) { value = null; entries = []; body.replaceChildren(); } feedback.textContent = error.status === 404 ? "This earlier file is no longer available. Refresh the list to check its record." : earlierFileError(error, "download"); root.dataset.state = "error"; }
    } finally { if (!signal.aborted && ticket === sequence) { busy = false; controller = null; controls(); } }
  }
  root.sync = () => load({ quiet: true }); root.clear = () => { clear(); feedback.textContent = ""; controls(); };
  root.invalidate = () => { clear(); feedback.textContent = opened ? "The Matter file records changed. Refresh earlier files to review them." : ""; controls(); };
  signal.addEventListener("abort", () => { clear(); root.replaceChildren(); }, { once: true }); controls();
  if (route.query.has("earlierFileId")) void load(); return root;
}
