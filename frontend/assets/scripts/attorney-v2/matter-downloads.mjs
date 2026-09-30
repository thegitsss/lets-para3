import { node, button, link, page, recoveryButton, setRecovery } from "./dom.mjs";
import { readDownloads, fileName, fileDescription, downloadAccess, downloadError } from "./download-model.mjs";

export function createMatterDownloads(caseId, { api, signal, ownerId, showHeading = true }) {
  const section = node("section", { className: "matter-notes matter-downloads", "data-matter-downloads": caseId, "aria-label": "Files for download" });
  const status = node("p", { role: "status", "data-download-feedback": "" }), body = node("div"), list = node("ul", { className: "matter-download-list" });
  const refresh = recoveryButton("Retry files", () => void load(false), "matter-note-button");
  const more = button("Load more files", () => void load(true), "matter-note-button");
  const cancel = button("Cancel download", () => transfer?.abort(), "matter-note-button");
  if (showHeading) section.append(node("h2", { text: "Files for download" }));
  section.append(status, body, node("div", { className: "matter-note-actions" }, [refresh, cancel]), list, more);
  let value = null, files = [], busy = false, transfer = null;
  const stale = new Set(), objectUrls = new Set();
  const alive = () => !signal.aborted;
  const message = (text, state) => { status.textContent = text; section.dataset.state = state; };
  function render() {
    if (!alive()) return;
    body.replaceChildren(); list.replaceChildren();
    refresh.disabled = busy; more.hidden = !value?.nextCursor; more.disabled = busy; cancel.hidden = !transfer;
    setRecovery(refresh, section);
    if (!value) return;
    body.append(node("h3", { text: value.caseTitle }), node("p", { text: downloadAccess(value) }));
    if (value.access !== "available") return;
    if (value.legacyAttachments) body.append(node("p", { text: "Older attachments without a current file record may be available only through the Matter archive." }));
    body.append(node("p", { text: files.length ? `Showing ${files.length} file records.${value.nextCursor ? " More files are available." : ""}` : "No downloadable file records were found here." }));
    for (const file of files) {
      const action = button(file.securityStatus === "clean" || file.securityStatus === "not_required" ? "Download file" : "Check and download", () => void download(file), "matter-note-button matter-note-primary");
      action.disabled = busy || stale.has(file.id); action.setAttribute("aria-label", `${action.textContent}: ${file.name}`);
      list.append(node("li", { className: "matter-download-file", "data-download-file": file.id }, [node("h4", { text: file.name }), node("p", { className: "matter-notes-meta", text: fileDescription(file) }), action]));
    }

  }
  function restricted() { value = null; files = []; stale.clear(); message("File downloads are no longer available to this account. Refresh to verify access.", "restricted"); }
  async function load(append) {
    if (busy || !alive() || (append && !value?.nextCursor)) return;
    const cursor = append ? value.nextCursor : null;
    if (!append) { value = null; files = []; stale.clear(); }
    busy = true; message(append ? "Loading more files…" : "Checking current files…", "loading"); render();
    try {
      const next = readDownloads(await api.readMatterDownloads(caseId, { signal, ownerId, cursor }), caseId, ownerId);
      if (!alive()) return;
      if (append && (next.nextCursor === cursor || next.files.some(file => files.some(previous => previous.id === file.id)))) throw new Error("invalid_next_page");
      files = next.access === "available" ? append ? [...files, ...next.files] : next.files : []; value = next;
      message("The current file list is ready.", "ready");
    } catch (error) {
      if (!alive()) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") restricted();
      else message(append ? "More files could not be loaded. The listed files are from the last successful read; try loading more again." : "The file list could not be checked. Refresh files to try again.", "error");
    } finally { if (alive()) { busy = false; render(); } }
  }
  async function download(file) {
    if (busy || !alive() || !value || value.access !== "available" || stale.has(file.id)) return;
    busy = true; transfer = new AbortController(); message("Checking and preparing this file…", "downloading"); render();
    try {
      const blob = await api.downloadMatterFile(caseId, file.id, file.revision, { signal: transfer.signal, ownerId });
      if (!alive() || transfer.signal.aborted) return;
      const url = URL.createObjectURL(blob); objectUrls.add(url);
      const anchor = node("a", { href: url, download: fileName(file.name), hidden: true }); section.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); }, 1000);
      message("The file was handed to your browser. Check its downloads list to confirm where it was saved.", "ready");
    } catch (error) {
      if (!alive()) return;
      if (error.name === "AbortError") message("Download canceled. No retry was sent.", "ready");
      else if ([401, 403].includes(error.status) || error.kind === "authentication" || error.code === "DOWNLOAD_NOT_FOUND") restricted();
      else { if (["DOWNLOAD_CHANGED", "DOWNLOAD_FILE_NOT_FOUND"].includes(error.code)) stale.add(file.id); message(downloadError(error), "error"); }
    } finally { if (alive()) { transfer = null; busy = false; render(); } }
  }
  signal.addEventListener("abort", () => { transfer?.abort(); value = null; files = []; stale.clear(); objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear(); section.replaceChildren(); }, { once: true });
  section.readiness = load(false); return section;
}
export function createDownloadsPage(route, identity, context) {
  const section = page("Files for download");
  section.firstChild.append(link("Back to Matters", "#/matters"));
  const files = createMatterDownloads(route.caseId, { ...context, ownerId: identity.id, showHeading: false }); section.append(files); section.readiness = files.readiness; return section;
}
