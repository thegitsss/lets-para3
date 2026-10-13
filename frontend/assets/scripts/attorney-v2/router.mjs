import { parseRoute } from "./routes.mjs";

export function createRouter({ outlet, render, onError, onCommit, interceptRoute, windowObject = window }) {
  let active = false;
  let generation = 0;
  let controller;
  let current = null;
  const positions = new Map();
  const win = windowObject;
  function suspend() {
    if (current) positions.set(current.key, outlet.scrollTop);
    active = false;
    generation += 1;
    controller?.abort();
    current = null;
    outlet.removeEventListener("scroll", onScroll);
    win.removeEventListener("hashchange", onHash);
    win.document.removeEventListener("click", onClick);
  }
  async function commit({ focus = true } = {}) {
    if (!active) return;
    const route = parseRoute(win.location.hash);
    if(interceptRoute?.(route,current))return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const ticket = ++generation;
    outlet.setAttribute("aria-busy", "true");
    try {
      // Build off-DOM; keep the existing route in place until its successor is ready.
      const view = await render(route, { signal });
      if (!active || signal.aborted || ticket !== generation) return;
      outlet.replaceChildren(view);
      const savedPosition = positions.get(route.key) || 0;
      // Loading regions are shorter than populated lists. Restore once their
      // content is ready, unless the user has already started interacting.
      if (savedPosition && view?.readiness) {
        let interacted = false;
        const interact = () => { interacted = true; };
        for (const event of ["wheel", "touchstart", "keydown", "pointerdown"]) outlet.addEventListener(event, interact, { once: true, passive: true, signal });
        void view.readiness.then(() => {
          if (active && !signal.aborted && ticket === generation && !interacted) outlet.scrollTop = savedPosition;
          for (const event of ["wheel", "touchstart", "keydown", "pointerdown"]) outlet.removeEventListener(event, interact);
        });
      }
    } catch (error) {
      if (!active || signal.aborted || ticket !== generation) return;
      outlet.replaceChildren(onError(error));
    }
    current = route;
    outlet.scrollTop = positions.get(route.key) || 0;
    outlet.setAttribute("aria-busy", "false");
    win.document.title = `${route.title} – Let’s-ParaConnect`;
    win.document.documentElement.dataset.attorneyRoute = route.name;
    onCommit?.(route);
    const assistant = win.document.activeElement?.closest?.('#supportDrawer[aria-hidden="false"]');
    if (focus && !assistant) outlet.focus({ preventScroll: true });
  }
  const onScroll = () => {
    // Hash navigation can reset scroll before hashchange reaches the router.
    if (current && win.location.hash.slice(1) === current.key) positions.set(current.key, outlet.scrollTop);
  };
  const onHash = () => { void commit(); };
  function onClick(event) {
    const link = event.target.closest?.("a[data-av2-route]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, win.location.href);
    if (url.origin !== win.location.origin || url.pathname !== win.location.pathname || url.search !== win.location.search || !url.hash.startsWith("#/")) return;
    event.preventDefault();
    if (current) positions.set(current.key, outlet.scrollTop);
    if (url.hash !== win.location.hash) win.location.hash = url.hash;
  }
  return Object.freeze({
    async start() {
      if (active) return;
      active = true;
      if (!win.location.hash || win.location.hash === "#/") win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}#/home`);
      outlet.addEventListener("scroll", onScroll, { passive: true });
      win.addEventListener("hashchange", onHash);
      win.document.addEventListener("click", onClick);
      await commit({ focus: false });
    },
    refresh: () => commit({ focus: false }),
    suspend,
    stop() {
      suspend();
      positions.clear();
    },
  });
}
