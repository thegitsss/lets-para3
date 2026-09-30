(function productivityCommandRegistry(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LPCProductivityCommands = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildRegistry() {
  "use strict";

  const MATTER_TABS = Object.freeze([
    "overview",
    "applications",
    "work",
    "files",
    "messages",
    "activity",
    "financials",
  ]);
  const MEMBER_ROLES = Object.freeze(["attorney", "paralegal"]);

  const COMMANDS = Object.freeze([
    { code: "attorney.home", roles: ["attorney"], label: "Home", destinationType: "navigation", href: "/dashboard-attorney.html#home", keywords: ["dashboard", "overview"] },
    { code: "attorney.matters", roles: ["attorney"], label: "Matters", destinationType: "navigation", href: "/dashboard-attorney.html#cases", keywords: ["cases", "work"] },
    { code: "attorney.tasks", roles: ["attorney"], label: "Tasks", destinationType: "navigation", href: "/dashboard-attorney.html#tasks", keywords: ["checklist", "reminders", "planning", "due"] },
    { code: "attorney.browse_paralegals", roles: ["attorney"], label: "Browse Paralegals", destinationType: "navigation", href: "/browse-paralegals.html", keywords: ["search", "profiles", "directory"] },
    { code: "attorney.review_applications", roles: ["attorney"], label: "Review Applications", destinationType: "workflow", href: "/dashboard-attorney.html#cases:inquiries", keywords: ["applicants", "candidates", "inquiries"] },
    { code: "attorney.funds", roles: ["attorney"], label: "Payments", destinationType: "navigation", href: "/dashboard-attorney.html#funds", keywords: ["funding", "payment methods", "receipts"] },
    { code: "attorney.post_matter", roles: ["attorney"], label: "Post a Matter", destinationType: "workflow", href: "/create-case.html", keywords: ["new matter", "create case", "post case"] },
    { code: "paralegal.home", roles: ["paralegal"], label: "Home", destinationType: "navigation", href: "/dashboard-paralegal.html#home", keywords: ["dashboard", "overview"] },
    { code: "paralegal.browse_matters", roles: ["paralegal"], label: "Browse Matters", destinationType: "workflow", href: "/browse-jobs.html", keywords: ["jobs", "opportunities", "find work"] },
    { code: "paralegal.my_work", roles: ["paralegal"], label: "My Matters & Applications", destinationType: "navigation", href: "/dashboard-paralegal.html#cases", keywords: ["assigned matters", "applications", "cases"] },
    { code: "paralegal.completed_matters", roles: ["paralegal"], label: "Completed Matters", destinationType: "navigation", href: "/dashboard-paralegal.html#cases-completed", keywords: ["earnings", "payouts", "receipts", "archive"] },
    { code: "paralegal.edit_profile", roles: ["paralegal"], label: "Edit Profile", destinationType: "workflow", href: "/profile-settings.html?onboardingStep=profile&profilePrompt=1", keywords: ["profile settings", "resume", "skills"] },
    { code: "common.account_settings", roles: MEMBER_ROLES, label: "Account Settings", destinationType: "navigation", href: "/profile-settings.html", keywords: ["settings", "preferences", "security"] },
    { code: "attorney.help", roles: ["attorney"], label: "Help", destinationType: "navigation", href: "/help.html", keywords: ["support", "faq"] },
    { code: "paralegal.help", roles: ["paralegal"], label: "Help", destinationType: "navigation", href: "/paralegalhelp.html", keywords: ["support", "faq"] },
    ...MATTER_TABS.map((tab) => ({
      code: `matter.${tab}`,
      roles: MEMBER_ROLES,
      label: tab.replace(/\b\w/g, (character) => character.toUpperCase()),
      destinationType: "navigation",
      contextTab: tab,
      keywords: ["matter", "case", tab],
    })),
  ].map((command) => Object.freeze({
    ...command,
    roles: Object.freeze([...command.roles]),
    keywords: Object.freeze([...(command.keywords || [])]),
    navigationOnly: true,
  })));

  const COMMAND_BY_CODE = new Map(COMMANDS.map((command) => [command.code, command]));

  function normalizeRole(value) {
    const role = String(value || "").trim().toLowerCase();
    return MEMBER_ROLES.includes(role) ? role : "";
  }

  function normalizeTabs(value) {
    const requested = Array.isArray(value) ? value : [];
    return [...new Set(requested.map((tab) => String(tab || "").trim().toLowerCase()))]
      .filter((tab) => MATTER_TABS.includes(tab));
  }

  function resolveCommand(code, context = {}) {
    const command = COMMAND_BY_CODE.get(String(code || "").trim());
    const role = normalizeRole(context.role);
    if (!command || !role || !command.roles.includes(role)) return null;

    let href = command.href || "";
    if (command.contextTab) {
      const caseId = String(context.caseId || "").trim();
      const availableTabs = normalizeTabs(context.availableMatterTabs);
      if (!/^[a-f0-9]{24}$/i.test(caseId) || !availableTabs.includes(command.contextTab)) return null;
      href = `/case-detail.html?caseId=${encodeURIComponent(caseId)}&tab=${command.contextTab}`;
    }
    if (!href || !href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
    return Object.freeze({
      code: command.code,
      label: command.label,
      destinationType: command.destinationType,
      navigationOnly: true,
      href,
      keywords: [...command.keywords],
      ...(command.contextTab ? { contextTab: command.contextTab } : {}),
    });
  }

  function listCommands(context = {}) {
    return COMMANDS.map((command) => resolveCommand(command.code, context)).filter(Boolean);
  }

  function matchCommands(query, context = {}) {
    const normalized = String(query || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    const commands = listCommands(context);
    if (!normalized) return commands;
    const tokens = normalized.split(" ").filter(Boolean);
    return commands
      .map((command, index) => {
        const label = command.label.toLowerCase();
        const searchable = [label, command.code.replace(/[._]/g, " "), ...command.keywords].join(" ").toLowerCase();
        if (!tokens.every((token) => searchable.includes(token))) return null;
        const score = label === normalized ? 400 : label.startsWith(normalized) ? 300 : searchable.includes(normalized) ? 200 : 100;
        return { command, score, index };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((entry) => entry.command);
  }

  function findCommandByHref(href, context = {}) {
    const target = String(href || "").trim();
    if (!target) return null;
    return listCommands(context).find((command) => command.href === target || command.href.slice(1) === target) || null;
  }

  return Object.freeze({
    MATTER_TABS,
    findCommandByHref,
    listCommands,
    matchCommands,
    normalizeRole,
    normalizeTabs,
    resolveCommand,
  });
});
