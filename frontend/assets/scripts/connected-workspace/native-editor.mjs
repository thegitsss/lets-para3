import { activateDialogFocus, deactivateDialogFocus } from "../utils/dialog-focus.js";
import { guardDialogDraft } from "../utils/dialog-discard-guard.mjs";
import { confirmAction } from "../utils/dialogs.js";

const BASE = "/api/document-collaboration/", POLL_MS = 10000;
const id = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const requests = new Map();
let sequence = 0;
function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false || value === null) continue;
    if (name === "text") element.textContent = value;
    else if (name === "className") element.className = value;
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  element.append(...children); return element;
}
const button = (text, handler, primary = false) => {
  const element = node("button", { type: "button", text, className: primary ? "lpc-native-editor__button lpc-native-editor__button--primary" : "lpc-native-editor__button" });
  element.addEventListener("click", handler); return element;
};

export function validateNativeEditorSession(value, ownerId, pageUrl = location.href) {
  if (!value || !id(value.sessionId) || !positive(value.savedVersion) || !Number.isFinite(Date.parse(value.expiresAt)) || value.config?.documentType !== "word" || value.config?.document?.fileType !== "docx" || typeof value.config.document.key !== "string" || !value.config.document.key || value.config.editorConfig?.user?.id !== ownerId || typeof value.config.token !== "string" || !value.config.token) throw new Error("The document editor returned an incomplete session. Try opening the document again.");
  let origin, script, page;
  try { origin = new URL(value.editorOrigin); script = new URL(value.scriptUrl); page = new URL(pageUrl); } catch { throw new Error("The document editor returned an invalid connection."); }
  const loopback = host => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  const local = origin.protocol === "http:" && page.protocol === "http:" && loopback(origin.hostname) && loopback(page.hostname);
  if (origin.protocol !== "https:" && !local || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || script.origin !== origin.origin || script.pathname !== "/web-apps/apps/api/documents/api.js" || script.username || script.password || script.search || script.hash) throw new Error("The document editor connection could not be verified. Return to Files and try again.");
  return { ...value, scriptUrl: script.href, editorOrigin: origin.origin };
}
export function readNativeEditorStatus(value, context) {
  if (!value || value.sessionId !== context.sessionId || value.caseId !== context.caseId || value.fileId !== context.fileId || value.ownerId !== context.ownerId || !["open", "saving", "closed", "needs_review"].includes(value.state) || !positive(value.savedVersion) || value.savedVersion < (context.minimumVersion || 0)) throw new Error("LPC could not verify the saved document. Keep the editor open and check again.");
  if (value.saveRequest && (typeof value.saveRequest.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.saveRequest.id) || !["requested", "confirmed", "failed", "unknown"].includes(value.saveRequest.state) || value.saveRequest.state === "confirmed" && (!positive(value.saveRequest.version) || value.saveRequest.version > value.savedVersion))) throw new Error("LPC returned an incomplete save confirmation. Keep the editor open and check again.");
  return value;
}
function loadProvider(session) {
  const previous = requests.get(session.scriptUrl);
  if (previous) return previous;
  const pending = new Promise((resolve, reject) => {
    const script = node("script", { src: session.scriptUrl, "data-lpc-editor-origin": session.editorOrigin, referrerpolicy: "no-referrer" });
    const timeout = setTimeout(() => { script.remove(); reject(new Error("The document editor is taking too long to connect. Try again.")); }, 25000);
    script.addEventListener("load", () => {
      clearTimeout(timeout);
      if (typeof window.DocsAPI?.DocEditor !== "function") { script.remove(); reject(new Error("The document editor could not start. Try again.")); return; }
      script.dataset.loaded = "true"; resolve(window.DocsAPI);
    }, { once: true });
    script.addEventListener("error", () => { clearTimeout(timeout); script.remove(); reject(new Error("The document editor could not connect. Try again.")); }, { once: true });
    document.head.append(script);
  });
  requests.set(session.scriptUrl, pending);
  pending.catch(() => { if (requests.get(session.scriptUrl) === pending) requests.delete(session.scriptUrl); });
  return pending;
}

export function createNativeDocumentEditor({ caseId, fileId, ownerId, role, api, signal, onSaved, onAccessLost, trigger } = {}) {
  if (!id(caseId) || !id(fileId) || !id(ownerId) || !["attorney", "paralegal"].includes(role) || typeof api?.read !== "function" || typeof api?.write !== "function") throw new Error("Open a document from its Matter’s Files section.");
  let dialog = null, editor = null, stage, statusText, detail, title, version, saveButton, checkButton, reopenButton;
  let disposed = false, generation = 0, pollTimer, expiryTimer, session = null, ready = false, dirty = false, providerPending = false, loading = false, checking = false, saving = false, blocked = false;
  let editEpoch = 0, pendingSave = null, baselineVersion = 0, savedVersion = 0, lastReceipt = null, requestClose = () => {};
  const current = ticket => !disposed && !signal?.aborted && !!dialog?.open && ticket === generation;
  const hasDraft = () => dirty || providerPending || saving || Boolean(pendingSave);
  function show(text, description = "", tone = "default") {
    if (!dialog) return;
    if (statusText.textContent !== text) statusText.textContent = text;
    detail.textContent = description; dialog.dataset.saveState = tone;
  }
  function controls() {
    if (!dialog) return;
    saveButton.disabled = !ready || loading || saving || providerPending || blocked || pendingSave?.state === "requested" || !dirty && !pendingSave;
    saveButton.textContent = saving || pendingSave?.state === "requested" ? "Saving to LPC…" : "Save to LPC";
    checkButton.disabled = !session || loading || checking;
    checkButton.textContent = checking ? "Checking…" : "Check saved version";
    version.textContent = positive(savedVersion) ? `Version ${savedVersion} in Files` : "";
    reopenButton.hidden = !blocked;
  }
  function clearTimers() { clearTimeout(pollTimer); clearTimeout(expiryTimer); }
  function destroyEditor() { if (editor) { try { editor.destroyEditor(); } catch { /* Frame removal below still revokes display. */ } editor = null; } ready = false; }
  function clean({ returnFocus = true, notify = true } = {}) {
    if (!dialog) return;
    clearTimers(); generation++; destroyEditor();
    const closed = dialog; dialog = null;
    deactivateDialogFocus(closed, { restoreFocus: returnFocus }); closed.remove();
    if (returnFocus && !trigger?.isConnected) {
      const target = document.querySelector(`[data-native-document-file="${fileId}"], [data-file-id="${fileId}"], [data-download-file="${fileId}"]`);
      if (target && !target.closest("[hidden], [inert]")) { if (!target.hasAttribute("tabindex") && target.tagName !== "BUTTON") target.tabIndex = -1; target.focus({ preventScroll: true }); }
    }
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("lpc-connected-access-lost", accessLost);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pagehide", pageHide);
    const receipt = notify && lastReceipt && lastReceipt.version > baselineVersion && !signal?.aborted ? { caseId, fileId, version: lastReceipt.version } : null;
    session = null; pendingSave = null; lastReceipt = null; dirty = false; providerPending = false;
    loading = false; checking = false; saving = false; blocked = false;
    if (receipt) onSaved?.(receipt);
  }
  function accessLost(error) {
    if (disposed) return;
    disposed = true; clearTimers(); destroyEditor(); clean({ returnFocus: false, notify: false }); onAccessLost?.(error);
  }
  function beforeUnload(event) { if (hasDraft()) { event.preventDefault(); event.returnValue = ""; } }
  function pageHide() { dispose(); }
  function onFocus() { if (session && dialog?.open) void check(); }
  function dispose() { if (disposed) return; disposed = true; clean({ returnFocus: false, notify: false }); }
  function failure(error, { opening = false } = {}) {
    if (disposed || !dialog?.open) return;
    if ([401, 403, 404].includes(error?.status) || ["authentication", "authorization"].includes(error?.kind)) { accessLost(error); return; }
    if (error?.status === 410) {
      blocked = true; clearTimers();
      show("This editing session expired", "Keep or download a copy of any unconfirmed edits before reopening the version saved in LPC.", "error");
    } else if (opening && !editor) {
      stage.replaceChildren(node("div", { className: "lpc-native-editor__empty" }, [node("p", { text: "Your document could not open" }), node("p", { className: "lpc-native-editor__muted", text: error?.message || "Check your connection and try again." }), button("Try again", () => void start())]));
      show("Connection unavailable", "Your selected document remains in Files.", "error");
    } else {
      show("The saved version could not be confirmed", "Keep the editor open. Check again, or download a copy from the editor before leaving.", "error");
    }
    controls();
  }
  function schedule() { clearTimeout(pollTimer); if (session && dialog?.open && !disposed && !blocked) pollTimer = setTimeout(() => void check(), pendingSave ? 2000 : POLL_MS); }
  function applyStatus(value) {
    savedVersion = value.savedVersion;
    if (value.savedVersion > baselineVersion) lastReceipt = { version: value.savedVersion };
    if (value.state === "needs_review" || value.state === "closed") {
      blocked = true; clearTimers();
      show(value.state === "closed" ? "This editing session is closed" : "This save needs review", "Download a copy of any unconfirmed edits before reopening the document saved in LPC.", value.state === "closed" && !hasDraft() ? "default" : "error");
    } else if (pendingSave && value.saveRequest?.id === pendingSave.id) {
      pendingSave.state = value.saveRequest.state;
      if (value.saveRequest.state === "confirmed") {
        const sameEdits = pendingSave.epoch === editEpoch && !providerPending;
        lastReceipt = { version: Math.max(value.savedVersion, value.saveRequest.version) };
        pendingSave = null; if (sameEdits) dirty = false;
        show(dirty ? "New changes to save" : `Version ${value.saveRequest.version} saved in LPC`, dirty ? "Your confirmed version is in Files. Save again to record later edits." : "The document is available in Files for attorney review.", dirty ? "pending" : "saved");
      } else if (["failed", "unknown"].includes(value.saveRequest.state)) {
        show("This save has not been confirmed", "Keep the editor open. Check the saved version, or download a copy before leaving.", "error");
      } else show("Waiting for LPC to confirm this save", "You can continue editing. Later edits may need another save.", "pending");
    } else if (value.state === "saving") show("Recording a document version", "Keep the editor open while LPC confirms the saved version.", "pending");
    else if (dirty || providerPending) show(providerPending ? "Finishing your edits…" : "Changes to save", "Use Save to LPC to record a document version in Files.", "pending");
    else show(positive(savedVersion) ? `Version ${savedVersion} in Files` : "Document ready", "Edit and review together. Attorney approval stays in Files.");
    controls();
  }
  async function check() {
    if (!session || checking || disposed || !dialog?.open) return;
    const ticket = generation, sessionId = session.sessionId;
    checking = true; controls();
    try {
      const query = pendingSave ? `?saveRequestId=${encodeURIComponent(pendingSave.id)}` : "";
      const result = await api.read(`${BASE}sessions/${sessionId}${query}`);
      if (!current(ticket)) return;
      applyStatus(readNativeEditorStatus(result, { sessionId, caseId, fileId, ownerId, minimumVersion: savedVersion }));
    } catch (error) { if (current(ticket)) failure(error); }
    finally { if (current(ticket)) { checking = false; controls(); schedule(); } }
  }
  async function save() {
    if (!ready || saving || providerPending || blocked || disposed || !session) return;
    const ticket = generation, epoch = editEpoch;
    const requestId = pendingSave?.state === "unknown" ? pendingSave.id : crypto.randomUUID();
    if (pendingSave?.id !== requestId) pendingSave = { id: requestId, epoch, state: "requested" };
    saving = true; show("Requesting a saved version…", "LPC will confirm the document after it is recorded in Files.", "pending"); controls();
    try {
      const result = await api.write(`${BASE}sessions/${session.sessionId}/save`, { expectedOwnerId: ownerId, clientRequestId: requestId });
      if (!current(ticket)) return;
      if (typeof result.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(result.requestId)) throw new Error("The save request could not be verified.");
      if (pendingSave?.id !== result.requestId) pendingSave = { id: result.requestId, epoch: null, state: result.noChanges ? "unknown" : "requested" };
      else pendingSave.state = result.noChanges ? "unknown" : "requested";
      if (result.noChanges) show("No new document version was returned", "Check the version recorded in Files. Keep or download a copy of any unconfirmed edits before leaving.", "error");
      else show("Waiting for LPC to confirm this save", "You can continue editing. Later edits may need another save.", "pending");
      await check();
    } catch (error) { if (current(ticket)) { if (pendingSave) pendingSave.state = "unknown"; failure(error); } }
    finally { if (current(ticket)) { saving = false; controls(); schedule(); } }
  }
  async function reopen() {
    if (!dialog?.open || loading) return;
    const ticket = generation;
    const accepted = !hasDraft() || await confirmAction("The editor will reload the latest version recorded in LPC. Download a copy of any unconfirmed edits first.", { title: "Reopen the saved document?", confirmLabel: "Reopen document", cancelLabel: "Keep editing", tone: "danger" });
    if (!accepted || !current(ticket)) return;
    dirty = false; providerPending = false; pendingSave = null; await start();
  }
  async function start() {
    if (!dialog?.open || loading || disposed) return;
    const ticket = ++generation; clearTimers(); destroyEditor(); session = null; loading = true; blocked = false; checking = false; saving = false;
    show("Opening your document…", "Your Files selection stays in place.", "pending"); controls();
    stage.replaceChildren(node("div", { className: "lpc-native-editor__empty", role: "status" }, [node("span", { className: "lpc-native-editor__spinner", "aria-hidden": "true" }), node("p", { text: "Opening document…" })]));
    try {
      const available = await api.read(`${BASE}status`);
      if (!current(ticket)) return;
      if (available.configured !== true) {
        stage.replaceChildren(node("div", { className: "lpc-native-editor__empty" }, [node("h3", { text: "Document editing is not connected yet" }), node("p", { className: "lpc-native-editor__muted", text: "You can download, edit, and share revisions from this Matter’s Files section." }), button("Check connection again", () => void start())]));
        show("Continue in Files", "Your document and its history are available there."); return;
      }
      const opened = await api.write(`${BASE}matters/${caseId}/files/${fileId}/session`, { expectedOwnerId: ownerId });
      if (!current(ticket)) return;
      session = validateNativeEditorSession(opened, ownerId);
      baselineVersion ||= session.savedVersion; savedVersion = session.savedVersion;
      title.textContent = String(session.config.document.title || "DOCX document").slice(0, 300);
      const provider = await loadProvider(session);
      if (!current(ticket)) return;
      const holder = node("div", { id: `lpc-native-document-${++sequence}`, className: "lpc-native-editor__document" });
      stage.replaceChildren(holder);
      const events = {
        onDocumentReady() { if (!current(ticket)) return; ready = true; show(dirty ? "Changes to save" : `Version ${savedVersion} in Files`, "Edit and review together. Use Save to LPC to record a version.", dirty ? "pending" : "default"); controls(); schedule(); },
        onDocumentStateChange(event) {
          if (!current(ticket) || typeof event?.data !== "boolean") return;
          providerPending = event.data;
          if (event.data) { dirty = true; editEpoch++; }
          if (!pendingSave) show(event.data ? "Finishing your edits…" : dirty ? "Changes to save" : `Version ${savedVersion} in Files`, dirty ? "Use Save to LPC to record a document version in Files." : "Edit and review together. Attorney approval stays in Files.", dirty ? "pending" : "default");
          controls();
        },
        onError() { if (current(ticket)) { dirty = true; show("The editor reported a problem", "Check the saved version. Keep or download a copy of any unconfirmed edits before leaving.", "error"); controls(); } },
        onRequestClose() { if (current(ticket)) void requestClose(); },
      };
      editor = new provider.DocEditor(holder.id, { ...session.config, events });
      stage.querySelector("iframe")?.setAttribute("title", `Document editor · ${title.textContent}`);
      const expiresIn = Date.parse(session.expiresAt) - Date.now();
      expiryTimer = setTimeout(() => { if (current(ticket)) failure({ status: 410 }); }, Math.max(0, Math.min(expiresIn, 2147483647)));
      schedule();
    } catch (error) { if (current(ticket)) failure(error, { opening: true }); }
    finally { if (current(ticket)) { loading = false; controls(); } }
  }
  async function open() {
    if (disposed || signal?.aborted) return false;
    if (dialog?.open) { dialog.querySelector("button")?.focus({ preventScroll: true }); return true; }
    baselineVersion = 0; savedVersion = 0; editEpoch = 0; lastReceipt = null; dirty = false; providerPending = false; pendingSave = null;
    const titleId = `lpc-native-editor-title-${++sequence}`, descriptionId = `${titleId}-description`;
    const close = button("Return to Files", () => {}); close.setAttribute("aria-label", "Return to Files");
    title = node("p", { className: "lpc-native-editor__filename", text: "DOCX document" });
    const heading = node("div", { className: "lpc-native-editor__heading" }, [node("h2", { id: titleId, text: "Document editor" }), title]);
    version = node("span", { className: "lpc-native-editor__version" });
    saveButton = button("Save to LPC", () => void save(), true); checkButton = button("Check saved version", () => void check()); reopenButton = button("Reopen saved document", () => void reopen()); reopenButton.hidden = true;
    statusText = node("p", { className: "lpc-native-editor__status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    detail = node("p", { id: descriptionId, className: "lpc-native-editor__detail" });
    stage = node("div", { className: "lpc-native-editor__stage", "data-native-editor-stage": "" });
    dialog = node("dialog", { className: "lpc-native-editor", "data-native-document-editor": "", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": descriptionId, "data-role": role }, [node("div", { className: "lpc-native-editor__surface" }, [
      node("header", { className: "lpc-native-editor__header" }, [heading, close]),
      node("div", { className: "lpc-native-editor__toolbar", role: "toolbar", "aria-label": "Document actions" }, [node("div", { className: "lpc-native-editor__actions" }, [saveButton, checkButton, reopenButton]), version]),
      node("div", { className: "lpc-native-editor__feedback" }, [statusText, detail]), stage,
      node("footer", { className: "lpc-native-editor__footer", text: "Tracked changes and comments stay with the document. Review and approval remain in Files." }),
    ])]);
    document.body.append(dialog);
    requestClose = guardDialogDraft(dialog, { buttons: [close], hasDraft, title: "Leave this document?", message: "LPC has not confirmed all of these edits. Keep or download a copy from the editor before returning to Files.", confirmLabel: "Return to Files", focusOnKeep: saveButton });
    dialog.addEventListener("close", () => clean(), { once: true });
    dialog.showModal();
    activateDialogFocus(dialog, { initialFocus: close, returnFocus: trigger, onEscape: () => void requestClose() });
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("lpc-connected-access-lost", accessLost);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", pageHide, { once: true });
    await start(); return !disposed;
  }
  signal?.addEventListener("abort", dispose, { once: true });
  return Object.freeze({ open, dispose });
}
