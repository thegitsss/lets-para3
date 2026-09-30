import { node, button, link } from "./dom.mjs";
import { readFileReview, fileStatus } from "./files-model.mjs";
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readHistory(value, caseId, ownerId, fileId) {
  if (!value || value.caseId !== caseId || value.ownerId !== ownerId || value.fileId !== fileId || !hash(value.revision) || !Array.isArray(value.entries) || value.entries.length > 25 || !Array.isArray(value.responses) || value.responses.length > 25 || value.nextCursor !== null && !/^(0|[1-9]\d{0,5})$/.test(value.nextCursor) || value.nextResponseCursor !== null && !validId(value.nextResponseCursor)) throw new Error("invalid_history");
  const seen = new Set();
  for (const entry of value.entries) { if (!Number.isSafeInteger(entry.index) || entry.index < 0 || seen.has(entry.index) || !hash(entry.revision) || typeof entry.hasStoredDocument !== "boolean" || entry.retainedAt !== null && (!Number.isFinite(Date.parse(entry.retainedAt)) || typeof entry.retainedAt !== "string")) throw new Error("invalid_history_entry"); seen.add(entry.index); }
  const responseIds = new Set();
  for (const response of value.responses) { readFileReview(response); if (typeof response.name !== "string" || !response.name || responseIds.has(response.id)) throw new Error("invalid_history_response"); responseIds.add(response.id); }
  return value;
}
export function createWorkspaceFileHistory(caseId, file, { api, signal, ownerId, onDenied }) {
  const root = node("section", { "aria-label": "Document history", "data-file-history": "" }), feedback = node("p", { role: "status" }), body = node("div");
  const open = button("Document history", () => void load()), stop = button("Cancel history request", () => controller?.abort()); stop.hidden = true; root.append(open, stop, feedback, body);
  let current = null, entries = [], responses = [], busy = false, disposed = false, controller = null, objectUrl = null;
  const cancel = () => controller?.abort(); signal.addEventListener("abort", cancel, { once: true });
  root.dispose = () => { disposed = true; controller?.abort(); signal.removeEventListener("abort", cancel); if (objectUrl) URL.revokeObjectURL(objectUrl); root.replaceChildren(); };
  function render() {
    open.disabled = busy; stop.hidden = !busy; if (!current) return;
    body.replaceChildren(node("h4", { text: "Earlier contents" }), node("p", { className: "av2-muted", text: "Earlier records identify when contents were replaced. Their original names, sizes and version numbers may not have been retained." }));
    const list = node("ul");
    for (const entry of entries) {
      const text = entry.retainedAt ? `Contents retained ${new Date(entry.retainedAt).toLocaleString()}` : "Earlier contents · Date not recorded";
      const row = node("li", {}, [node("p", { text })]);
      if (entry.hasStoredDocument) row.append(button("Download earlier contents", () => void download(entry))); else row.append(node("p", { text: "No stored document reference remains for this entry." }));
      list.append(row);
    }
    body.append(list); if (!entries.length) body.append(node("p", { text: "No earlier contents are recorded for this document." }));
    if (current.nextCursor !== null) body.append(button("More earlier contents", () => void load("entries")));
    body.append(node("h4", { text: "Documents submitted in response" }));
    const submitted = node("ul");
    for (const response of responses) submitted.append(node("li", {}, [link(response.name, `#/matters/${caseId}/files?fileId=${response.id}`), node("p", { text: `${fileStatus(response)}${response.revisionOf?.version ? ` · In response to version ${response.revisionOf.version}` : ""}` })]));
    body.append(submitted); if (!responses.length) body.append(node("p", { text: "No documents are linked as a response to this document." }));
    if (current.nextResponseCursor) body.append(button("More responses", () => void load("responses")));
    body.querySelectorAll("button").forEach(control => { control.disabled = busy; });
  }
  async function load(append) {
    if (busy || disposed || signal.aborted) return; busy = true; controller = new AbortController(); feedback.textContent = "Loading document history…"; render();
    try {
      const value = readHistory(await api.readWorkspaceFileHistory(caseId, file.id, file.reviewRevision, { ownerId, signal: controller.signal, cursor: append === "entries" ? current.nextCursor : null, responseCursor: append === "responses" ? current.nextResponseCursor : null }), caseId, ownerId, file.id);
      if (disposed || signal.aborted) return;
      if (append && value.revision !== current.revision) throw new Error("history_changed");
      if (append === "entries") { if (value.entries.some(next => entries.some(old => old.index === next.index))) throw new Error("history_page_repeated"); entries.push(...value.entries); current.nextCursor = value.nextCursor; }
      else if (append === "responses") { if (value.responses.some(next => responses.some(old => old.id === next.id))) throw new Error("history_page_repeated"); responses.push(...value.responses); current.nextResponseCursor = value.nextResponseCursor; }
      else { entries = value.entries; responses = value.responses; current = value; }
      feedback.textContent = "";
    } catch (error) { if (!disposed && !signal.aborted && ([401, 403].includes(error.status) || error.kind === "authentication")) onDenied?.(error); if (!disposed && !signal.aborted) { current = null; entries = []; responses = []; body.replaceChildren(); feedback.textContent = error.name === "AbortError" ? "History request canceled." : [401, 403, 404].includes(error.status) ? "This document history is no longer available." : error.status === 409 ? "This document changed. Refresh Files before reading its history." : "Document history couldn’t load. Try again."; } }
    finally { busy = false; controller = null; if (!disposed && !signal.aborted) render(); }
  }
  async function download(entry) {
    if (busy || disposed || signal.aborted) return; busy = true; controller = new AbortController(); feedback.textContent = "Checking and preparing the earlier document…"; render();
    try {
      const blob = await api.downloadWorkspaceFileHistory(caseId, file.id, entry.index, entry.revision, { signal: controller.signal, ownerId });
      if (disposed || signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); const anchor = node("a", { href: objectUrl, download: "Earlier document", hidden: true }); root.append(anchor); anchor.click(); anchor.remove();
      const url = objectUrl; setTimeout(() => { URL.revokeObjectURL(url); if (objectUrl === url) objectUrl = null; }, 1000);
      feedback.textContent = "The earlier document was handed to your browser. Check its downloads list to confirm where it was saved.";
    } catch (error) { if (!disposed && !signal.aborted && ([401, 403].includes(error.status) || error.kind === "authentication")) onDenied?.(error); if (!disposed && !signal.aborted) feedback.textContent = [401, 403, 404].includes(error.status) ? "The earlier document is no longer available." : "The earlier document could not be downloaded. Refresh Files to check its current availability."; }
    finally { busy = false; controller = null; if (!disposed && !signal.aborted) render(); }
  }
  return root;
}
