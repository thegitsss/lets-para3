(function globalSearchModule() {
  "use strict";

  const MIN_QUERY_LENGTH = 2;
  const MAX_QUERY_LENGTH = 80;
  const DEBOUNCE_MS = 260;
  const SEARCH_ENDPOINT = "/api/cases/search";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon() {
    const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wrapper.setAttribute("viewBox", "0 0 24 24");
    wrapper.setAttribute("fill", "none");
    wrapper.setAttribute("stroke", "currentColor");
    wrapper.setAttribute("stroke-width", "1.7");
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.innerHTML = '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.7-3.7"></path>';
    return wrapper;
  }

  function createIcon() {
    const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wrapper.setAttribute("viewBox", "0 0 24 24");
    wrapper.setAttribute("fill", "none");
    wrapper.setAttribute("stroke", "currentColor");
    wrapper.setAttribute("stroke-width", "1.7");
    wrapper.setAttribute("stroke-linecap", "round");
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.innerHTML = '<path d="M12 5v14M5 12h14"></path>';
    return wrapper;
  }

  function normalizeQuery(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  function getViewerRole() {
    try {
      const user = JSON.parse(localStorage.getItem("lpc_user") || "null");
      return String(user?.role || "").toLowerCase();
    } catch {
      return "";
    }
  }

  function getCommandContext(viewerRole) {
    const context = window.LPCProductivityContext && typeof window.LPCProductivityContext === "object"
      ? window.LPCProductivityContext
      : {};
    return {
      role: viewerRole,
      caseId: String(context.caseId || new URLSearchParams(window.location.search).get("caseId") || ""),
      availableMatterTabs: Array.isArray(context.availableMatterTabs) ? context.availableMatterTabs : [],
    };
  }

  function resolveTriggerHost() {
    const explicitHost = document.querySelector("[data-productivity-trigger-host]");
    if (explicitHost) return explicitHost;
    const sidebar = document.querySelector("aside.sidebar, .sidebar, .mobile-sidebar");
    if (sidebar) {
      const role = getViewerRole();
      const nav = sidebar.querySelector(`nav[data-visible="${role}"]`) || sidebar.querySelector("nav");
      if (nav) {
        const host = el("div", "lpc-global-search-host");
        host.dataset.productivityTriggerHost = "";
        nav.append(host);
        return host;
      }
    }
    return document.querySelector("[data-productivity-trigger-host], .header-actions");
  }

  function hasBlockingModal(dialog) {
    const isEffectivelyVisible = (node) => {
      if (!(node instanceof Element) || node.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
    };
    if ([...document.querySelectorAll("dialog[open]:not(.lpc-global-search-dialog)")].some(isEffectivelyVisible)) {
      return true;
    }
    return [...document.querySelectorAll('[aria-modal="true"]')]
      .some((node) => node !== dialog && isEffectivelyVisible(node));
  }

  function isEditableTarget(target) {
    return target instanceof Element && Boolean(
      target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]')
    );
  }

  function ensureAttorneyCreateAction(notificationCenter, viewerRole) {
    if (viewerRole !== "attorney") return null;
    let action = notificationCenter.querySelector("[data-lpc-quick-create]");
    if (action) return action;
    action = el("a", "lpc-quick-create");
    action.href = "create-case.html";
    action.dataset.lpcQuickCreate = "";
    action.setAttribute("aria-label", "Create a new matter");
    action.title = "Create";
    const createGlyph = createIcon();
    createGlyph.classList.add("lpc-quick-create-icon");
    action.append(createGlyph, el("span", "lpc-quick-create-label", "Create"));
    const notificationWrapper = notificationCenter.querySelector(".notification-wrapper")
      || notificationCenter.querySelector("[data-notification-toggle]");
    notificationCenter.insertBefore(action, notificationWrapper);
    return action;
  }

  function dockSearchBesideNotifications(host, viewerRole) {
    if (!host) return false;
    const notificationCenter = [...document.querySelectorAll("[data-notification-center]")]
      .find((center) => center.querySelector("[data-notification-toggle]"));
    if (!notificationCenter) return false;
    const notificationWrapper = notificationCenter.querySelector(".notification-wrapper")
      || notificationCenter.querySelector("[data-notification-toggle]");
    const createAction = ensureAttorneyCreateAction(notificationCenter, viewerRole);
    const anchor = createAction || notificationWrapper;
    if (host.parentElement !== notificationCenter || host.nextElementSibling !== anchor) {
      notificationCenter.insertBefore(host, anchor);
    }
    return true;
  }

  function safeObjectHref(value, type) {
    try {
      const url = new URL(String(value || ""), window.location.origin);
      if (url.origin !== window.location.origin || url.hash || url.username || url.password) return "";
      const entries = [...url.searchParams.entries()];
      const id = (name) => /^[a-f0-9]{24}$/i.test(url.searchParams.get(name) || "");
      const matter = type === "matter" && url.pathname === "/case-detail.html" && id("caseId") &&
        entries.every(([key, entry]) => key === "caseId" || (key === "tab" && window.LPCProductivityCommands?.MATTER_TABS?.includes(entry))) &&
        entries.filter(([key]) => key === "caseId").length === 1;
      const opportunity = type === "matter" && url.pathname === "/browse-jobs.html" && entries.length === 1 && id("caseId");
      const profile = type === "profile" && url.pathname === "/profile-paralegal.html" && entries.length === 1 && id("paralegalId");
      if (!matter && !opportunity && !profile) return "";
      return `${url.pathname}${url.search}`;
    } catch {
      return "";
    }
  }

  function mountGlobalSearch() {
    if (document.querySelector("[data-lpc-global-search]")) return null;
    const viewerRole = getViewerRole();
    if (!["attorney", "paralegal"].includes(viewerRole)) return null;
    const registry = window.LPCProductivityCommands;
    if (!registry?.matchCommands || !registry?.resolveCommand) return null;
    const host = resolveTriggerHost();
    if (!host) return null;
    if (!dockSearchBesideNotifications(host, viewerRole)) {
      const dockObserver = new MutationObserver(() => {
        if (!dockSearchBesideNotifications(host, viewerRole)) return;
        dockObserver.disconnect();
      });
      dockObserver.observe(document.body, { childList: true, subtree: true });
    }
    const canSearchProfiles = viewerRole === "attorney";

    const wrap = el("div", "lpc-global-search-trigger-wrap");
    wrap.dataset.lpcGlobalSearch = "";
    const trigger = el("button", "lpc-global-search-trigger");
    trigger.type = "button";
    const paralegalSearchLabel = "Search your workspace";
    trigger.setAttribute("aria-label", canSearchProfiles ? "Search" : paralegalSearchLabel);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    const triggerLabel = el("span", "lpc-global-search-trigger-label", canSearchProfiles ? "Search" : paralegalSearchLabel);
    trigger.append(icon(), triggerLabel);
    wrap.append(trigger);
    const firstLink = host.querySelector("a");
    if (firstLink?.nextSibling) host.insertBefore(wrap, firstLink.nextSibling);
    else host.append(wrap);

    const dialog = el("dialog", "lpc-global-search-dialog");
    dialog.id = "lpcGlobalSearchDialog";
    trigger.setAttribute("aria-controls", dialog.id);
    dialog.setAttribute("aria-labelledby", "lpcGlobalSearchTitle");
    dialog.setAttribute("aria-describedby", "lpcGlobalSearchHint");
    const title = el("h2", "lpc-global-search-visually-hidden", "Search");
    title.id = "lpcGlobalSearchTitle";
    const hint = el("p", "lpc-global-search-visually-hidden", "Search Matters, paralegal profiles, and dashboard actions.");
    hint.id = "lpcGlobalSearchHint";

    const form = el("form", "lpc-global-search-form");
    form.setAttribute("role", "search");
    const label = el("label", "lpc-global-search-visually-hidden", canSearchProfiles ? "Search Matters, paralegal profiles, and actions" : paralegalSearchLabel);
    label.htmlFor = "lpcGlobalSearchInput";
    const inputWrap = el("div", "lpc-global-search-input-wrap");
    const input = el("input", "lpc-global-search-input");
    input.id = "lpcGlobalSearchInput";
    input.name = "q";
    input.type = "search";
    input.autocomplete = "off";
    input.maxLength = MAX_QUERY_LENGTH;
    input.placeholder = canSearchProfiles ? "Search Matters, paralegals, or actions" : paralegalSearchLabel;
    inputWrap.append(icon(), input);
    form.append(label, inputWrap);

    const live = el("p", "lpc-global-search-live");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    const results = el("div", "lpc-global-search-results");
    results.id = "lpcGlobalSearchResults";
    input.setAttribute("aria-controls", results.id);
    dialog.append(title, hint, form, live, results);
    document.body.append(dialog);

    let returnFocus = null;
    let debounceTimer = null;
    let controller = null;
    let requestSequence = 0;
    let lastQuery = "";
    let activeIndex = -1;
    let renderedResultId = 0;
    let remoteState = { mode: "initial", payload: null };

    function resultLinks() {
      return [...results.querySelectorAll(".lpc-global-search-result")];
    }

    function setActive(index, focus = false) {
      const links = resultLinks();
      if (!links.length) return;
      activeIndex = (index + links.length) % links.length;
      links.forEach((link, current) => {
        const active = current === activeIndex;
        link.classList.toggle("is-active", active);
        link.setAttribute("aria-selected", active ? "true" : "false");
      });
      input.setAttribute("aria-activedescendant", links[activeIndex].id);
      if (focus) links[activeIndex].focus();
    }

    function renderGroup(groupTitle, items, kind) {
      if (!items.length) return null;
      const group = el("section", "lpc-global-search-group");
      group.append(el("h3", "lpc-global-search-group-title", groupTitle));
      const list = el("ul", "lpc-global-search-list");
      list.setAttribute("role", "listbox");
      items.forEach((item) => {
        const isCommand = kind === "command";
        const href = isCommand ? String(item.href || "") : safeObjectHref(item?.nextAction?.href, item?.type);
        if (!href) return;
        const row = el("li");
        const link = el("a", "lpc-global-search-result");
        link.id = `lpcPaletteResult${renderedResultId++}`;
        link.href = href;
        link.setAttribute("role", "option");
        link.setAttribute("aria-selected", "false");
        if (isCommand) {
          link.dataset.commandCode = item.code;
          if (item.contextTab) link.dataset.matterTab = item.contextTab;
        } else {
          link.dataset.searchObjectType = String(item.type || "");
          link.dataset.searchObjectId = String(item.id || "");
        }
        const copy = el("span");
        copy.append(el("span", "lpc-global-search-result-title", String(item.label || item.title || "Untitled")));
        const metaParts = isCommand
          ? [item.destinationType === "workflow" ? "Workflow" : "Navigation"]
          : item.type === "matter"
          ? [item.status?.label, item.practiceArea, item.relationship?.label]
          : [item.headline, item.location];
        copy.append(el("span", "lpc-global-search-result-meta", metaParts.filter(Boolean).join(" · ")));
        if (!isCommand && item.attention?.label) copy.append(el("span", "lpc-global-search-result-attention", item.attention.label));
        link.append(copy);
        row.append(link);
        list.append(row);
      });
      if (!list.children.length) return null;
      group.append(list);
      return group;
    }

    function renderRemoteState(mode) {
      const state = el("div", "lpc-global-search-remote-state");
      if (mode === "loading") {
        state.append(el("span", null, "Searching authorized records…"));
        state.setAttribute("aria-busy", "true");
      } else if (mode === "short") {
        state.textContent = `Enter at least ${MIN_QUERY_LENGTH} characters for record results.`;
      } else if (mode === "empty") {
        state.textContent = "No authorized record matches. Commands remain available above.";
      } else if (mode === "rate-limit") {
        state.textContent = "Search is busy. Please wait a moment and try again.";
      } else if (mode === "error") {
        state.textContent = "Search is temporarily unavailable. Commands still work.";
        const retry = el("button", "lpc-global-search-retry", "Try again");
        retry.type = "button";
        retry.dataset.searchRetry = "";
        state.append(retry);
      }
      return state;
    }

    function renderPalette() {
      renderedResultId = 0;
      const query = normalizeQuery(input.value);
      const commands = registry.matchCommands(query, getCommandContext(viewerRole));
      const groups = [];
      const commandGroup = renderGroup("Commands", commands, "command");
      if (commandGroup) groups.push(commandGroup);

      if (remoteState.mode === "results") {
        const matters = Array.isArray(remoteState.payload?.results?.matters) ? remoteState.payload.results.matters : [];
        const profiles = Array.isArray(remoteState.payload?.results?.profiles) ? remoteState.payload.results.profiles : [];
        const matterGroup = renderGroup("Matters", matters, "object");
        const profileGroup = renderGroup("Paralegal profiles", profiles, "object");
        if (matterGroup) groups.push(matterGroup);
        if (profileGroup) groups.push(profileGroup);
        if (!matterGroup && !profileGroup) groups.push(renderRemoteState("empty"));
        live.textContent = `${commands.length} commands and ${matters.length + profiles.length} record results available.`;
      } else if (remoteState.mode !== "initial") {
        groups.push(renderRemoteState(remoteState.mode));
        live.textContent = remoteState.mode === "loading" ? "Searching." : `${commands.length} commands available.`;
      } else {
        live.textContent = `${commands.length} commands available.`;
      }
      if (!groups.length) groups.push(renderRemoteState(query.length < MIN_QUERY_LENGTH ? "short" : "empty"));
      results.replaceChildren(...groups);
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
    }

    async function runSearch(rawQuery) {
      const query = normalizeQuery(rawQuery);
      lastQuery = query;
      controller?.abort();
      controller = null;
      if (query.length < MIN_QUERY_LENGTH) {
        remoteState = { mode: query ? "short" : "initial", payload: null };
        renderPalette();
        return;
      }

      const sequence = ++requestSequence;
      controller = new AbortController();
      remoteState = { mode: "loading", payload: null };
      renderPalette();
      try {
        const params = new URLSearchParams({ q: query, types: canSearchProfiles ? "matter,profile" : "matter" });
        const response = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (sequence !== requestSequence) return;
        if (response.status === 401 || response.status === 403) {
          remoteState = { mode: "initial", payload: null };
          renderPalette();
          return;
        }
        if (response.status === 429) {
          remoteState = { mode: "rate-limit", payload: null };
          renderPalette();
          return;
        }
        if (!response.ok) throw new Error("search_failed");
        remoteState = { mode: "results", payload };
        renderPalette();
      } catch (error) {
        if (error?.name === "AbortError" || sequence !== requestSequence) return;
        remoteState = { mode: "error", payload: null };
        renderPalette();
      }
    }

    function scheduleSearch() {
      window.clearTimeout(debounceTimer);
      remoteState = normalizeQuery(input.value).length >= MIN_QUERY_LENGTH
        ? { mode: "loading", payload: null }
        : { mode: normalizeQuery(input.value) ? "short" : "initial", payload: null };
      renderPalette();
      debounceTimer = window.setTimeout(() => runSearch(input.value), DEBOUNCE_MS);
    }

    function close() {
      window.clearTimeout(debounceTimer);
      controller?.abort();
      const focusTarget = returnFocus?.isConnected ? returnFocus : trigger;
      if (dialog.open) dialog.close();
      focusTarget?.focus();
      window.requestAnimationFrame(() => {
        if (!dialog.open && focusTarget?.isConnected) focusTarget.focus();
      });
    }

    function positionDialog() {
      const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
      const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
      const triggerBox = trigger.getBoundingClientRect();
      const gutter = viewportWidth <= 640 ? 8 : 12;
      const preferredWidth = viewportWidth <= 640 ? viewportWidth - gutter * 2 : 360;
      const width = viewportWidth <= 640
        ? preferredWidth
        : Math.min(360, preferredWidth, viewportWidth - gutter * 2);
      const left = Math.min(Math.max(triggerBox.right - width, gutter), viewportWidth - width - gutter);
      const top = Math.min(Math.max(triggerBox.bottom + 8, gutter), viewportHeight - 96);
      dialog.style.setProperty("--lpc-search-left", `${Math.round(left)}px`);
      dialog.style.setProperty("--lpc-search-top", `${Math.round(top)}px`);
      dialog.style.setProperty("--lpc-search-width", `${Math.round(width)}px`);
      dialog.style.setProperty("--lpc-search-max-height", `${Math.max(160, Math.round(viewportHeight - top - gutter))}px`);
    }

    function open() {
      if (hasBlockingModal(dialog)) return false;
      returnFocus = document.activeElement;
      positionDialog();
      if (!dialog.open) dialog.show();
      wrap.classList.add("is-open");
      host.classList.add("is-search-open");
      trigger.setAttribute("aria-expanded", "true");
      remoteState = { mode: input.value ? (normalizeQuery(input.value).length >= MIN_QUERY_LENGTH ? "loading" : "short") : "initial", payload: null };
      renderPalette();
      if (normalizeQuery(input.value).length >= MIN_QUERY_LENGTH) scheduleSearch();
      window.requestAnimationFrame(() => input.focus());
      return true;
    }

    function activateResult(link) {
      const tab = String(link?.dataset?.matterTab || "");
      if (tab && window.LPCMatterNavigation?.activateTab) {
        close();
        window.LPCMatterNavigation.activateTab(tab);
        return true;
      }
      link?.click();
      return Boolean(link);
    }

    trigger.addEventListener("click", open);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("close", () => {
      wrap.classList.remove("is-open");
      host.classList.remove("is-search-open");
      trigger.setAttribute("aria-expanded", "false");
      if (returnFocus?.isConnected) returnFocus.focus();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      window.clearTimeout(debounceTimer);
      const links = resultLinks();
      if (links.length && normalizeQuery(input.value) === lastQuery) activateResult(links[activeIndex >= 0 ? activeIndex : 0]);
      else runSearch(input.value);
    });
    input.addEventListener("input", scheduleSearch);
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [input, ...resultLinks(), ...results.querySelectorAll("button:not([disabled])")]
          .filter((node, index, array) => node.offsetParent !== null && array.indexOf(node) === index);
        if (!focusable.length) return;
        const current = focusable.indexOf(document.activeElement);
        if (event.shiftKey && current <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && current === focusable.length - 1) {
          event.preventDefault();
          focusable[0].focus();
        }
        return;
      }
      const links = resultLinks();
      if (!links.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : activeIndex < 0
        ? (event.key === "ArrowDown" ? 0 : links.length - 1)
        : activeIndex + (event.key === "ArrowDown" ? 1 : -1);
      setActive(nextIndex, true);
    });
    results.addEventListener("click", (event) => {
      const retry = event.target.closest("[data-search-retry]");
      if (retry) {
        runSearch(lastQuery || input.value);
        return;
      }
      const commandLink = event.target.closest("[data-command-code]");
      if (commandLink) {
        const resolved = registry.resolveCommand(commandLink.dataset.commandCode, getCommandContext(viewerRole));
        if (!resolved || resolved.href !== commandLink.getAttribute("href")) {
          event.preventDefault();
          return;
        }
        if (resolved.contextTab && window.LPCMatterNavigation?.activateTab) {
          event.preventDefault();
          close();
          window.LPCMatterNavigation.activateTab(resolved.contextTab);
        }
        return;
      }
      const matterLink = event.target.closest('[data-search-object-type="matter"]');
      const matterId = String(matterLink?.dataset?.searchObjectId || "");
      if (matterLink && /^[a-f0-9]{24}$/i.test(matterId) && window.LPCContextPanel?.openMatter) {
        event.preventDefault();
        close();
        window.requestAnimationFrame(() => window.LPCContextPanel.openMatter(matterId, { historyMode: "push", returnFocus: trigger }));
        return;
      }
      const profileLink = event.target.closest('[data-search-object-type="profile"]');
      const profileId = String(profileLink?.dataset?.searchObjectId || "");
      if (!profileLink || !/^[a-f0-9]{24}$/i.test(profileId) || !window.LPCContextPanel?.openProfile) return;
      event.preventDefault();
      close();
      window.requestAnimationFrame(() => window.LPCContextPanel.openProfile(profileId, { historyMode: "push", returnFocus: trigger }));
    });
    document.addEventListener("pointerdown", (event) => {
      if (!dialog.open || dialog.contains(event.target) || wrap.contains(event.target)) return;
      close();
    });
    document.addEventListener("keydown", (event) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        String(event.key).toLowerCase() !== "k" ||
        (isEditableTarget(event.target) && event.target !== input)
      ) {
        return;
      }
      event.preventDefault();
      if (dialog.open) close();
      else open();
    });
    window.addEventListener("resize", () => {
      if (dialog.open) positionDialog();
    });
    document.addEventListener("scroll", (event) => {
      if (dialog.open && !dialog.contains(event.target)) positionDialog();
    }, true);

    return { trigger, dialog, input, results, open, close, runSearch, renderPalette };
  }

  window.LPCGlobalSearch = { mount: mountGlobalSearch, normalizeQuery, safeObjectHref };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountGlobalSearch, { once: true });
  else mountGlobalSearch();
})();
