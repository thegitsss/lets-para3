import { node, button } from "./dom.mjs";

export function createMessageAttachment(caseId, message, { api, signal, ownerId, onAccessLost, retained = false, presentation, attachmentId, multipleAttachments = false }) {
  const root = node("div", { "data-message-attachment": message.id }), feedback = node("p", { role: "status" });
  if (presentation==='conversation') {
    root.classList.add('av2-attachment-tile');
    const extension=message.filename?.split('.').at(-1)?.toUpperCase();
    const size=Number.isFinite(message.size) ? message.size<1024?`${message.size} B`:message.size<1048576?`${(message.size/1024).toFixed(1)} KB`:`${(message.size/1048576).toFixed(1)} MB` : '';
    root.append(node('span',{className:'av2-file-name',text:message.filename || 'Attachment'}),node('span',{className:'av2-file-meta',text:[extension?.length<9?extension:'Document',size].filter(Boolean).join(' · ')}));
  }
  if (!message.hasAttachment) {
    root.append(node("p", { text: multipleAttachments ? "This attachment is unavailable." : "No attachment is available for this message." }));
    root.dispose = () => {}; return root;
  }
  let request = null, disposed = false, audio = null;
  const urls = new Set(), options = { signal, ownerId, retained, attachmentId };
  const download = button("Download attachment", () => void run("download"));
  const loadAudio = message.audioMimeType ? button("Load audio", () => void run("audio")) : null;
  const cancel = button("Cancel attachment request", () => { request?.abort(); stopAudio(); feedback.textContent = "Attachment request cancelled."; }); cancel.hidden = true;
  if(presentation==='conversation') {
    const label=node('span',{className:'av2-file-copy'},[...root.childNodes]);
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
    const path=document.createElementNS(icon.namespaceURI,'path');path.setAttribute('d','M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6M9 16h6');icon.append(path);
    download.classList.add('av2-file-open');download.setAttribute('aria-label','Download attachment');download.replaceChildren(icon,label);
    const arrow=document.createElementNS(icon.namespaceURI,'svg');arrow.setAttribute('viewBox','0 0 24 24');arrow.setAttribute('aria-hidden','true');arrow.classList.add('av2-file-download-icon');
    const arrowPath=document.createElementNS(icon.namespaceURI,'path');arrowPath.setAttribute('d','M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5');arrow.append(arrowPath);download.append(arrow);
    root.append(download,node('div',{className:'av2-actions'},[...(loadAudio?[loadAudio]:[]),cancel]),feedback);
  } else root.append(node("div", { className: "av2-actions" }, [download, ...(loadAudio ? [loadAudio] : []), cancel]), feedback);
  function controls() { download.disabled = Boolean(request); if (loadAudio) loadAudio.disabled = Boolean(request); cancel.hidden = !request; }
  function stopAudio() { if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); audio.remove(); audio = null; } if (loadAudio) loadAudio.hidden = false; }
  function failure(error) {
    if ([401, 403, 410].includes(error.status) || error.kind === "authentication") { onAccessLost(); return; }
    feedback.textContent = error.status === 409 ? "This message changed. Refresh messages before opening its attachment." : error.status === 404 ? "This attachment is no longer available." : error.status === 422 ? "This attachment was blocked by its security check." : error.status === 423 ? "This attachment is still awaiting its security check. Try again shortly." : "The attachment couldn’t load. Try again when your connection and its security check are ready.";
  }
  async function run(action) {
    if (request || signal.aborted || disposed) return;
    const controller = new AbortController(); request = controller;
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 120000);
    controls(); feedback.textContent = action === "audio" ? "Loading the recorded audio…" : "Preparing the message attachment…";
    try {
      if (action === "audio") {
        const src = await api.prepareMessageAudio(caseId, message.id, message.revision, { ...options, signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        stopAudio(); audio = node("audio", { controls: "", preload: "metadata", "aria-label": message.filename || "Recorded audio message" });
        const player = audio;
        player.addEventListener("loadedmetadata", () => { if (!disposed && audio === player) feedback.textContent = "Audio ready. Use the player to listen."; });
        player.addEventListener("error", () => { if (!disposed && audio === player) { stopAudio(); feedback.textContent = "Audio couldn’t play here. Download the attachment to listen in an audio app."; } });
        player.src = src; root.append(player); loadAudio.hidden = true;
        feedback.textContent = "Use the player to load and listen to the recorded audio.";
      } else {
        const blob = await api.downloadMessageAttachment(caseId, message.id, message.revision, { ...options, signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        const url = URL.createObjectURL(blob); urls.add(url);
        const anchor = node("a", { href: url, download: (message.filename || "Message attachment").replace(/[\\/\u0000-\u001f\u007f]/g, "-") });
        root.append(anchor); anchor.click(); anchor.remove();
        setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000);
        feedback.textContent = "Attachment download started.";
      }
    } catch (error) {
      if (disposed || signal.aborted) return;
      if (controller.signal.aborted) feedback.textContent = "Attachment request stopped. You can try again."; else failure(error);
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (request === controller) request = null;
      if (!disposed && !signal.aborted) controls();
    }
  }
  root.dispose = () => { if (disposed) return; disposed = true; signal.removeEventListener("abort", root.dispose); request?.abort(); stopAudio(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  signal.addEventListener("abort", root.dispose, { once: true }); return root;
}
