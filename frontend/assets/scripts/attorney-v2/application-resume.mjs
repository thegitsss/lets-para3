import { node, button } from "./dom.mjs";
import { readApplicationResume, applicationResumeError } from "./application-resume-model.mjs";

export function createApplicationResume(caseId, item, { api, signal, ownerId }) {
  let review = null, transfer = null, generation = 0;
  const urls = new Set();
  const status = node("p", { role: "status" });
  const check = button("Check recorded résumé", () => void run(false));
  const download = button("Download recorded résumé", () => void run(true));
  const cancel = button("Cancel résumé request", () => {
    generation++; transfer?.abort(); transfer = null;
    status.textContent = "Résumé request canceled."; section.dataset.state = review ? "ready" : "idle";
    controls(); check.focus();
  });
  const section = node("section", { "data-application-resume": item.applicantId, "aria-label": "Résumé recorded with the application" }, [
    node("h3", { text: "Résumé recorded with the application" }),
    node("p", { text: "This opens the file referenced in the application. It may be unavailable if it was later removed." }),
    status, node("div", { className: "av2-actions" }, [check, download, cancel]),
  ]);
  const revoke = url => { URL.revokeObjectURL(url); urls.delete(url); };
  function controls() {
    check.disabled = !!transfer; download.hidden = !review; download.disabled = !!transfer;
    cancel.hidden = !transfer; section.setAttribute("aria-busy", String(!!transfer));
  }
  async function run(saving) {
    if (signal.aborted || transfer || saving && !review) return;
    const ticket = ++generation, controller = new AbortController(); transfer = controller;
    if (!saving) review = null;
    section.dataset.state = "loading"; status.textContent = saving ? "Preparing the recorded résumé…" : "Checking the recorded résumé…"; controls();
    try {
      if (saving) {
        const blob = await api.downloadApplicationResume(caseId, item.applicantId, review.revision, { ownerId, signal: controller.signal });
        if (signal.aborted || controller.signal.aborted || ticket !== generation) return;
        if (blob.size !== review.size) throw new Error("invalid_resume_length");
        const url = URL.createObjectURL(blob); urls.add(url);
        const anchor = node("a", { href: url, download: review.name, hidden: "" });
        section.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => revoke(url), 1000);
        status.textContent = "The résumé was handed to your browser. Check its downloads list to confirm where it was saved.";
      } else {
        const value = await api.readApplicationResume(caseId, item.applicantId, { ownerId, signal: controller.signal });
        if (signal.aborted || controller.signal.aborted || ticket !== generation) return;
        review = readApplicationResume(value, caseId, ownerId, item);
        status.textContent = `PDF · ${Math.max(1, Math.ceil(review.size / 1024)).toLocaleString()} KB · Ready to download`;
      }
      section.dataset.state = "ready";
    } catch (error) {
      if (signal.aborted || controller.signal.aborted || ticket !== generation) return;
      review = null; section.dataset.state = "error"; status.textContent = applicationResumeError(error);
    } finally {
      if (!signal.aborted && ticket === generation) { transfer = null; check.textContent = "Check résumé again"; controls(); }
    }
  }
  signal.addEventListener("abort", () => {
    generation++; transfer?.abort(); transfer = null; review = null;
    for (const url of urls) revoke(url);
    section.replaceChildren();
  }, { once: true });
  section.dataset.state = "idle"; controls(); return section;
}
