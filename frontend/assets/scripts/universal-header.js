(function initializeUniversalAuthenticatedHeader() {
  // These destinations can reveal without accepting an outgoing snapshot.
  // Keep their navigation ordinary: Chromium can otherwise reject the native
  // transition while the new settings, shell or Matter document is opening.
  let transitionBoundaryStyle = null;
  const restoreTransitionBoundary = () => {
    transitionBoundaryStyle?.remove();
    transitionBoundaryStyle = null;
  };
  window.navigation?.addEventListener("navigate", (event) => {
    restoreTransitionBoundary();
    const destination = new URL(event.destination.url);
    if (destination.origin !== window.location.origin || !["/attorney-v2.html", "/paralegal-v2.html", "/profile-settings.html", "/case-detail.html"].includes(destination.pathname)) return;
    transitionBoundaryStyle = document.createElement("style");
    transitionBoundaryStyle.textContent = "@view-transition { navigation: none; }";
    document.head.append(transitionBoundaryStyle);
  });
  window.navigation?.addEventListener("navigateerror", restoreTransitionBoundary);
  window.addEventListener("pageshow", restoreTransitionBoundary);
  const scriptUrl = document.currentScript?.src || window.location.href;
  const assetUrl = (relative) => new URL(relative, scriptUrl).href;
  let controls = null;
  let observer = null;
  let syncing = false;

  function storedUser() {
    try {
      return JSON.parse(localStorage.getItem("lpc_user") || "null");
    } catch (_) {
      return null;
    }
  }

  function roleOf(user) {
    return String(user?.role || "").trim().toLowerCase();
  }

  function loadStylesheet(href, marker) {
    const requestedPath = new URL(href, document.baseURI).pathname;
    const existing = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).find((link) => {
      try {
        return new URL(link.href, document.baseURI).pathname === requestedPath;
      } catch (_) {
        return false;
      }
    });
    if (existing || document.querySelector(`link[data-${marker}]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset[marker] = "true";
    document.head.appendChild(link);
  }

  function loadScript(src, marker) {
    if (document.querySelector(`script[data-${marker}]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find((item) => item.src === src);
      if (existing) {
        if (existing.dataset.loaded === "true") resolve();
        else {
          existing.addEventListener("load", resolve, { once: true });
          window.setTimeout(resolve, 0);
        }
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.dataset[marker] = "true";
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", reject, { once: true });
      document.body.appendChild(script);
    });
  }

  function notificationMarkup() {
    const wrapper = document.createElement("div");
    wrapper.className = "notification-wrapper";
    wrapper.innerHTML = `
      <button class="notification-icon" type="button" aria-label="View notifications" data-notification-toggle>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <span class="notification-badge" data-notification-badge>0</span>
      </button>
      <div class="notifications-panel notif-panel hidden" role="region" aria-label="Notifications" aria-live="polite" data-notification-panel>
        <div class="notif-header" aria-label="Notifications"></div>
        <div class="notif-scroll" data-notification-list></div>
        <div class="notif-empty" data-notification-empty>Loading…</div>
        <button type="button" class="notif-markall" data-notification-mark>Mark All Read</button>
      </div>`;
    return wrapper;
  }

  function headerFor(main) {
    const existing = main.querySelector(":scope > .lpc-universal-header-shell[data-lpc-universal-header='true']");
    if (existing) return existing;
    const header = document.createElement("div");
    header.className = "lpc-universal-header-shell lpc-universal-header-shell--created";
    header.setAttribute("role", "group");
    header.setAttribute("aria-label", "Workspace tools");
    main.prepend(header);
    return header;
  }

  function sharedHeaderHost(main) {
    const browseShell = main.closest(".browse-page-shell");
    if (browseShell) return browseShell;
    if (main.parentElement?.classList.contains("lpc-auth-page-shell")) return main.parentElement;
    return main;
  }

  function relocateMobileMenu(toolbar) {
    const menu = toolbar.querySelector(":scope > .sidebar-toggle");
    if (!menu) return;
    const sidebar = document.querySelector(".sidebar, #sidebarNav, .authenticated-browse-sidebar");
    if (sidebar?.parentNode) sidebar.parentNode.insertBefore(menu, sidebar);
  }

  function retireLegacyToolbars(main, activeHeader) {
    main.querySelectorAll(":scope > .topbar, :scope > .case-topbar, :scope > .page-header > .topbar").forEach((toolbar) => {
      if (toolbar === activeHeader) return;
      relocateMobileMenu(toolbar);
      if (toolbar.querySelector(":scope > .back-link")) {
        toolbar.classList.add("lpc-context-toolbar");
        return;
      }
      toolbar.hidden = true;
      toolbar.setAttribute("aria-hidden", "true");
      toolbar.querySelectorAll("[tabindex], button, a, input, select, textarea").forEach((control) => {
        control.setAttribute("tabindex", "-1");
      });
    });
  }

  function removeHeaderProfiles(root = document) {
    root.querySelectorAll(
      ".topbar .user-chip, .topbar .user-profile, .topbar .profile-menu, " +
      ".case-topbar .user-chip, .case-topbar .user-profile, .case-topbar .profile-menu, " +
      ".page-header .user-chip, .page-header .user-profile, .page-header .profile-menu, " +
      ".lpc-universal-header-shell .user-chip, .lpc-universal-header-shell .user-profile, .lpc-universal-header-shell .profile-menu"
    ).forEach((node) => {
      if (node.closest(".sidebar-profile-cluster")) return;
      node.remove();
    });
  }

  function consolidateNotifications() {
    if (!controls) return;
    const wrappers = Array.from(document.querySelectorAll("[data-notification-center] .notification-wrapper"));
    let primary = controls.querySelector(":scope > .notification-wrapper");
    if (!primary && wrappers.length) {
      primary = wrappers.shift();
      controls.appendChild(primary);
    }
    if (!primary) {
      primary = notificationMarkup();
      controls.appendChild(primary);
    }
    wrappers.forEach((wrapper) => {
      if (wrapper !== primary && !controls.contains(wrapper)) wrapper.remove();
    });
  }

  function retireLegacyHeaderClusters() {
    document.querySelectorAll("[data-notification-center]").forEach((center) => {
      if (center === controls) return;
      center.removeAttribute("data-notification-center");
      center.removeAttribute("data-bound-notification-center");
      center.removeAttribute("data-bound-support-launcher");
      center.querySelectorAll(":scope > .support-launcher").forEach((launcher) => launcher.remove());
    });
    [
      ".topbar-header-slot",
      ".case-topbar-controls",
      ".profile-header-controls",
      "#paralegalFloatingCluster",
      ".lpc-shared-header .header-controls",
      ".lpc-shared-header",
    ].forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (node === controls || node.contains(controls)) return;
        if (node.children.length || String(node.textContent || "").trim()) return;
        node.remove();
      });
    });
  }

  function sync(role) {
    if (syncing || !controls) return;
    syncing = true;
    removeHeaderProfiles();
    consolidateNotifications();
    retireLegacyHeaderClusters();
    controls.querySelectorAll(".lpc-quick-create").forEach((action) => {
      action.hidden = role !== "attorney";
    });
    syncing = false;
  }

  async function mount(user) {
    const role = roleOf(user);
    if (!["attorney", "paralegal"].includes(role)) return;
    const sidebar = document.querySelector(".sidebar, #sidebarNav, .authenticated-browse-sidebar");
    const pageMain = document.querySelector("main") || document.querySelector(".case-main");
    const headerHost = pageMain ? sharedHeaderHost(pageMain) : null;
    if (!sidebar || !pageMain || !headerHost) return;

    const header = headerFor(headerHost);
    header.classList.add("lpc-universal-header-shell");
    header.dataset.lpcUniversalHeader = "true";
    header.setAttribute("aria-label", "Workspace tools");
    retireLegacyToolbars(pageMain, header);
    controls = header.querySelector(".lpc-universal-header-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "lpc-universal-header-controls";
      controls.dataset.notificationCenter = "true";
      controls.setAttribute("aria-label", "Search, create, notifications, and Assistant");
      header.appendChild(controls);
    }

    let searchHost = document.querySelector("[data-productivity-trigger-host]");
    if (!searchHost) {
      searchHost = document.createElement("div");
      searchHost.className = "lpc-global-search-host";
      searchHost.dataset.productivityTriggerHost = "";
    }
    controls.prepend(searchHost);
    sync(role);

    loadStylesheet(assetUrl("../styles/global-search.css?v=20260831-2"), "lpcUniversalSearchStyles");
    loadStylesheet(assetUrl("../styles/notifications-dashboard.css"), "lpcUniversalNotificationStyles");
    loadStylesheet(assetUrl("../styles/support-drawer.css?v=20260831-side-drawer"), "lpcUniversalAssistantStyles");

    try {
      await loadScript(assetUrl("productivity-command-registry.js"), "lpcUniversalRegistry");
      await loadScript(assetUrl("global-search.js"), "lpcUniversalSearch");
    } catch (error) {
      console.warn("Unable to initialize universal search", error);
    }

    try {
      const notifications = await import(assetUrl("utils/notifications.js"));
      notifications.scanNotificationCenters?.();
    } catch (error) {
      console.warn("Unable to initialize universal notifications", error);
    }

    try {
      const assistant = await import(assetUrl("utils/support-drawer.js"));
      assistant.scanSupportLaunchers?.();
    } catch (error) {
      console.warn("Unable to initialize universal Assistant", error);
    }

    sync(role);
    if (!observer) {
      observer = new MutationObserver(() => sync(role));
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function start() {
    if (document.body.classList.contains("public-site-chrome")) return;
    const cached = storedUser();
    if (["attorney", "paralegal"].includes(roleOf(cached))) {
      await mount(cached);
      return;
    }
    try {
      const response = await fetch("/api/auth/me", { credentials: "include", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      await mount(payload?.user || payload);
    } catch (error) {
      console.warn("[universal-header] authenticated user hydration failed", error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    void start();
  }
})();
