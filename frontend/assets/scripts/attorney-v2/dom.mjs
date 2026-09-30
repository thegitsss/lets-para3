export function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") element.textContent = String(value);
    else if (key === "className") element.className = value;
    else element.setAttribute(key, String(value));
  }
  children.forEach((child) => element.append(child));
  return element;
}

export function link(text, href, className = "av2-text-link") {
  return node("a", { text, href, className, ...(href.startsWith("#/") ? { "data-av2-route": "" } : {}) });
}

export function button(text, action, className = "av2-secondary") {
  const control = node("button", { type: "button", text, className });
  control.addEventListener("click", action);
  return control;
}

export function recoveryButton(label, action, className = "av2-secondary") {
  const control = button(label.replace(/^Refresh\b/, "Retry"), action, className);
  control.dataset.retryLabel = control.textContent;
  control.hidden = true;
  control.addEventListener("click", () => { control.restoreRecoveryFocus = true; });
  return control;
}

// Recovery is contextual: successful reads do not leave a manual reload task
// behind. Keep an explicit readback for uncertain actions, without replaying them.
export function setRecovery(control, boundary, { pending = false, label = "Check status" } = {}) {
  const failed = boundary.dataset.state === "error";
  const needed = failed || pending;
  const hadFocus = document.activeElement === control || control.restoreRecoveryFocus && [document.body, document.documentElement].includes(document.activeElement);
  const retryLabel = control.dataset.retryLabel ||= (control.getAttribute("aria-label") || control.textContent || "Retry").replace(/^Refresh\b/, "Retry");
  const caption = pending ? label : retryLabel;
  if (control.setLabel) control.setLabel(caption);
  else control.textContent = caption;
  control.setAttribute("aria-label", caption);
  control.hidden = !needed;
  if (!control.disabled || !needed) control.restoreRecoveryFocus = false;
  if (hadFocus && !needed) {
    const target = boundary.querySelector("h1, h2, h3, [role='status']") || boundary;
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  } else if (hadFocus && needed && !control.disabled) {
    control.focus({ preventScroll: true });
  }
}

export function page(title, description) {
  return node("section", { className: "av2-view", "aria-labelledby": "av2-page-title" }, [
    node("header", { className: "av2-view-header" }, [
      node("h1", { id: "av2-page-title", text: title }),
      ...(description ? [node("p", { className: "av2-lead", text: description })] : []),
    ]),
  ]);
}

// Each source has its own loading/failure boundary. A failed refresh removes old
// values; neither failed requests nor malformed payloads become fabricated zeroes.
export function region(title, { signal, load, render, key = title, showHeading = true } = {}) {
  const body = node("div", { className: "av2-region-body" });
  const status = node("p", { className: "av2-muted", role: "status" });
  const refresh = recoveryButton("Retry", () => void update(), "av2-refresh");
  refresh.setAttribute("aria-label", `Retry ${title.toLowerCase()}`);
  refresh.dataset.retryLabel = `Retry ${title.toLowerCase()}`;
  const section = node("section", { className: "av2-card", "aria-label": title, "data-av2-region": key }, [
    ...(showHeading ? [node("div", { className: "av2-card-heading" }, [node("h2", { text: title }), refresh])] : []), status, body, ...(!showHeading ? [refresh] : []),
  ]);
  let generation = 0;
  async function update({ background = false } = {}) {
    if (signal.aborted) return;
    const ticket = ++generation;
    const quiet = background && section.dataset.state === "ready";
    refresh.disabled = true;
    // Background reads keep the loaded presentation in place. Switching to
    // loading exposes headings and skeleton spacing on every notification poll.
    if (!quiet) section.dataset.state = "loading";
    body.setAttribute("aria-busy", "true");
    if (!background) body.replaceChildren();
    status.textContent = background ? "" : "Loading…";
    let focusAfterRefresh = null;
    try {
      const data = await load();
      if (signal.aborted || ticket !== generation) return;
      const focusedHref = background && body.contains(document.activeElement) ? document.activeElement.closest('a[href]')?.getAttribute('href') : null;
      const content = render(data);
      const unchanged = quiet && content.length === body.childNodes.length && content.every((child, index) => child.isEqualNode(body.childNodes[index]));
      if (!unchanged) {
        body.replaceChildren(...content);
        if (focusedHref) focusAfterRefresh = [...body.querySelectorAll('a[href]')].find(item => item.getAttribute('href') === focusedHref) || section.querySelector('h2') || section;
      }
      section.dataset.state = "ready";
      status.textContent = "";
    } catch (error) {
      // A request timeout can abort independently of route navigation.
      // Only a canceled route or superseded read should remain silent.
      if (signal.aborted || ticket !== generation) return;
      const hadFocus = background && body.contains(document.activeElement);
      body.replaceChildren();
      if (hadFocus) focusAfterRefresh = refresh;
      section.dataset.state = "error";
      status.textContent = error.kind === "authorization"
        ? "This information is no longer available to your account."
        : "This information couldn’t be loaded. Try again.";
    } finally {
      if (!signal.aborted && ticket === generation) {
        refresh.disabled = false;
        body.setAttribute("aria-busy", "false");
        setRecovery(refresh, section);
        if (focusAfterRefresh && !focusAfterRefresh.matches('a, button, input, select, textarea')) focusAfterRefresh.tabIndex = -1;
        focusAfterRefresh?.focus({ preventScroll: true });
      }
    }
  }
  section.readiness = update();
  section.refresh = update;
  return section;
}
