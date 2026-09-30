export const ROUTES = Object.freeze([
  Object.freeze({ name: "payouts", pattern: /^\/payouts\/?$/, title: "Payouts" }),
  Object.freeze({ name: "conversations", pattern: /^\/conversations\/?$/, title: "Messages" }),
  Object.freeze({ name: "home", pattern: /^\/home\/?$/, title: "Home" }),
  Object.freeze({ name: "browse", pattern: /^\/browse\/?$/, title: "Browse Matters" }),
  Object.freeze({ name: "work", pattern: /^\/work\/?$/, title: "Matters" }),
  Object.freeze({ name: "settings", pattern: /^\/settings\/?$/, title: "Profile Settings" }),
  Object.freeze({ name: "help", pattern: /^\/help\/?$/, title: "Help" }),
  Object.freeze({ name: "profile", pattern: /^\/profile\/([^/]+)\/?$/, title: "Profile", parameter: "profileId" }),
  Object.freeze({ name: "attorney", pattern: /^\/attorney\/([^/]+)\/?$/, title: "Attorney profile", parameter: "attorneyId" }),
  Object.freeze({ name: "matter", pattern: /^\/matter\/([^/]+)\/?$/, title: "Matter workspace", parameter: "matterId" }),
]);

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRouteHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const source = raw.startsWith("/") ? raw : `/${raw}`;
  const queryIndex = source.indexOf("?");
  const pathname = (queryIndex >= 0 ? source.slice(0, queryIndex) : source) || "/home";
  const queryString = queryIndex >= 0 ? source.slice(queryIndex + 1) : "";

  for (const definition of ROUTES) {
    const match = pathname.match(definition.pattern);
    if (!match) continue;
    const params = definition.parameter ? { [definition.parameter]: safeDecode(match[1]) } : {};
    const query = new URLSearchParams(queryString);
    if (definition.name === "home" && query.get("view") === "history") {
      query.delete("view");
      return Object.freeze({ name: "payouts", title: "Payouts", pathname: "/payouts", params: Object.freeze({}), query, key: `/payouts${query.size ? `?${query}` : ""}`, found: true });
    }
    if(definition.name === "matter" && query.get("tab") === "messages") {
      query.delete("tab");query.set("matter",params.matterId);
      return Object.freeze({name:"conversations",title:"Messages",pathname:"/conversations",params:Object.freeze({}),query,key:`/conversations?${query}`,found:true});
    }
    return Object.freeze({
      name: definition.name,
      title: definition.title,
      pathname,
      params: Object.freeze(params),
      query,
      key: `${pathname}${queryString ? `?${queryString}` : ""}`,
      found: true,
    });
  }

  return Object.freeze({
    name: "not-found",
    title: "Page not found",
    pathname,
    params: Object.freeze({}),
    query: new URLSearchParams(queryString),
    key: `${pathname}${queryString ? `?${queryString}` : ""}`,
    found: false,
  });
}

export function createRouter({ windowObject = window, scrollElement, render }) {
  if (!scrollElement || typeof render !== "function") {
    throw new TypeError("The V2 router requires one scroll owner and one render function.");
  }

  const scrollPositions = new Map();
  let currentRoute = null;
  let started = false;
  let navigationSequence = 0;
  let focusAfterHashChange = false;

  function currentHash() {
    return String(windowObject.location.hash || "");
  }

  function canonicalizeInitialHash() {
    if (currentHash() && currentHash() !== "#/") return;
    const url = new URL(windowObject.location.href);
    url.hash = "/home";
    windowObject.history.replaceState(windowObject.history.state, "", url);
  }

  async function commit({ focus = true, refresh = false } = {}) {
    const sequence = ++navigationSequence;
    if (currentRoute) scrollPositions.set(currentRoute.key, scrollElement.scrollTop);
    const nextRoute = parseRouteHash(currentHash());
    const restoredScrollTop = scrollPositions.get(nextRoute.key) || 0;
    document.documentElement.dataset.lpcV2Route = nextRoute.name;
    document.documentElement.dataset.lpcV2Navigation = "pending";
    document.title = `${nextRoute.title} – Let’s-ParaConnect`;

    try {
      await render(nextRoute, {
        sequence,
        isCurrent: () => sequence === navigationSequence,
        isInitial: currentRoute === null,
        isPrimaryRouteChange: Boolean(currentRoute && currentRoute.name !== nextRoute.name),
        restoredScrollTop,
      });
    } catch (error) {
      if (sequence !== navigationSequence) return;
      await render(
        Object.freeze({ ...nextRoute, name: "route-error", title: "Something went wrong", error }),
        {
          sequence,
          isCurrent: () => sequence === navigationSequence,
          isInitial: currentRoute === null,
          isPrimaryRouteChange: Boolean(currentRoute),
          restoredScrollTop,
        }
      );
    }
    if (sequence !== navigationSequence) return;

    currentRoute = nextRoute;
    // Restore before the browser can paint the newly committed view. Deferring this
    // by a frame makes a tall page visibly jump through the previous route's offset.
    scrollElement.scrollTop = restoredScrollTop;
    document.documentElement.dataset.lpcV2Navigation = "idle";
    document.documentElement.dataset.lpcV2CommittedRoute = nextRoute.name;
    // Finish focus and overlay cleanup in the same commit. A deferred callback
    // can otherwise close Search after the user has already reopened it.
    if (focus) scrollElement.focus({ preventScroll: true });
    windowObject.dispatchEvent(new CustomEvent("lpc:v2-route-changed", {
      detail: refresh ? { ...nextRoute, refresh: true } : nextRoute,
    }));
  }

  function onHashChange() {
    const focus = focusAfterHashChange;
    focusAfterHashChange = false;
    commit({ focus });
  }

  function onDocumentClick(event) {
    const link = event.target.closest("a[data-v2-route]");
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, windowObject.location.href);
    if (url.origin !== windowObject.location.origin || url.pathname !== windowObject.location.pathname) return;
    event.preventDefault();
    // Pointer navigation should keep focus on the persistent control. Keyboard
    // navigation moves focus to main, except for tabs whose roving focus remains
    // on the selected tab.
    // Firefox can report detail=1 for Enter activation; its empty pointer type
    // still distinguishes that keyboard click from mouse, pen and touch input.
    const keyboardActivation = event.detail === 0 || event.pointerType === "";
    const shouldMoveFocus = keyboardActivation && !link.matches('[role="tab"]');
    if (url.hash === currentHash()) {
      commit({ focus: shouldMoveFocus });
      return;
    }
    focusAfterHashChange = shouldMoveFocus;
    windowObject.location.hash = url.hash;
  }

  return Object.freeze({
    async start() {
      if (started) return;
      started = true;
      canonicalizeInitialHash();
      windowObject.addEventListener("hashchange", onHashChange);
      windowObject.document.addEventListener("click", onDocumentClick);
      await commit({ focus: false });
    },
    stop() {
      if (!started) return;
      started = false;
      navigationSequence += 1;
      windowObject.removeEventListener("hashchange", onHashChange);
      windowObject.document.removeEventListener("click", onDocumentClick);
    },
    refresh() {
      return commit({ focus: false, refresh: true });
    },
    getCurrentRoute() {
      return currentRoute;
    },
    getScrollPosition(key) {
      return scrollPositions.get(key) || 0;
    },
  });
}

// Return context is a list address, never an external or recursively nested URL.
export function safeMatterReturn(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\\#\x00-\x20\x7f]/.test(value) || !/^\/(home|work)(?:\?|$)/.test(value)) return null;
  const [path, query = ''] = value.split('?');
  const input = new URLSearchParams(query), output = new URLSearchParams();
  const keys = path === '/home' ? ['view','item','tab'] : ['section','appQuery','appStatus','appPractice','appRange','appSort','appPage','highlightCase','matterId','applicationId','appId','jobId'];
  for (const key of keys) {
    const text = input.get(key);
    if (input.getAll(key).length !== 1 || !text || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) continue;
    if (['highlightCase','matterId','applicationId','appId','jobId'].includes(key) && !/^[a-f0-9]{24}$/i.test(text)) continue;
    if (key === 'appPage' && !/^[1-9]\d{0,5}$/.test(text)) continue;
    output.set(key,text);
  }
  return path + (output.size ? '?' + output : '');
}
export function withMatterReturn(href, source) {
  const target = safeMatterReturn(source);
  if (!target || !/^\/matter\/[a-f0-9]{24}\?/i.test(href)) return href;
  const [path, query] = href.split('?'), parameters = new URLSearchParams(query);
  parameters.set('returnTo',target);
  return path + '?' + parameters;
}
