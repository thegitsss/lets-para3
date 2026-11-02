import { node, notice, createClient, showFatal, validId, matterHref } from "./shared.mjs";
const params = new URLSearchParams(location.search), caseId = params.get("caseId"), fileId = params.get("fileId");
let editor, timer;
window.addEventListener("lpc-connected-access-lost", () => { clearTimeout(timer); editor?.destroyEditor(); editor = null; });
try {
  if (!validId(caseId) || !validId(fileId)) throw new Error("Open a document from its Matter workspace.");
  const client = await createClient(["attorney", "paralegal"]);
  document.querySelector("[data-return]").href = matterHref(client.identity.role, caseId);
  const status = document.querySelector("[data-status]"), content = document.querySelector("[data-content]");
  const provider = await client.read("/api/document-collaboration/status");
  if (!provider.configured) { status.textContent = "Document collaboration is awaiting connection."; content.append(notice("You can continue to download, edit, and share revisions through the Matter’s Files section.")); }
  else {
    status.textContent = "Opening your document…";
    const session = await client.write("/api/document-collaboration/matters/" + caseId + "/files/" + fileId + "/session", { expectedOwnerId: client.identity.id });
    const script = document.createElement("script");
    const scriptUrl = new URL(session.scriptUrl);
    if (!["https:", "http:"].includes(scriptUrl.protocol) || scriptUrl.username || scriptUrl.password || scriptUrl.pathname !== "/web-apps/apps/api/documents/api.js") throw new Error("The document editor configuration is invalid.");
    script.src = scriptUrl.href;
    await new Promise((resolve, reject) => { script.addEventListener("load", resolve, { once: true }); script.addEventListener("error", () => reject(new Error("The document editor could not load. Return to Files or try again.")), { once: true }); document.head.append(script); });
    content.replaceChildren(node("div", { id: "cw-document-editor" }));
    const events = {
      onDocumentReady: () => { status.textContent = "Document ready. Changes are saved through LPC’s document connection."; },
      onError: () => { status.textContent = "The editor reported a problem. Check the saved document status before leaving."; },
      onRequestClose: () => { location.assign(matterHref(client.identity.role, caseId)); },
    };
    editor = new window.DocsAPI.DocEditor("cw-document-editor", { ...session.config, events });
    async function check() {
      try {
        const saved = await client.read("/api/document-collaboration/sessions/" + session.sessionId);
        status.textContent = saved.message || (saved.savedVersion ? "Saved in LPC · Version " + saved.savedVersion : "Editing session open. Use Save to request a saved version.");
      } catch (error) { status.textContent = error.message; if ([401,403,404,410].includes(error.status)) { editor?.destroyEditor(); editor = null; } }
      if (editor) timer = setTimeout(() => void check(), 15000);
    }
    timer = setTimeout(() => void check(), 15000);
  }
} catch (error) { showFatal(error); }
