import { node, button } from "./dom.mjs";

export function financialRefresh(label, action) {
  const control = button("", action, "av2-secondary av2-financial-refresh");
  control.hidden = true;
  control.dataset.retryLabel = label.replace(/^Refresh\b/, "Retry");
  control.addEventListener("click", () => { control.restoreRecoveryFocus = true; });
  const caption = node("span", { className: "av2-financial-refresh-label" });
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) icon.setAttribute(key, value);
  const path = document.createElementNS(icon.namespaceURI, "path");
  path.setAttribute("d", "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5");
  icon.append(path); control.append(icon, caption);
  control.setLabel = (text, compact = false) => {
    caption.textContent = text;
    control.dataset.compact = String(compact);
    if (compact) control.setAttribute("title", text);
    else control.removeAttribute("title");
  };
  control.setLabel(label);
  return control;
}

export const financialHeading = (title, refresh) => node("header", { className: "av2-financial-section-heading" }, [node("h2", { text: title }), refresh]);

// These controls only open or cancel a local review. Submission controls must
// keep their existing fresh-read, revision and pending-request guards.
export const localFinancialReview = control => { control.dataset.financialLocalReview = ""; return control; };
