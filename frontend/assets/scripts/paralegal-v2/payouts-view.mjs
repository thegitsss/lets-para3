import { verifyParalegalSession } from "./session-boundary.mjs";
import { readEarningsReport, readExpectedCompensation, renderEarningsReport } from "../utils/paralegal-financials.mjs";

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};

// Financial data stays in this mounted view, never in browser storage or a
// cross-route cache. Every refresh verifies the account before and after reading.
export function createPayoutsView({ api, getIdentity, onSessionLost }) {
  let root = null;
  let controller = null;
  let generation = 0;

  function clearProtected() {
    generation += 1;
    controller?.abort();
    controller = null;
    root?.replaceChildren();
    root = null;
  }

  function render({ isCurrent = () => true } = {}) {
    clearProtected();
    const view = node("section", null, "v2-payouts");
    root = view;
    view.dataset.v2Payouts = "";
    view.setAttribute("aria-labelledby", "v2-payouts-title");
    const heading = node("h1", "Payouts");
    heading.id = "v2-payouts-title";
    const content = node("div");
    content.setAttribute("aria-live", "polite");
    const actions = node("nav", null, "ph-history-actions");
    actions.setAttribute("aria-label", "Payout navigation");
    for (const [label, path] of [["Completed & withdrawn matters", "/work?section=history"], ["Payment settings", "/settings?tab=security&section=payments"]]) {
      const link = node("a", label, "ph-link");
      link.href = `paralegal-v2.html#${path}`;
      link.dataset.view = path;
      actions.append(link);
    }
    view.append(heading, content, actions);

    async function load() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const run = ++generation;
      const ownerId = String(getIdentity()?.id || getIdentity()?._id || "");
      const current = () => run === generation && root === view && isCurrent();
      const sameOwner = () => ownerId && ownerId === String(getIdentity()?.id || getIdentity()?._id || "");
      view.dataset.state = "loading";
      content.setAttribute("aria-busy", "true");
      content.replaceChildren(node("p", "Loading payouts…"));
      const timeout = setTimeout(() => request.abort(), 10_000);
      try {
        const options = { signal: request.signal };
        const before = await verifyParalegalSession(api, options);
        if (!current()) return;
        if (!sameOwner() || before.state !== "ready" || before.identity.id !== ownerId) {
          clearProtected(); onSessionLost?.(); return;
        }
        const payload = await api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(ownerId)}`, options);
        const after = await verifyParalegalSession(api, options);
        if (!current()) return;
        if (!sameOwner() || after.state !== "ready" || after.identity.id !== ownerId) {
          clearProtected(); onSessionLost?.(); return;
        }
        let report = null;
        let expected = null;
        try { report = readEarningsReport(payload?.metrics?.earningsReport, ownerId); } catch { /* Unverified totals stay unavailable. */ }
        try { expected = readExpectedCompensation(payload?.metrics?.expectedCompensation, ownerId); } catch { /* An estimate failure does not erase verified payouts. */ }
        view.dataset.state = report ? "ready" : "unavailable";
        content.replaceChildren(renderEarningsReport(report, { expected, onRetry: load }));
        if (report && !expected) {
          const retry = node("button", "Refresh payouts", "ph-link");
          retry.type = "button";
          retry.addEventListener("click", load);
          content.append(retry);
        }
      } catch {
        if (!current()) return;
        if (!sameOwner()) { clearProtected(); onSessionLost?.(); return; }
        view.dataset.state = "unavailable";
        content.replaceChildren(renderEarningsReport(null, { onRetry: load }));
      } finally {
        clearTimeout(timeout);
        if (current()) content.removeAttribute("aria-busy");
      }
    }
    void load();
    return view;
  }

  return { render, clearProtected, leave: clearProtected };
}
