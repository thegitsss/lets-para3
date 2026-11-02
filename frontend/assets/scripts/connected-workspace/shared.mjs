export const validId = value => /^[a-f0-9]{24}$/i.test(value || "");
export function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") element.textContent = value;
    else if (key === "className") element.className = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  element.append(...children);
  return element;
}
export const action = (text, fn, className = "lpc-connected-button") => {
  const control = node("button", { type: "button", text, className });
  control.addEventListener("click", fn);
  return control;
};
export function notice(text, error = false) { return node("p", { className: error ? "cw-notice cw-error" : "cw-notice", role: error ? "alert" : "status", text }); }
export function input(label, attributes = {}) {
  const id = "cw-" + crypto.randomUUID(), control = node(attributes.multiline ? "textarea" : "input", { ...attributes, multiline: undefined, id });
  return { control, element: node("label", { className: "cw-field", for: id }, [node("span", { text: label }), control]) };
}
export function matterHref(role, caseId, tab = "files") {
  return role === "paralegal" ? "/paralegal-v2.html#/matter/" + caseId + "?tab=" + tab : "/attorney-v2.html#/matters/" + caseId + "/" + tab;
}
