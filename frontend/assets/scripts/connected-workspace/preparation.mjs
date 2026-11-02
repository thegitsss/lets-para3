import { node, action, notice, createClient, showFatal, validId, matterHref } from "./shared.mjs";
const params = new URLSearchParams(location.search), caseId = params.get("caseId");
const main = document.querySelector("main"), status = document.querySelector("[data-status]"), content = document.querySelector("[data-content]");
let client, snapshot, busy = false, generation = 0;
const endpoint = "/api/matter-preparation/matters/" + caseId;
function citationView(citation) {
  const label = [citation.name, citation.version ? "Version " + citation.version : "", citation.page ? "Page " + citation.page : citation.section ? "Text section " + citation.section : ""].filter(Boolean).join(" · ");
  const elements = [node("summary", { text: label }), node("blockquote", { text: citation.quote })];
  if (citation.fileId) elements.push(node("a", { href: matterHref(client.identity.role, caseId) + (client.identity.role === "paralegal" ? "&" : "?") + "fileId=" + citation.fileId, text: "Open source document" }));
  return node("details", { className: "cw-source" }, elements);
}
function proposalView(value, review = false) {
  if (!value) return notice(review ? "A submission check will appear here after you choose the documents to review." : "Prepare a working checklist from the agreed instructions and selected documents.");
  const title = review ? "Submission observations" : "Working checklist";
  const card = node("section", { className: "cw-card", "aria-label": title }, [node("div", { className: "cw-section-title" }, [node("h2", { text: title }), node("span", { className: "cw-tag", text: value.stale ? "Sources changed" : value.status === "accepted" ? "Accepted by attorney" : "For review" })])]);
  if (value.stale) card.append(notice("The scope or a source document changed. Generate fresh suggestions before relying on this preparation.", true));
  const edits = [];
  const items = node("ol", { className: "cw-checklist" });
  for (const item of value.items || []) {
    const row = node("li");
    if (!review && client.identity.role === "attorney" && value.status !== "accepted" && !value.stale) {
      const edit = node("textarea", { rows: "2", maxlength: "400", "aria-label": "Working checklist item " + (edits.length + 1) });
      edit.value = item.title; edits.push(edit); row.append(edit);
    } else row.append(node("p", { text: item.title }));
    if (item.editedByAttorney) row.append(node("span", { className: "cw-muted", text: "Edited by attorney; source evidence relates to the original suggestion." }));
    row.append(...(item.citations || []).map(citationView)); items.append(row);
  }
  card.append(items);
  for (const [field, heading] of [["questions", "Questions to resolve"], ["observations", "Items to review"]]) {
    if (!value[field]?.length) continue;
    card.append(node("h3", { text: heading }), ...value[field].map(item => node("div", { className: "cw-observation" }, [node("p", { text: item.title }), ...item.citations.map(citationView)])));
  }
  if (!value.items?.length && !value.questions?.length && !value.observations?.length) card.append(notice("No source-supported suggestions were produced. Review the selected documents directly."));
  if (value.files?.length) {
    const coverage = node("details", { className: "cw-source" }, [node("summary", { text: "Documents included · " + value.files.length })]);
    coverage.append(...value.files.map(file => node("p", { text: file.name + " · Version " + file.version + (file.unreadablePages?.length ? " · Unreadable pages: " + file.unreadablePages.join(", ") : "") })));
    card.append(coverage);
  }
  card.append(node("p", { className: "cw-muted", text: value.coverageNotice }));
  if (!review && client.identity.role === "attorney" && value.status !== "accepted" && !value.stale) {
    const accept = action("Accept working checklist", async () => {
      if (busy || edits.some(edit => !edit.value.trim())) return;
      await operate(async () => {
        await client.write(endpoint + "/accept", { preparationId: value.id, revision: value.revision, items: edits.map(edit => edit.value.trim()), confirmed: true });
        status.textContent = "Working checklist accepted. The agreed Matter scope and payment decisions are unchanged.";
        await load();
      });
    });
    card.append(notice("Accepting saves this as a working aid. It does not amend the agreed scope or approve any deliverable."), accept);
  }
  return card;
}
function render() {
  document.querySelector("h1").textContent = snapshot.title;
  document.title = snapshot.title + " · Matter preparation · Let’s-ParaConnect";
  document.querySelector("[data-return]").href = matterHref(client.identity.role, caseId, "work");
  const files = node("fieldset", { className: "cw-document-choice" }, [node("legend", { text: "Choose source documents" })]);
  for (const file of snapshot.files) {
    const supported = /\.(pdf|docx?|txt)$/i.test(file.name), safe = ["clean", "not_required"].includes(file.securityStatus);
    const box = node("input", { type: "checkbox", value: file.id, disabled: !supported || !safe || file.size > 10 * 1024 * 1024, "data-source": "" });
    const text = node("span", {}, [node("strong", { text: file.name }), node("small", { text: "Version " + file.version + (!safe ? " · Security check required" : !supported ? " · Read in Files" : "") })]);
    const row = node("label", { className: "cw-document-row" }, [box, text]);
    files.append(row);
  }
  if (!snapshot.files.length) files.append(node("p", { text: "No documents have been shared yet. You can prepare from the agreed Matter instructions." }));
  const controls = node("div", { className: "cw-actions" }, [
    action("Prepare workspace", () => void generate("preparation")),
    action("Check submission", () => void generate("submission"), "cw-secondary"),
  ]);
  if (!snapshot.aiConfigured) controls.querySelectorAll("button").forEach(button => { button.disabled = true; });
  const choices = node("section", { className: "cw-card" }, [node("h2", { text: "Prepare the next step" }), node("p", { text: "Use agreed instructions and selected readable documents to prepare suggestions with source references. Review every suggestion before accepting it." }), files, controls, notice(snapshot.aiConfigured ? "Selected document text is processed by LPC’s configured AI provider when you choose an action. Select up to eight documents; each must be no larger than 10 MB." : "Document preparation is awaiting connection. Your existing Files and Work sections remain available.")]);
  const documents = node("section", { className: "cw-card" }, [node("h2", { text: "Work on a document" }), node("p", { text: "Open a Word document for collaborative editing and tracked review." })]);
  const wordFiles = snapshot.files.filter(file => /\.docx$/i.test(file.name) && ["clean", "not_required"].includes(file.securityStatus));
  documents.append(...wordFiles.map(file => node("a", { className: "cw-document-link", href: "/document-editor.html?caseId=" + caseId + "&fileId=" + file.id, text: file.name })));
  if (!wordFiles.length) documents.append(node("p", { className: "cw-muted", text: "Share a DOCX document through Files to begin." }));
  if (client.identity.role === "attorney") documents.append(node("a", { className: "cw-document-link", href: "/clio-connect.html?caseId=" + caseId, text: "Bring selected documents from Clio or return approved work" }));
  const columns = node("div", { className: "cw-columns" }, [node("div", {}, [choices, documents]), node("div", {}, [proposalView(snapshot.preparation), proposalView(snapshot.submission, true)])]);
  content.replaceChildren(columns);
}
async function operate(fn) {
  if (busy) return;
  busy = true; main.setAttribute("aria-busy", "true");
  for (const button of content.querySelectorAll("button")) button.disabled = true;
  try { await fn(); } catch (error) { status.textContent = error.message; status.className = "cw-error"; }
  finally { busy = false; main.setAttribute("aria-busy", "false"); for (const button of content.querySelectorAll("button")) button.disabled = !snapshot?.aiConfigured; }
}
async function generate(kind) {
  const fileIds = [...content.querySelectorAll("[data-source]:checked")].map(box => box.value);
  if (fileIds.length > 8) { status.textContent = "Choose up to eight documents."; return; }
  await operate(async () => {
    status.className = "cw-muted"; status.textContent = kind === "submission" ? "Checking selected submission documents…" : "Reading selected documents and preparing suggestions…";
    await client.write(endpoint + "/generate", { fileIds, kind, requestId: crypto.randomUUID() });
    await load(); status.textContent = "Suggestions are ready for your review.";
  });
}
async function load() {
  const ticket = ++generation;
  const value = await client.read(endpoint);
  if (ticket !== generation) return;
  snapshot = value; render();
}
window.addEventListener("lpc-connected-access-lost", () => { generation++; snapshot = null; content.replaceChildren(); });
try { if (!validId(caseId)) throw new Error("Open preparation from a Matter workspace."); client = await createClient(["attorney", "paralegal"]); await load(); status.textContent = ""; }
catch (error) { showFatal(error); }
