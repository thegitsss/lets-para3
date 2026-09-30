(function mountProfileClusterInSidebar() {
  const FALLBACK_AVATAR = "assets/avatar-placeholder.svg";
  function safeAvatarUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return FALLBACK_AVATAR;
    try {
      const url = new URL(value, document.baseURI);
      return url.origin === location.origin && ["http:", "https:"].includes(url.protocol)
        ? url.href
        : FALLBACK_AVATAR;
    } catch {
      return FALLBACK_AVATAR;
    }
  }
  const PROFILE_SELECTORS = [
    "#sidebarNav [data-lpc-sidebar-profile-trigger]",
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

  function getDisplayName(user = getStoredUser() || {}) {
    return `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "Member";
  }

  function getDisplayAvatar(user = getStoredUser() || {}) {
    return safeAvatarUrl(user.pendingProfileImage || user.profileImage || user.avatarURL || FALLBACK_AVATAR);
  }

  function syncSidebarAccountIdentity(user = getStoredUser() || {}) {
    const name = getDisplayName(user);
    const avatar = getDisplayAvatar(user);
    document.querySelectorAll(".lpc-account-menu-user-name, .lpc-sidebar-profile-trigger .globalProfileName").forEach((node) => {
      node.textContent = name;
    });
    document.querySelectorAll(".lpc-account-menu-avatar, .lpc-sidebar-profile-trigger .globalProfileImage").forEach((image) => {
      installAvatarFallback(image);
      image.src = avatar;
    });
    document.querySelectorAll(".lpc-account-menu-user").forEach((row) => {
      row.setAttribute("aria-label", `Open profile settings for ${name}`);
    });
  }

  function accountMenuIcon(kind, className = "lpc-account-menu-icon") {
    const paths = {
      settings: [
        '<circle cx="12" cy="12" r="3"></circle>',
        '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.37.33.7.6 1 .3.25.69.39 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6Z"></path>',
      ].join(""),
      plus: '<path d="M12 5v14M5 12h14"></path>',
      user: '<circle cx="12" cy="7.5" r="4"></circle><path d="M5 21v-1.5A5.5 5.5 0 0 1 10.5 14h3a5.5 5.5 0 0 1 5.5 5.5V21Z"></path>',
      info: '<rect x="5" y="3" width="14" height="18" rx="3"></rect><path d="M12 10v6M12 7h.01"></path>',
      signout: '<path d="M10 17l5-5-5-5M15 12H3"></path><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"></path>',
      chevron: '<path d="m9 18 6-6-6-6"></path>',
      caret: '<path d="m8 10 4 4 4-4"></path>',
    };
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || ""}</svg>`;
  }

  function setAccountMenuItemContent(item, kind, label, { trailing = "" } = {}) {
    item.replaceChildren();
    item.insertAdjacentHTML("beforeend", accountMenuIcon(kind));
    const text = document.createElement("span");
    text.className = "lpc-account-menu-label";
    text.textContent = label;
    item.appendChild(text);
    if (trailing) {
      item.insertAdjacentHTML("beforeend", accountMenuIcon(trailing, "lpc-account-menu-trailing-icon"));
    }
  }

  function normalizeProfileTrigger(trigger, menu) {
    if (!trigger) return;
    trigger.classList.add("lpc-sidebar-profile-trigger");
    const image = trigger.querySelector(":scope > img");
    image?.classList.add("globalProfileImage", "lpc-sidebar-profile-trigger-avatar");
    const details = Array.from(trigger.children).find((child) => child.tagName === "DIV" && child !== menu);
    details?.classList.add("lpc-sidebar-profile-trigger-details");
    details?.querySelector("strong")?.classList.add("globalProfileName");
    if (!trigger.querySelector(":scope > .lpc-profile-trigger-caret")) {
      trigger.insertAdjacentHTML("beforeend", accountMenuIcon("caret", "lpc-profile-trigger-caret"));
    }
  }

  function positionProfileMenu(menu, trigger) {
    if (!menu?.classList.contains("show") || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.min(270, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    menu.style.setProperty("--lpc-account-menu-left", `${Math.round(left)}px`);
    menu.style.setProperty("--lpc-account-menu-top", `${Math.round(rect.bottom + 8)}px`);
  }

  function portalProfileMenu(menu, trigger) {
    if (!menu || !trigger || menu.dataset.sidebarMenuPortaled === "true") return;
    menu.dataset.sidebarMenuPortaled = "true";
    document.body.appendChild(menu);
    const observer = new MutationObserver(() => {
      positionProfileMenu(menu, trigger);
      trigger.setAttribute("aria-expanded", String(menu.classList.contains("show")));
    });
    observer.observe(menu, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", () => positionProfileMenu(menu, trigger));
    document.addEventListener("scroll", () => positionProfileMenu(menu, trigger), true);
    document.addEventListener("click", (event) => {
      if (!menu.classList.contains("show") || menu.contains(event.target) || trigger.contains(event.target)) return;
      menu.classList.remove("show");
      menu.setAttribute("aria-hidden", "true");
      trigger.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.classList.contains("show")) return;
      event.preventDefault();
      menu.classList.remove("show");
      menu.setAttribute("aria-hidden", "true");
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus();
    });
  }

  function buildAccountMenu(menu, trigger) {
    const user = getStoredUser() || {};
    const name = getDisplayName(user);
    const avatar = getDisplayAvatar(user);
    let settings = menu.querySelector("[data-account-settings]");
    if (!settings) {
      settings = document.createElement("a");
      settings.href = "profile-settings.html";
      settings.setAttribute("data-account-settings", "");
    }
    if (settings.matches("a")) settings.href = "profile-settings.html";
    settings.classList.add("lpc-account-menu-item");
    setAccountMenuItemContent(settings, "settings", "Settings");

    const create = document.createElement("a");
    create.href = "create-case.html";
    create.className = "lpc-account-menu-item lpc-account-menu-create";
    create.setAttribute("data-account-create", "");
    setAccountMenuItemContent(create, "plus", "Create", { trailing: "chevron" });

    let logout = menu.querySelector("[data-logout], [data-cluster-logout], .logout-btn");
    if (!logout) {
      logout = document.createElement("button");
      logout.type = "button";
    }
    logout.removeAttribute("data-cluster-logout");
    logout.setAttribute("data-logout", "");
    logout.classList.add("logout-btn", "lpc-account-menu-item");
    setAccountMenuItemContent(logout, "signout", "Sign out");

    const identity = document.createElement("div");
    identity.className = "lpc-account-menu-identity";
    const identityAvatar = document.createElement("img");
    identityAvatar.className = "lpc-account-menu-avatar globalProfileImage";
    identityAvatar.src = avatar;
    identityAvatar.alt = "";
    installAvatarFallback(identityAvatar);
    const productName = document.createElement("strong");
    productName.className = "lpc-account-menu-product";
    productName.innerHTML = 'Let<span class="lpc-brand-apostrophe">’</span>s-ParaConnect';
    identity.append(identityAvatar, productName);

    const primary = document.createElement("div");
    primary.className = "lpc-account-menu-section lpc-account-menu-primary";
    primary.append(settings);
    if (isAttorneySidebar(trigger.closest(".sidebar, #sidebarNav, .authenticated-browse-sidebar") || document.body)) {
      primary.append(create);
    }

    const divider = document.createElement("div");
    divider.className = "lpc-account-menu-divider";
    divider.setAttribute("aria-hidden", "true");

    const signedInUser = document.createElement("a");
    signedInUser.href = "profile-settings.html#profile";
    signedInUser.className = "lpc-account-menu-item lpc-account-menu-user";
    signedInUser.setAttribute("aria-label", `Open profile settings for ${name}`);
    signedInUser.insertAdjacentHTML("beforeend", accountMenuIcon("user"));
    const userName = document.createElement("span");
    userName.className = "lpc-account-menu-label lpc-account-menu-user-name globalProfileName";
    userName.textContent = name;
    signedInUser.appendChild(userName);
    signedInUser.insertAdjacentHTML("beforeend", accountMenuIcon("info", "lpc-account-menu-trailing-icon"));

    const secondary = document.createElement("div");
    secondary.className = "lpc-account-menu-section lpc-account-menu-secondary";
    secondary.append(signedInUser, logout);

    menu.replaceChildren(identity, primary, divider, secondary);
    menu.classList.add("lpc-sidebar-account-menu");
    menu.setAttribute("aria-label", "Account menu");
    if (!menu.id) menu.id = `sidebarAccountMenu-${Math.random().toString(36).slice(2, 9)}`;
    trigger.setAttribute("aria-controls", menu.id);
    normalizeProfileTrigger(trigger, menu);
    return logout;
  }

  function createProfileCluster() {
    const user = getStoredUser() || {};
    const name = getDisplayName(user);
    const avatar = getDisplayAvatar(user);
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
      host.classList.add("sidebar-profile-host");
      normalizeProfileMenu(host);
      normalizeSidebarNavigation(sidebar);
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

    const logout = buildAccountMenu(menu, trigger);
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
        event.stopPropagation();
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
        if (event.key === "Escape" && menu.classList.contains("show")) {
          event.preventDefault();
          menu.classList.remove("show");
          menu.setAttribute("aria-hidden", "true");
          trigger.setAttribute("aria-expanded", "false");
          trigger.focus();
          return;
        }
        if (event.key === "Enter" || event.key === " ") toggleMenu(event);
      });
    }
    portalProfileMenu(menu, trigger);
  }

  function iconMarkup(kind) {
    const paths = {
      home: '<path d="m3 10 9-7 9 7"></path><path d="M5 9v11h14V9"></path><path d="M9 20v-6h6v6"></path>',
      matters: '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M3 12h18"></path>',
      browse: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path><path d="M8 11h6"></path><path d="M11 8v6"></path>',
      people: '<circle cx="9" cy="7" r="4"></circle><path d="M2 21a7 7 0 0 1 14 0"></path><path d="M18 8a3 3 0 0 1 0 6"></path><path d="M22 21a5 5 0 0 0-4-4"></path>',
      payments: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path><path d="M6 15h2"></path>',
      settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.37.33.7.6 1 .3.25.69.39 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6Z"></path>',
      profile: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>',
      security: '<path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6l-7-3Z"></path><path d="m9 12 2 2 4-4"></path>',
      preferences: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle>',
      help: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.7 2.7 0 1 1 4.6 1.9c-1.1.9-2.1 1.3-2.1 3.1"></path><path d="M12 18h.01"></path>',
    };
    return `<svg class="sidebar-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.matters}</svg>`;
  }

  function getLinkKind(link) {
    const requestedKind = String(link.dataset.sidebarIcon || "").trim().toLowerCase();
    if (["home", "matters", "browse", "people", "payments", "settings", "profile", "security", "preferences", "help"].includes(requestedKind)) {
      return requestedKind;
    }
    const text = String(link.textContent || "").trim().toLowerCase();
    const href = String(link.getAttribute("href") || "").toLowerCase();
    if (text === "home" || href.includes("#home")) return "home";
    if (text.includes("browse")) return "browse";
    if (text.includes("matter") || text.includes("case") || href.includes("#cases")) return "matters";
    if (text.includes("dashboard")) return "home";
    if (text.includes("paralegal")) return "people";
    if (text.includes("fund") || text.includes("payment") || text.includes("billing")) return "payments";
    if (text.includes("profile") || text.includes("setting") || text.includes("security") || text.includes("preference")) return "profile";
    if (text.includes("help")) return "help";
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

  function observeSidebarNavigation(sidebar) {
    if (sidebar.dataset.sidebarNavigationObserved) return;
    sidebar.dataset.sidebarNavigationObserved = "true";
    const observer = new MutationObserver(() => {
      normalizeSidebarNavigation(sidebar);
    });
    sidebar.querySelectorAll("nav").forEach((nav) => observer.observe(nav, { childList: true }));
  }

  function normalizeSidebarFooter(sidebar) {
    sidebar.querySelectorAll("#logoutBtn").forEach((logout) => logout.remove());
    let footer = sidebar.querySelector(".sidebar-footer");
    if (!footer) {
      footer = document.createElement("div");
      footer.className = "sidebar-footer";
      footer.innerHTML = '© Let<span class="lpc-brand-apostrophe">’</span>s-ParaConnect 2026';
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

  window.addEventListener("lpc:user-updated", (event) => {
    syncSidebarAccountIdentity(event.detail || {});
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
