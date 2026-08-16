(function mountProfileClusterInSidebar() {
  const FALLBACK_AVATAR = "assets/avatar-placeholder.svg";
  const PROFILE_SELECTORS = [
    ".profile-header-controls .profile-menu",
    ".lpc-shared-header .user-chip",
    "#paralegalFloatingCluster .user-profile",
    "#createCaseUserChip",
    ".case-topbar-controls .user-chip",
    ".profile-header-controls .user-chip",
    "#clusterProfileTrigger",
  ];

  function findProfileCluster() {
    for (const selector of PROFILE_SELECTORS) {
      const cluster = document.querySelector(selector);
      if (cluster) return cluster;
    }
    return null;
  }

  function getStoredUser() {
    try {
      return JSON.parse(localStorage.getItem("lpc_user") || "null");
    } catch (_) {
      return null;
    }
  }

  function installAvatarFallback(image) {
    if (!image || image.dataset.sidebarAvatarFallbackBound === "true") return;
    image.dataset.sidebarAvatarFallbackBound = "true";
    image.addEventListener("error", () => {
      const fallbackUrl = new URL(FALLBACK_AVATAR, document.baseURI).href;
      if (image.src === fallbackUrl) return;
      image.src = FALLBACK_AVATAR;
      image.alt = "";
    });
  }

  function normalizeProfileAvatars(cluster) {
    cluster?.querySelectorAll?.("img").forEach(installAvatarFallback);
  }

  function createProfileCluster() {
    const user = getStoredUser() || {};
    const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "Profile";
    const avatar = user.pendingProfileImage || user.profileImage || user.avatarURL || FALLBACK_AVATAR;
    const cluster = document.createElement("button");
    cluster.type = "button";
    cluster.className = "user-chip";
    cluster.setAttribute("aria-label", "Open profile menu");
    const image = document.createElement("img");
    installAvatarFallback(image);
    image.src = avatar;
    image.alt = "";
    const details = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = name;
    details.appendChild(strong);
    cluster.append(image, details);
    return cluster;
  }

  function mount() {
    const sidebar = document.querySelector(".sidebar, #sidebarNav, .authenticated-browse-sidebar");
    const host = sidebar?.querySelector(".logo");
    const cluster = findProfileCluster() || createProfileCluster();
    if (!host) return false;
    normalizeProfileAvatars(cluster);
    if (host.contains(cluster)) {
      normalizeProfileMenu(host);
      normalizeSidebarNavigation(sidebar);
      setupAttorneyMatterNavigation(sidebar);
      normalizeSidebarFooter(sidebar);
      observeSidebarNavigation(sidebar);
      return true;
    }

    host.textContent = "";
    host.classList.add("sidebar-profile-host");
    const profileShell = document.createElement("div");
    profileShell.className = "sidebar-profile-cluster";
    const linkedMenu = findLinkedMenu(cluster);
    profileShell.appendChild(cluster);
    if (linkedMenu && !cluster.contains(linkedMenu)) profileShell.appendChild(linkedMenu);
    host.appendChild(profileShell);
    normalizeProfileMenu(profileShell);
    normalizeSidebarNavigation(sidebar);
    setupAttorneyMatterNavigation(sidebar);
    normalizeSidebarFooter(sidebar);
    observeSidebarNavigation(sidebar);
    return true;
  }

  function findLinkedMenu(cluster) {
    const nested = cluster.querySelector?.(".profile-dropdown, [data-profile-menu]");
    if (nested) return nested;
    const trigger = cluster.matches?.("[aria-controls]") ? cluster : cluster.querySelector?.("[aria-controls]");
    const controlledId = trigger?.getAttribute("aria-controls");
    if (controlledId) {
      const controlled = document.getElementById(controlledId);
      if (controlled?.matches(".profile-dropdown, [data-profile-menu]")) return controlled;
    }
    const sibling = cluster.nextElementSibling;
    return sibling?.matches(".profile-dropdown, [data-profile-menu]") ? sibling : null;
  }

  function normalizeProfileMenu(cluster) {
    let menu = cluster.querySelector(".profile-dropdown, [data-profile-menu]");
    const trigger = cluster.querySelector(".user-chip, .user-profile, [data-profile-toggle]") || cluster;
    const menuWasCreated = !menu;
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "profile-dropdown";
      menu.setAttribute("data-profile-menu", "");
      menu.setAttribute("aria-hidden", "true");
      menu.innerHTML = '<a href="profile-settings.html" data-account-settings>Account Settings</a>';
      cluster.appendChild(menu);
    }

    let logout = menu.querySelector("[data-logout], [data-cluster-logout], .logout-btn");
    if (!logout) {
      logout = document.createElement("button");
      logout.type = "button";
      logout.textContent = "Log Out";
      menu.appendChild(logout);
    }
    logout.removeAttribute("data-cluster-logout");
    logout.setAttribute("data-logout", "");
    logout.classList.add("logout-btn");
    if (menuWasCreated && !logout.dataset.sidebarLogoutBound) {
      logout.dataset.sidebarLogoutBound = "true";
      logout.addEventListener("click", async (event) => {
        if (typeof window.logoutUser === "function") return;
        event.preventDefault();
        try {
          const { logoutUser } = await import("../auth.js");
          await logoutUser(event);
        } catch (error) {
          console.warn("Unable to load the logout control", error);
        }
      });
    }

    if (menuWasCreated && !trigger.dataset.sidebarProfileMenuBound) {
      trigger.dataset.sidebarProfileMenuBound = "true";
      if (trigger.matches("a")) {
        trigger.removeAttribute("href");
        trigger.setAttribute("role", "button");
        trigger.setAttribute("tabindex", "0");
      }
      trigger.setAttribute("aria-haspopup", "true");
      trigger.setAttribute("aria-expanded", "false");
      const toggleMenu = (event) => {
        if (event.target.closest(".profile-dropdown, [data-profile-menu]")) return;
        event.preventDefault();
        const open = !menu.classList.contains("show");
        document.querySelectorAll(".profile-dropdown.show, [data-profile-menu].show").forEach((other) => {
          if (other !== menu) {
            other.classList.remove("show");
            other.setAttribute("aria-hidden", "true");
          }
        });
        menu.classList.toggle("show", open);
        menu.setAttribute("aria-hidden", String(!open));
        trigger.setAttribute("aria-expanded", String(open));
      };
      trigger.addEventListener("click", toggleMenu);
      trigger.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        toggleMenu(event);
      });
    }
  }

  function iconMarkup(kind) {
    const paths = {
      home: '<path d="m3 10 9-7 9 7"></path><path d="M5 9v11h14V9"></path><path d="M9 20v-6h6v6"></path>',
      matters: '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M3 12h18"></path>',
      browse: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path>',
      people: '<circle cx="9" cy="7" r="4"></circle><path d="M2 21a7 7 0 0 1 14 0"></path><path d="M18 8a3 3 0 0 1 0 6"></path><path d="M22 21a5 5 0 0 0-4-4"></path>',
      payments: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path><path d="M6 15h2"></path>',
      profile: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>',
      help: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.7 2.7 0 1 1 4.6 1.9c-1.1.9-2.1 1.3-2.1 3.1"></path><path d="M12 18h.01"></path>',
    };
    return `<svg class="sidebar-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.matters}</svg>`;
  }

  function getLinkKind(link) {
    const text = String(link.textContent || "").trim().toLowerCase();
    const href = String(link.getAttribute("href") || "").toLowerCase();
    if (text === "home" || text.includes("dashboard") || href.includes("#home") || href.includes("dashboard-")) return "home";
    if (text.includes("paralegal")) return "people";
    if (text.includes("fund") || text.includes("payment") || text.includes("billing")) return "payments";
    if (text.includes("profile") || text.includes("setting") || text.includes("security") || text.includes("preference")) return "profile";
    if (text.includes("help")) return "help";
    if (text.includes("browse")) return "browse";
    return "matters";
  }

  function normalizeSidebarNavigation(sidebar) {
    sidebar.querySelectorAll("nav").forEach((nav) => {
      const returnLink = sidebar.querySelector("#dashboardReturnLink");
      if (returnLink && !nav.contains(returnLink)) {
        returnLink.removeAttribute("style");
        returnLink.textContent = "Dashboard";
        nav.prepend(returnLink);
      }
      const links = Array.from(nav.querySelectorAll(":scope > a, :scope > button"));
      links.forEach((link) => {
        link.classList.add("lpc-sidebar-nav-link");
        Array.from(link.childNodes).forEach((node) => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return;
          const label = document.createElement("span");
          label.className = "lpc-sidebar-nav-label";
          label.textContent = node.textContent.trim();
          node.replaceWith(label);
        });
        Array.from(link.children).forEach((child) => {
          if (child.matches("svg, .sidebar-nav-icon, .case-nav-caret")) return;
          child.classList.add("lpc-sidebar-nav-label");
        });
        if (!link.querySelector(".sidebar-nav-icon")) {
          link.insertAdjacentHTML("afterbegin", iconMarkup(getLinkKind(link)));
        }
        const kind = getLinkKind(link);
        if (["profile", "help"].includes(kind)) link.classList.add("lpc-sidebar-nav-link--secondary");
      });
      const firstSecondary = nav.querySelector(".lpc-sidebar-nav-link--secondary");
      if (firstSecondary && !nav.querySelector(".lpc-sidebar-section-label")) {
        const label = document.createElement("div");
        label.className = "lpc-sidebar-section-label";
        label.textContent = links.some((link) => getLinkKind(link) === "profile") ? "Account" : "Support";
        firstSecondary.before(label);
      }
    });
  }

  function isAttorneySidebar(sidebar) {
    const role = String(getStoredUser()?.role || "").trim().toLowerCase();
    if (role) return role === "attorney";
    return !!sidebar.querySelector('a[href*="dashboard-attorney"]') &&
      !sidebar.querySelector('a[href*="dashboard-paralegal"]');
  }

  function getMatterToggle(sidebar) {
    const links = Array.from(sidebar.querySelectorAll("nav > a, nav > button"));
    return links.find((link) => {
      const label = link.querySelector(".lpc-sidebar-nav-label")?.textContent || link.textContent || "";
      const href = String(link.getAttribute("href") || "").toLowerCase();
      const target = String(link.getAttribute("data-view-target") || "").toLowerCase();
      return String(label).trim().toLowerCase() === "matters" &&
        (target === "cases" || href.includes("#cases"));
    }) || null;
  }

  function matterId(item = {}) {
    return String(item._id || item.id || "").trim();
  }

  function renderAttorneyMatters(panel, matters) {
    const status = panel.querySelector("[data-sidebar-matters-status]");
    const list = panel.querySelector("[data-sidebar-matters-list]");
    if (!status || !list) return;
    list.textContent = "";

    const activeMatters = (Array.isArray(matters) ? matters : []).filter((item) => {
      const state = String(item?.status || "").trim().toLowerCase();
      return matterId(item) && item?.archived !== true && item?.paymentReleased !== true &&
        !["completed", "closed", "cancelled", "canceled"].includes(state);
    });

    activeMatters.forEach((item) => {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.className = "lpc-sidebar-matter-link";
      link.href = `case-detail.html?caseId=${encodeURIComponent(matterId(item))}`;
      link.textContent = String(item.title || item.name || "Untitled matter").trim();
      link.title = link.textContent;
      row.appendChild(link);
      list.appendChild(row);
    });

    status.textContent = activeMatters.length ? "" : "No active matters";
    status.hidden = !!activeMatters.length;
  }

  async function loadAttorneyMatters(panel) {
    if (panel.dataset.sidebarMattersLoaded === "true" || panel.dataset.sidebarMattersLoading === "true") return;
    panel.dataset.sidebarMattersLoading = "true";
    const status = panel.querySelector("[data-sidebar-matters-status]");
    if (status) {
      status.hidden = false;
      status.textContent = "Loading matters…";
    }
    try {
      const response = await fetch("/api/cases/my-active?limit=100", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Matter navigation request failed (${response.status})`);
      const payload = await response.json();
      renderAttorneyMatters(panel, Array.isArray(payload) ? payload : payload?.items);
      panel.dataset.sidebarMattersLoaded = "true";
    } catch (error) {
      console.warn("Unable to load attorney matter navigation", error);
      if (status) {
        status.hidden = false;
        status.textContent = "Matters unavailable";
      }
    } finally {
      delete panel.dataset.sidebarMattersLoading;
    }
  }

  function setMatterPanelOpen(toggle, panel, open) {
    toggle.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    panel.classList.toggle("is-open", open);
    panel.hidden = !open;
    if (open) void loadAttorneyMatters(panel);
  }

  function navigateToMatters(toggle) {
    const href = String(toggle.getAttribute("href") || "").trim();
    if (href) window.location.href = href;
  }

  function setupAttorneyMatterNavigation(sidebar) {
    if (!isAttorneySidebar(sidebar)) return;
    const toggle = getMatterToggle(sidebar);
    if (!toggle || toggle.dataset.sidebarMattersBound === "true") return;

    // The Matter workspace already owns this dropdown on case-detail.html.
    if (toggle.matches("[data-case-nav-toggle]") && toggle.parentElement?.querySelector("[data-case-nav-dropdown]")) {
      toggle.addEventListener("click", (event) => {
        const panel = toggle.parentElement?.querySelector("[data-case-nav-dropdown]");
        if (!panel?.classList.contains("show")) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        navigateToMatters(toggle);
      }, { capture: true });
      toggle.dataset.sidebarMattersBound = "true";
      return;
    }

    toggle.dataset.sidebarMattersBound = "true";
    toggle.classList.add("lpc-attorney-matters-toggle");
    const panelId = `sidebar-active-matters-${Math.random().toString(36).slice(2, 9)}`;
    toggle.setAttribute("aria-controls", panelId);
    toggle.setAttribute("aria-expanded", "false");
    toggle.insertAdjacentHTML(
      "beforeend",
      '<svg class="lpc-sidebar-matters-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"></path></svg>'
    );

    const panel = document.createElement("div");
    panel.id = panelId;
    panel.className = "lpc-sidebar-matters-panel";
    panel.hidden = true;
    panel.innerHTML = [
      '<div class="lpc-sidebar-matters-status" data-sidebar-matters-status role="status">Loading matters…</div>',
      '<ul class="lpc-sidebar-matters-list" data-sidebar-matters-list></ul>',
    ].join("");
    toggle.after(panel);

    toggle.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!panel.hidden) {
        setMatterPanelOpen(toggle, panel, false);
        navigateToMatters(toggle);
        return;
      }
      if (document.body.classList.contains("nav-collapsed")) {
        document.body.classList.remove("nav-collapsed");
      }
      setMatterPanelOpen(toggle, panel, true);
    }, { capture: true });

    document.addEventListener("click", (event) => {
      if (panel.hidden || toggle.contains(event.target) || panel.contains(event.target)) return;
      setMatterPanelOpen(toggle, panel, false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || panel.hidden) return;
      setMatterPanelOpen(toggle, panel, false);
      toggle.focus();
    });
  }

  function observeSidebarNavigation(sidebar) {
    if (sidebar.dataset.sidebarNavigationObserved) return;
    sidebar.dataset.sidebarNavigationObserved = "true";
    const observer = new MutationObserver(() => {
      normalizeSidebarNavigation(sidebar);
      setupAttorneyMatterNavigation(sidebar);
    });
    sidebar.querySelectorAll("nav").forEach((nav) => observer.observe(nav, { childList: true }));
  }

  function normalizeSidebarFooter(sidebar) {
    sidebar.querySelectorAll("#logoutBtn").forEach((logout) => logout.remove());
    let footer = sidebar.querySelector(".sidebar-footer");
    if (!footer) {
      footer = document.createElement("div");
      footer.className = "sidebar-footer";
      footer.textContent = "© Let’s-ParaConnect 2026";
      sidebar.appendChild(footer);
    }
    let bottom = sidebar.querySelector(".sidebar-bottom");
    if (!bottom) {
      bottom = document.createElement("div");
      bottom.className = "sidebar-bottom";
      footer.before(bottom);
    }
    bottom.append(footer);
  }

  function start() {
    if (mount()) return;
    const observer = new MutationObserver(() => {
      if (!mount()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
