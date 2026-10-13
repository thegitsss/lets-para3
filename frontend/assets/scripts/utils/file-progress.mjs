// Presentation only. Availability must still come from the server's scan result.
export function fileProgress(status = "pending", label) {
  if (!document.querySelector('link[data-lpc-file-progress]')) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("../../styles/file-progress.css", import.meta.url).href;
    stylesheet.dataset.lpcFileProgress = "";
    document.head.append(stylesheet);
  }
  const ready = ["clean", "not_required"].includes(status);
  const indicator = document.createElement("span");
  indicator.className = `lpc-file-progress${ready ? " is-ready" : ""}`;
  indicator.dataset.fileProgress = ready ? "ready" : "pending";
  indicator.setAttribute("role", "status");
  indicator.setAttribute("aria-label", label || (ready ? "File ready" : "File processing"));
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(icon.namespaceURI, "path");
  path.setAttribute("d", ready ? "M5 12l4 4L19 6" : "M12 3a9 9 0 1 1-9 9");
  icon.append(path); indicator.append(icon);
  return indicator;
}
