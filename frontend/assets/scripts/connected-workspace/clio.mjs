import { node, action, notice, createClient, showFatal, validId, matterHref } from "./shared.mjs";
const params = new URLSearchParams(location.search), caseId = params.get("caseId");
const main = document.querySelector("main"), content = document.querySelector("[data-content]"), feedback = document.querySelector("[data-status]");
const base = "/api/integrations/clio/";
let client, busy = false, connection, documents = [], cursor = null, availableMatters = [];
const transferIds = new Map();
const operationId = key => { if (!transferIds.has(key)) transferIds.set(key, crypto.randomUUID()); return transferIds.get(key); };
function safeDraftHref(value) {
  if (typeof value !== "string") return null;
  const url = new URL(value, location.origin);
  return url.origin === location.origin && url.pathname === "/attorney-v2.html" && /^#\/matters\/new\?draftId=[a-f0-9]{24}$/i.test(url.hash) ? url.pathname + url.hash : null;
}
async function write(path, body = {}, method = "POST") { return client.write(base + path.replace(/^\//, ""), { ...body, expectedOwnerId: client.identity.id, ...(!["/connect", "/connection"].includes(path) ? { expectedConnectionRevision: connection.connectionRevision } : {}) }, method); }
async function operate(task) {
  if (busy) return;
  busy = true; main.setAttribute("aria-busy", "true");
  for (const control of content.querySelectorAll("button,input,select")) control.disabled = true;
  try { await task(); } catch (error) { feedback.textContent = error.message; feedback.className = "cw-error"; }
  finally { busy = false; main.setAttribute("aria-busy", "false"); for (const control of content.querySelectorAll("button,input,select")) if (!control.hasAttribute("data-unavailable")) control.disabled = false; }
}
function documentChoices(rows, prefix) {
  return node("fieldset", { className: "cw-document-choice" }, [
    node("legend", { text: "Choose documents to share" }),
    ...rows.map(file => {
      const box = node("input", { type: "checkbox", value: file.id, "data-clio-document": prefix, disabled: file.ready === false, ...(file.ready === false ? { "data-unavailable": "" } : {}) });
      return node("label", { className: "cw-document-row" }, [box, node("span", {}, [node("strong", { text: file.name || "Document" }), node("small", { text: file.ready === false ? "This document is not ready for transfer" : "Selected only when you check this box" })])]);
    }),
  ]);
}
function connectionCard() {
  const card = node("section", { className: "cw-card" }, [node("div", { className: "cw-section-title" }, [node("h2", { text: "Clio · United States" }), node("span", { className: "cw-tag", text: connection.connected ? "Connected" : "Not connected" })])]);
  if (!connection.configured) card.append(notice("The Clio connection is awaiting setup. Your LPC Matters and existing files remain available."));
  else if (!connection.connected) card.append(node("p", { text: "Connect your Clio account, then explicitly choose the matter and documents to share." }), action("Connect Clio", () => void operate(async () => {
    const response = await write("/connect");
    const url = new URL(response.authorizationUrl);
    if (url.origin !== "https://app.clio.com" || url.pathname !== "/oauth/authorize") throw new Error("The Clio connection returned an invalid destination.");
    location.assign(url.href);
  })));
  else {
    card.append(node("p", { text: "Only information and documents you select are transferred. Disconnecting stops new transfers from LPC." }));
    card.append(node("div", { className: "cw-actions" }, [
      action("Add LPC action in Clio", () => void operate(async () => { await write("/custom-action", { confirmed: true }); feedback.textContent = "The LPC delegation action is available in Clio."; }), "cw-secondary"),
      action("Disconnect Clio", () => void operate(async () => { await write("/connection", {}, "DELETE"); connection = await client.read(base + "status"); content.replaceChildren(connectionCard()); feedback.textContent = "Clio disconnected from LPC."; }), "cw-secondary"),
    ]));
  }
  return card;
}
async function selectMatter(matter, destination) {
  feedback.textContent = "Loading the selected Clio matter’s documents…";
  const result = await client.read(base + "matters/" + encodeURIComponent(matter.id) + "/documents");
  documents = result.items || [];
  let choices = documentChoices(documents, "handoff");
  const create = action("Prepare private LPC handoff", () => void operate(async () => {
    const documentIds = [...choices.querySelectorAll("input:checked")].map(box => box.value);
    const response = await write("/handoffs", { clioMatterId: String(matter.id), documentIds, requestId: operationId("handoff:" + matter.id + ":" + documentIds.join(",")), confirmed: true });
    const href = safeDraftHref(response.href);
    feedback.textContent = "Private handoff prepared. Author and review the public posting separately; confidential Clio details stay private.";
    if (href) destination.replaceChildren(notice("Your selected document references are retained privately. Source files can be imported once the resulting LPC Matter is hired and funded."), node("a", { href, className: "cw-button", text: "Open LPC posting draft" }));
    else throw new Error("The draft link could not be verified. Refresh to review the handoff.");
  }));
  destination.replaceChildren(node("h3", { text: matter.label || matter.name || matter.description || "Selected Clio matter" }), choices, notice("This creates a private handoff and a separate posting draft. Confidential matter descriptions are not copied into the public posting. Selected files are imported only after the LPC engagement is funded."), create);
  let nextCursor = result.nextCursor;
  if (nextCursor) {
    const more = action("Load more documents", () => void operate(async () => {
      const selected = new Set([...choices.querySelectorAll("input:checked")].map(box => box.value));
      const next = await client.read(base + "matters/" + encodeURIComponent(matter.id) + "/documents?cursor=" + encodeURIComponent(nextCursor));
      documents = [...documents, ...(next.items || [])]; nextCursor = next.nextCursor;
      const replacement = documentChoices(documents, "handoff");
      for (const box of replacement.querySelectorAll("input")) box.checked = selected.has(box.value);
      choices.replaceWith(replacement); choices = replacement;
      more.hidden = !nextCursor;
    }), "cw-secondary");
    destination.append(more);
  }
  feedback.textContent = "";
}
async function loadMatters(list, append = false) {
  const result = await client.read(base + "matters" + (append && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
  cursor = result.nextCursor || null;
  availableMatters = append ? [...availableMatters, ...(result.items || [])] : result.items || [];
  const selected = node("div", { className: "cw-card" });
  const rows = node("div", { className: "cw-clio-list" });
  for (const matter of availableMatters) rows.append(action(matter.label || matter.name || matter.description || "Clio matter " + matter.id, () => void operate(() => selectMatter(matter, selected)), "cw-secondary"));
  list.replaceChildren(rows);
  if (!availableMatters.length) list.append(notice("No accessible Clio matters were returned."));
  if (cursor) list.append(action("Load more matters", () => void operate(() => loadMatters(list, true)), "cw-secondary"));
  list.append(selected);
}
async function fundedTransferCard() {
  if (!validId(caseId)) return null;
  const [pending, matter] = await Promise.all([client.read(base + "handoffs?caseId=" + caseId), client.read("/api/matter-preparation/matters/" + caseId)]);
  const card = node("section", { className: "cw-card" }, [node("h2", { text: "Documents for " + matter.title })]);
  for (const handoff of pending.items || []) {
    const choices = documentChoices(handoff.documents || [], handoff.handoffId);
    card.append(node("h3", { text: handoff.label || "Selected Clio documents" }), choices, action("Import selected documents into this Matter", () => void operate(async () => {
      const documentIds = [...choices.querySelectorAll("input:checked")].map(box => box.value);
      if (!documentIds.length) throw new Error("Choose at least one document to import.");
      feedback.textContent = "Importing selected documents. Security checks apply before they can be opened.";
      await write("/matters/" + caseId + "/import", { handoffId: handoff.handoffId, documentIds, requestId: operationId("import:" + handoff.handoffId + ":" + documentIds.join(",")), confirmed: true });
      feedback.textContent = "The selected documents were imported. Open Files to review their security status.";
    })));
  }
  const approved = matter.files.filter(file => file.status === "approved" && ["clean", "not_required"].includes(file.securityStatus));
  if (approved.length) {
    const files = node("select", { "aria-label": "Approved document to return to Clio" }, approved.map(file => node("option", { value: file.id, text: file.name + " · Version " + file.version })));
    const targets = new Map([...availableMatters, ...(pending.items || []).map(item => ({ id: item.clioMatterId, label: item.label }))].map(item => [String(item.id), item]));
    const target = node("select", { "aria-label": "Destination Clio matter" }, [node("option", { value: "", text: "Choose the destination matter" }), ...[...targets.values()].map(item => node("option", { value: item.id, text: item.label || "Clio matter " + item.id }))]);
    card.append(node("h3", { text: "Return approved work to Clio" }), files, node("label", { className: "cw-field" }, [node("span", { text: "Destination Clio matter" }), target]), notice("Only the selected, attorney-approved document is sent to the chosen Clio matter. Confirm the destination before sending. If you need another destination, load the remaining Clio matters below and refresh this connection."), action("Send approved document to Clio", () => void operate(async () => {
      if (!/^\d{1,24}$/.test(target.value)) throw new Error("Choose the destination Clio matter.");
      await write("/matters/" + caseId + "/export", { fileId: files.value, clioMatterId: target.value, requestId: operationId("export:" + files.value + ":" + target.value), confirmed: true });
      feedback.textContent = "The approved document was returned to Clio.";
    })));
  } else card.append(notice("An attorney-approved, security-cleared document is required before returning work to Clio."));
  card.append(node("a", { href: matterHref("attorney", caseId), text: "Review this Matter’s files" }));
  return card;
}
try {
  client = await createClient(["attorney"]);
  if (validId(caseId)) document.querySelector("[data-return]").href = matterHref("attorney", caseId);
  connection = await client.read(base + "status");
  content.replaceChildren(connectionCard()); feedback.textContent = "";
  if (connection.connected) {
    const card = node("section", { className: "cw-card" }, [node("h2", { text: "Begin from a Clio matter" })]), list = node("div");
    card.append(list); content.append(card); await loadMatters(list);
    if (params.has("custom_action_nonce") && params.has("subject_url") && params.has("user_id")) {
      const result = await write("/action-context", { user_id: params.get("user_id"), subject_url: params.get("subject_url"), custom_action_nonce: params.get("custom_action_nonce") });
      history.replaceState(null, "", "/clio-connect.html" + (validId(caseId) ? "?caseId=" + caseId : ""));
      const selected = node("section", { className: "cw-card" }); content.prepend(selected); await selectMatter(result.matter, selected);
    }
    if (validId(caseId)) {
      try { const transfers = await fundedTransferCard(); if (transfers) content.prepend(transfers); }
      catch (error) { content.append(notice(error.message, true)); }
    }
  }
  window.addEventListener("lpc-connected-access-lost", () => { documents = []; availableMatters = []; content.replaceChildren(); });
} catch (error) { showFatal(error); }
