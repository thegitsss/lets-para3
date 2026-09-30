(function contextPanelModule() {
  "use strict";

  const adapters = new Map();
  let panel = null;
  let current = null;
  let controller = null;
  let sequence = 0;
  let returnFocus = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeLocalHref(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("//") || raw.includes("\\")) return "";
    try {
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin) return "";
      const allowedPage = new Set([
        "/case-detail.html",
        "/profile-paralegal.html",
        "/dashboard-attorney.html",
        "/dashboard-paralegal.html",
      ]).has(url.pathname);
      const allowedDownload = /^\/api\/uploads\/case\/[a-f\d]{24}\/[a-f\d]{24}\/download$/i.test(url.pathname);
      if (!allowedPage && !allowedDownload) return "";
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "";
    }
  }

  function ensurePanel() {
    if (panel) return panel;
    const dialog = element("dialog", "lpc-context-dialog");
    dialog.setAttribute("aria-labelledby", "lpcContextTitle");
    const sheet = element("section", "lpc-context-sheet");
    const header = element("header", "lpc-context-header");
    const heading = element("div");
    const eyebrow = element("p", "lpc-context-eyebrow", "Context");
    const title = element("h2", "lpc-context-title", "Details");
    title.id = "lpcContextTitle";
    heading.append(eyebrow, title);
    const close = element("button", "lpc-context-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close details");
    header.append(heading, close);
    const body = element("div", "lpc-context-body");
    const footer = element("footer", "lpc-context-footer");
    sheet.append(header, body, footer);
    dialog.append(sheet);
    document.body.append(dialog);
    panel = { dialog, eyebrow, title, close, body, footer };

    close.addEventListener("click", () => closePanel());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePanel();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closePanel();
    });
    return panel;
  }

  function renderState(title, message, { retry = false } = {}) {
    const target = ensurePanel();
    const state = element("div", "lpc-context-state");
    state.append(element("strong", null, title), element("span", null, message));
    if (retry) {
      const button = element("button", "lpc-context-retry", "Try again");
      button.type = "button";
      button.addEventListener("click", () => loadCurrent());
      state.append(button);
    }
    target.body.replaceChildren(state);
    target.footer.replaceChildren();
  }

  function renderView(view = {}) {
    const target = ensurePanel();
    target.eyebrow.textContent = String(view.eyebrow || "Context");
    target.title.textContent = String(view.title || "Details");
    const content = document.createDocumentFragment();
    if (view.summary) content.append(element("p", "lpc-context-summary", String(view.summary)));
    const facts = Array.isArray(view.facts) ? view.facts.filter((fact) => fact?.value !== null && fact?.value !== undefined && String(fact.value).trim()) : [];
    if (facts.length) {
      const list = element("dl", "lpc-context-facts");
      facts.forEach((fact) => {
        const row = element("div", "lpc-context-fact");
        row.append(element("dt", "lpc-context-label", String(fact.label || "Detail")), element("dd", "lpc-context-value", String(fact.value)));
        list.append(row);
      });
      content.append(list);
    }
    (Array.isArray(view.sections) ? view.sections : []).forEach((section) => {
      if (!section || (!section.body && !section.items?.length && !section.links?.length)) return;
      const node = element("section", "lpc-context-section");
      if (section.title) node.append(element("h3", null, String(section.title)));
      if (section.body) node.append(element("p", null, String(section.body)));
      if (Array.isArray(section.items) && section.items.length) {
        const tags = element("div", "lpc-context-tags");
        section.items.filter(Boolean).forEach((item) => tags.append(element("span", "lpc-context-tag", String(item))));
        node.append(tags);
      }
      if (Array.isArray(section.links) && section.links.length) {
        const links = element("div", "lpc-context-related-list");
        section.links.forEach((item) => {
          const href = safeLocalHref(item?.href);
          if (!href) return;
          const row = element("div", "lpc-context-related-person");
          if (item?.label) {
            row.append(element("span", "lpc-context-related-role", String(item.label)));
          } else {
            row.classList.add("is-link-only");
          }
          const link = element("a", "lpc-context-related-link", String(item?.text || "View profile"));
          link.href = href;
          row.append(link);
          links.append(row);
        });
        if (links.childElementCount) node.append(links);
      }
      content.append(node);
    });
    target.body.replaceChildren(content);
    target.footer.replaceChildren();
    (Array.isArray(view.actions) ? view.actions : []).slice(0, 2).forEach((action, index) => {
      const href = safeLocalHref(action?.href);
      let node;
      if (href) {
        node = element("a", `lpc-context-action${action.primary || index === 0 ? " is-primary" : ""}`, String(action.label || "Open"));
        node.href = href;
      } else if (typeof action?.onClick === "function") {
        node = element("button", `lpc-context-action${action.primary || index === 0 ? " is-primary" : ""}`, String(action.label || "Open"));
        node.type = "button";
        node.addEventListener("click", action.onClick);
      }
      if (node) target.footer.append(node);
    });
  }

  function updateUrl(config, historyMode) {
    if (historyMode === "none" || !window.history?.[`${historyMode}State`]) return;
    const url = new URL(window.location.href);
    url.searchParams.set("panel", config.kind);
    Object.entries(config.urlParams || {}).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, String(value));
    });
    window.history[`${historyMode}State`](Object.assign({}, window.history.state, {
      lpcContextPanel: { kind: config.kind, id: config.id },
    }), "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function loadCurrent() {
    if (!current) return;
    const adapter = adapters.get(current.kind);
    if (!adapter) {
      renderState("Unavailable", "This item cannot be previewed here.");
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const requestSequence = ++sequence;
    renderState("Loading", `Loading ${current.label || "details"}…`);
    try {
      const view = await adapter({
        id: current.id,
        params: current.params || {},
        signal: controller.signal,
      });
      if (requestSequence !== sequence || !current) return;
      renderView(view);
    } catch (error) {
      if (error?.name === "AbortError" || requestSequence !== sequence) return;
      const unavailable = error?.status === 401 || error?.status === 403 || error?.status === 404;
      renderState(
        unavailable ? "No longer available" : "Unable to load",
        unavailable ? "You may no longer have access to this item." : "Please try again in a moment.",
        { retry: !unavailable }
      );
    }
  }

  function open(kind, options = {}) {
    const id = String(options.id || "").trim();
    if (!kind || !id || !adapters.has(kind)) return false;
    const target = ensurePanel();
    returnFocus = options.returnFocus || document.activeElement;
    target.dialog.dataset.contextKind = kind;
    current = {
      kind,
      id,
      label: options.label || kind,
      params: options.params || {},
      urlParams: options.urlParams || {},
      clearParams: [...new Set(["panel", ...(options.clearParams || []), ...Object.keys(options.urlParams || {})])],
      historyOwned: options.historyMode === "push",
    };
    target.eyebrow.textContent = String(options.eyebrow || "Context");
    target.title.textContent = String(options.title || "Details");
    updateUrl(current, options.historyMode || "push");
    if (!target.dialog.open) target.dialog.showModal();
    window.requestAnimationFrame(() => target.close.focus());
    void loadCurrent();
    return true;
  }

  function closePanel({ historyMode = "auto", restoreFocus = true } = {}) {
    if (!panel?.dialog.open) return;
    controller?.abort();
    sequence += 1;
    const closing = current;
    current = null;
    panel.dialog.close();
    if (historyMode === "auto" && closing?.historyOwned && window.history.length > 1) {
      window.history.back();
    } else if (historyMode !== "none") {
      const url = new URL(window.location.href);
      (closing?.clearParams || ["panel", "profileId"]).forEach((key) => url.searchParams.delete(key));
      window.history.replaceState(Object.assign({}, window.history.state, { lpcContextPanel: null }), "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  }

  function register(kind, adapter) {
    if (!kind || typeof adapter !== "function") return;
    adapters.set(String(kind), adapter);
  }

  register("profile", async ({ id, signal }) => {
    const response = await fetch(`/api/users/profile-preview/${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || "Profile unavailable");
      error.status = response.status;
      throw error;
    }
    const profile = payload?.profile || {};
    return {
      eyebrow: "Paralegal Profile",
      title: profile.name || "Profile",
      summary: profile.bio || "Profile details are available on the full Profile.",
      facts: [
        { label: "Location", value: profile.location },
        { label: "Experience", value: Number.isFinite(Number(profile.yearsExperience)) ? `${profile.yearsExperience} years` : "" },
        { label: "Availability", value: profile.availability },
      ],
      sections: [
        { title: "Practice areas", items: profile.practiceAreas },
        { title: "Specialties and skills", items: [...(profile.specialties || []), ...(profile.skills || [])] },
        { title: "Experience", body: profile.experience },
      ],
      actions: [{ label: "View full Profile", href: profile.fullHref, primary: true }],
    };
  });

  register("matter", async ({ id, signal }) => {
    const response = await fetch(`/api/cases/${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || "Matter unavailable");
      error.status = response.status;
      throw error;
    }
    const experience = payload?.matterExperience || {};
    const header = experience.header || {};
    const overview = experience.overview || {};
    const financials = experience.financials || null;
    const taskProgress = overview.taskProgress || {};
    const nextTab = String(header?.primaryAction?.tab || "overview");
    const fullHref = `/case-detail.html?caseId=${encodeURIComponent(id)}&tab=${encodeURIComponent(nextTab)}`;
    let viewerRole = "";
    try {
      viewerRole = String(JSON.parse(localStorage.getItem("lpc_user") || "{}")?.role || "").toLowerCase();
    } catch {}
    const isAttorney = viewerRole === "attorney";
    const paralegalId = String(overview.paralegalId || payload?.paralegal?.id || payload?.paralegal?._id || "").trim();
    const paralegalName = String(overview.paralegal || payload?.paralegalNameSnapshot || "").trim();
    const paralegalHref = paralegalId
      ? `/profile-paralegal.html?paralegalId=${encodeURIComponent(paralegalId)}`
      : "";
    const nextActionDetail = String(header.primaryAction?.detail || "").trim();
    return {
      eyebrow: "Matter",
      title: header.title || payload.title || "Matter",
      summary: overview.summary || payload.briefSummary || "Open the Matter for its complete authorized record.",
      facts: [
        { label: "Status", value: header.status?.label || payload.status },
        ...(!isAttorney ? [{ label: "Your relationship", value: header.relationship }] : []),
        { label: "Needs attention", value: header.attention },
        { label: "Practice area", value: overview.practiceArea || payload.practiceArea },
        { label: "Deadline", value: overview.deadline ? window.LPCBusinessDate?.format(overview.deadline) || overview.deadline : "" },
        { label: "Work progress", value: Number(taskProgress.total) > 0 ? `${Number(taskProgress.completed)}/${Number(taskProgress.total)} tasks complete` : "" },
        ...(!isAttorney ? [{ label: "Financial status", value: financials?.status || "" }] : []),
      ],
      sections: [
        isAttorney ? {
          title: "Paralegal",
          links: paralegalHref && paralegalName && paralegalName !== "Not assigned"
            ? [{ text: paralegalName, href: paralegalHref }]
            : [],
        } : {
          title: "Related people",
          items: [overview.attorney, overview.paralegal].filter(Boolean),
        },
        ...(nextActionDetail ? [{
          title: "Next action",
          body: nextActionDetail,
        }] : []),
      ],
      actions: [
        { label: header.primaryAction?.label || "Open Matter", href: fullHref, primary: true },
        ...(typeof window.openSupportDrawer === "function" ? [{
          label: "AI Matter briefing",
          onClick: () => {
            window.LPCProductivityContext = {
              ...(window.LPCProductivityContext || {}),
              caseId: id,
              objectType: "matter",
              objectId: id,
              status: String(header.status?.label || payload.status || ""),
              relationship: String(header.relationship || ""),
              attention: String(header.attention || ""),
              nextAction: String(header.primaryAction?.label || ""),
              availableMatterTabs: Array.isArray(experience.sections) ? experience.sections.map((section) => section.id) : [],
            };
            closePanel({ historyMode: "none", restoreFocus: false });
            void window.openSupportDrawer({
              focusComposer: false,
              promptText: "Give me a concise Matter briefing: summarize current status, recent activity, work progress, messages or files needing attention, financial readiness, and the safest next action. Use only my authorized LPC context.",
              submitPrompt: true,
            });
          },
        }] : []),
      ],
    };
  });

  function openProfile(profileId, options = {}) {
    return open("profile", {
      id: profileId,
      label: "Profile",
      title: "Profile",
      eyebrow: "Paralegal Profile",
      urlParams: { profileId },
      clearParams: ["profileId"],
      ...options,
    });
  }

  function openMatter(matterId, options = {}) {
    return open("matter", {
      id: matterId,
      label: "Matter",
      title: "Matter",
      eyebrow: "Matter",
      urlParams: { matterId },
      clearParams: ["matterId"],
      ...options,
    });
  }

  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("panel");
    const profileId = params.get("profileId");
    const matterId = params.get("matterId");
    if (kind === "profile" && profileId) {
      openProfile(profileId, { historyMode: "none" });
      return;
    }
    if (kind === "matter" && matterId) {
      openMatter(matterId, { historyMode: "none" });
      return;
    }
    if (["profile", "matter"].includes(current?.kind)) closePanel({ historyMode: "none" });
  });

  window.LPCContextPanel = {
    close: closePanel,
    current: () => current,
    refresh: async (kind, id) => {
      if (current?.kind !== kind || current?.id !== String(id)) return;
      const requested = current;
      await loadCurrent();
      if (current === requested && panel?.dialog.open) {
        (panel.footer.querySelector("button, a") || panel.close).focus();
      }
    },
    open,
    openMatter,
    openProfile,
    register,
    safeLocalHref,
  };

  const initial = new URLSearchParams(window.location.search);
  if (initial.get("panel") === "profile" && initial.get("profileId")) {
    const openInitialProfile = () => openProfile(initial.get("profileId"), { historyMode: "none" });
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", openInitialProfile, { once: true });
    } else {
      openInitialProfile();
    }
  } else if (initial.get("panel") === "matter" && initial.get("matterId")) {
    const openInitialMatter = () => openMatter(initial.get("matterId"), { historyMode: "none" });
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", openInitialMatter, { once: true });
    } else {
      openInitialMatter();
    }
  }
})();
