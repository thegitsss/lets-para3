import { secureFetch, logout } from "./auth.js?v=20260812-state-filter-owner";
import { normalizePresentation } from "./authenticated-object-search.mjs";
import { activateDialogFocus, deactivateDialogFocus } from "./utils/dialog-focus.js";
import { showAlert } from "./utils/dialogs.js";

const states = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","District of Columbia","Florida","Georgia",
  "Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts",
  "Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
  "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island",
  "South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming"
];

const specialties = [
  "Administrative Law","Admiralty / Maritime Law","Antitrust Law","Appellate Law","Banking & Finance Law","Bankruptcy Law",
  "Business / Corporate Law","Civil Rights Law","Class Action Law","Commercial Law","Constitutional Law",
  "Construction Law","Consumer Law","Contract Law","Criminal Defense","Education Law","Elder Law",
  "Employment / Labor Law","Energy Law","Entertainment Law","Environmental Law","Family Law","Government Law",
  "Health Law","Immigration Law","Insurance Law","Intellectual Property","International Law","Litigation",
  "Medical Malpractice","Mergers & Acquisitions","Personal Injury","Privacy / Data Security","Product Liability",
  "Real Estate Law","Securities Law","Social Security / Disability","Tax Law","Technology Law","Torts",
  "Trusts & Estates","Workers’ Compensation"
];

const selectedSpecialties = new Set();
const selectedStates = new Set();
const AVATAR_PLACEHOLDER = "/assets/avatar-placeholder.svg";

const elements = {
  results: document.getElementById("paralegalResults"),
  status: document.getElementById("resultsStatus"),
  experience: document.getElementById("experience"),
  sortBy: document.getElementById("sortBy"),
  sortMenuTrigger: document.getElementById("sortMenuTrigger"),
  sortMenuOptions: document.getElementById("sortMenuOptions"),
  sortMenuValue: document.getElementById("sortMenuValue"),
  stateInput: document.getElementById("stateInput"),
  stateList: document.getElementById("stateList"),
  selectedStateChips: document.getElementById("selectedStateChips"),
  specialtyInput: document.getElementById("specialtyInput"),
  specialtyList: document.getElementById("specialtyList"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  paginationLabel: document.getElementById("paginationLabel"),
  inquireModal: document.getElementById("inquireModal"),
  jobList: document.getElementById("jobList"),
  inquireMessage: document.getElementById("inquireMessage"),
  cancelInquire: document.getElementById("cancelInquire"),
  confirmInquire: document.getElementById("confirmInquire"),
  selectedParalegalText: document.getElementById("selectedParalegalText"),
  filterMenu: document.getElementById("filterMenu"),
  filterToggle: document.getElementById("filterToggle"),
  filterCount: document.getElementById("filterCount"),
  filterClose: document.querySelector("[data-filter-close]"),
  applyFilters: document.getElementById("applyFilters"),
  clearFilters: document.getElementById("clearFilters"),
  authBlocker: document.getElementById("authBlocker"),
  returnDashboard: document.getElementById("returnDashboard"),
  utilityHeader: document.querySelector("[data-utility-header]"),
  publicHeader: document.querySelector("[data-public-header]"),
  authSidebar: document.querySelector("[data-auth-sidebar]"),
  authSidebarNav: document.querySelector("[data-auth-sidebar-nav]"),
  authSidebarToggle: document.querySelector("[data-auth-sidebar-toggle]"),
  authSidebarBackdrop: document.querySelector("[data-auth-sidebar-backdrop]"),
  authSidebarLogout: document.querySelector("[data-auth-sidebar-logout]"),
  publicFooter: document.querySelector("[data-public-footer]"),
};

const state = {
  page: 1,
  limit: 10,
  total: 0,
  pages: 1,
  filters: {
    experience: "",
    location: "",
    sort: "recent",
    specialties: selectedSpecialties,
    states: selectedStates,
  },
  viewer: null,
  viewerRole: "",
  isLoggedIn: false,
  canInvite: false,
};

let availableCases = [];
let activeParalegal = null;
let filterFetchTimer = null;
let sidebarProfileLoadPromise = null;
const toast = window.toastUtils;
const AUTH_LOCK_CLASS = "auth-locked";
const AUTH_BLOCKER_READY_CLASS = "auth-blocker-ready";

function normalizeId(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object") return String(val.id || val._id || val.paralegalId || "");
  return "";
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await hydrateViewer();
  syncAuthenticatedShell();
  syncAuthButtons();
  toggleAuthBlocker();
  initStateDropdown();
  initSpecialtyDropdown();
  bindFilterEvents();
  bindSortMenu();
  bindFilterMenuToggle();
  bindFilterButtons();
  bindModalEvents();
  updateFilterCount();

  if (state.canInvite) {
    await loadCases();
  } else {
    renderCaseOptions();
  }

  await loadParalegals();
}

function dashboardHrefForRole(role = "") {
  if (role === "paralegal") return "dashboard-paralegal.html";
  if (role === "admin") return "admin-dashboard.html";
  return "dashboard-attorney.html";
}

function authenticatedNavItems(role = "") {
  if (role === "paralegal") {
    return [
      ["Home", "dashboard-paralegal.html#home"],
      ["Browse Matters", "browse-jobs.html"],
      ["My Matters & Applications", "dashboard-paralegal.html#cases"],
      ["Profile Settings", "profile-settings.html"],
      ["Help", "paralegalhelp.html"],
    ];
  }
  if (role === "admin") {
    return [
      ["Dashboard", "admin-dashboard.html"],
      ["Browse Paralegals", "browse-paralegals.html", true],
      ["Help", "help.html"],
    ];
  }
  return [
    ["Home", "dashboard-attorney.html#home"],
    ["Matters", "dashboard-attorney.html#cases"],
    ["Tasks", "dashboard-attorney.html#tasks"],
    ["Paralegals", "browse-paralegals.html", true],
    ["Payments", "dashboard-attorney.html#funds"],
  ];
}

function closeAuthenticatedSidebar() {
  document.body?.classList.remove("authenticated-sidebar-open");
  elements.authSidebarToggle?.setAttribute("aria-expanded", "false");
  elements.authSidebarToggle?.setAttribute("aria-label", "Open dashboard navigation");
  if (elements.authSidebarBackdrop) elements.authSidebarBackdrop.hidden = true;
}

function loadAuthenticatedSidebarProfile() {
  if (!state.isLoggedIn || !elements.authSidebar) return Promise.resolve();
  if (!sidebarProfileLoadPromise) {
    sidebarProfileLoadPromise = import("./sidebar-profile.js?v=20260828-phase1")
      .catch((error) => {
        sidebarProfileLoadPromise = null;
        console.warn("[browse-paralegals] authenticated sidebar profile failed to load", error);
      });
  }
  return sidebarProfileLoadPromise;
}

function syncAuthenticatedShell() {
  const signedIn = state.isLoggedIn;
  document.body?.classList.toggle("authenticated-browse", signedIn);
  document.body?.classList.toggle("lpc-product-clean", signedIn);
  document.documentElement.classList.toggle("authenticated-browse", signedIn);
  document.documentElement.classList.toggle("has-user-cache", signedIn);
  if (elements.utilityHeader) elements.utilityHeader.hidden = signedIn;
  if (elements.publicHeader) elements.publicHeader.hidden = signedIn;
  if (elements.authSidebar) elements.authSidebar.hidden = !signedIn;
  if (elements.authSidebarToggle) elements.authSidebarToggle.hidden = !signedIn;
  if (elements.publicFooter) elements.publicFooter.hidden = signedIn;
  if (!signedIn) {
    closeAuthenticatedSidebar();
    return;
  }

  if (elements.authSidebarNav) {
    const links = authenticatedNavItems(state.viewerRole).map(([label, href, active]) => {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      if (active) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
      link.addEventListener("click", closeAuthenticatedSidebar);
      return link;
    });
    elements.authSidebarNav.replaceChildren(...links);
  }

  void loadAuthenticatedSidebarProfile();

  elements.authSidebarToggle?.addEventListener("click", () => {
    const open = !document.body.classList.contains("authenticated-sidebar-open");
    document.body.classList.toggle("authenticated-sidebar-open", open);
    elements.authSidebarToggle.setAttribute("aria-expanded", String(open));
    elements.authSidebarToggle.setAttribute("aria-label", open ? "Close dashboard navigation" : "Open dashboard navigation");
    if (elements.authSidebarBackdrop) elements.authSidebarBackdrop.hidden = !open;
  });
  elements.authSidebarBackdrop?.addEventListener("click", closeAuthenticatedSidebar);
  elements.authSidebarLogout?.addEventListener("click", () => logout("login.html"));
  window.addEventListener("resize", () => {
    if (window.innerWidth > 960) closeAuthenticatedSidebar();
  });
}

async function hydrateViewer() {
  let user = null;
  let role = "";
  if (typeof window.getSessionData === "function") {
    try {
      const session = await window.getSessionData();
      user = session?.user || null;
      role = session?.role || "";
    } catch (error) {
      console.warn("[browse-paralegals] session hydration failed", error);
    }
  }
  state.viewer = user;
  state.viewerRole = String(role || "").toLowerCase();
  state.isLoggedIn = Boolean(user);
  state.canInvite = state.viewerRole === "attorney";
}

function syncAuthButtons() {
  const signInLink = document.getElementById("authAction");
  const logoutBtn = document.getElementById("logoutAction");
  const dashboardHref = dashboardHrefForRole(state.viewerRole);
  if (elements.returnDashboard) {
    if (state.isLoggedIn) {
      elements.returnDashboard.href = dashboardHref;
      elements.returnDashboard.textContent = "RETURN TO DASHBOARD";
    } else {
      elements.returnDashboard.href = "login.html";
      elements.returnDashboard.textContent = "Sign In";
    }
  }
  if (state.isLoggedIn) {
    if (signInLink) signInLink.style.display = "none";
    if (logoutBtn) {
      logoutBtn.style.display = "inline-flex";
      logoutBtn.addEventListener("click", (event) => {
        event.preventDefault();
        logout("login.html");
      });
    }
  } else {
    if (logoutBtn) logoutBtn.style.display = "none";
    if (signInLink) signInLink.style.display = "inline-flex";
  }
  document.querySelectorAll("[data-utility-guest]").forEach((element) => {
    element.hidden = state.isLoggedIn;
  });
  document.querySelectorAll("[data-utility-member]").forEach((element) => {
    element.hidden = !state.isLoggedIn;
  });
  document.querySelectorAll("[data-utility-auth], [data-utility-signup]").forEach((element) => {
    element.hidden = state.isLoggedIn;
  });
  document.querySelectorAll("[data-utility-dashboard]").forEach((element) => {
    element.href = dashboardHref;
  });
}

function toggleAuthBlocker() {
  if (!elements.authBlocker || !document.body) return;
  closeAuthBlocker();
}

function openAuthBlocker() {
  if (!elements.authBlocker || !document.body) return;
  document.body.classList.add(AUTH_LOCK_CLASS);
  document.body.classList.add(AUTH_BLOCKER_READY_CLASS);
  elements.authBlocker.setAttribute("aria-hidden", "false");
  elements.authBlocker.removeAttribute("inert");
  activateDialogFocus(elements.authBlocker, {
    initialFocus: elements.authBlocker.querySelector("a[href]"),
    onEscape: closeAuthBlocker,
  });
}

function closeAuthBlocker() {
  if (!elements.authBlocker || !document.body) return;
  document.body.classList.remove(AUTH_LOCK_CLASS);
  document.body.classList.remove(AUTH_BLOCKER_READY_CLASS);
  elements.authBlocker.setAttribute("aria-hidden", "true");
  elements.authBlocker.setAttribute("inert", "");
  deactivateDialogFocus(elements.authBlocker);
}

function requireSignIn(event) {
  if (state.isLoggedIn) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  openAuthBlocker();
  return true;
}

function bindFilterEvents() {
  elements.experience?.addEventListener("change", () => {
    state.filters.experience = elements.experience.value;
    resetPageAndFetch();
  });
  elements.sortBy?.addEventListener("change", () => {
    state.filters.sort = normalizeSortValue(elements.sortBy.value);
    resetPageAndFetch();
  });
  elements.prevPage?.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      window.scrollTo({ top: 0, behavior: "smooth" });
      loadParalegals();
    }
  });
  elements.nextPage?.addEventListener("click", () => {
    if (state.page < state.pages) {
      state.page += 1;
      window.scrollTo({ top: 0, behavior: "smooth" });
      loadParalegals();
    }
  });
}

function bindSortMenu() {
  const trigger = elements.sortMenuTrigger;
  const menu = elements.sortMenuOptions;
  const select = elements.sortBy;
  if (!trigger || !menu || !select) return;
  const options = Array.from(menu.querySelectorAll("[data-sort-value]"));

  const selectedIndex = () => Math.max(0, options.findIndex((option) => option.getAttribute("aria-selected") === "true"));
  const focusOption = (index) => {
    const normalizedIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => option.setAttribute("tabindex", optionIndex === normalizedIndex ? "0" : "-1"));
    options[normalizedIndex]?.focus();
  };
  const syncVisualSelection = () => {
    const selectedValue = normalizeSortValue(select.value);
    const selected = options.find((option) => option.dataset.sortValue === selectedValue) || options[0];
    options.forEach((option) => {
      option.setAttribute("aria-selected", String(option === selected));
      option.setAttribute("tabindex", "-1");
    });
    if (elements.sortMenuValue && selected) elements.sortMenuValue.textContent = selected.textContent.trim();
  };
  const close = ({ restoreFocus = false } = {}) => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    options.forEach((option) => option.setAttribute("tabindex", "-1"));
    if (restoreFocus) trigger.focus();
  };
  const open = ({ focusIndex = selectedIndex() } = {}) => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    focusOption(focusIndex);
  };
  const commit = (option) => {
    if (!option) return;
    select.value = option.dataset.sortValue || "recent";
    syncVisualSelection();
    select.dispatchEvent(new Event("change", { bubbles: true }));
    close({ restoreFocus: true });
  };

  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
      return;
    }
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  });
  options.forEach((option) => option.addEventListener("click", () => commit(option)));
  menu.addEventListener("keydown", (event) => {
    const current = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      focusOption((current < 0 ? selectedIndex() : current) + delta);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusOption(event.key === "Home" ? 0 : options.length - 1);
    } else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
      event.preventDefault();
      commit(options[current]);
    }
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !event.target.closest(".sort-menu-control")) close();
  });
  select.addEventListener("change", syncVisualSelection);
  syncVisualSelection();
}

function bindFilterMenuToggle() {
  const menu = elements.filterMenu;
  const toggle = elements.filterToggle;
  if (!menu || !toggle) return;

  const setOpen = (open, { restoreFocus = false } = {}) => {
    if (!open) closeFilterOptionLists();
    menu.hidden = !open;
    menu.classList.toggle("active", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close filters" : "Open filters");
    if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });
  elements.filterClose?.addEventListener("click", () => setOpen(false, { restoreFocus: true }));
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target) && !toggle.contains(event.target)) {
      setOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) setOpen(false, { restoreFocus: true });
  });
}

function closeFilterMenu() {
  if (!elements.filterMenu || !elements.filterToggle) return;
  closeFilterOptionLists();
  elements.filterMenu.hidden = true;
  elements.filterMenu.classList.remove("active");
  elements.filterToggle.setAttribute("aria-expanded", "false");
  elements.filterToggle.setAttribute("aria-label", "Open filters");
}

function updateFilterCount() {
  const count = (elements.experience?.value ? 1 : 0) + selectedStates.size + selectedSpecialties.size;
  if (elements.filterCount) {
    elements.filterCount.textContent = String(count);
    elements.filterCount.hidden = count === 0;
  }
  elements.filterToggle?.classList.toggle("has-filters", count > 0);
  const description = count
    ? `Open filters, ${count} active filter${count === 1 ? "" : "s"}`
    : "Open filters";
  if (elements.filterToggle?.getAttribute("aria-expanded") !== "true") {
    elements.filterToggle?.setAttribute("aria-label", description);
  }
}

function bindFilterButtons() {
  elements.applyFilters?.addEventListener("click", () => {
    syncFiltersFromInputs();
    closeFilterMenu();
    resetPageAndFetch();
  });
  elements.clearFilters?.addEventListener("click", () => {
    if (elements.experience) elements.experience.value = "";
    if (elements.stateInput) elements.stateInput.value = "";
    state.filters.experience = "";
    state.filters.location = "";
    selectedStates.clear();
    renderSelectedStateChips();
    if (elements.stateList) {
      elements.stateList.querySelectorAll("[role='option']").forEach((option) => {
        option.setAttribute("aria-selected", "false");
      });
      elements.stateList.classList.remove("show");
    }
    selectedSpecialties.clear();
    updateSpecialtyInput();
    if (elements.specialtyList) {
      elements.specialtyList.querySelectorAll("[role='option']").forEach((option) => {
        option.setAttribute("aria-selected", "false");
      });
      elements.specialtyList.classList.remove("show");
    }
    closeFilterMenu();
    syncFiltersFromInputs();
    resetPageAndFetch();
  });
}

function syncFiltersFromInputs() {
  state.filters.experience = elements.experience?.value || "";
  state.filters.location = [...selectedStates].join("|");
  state.filters.sort = normalizeSortValue(elements.sortBy?.value);
}

function filterOptionElements(list) {
  return Array.from(list?.querySelectorAll?.("[role='option'][data-filter-value]") || []);
}

function closeFilterOptionList(input, list, { restoreFocus = false } = {}) {
  if (!input || !list) return;
  list.classList.remove("show");
  input.setAttribute("aria-expanded", "false");
  filterOptionElements(list).forEach((option) => option.setAttribute("tabindex", "-1"));
  if (restoreFocus) input.focus();
}

function closeFilterOptionLists({ except = null } = {}) {
  [
    [elements.specialtyInput, elements.specialtyList],
    [elements.stateInput, elements.stateList],
  ].forEach(([input, list]) => {
    if (list && list !== except) closeFilterOptionList(input, list);
  });
}

function focusFilterOption(list, index) {
  const options = filterOptionElements(list);
  if (!options.length) return;
  const normalizedIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => option.setAttribute("tabindex", optionIndex === normalizedIndex ? "0" : "-1"));
  options[normalizedIndex].focus();
  options[normalizedIndex].scrollIntoView({ block: "nearest" });
}

function openFilterOptionList(input, list, render, { moveFocus = false } = {}) {
  closeFilterOptionLists({ except: list });
  render();
  list.classList.add("show");
  input.setAttribute("aria-expanded", "true");
  if (moveFocus) {
    const options = filterOptionElements(list);
    const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    focusFilterOption(list, selectedIndex >= 0 ? selectedIndex : 0);
  }
}

function handleFilterOptionListKeydown(event, { input, list, toggleSelection }) {
  const options = filterOptionElements(list);
  const current = options.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeFilterOptionList(input, list, { restoreFocus: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    focusFilterOption(list, (current < 0 ? 0 : current) + delta);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusFilterOption(list, event.key === "Home" ? 0 : options.length - 1);
  } else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
    event.preventDefault();
    toggleSelection(options[current]);
  }
}


function bindModalEvents() {
  elements.cancelInquire?.addEventListener("click", closeInquireModal);
  elements.inquireModal?.addEventListener("click", (event) => {
    if (event.target === elements.inquireModal) {
      closeInquireModal();
    }
  });
  elements.confirmInquire?.addEventListener("click", sendInquiry);
  elements.jobList?.addEventListener("change", (event) => {
    if (event.target.matches("input[name='jobOption']")) {
      clearFieldError(elements.jobList);
    }
  });
  elements.inquireMessage?.addEventListener("input", () => clearFieldError(elements.inquireMessage));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeInquireModal();
  });
  elements.authBlocker?.addEventListener("click", (event) => {
    if (event.target === elements.authBlocker) {
      closeAuthBlocker();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAuthBlocker();
  });
}

function initStateDropdown() {
  if (!elements.stateInput || !elements.stateList) return;
  elements.stateInput.readOnly = true;
  elements.stateInput.placeholder = "State";
  elements.stateInput.setAttribute("role", "combobox");
  elements.stateInput.setAttribute("aria-haspopup", "listbox");
  elements.stateInput.setAttribute("aria-controls", elements.stateList.id);
  elements.stateInput.setAttribute("aria-expanded", "false");
  elements.stateInput.setAttribute("aria-autocomplete", "none");
  elements.stateList.setAttribute("role", "listbox");
  elements.stateList.setAttribute("aria-multiselectable", "true");
  const stateWrapper = elements.stateInput.closest(".dropdown-wrapper");
  const specialtyWrapper = elements.specialtyInput?.closest(".dropdown-wrapper") || null;
  const closeList = (options) => closeFilterOptionList(elements.stateInput, elements.stateList, options);
  const renderList = () => {
    elements.stateList.innerHTML = states
      .map((stateName) => {
        const slug = stateName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return `
        <li id="state-option-${slug}" role="option" tabindex="-1" data-filter-value="${escapeHTML(stateName)}" aria-selected="${selectedStates.has(stateName) ? "true" : "false"}">
          <span class="filter-option-check" aria-hidden="true"></span>
          <span class="filter-option-label">${escapeHTML(stateName)}</span>
        </li>`;
      })
      .join("");
  };
  const openList = (options) => {
    openFilterOptionList(elements.stateInput, elements.stateList, renderList, options);
  };
  const toggleSelection = (row) => {
    const value = row?.dataset.filterValue || "";
    if (!value) return;
    const selected = row.getAttribute("aria-selected") !== "true";
    row.setAttribute("aria-selected", String(selected));
    if (selected) selectedStates.add(value);
    else selectedStates.delete(value);
    renderSelectedStateChips();
    updateStateInput();
    state.filters.location = [...selectedStates].join("|");
    scheduleResetPageAndFetch({ preserveScroll: true, quiet: true });
  };
  elements.stateInput.addEventListener("click", (event) => {
    event.preventDefault();
    if (elements.stateList.classList.contains("show")) closeList();
    else openList();
  });
  elements.stateInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeList({ restoreFocus: true });
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openList({ moveFocus: true });
    }
  });
  elements.stateList.addEventListener("click", (event) => {
    const row = event.target.closest("[role='option'][data-filter-value]");
    if (row) toggleSelection(row);
  });
  elements.stateList.addEventListener("keydown", (event) => {
    handleFilterOptionListKeydown(event, {
      input: elements.stateInput,
      list: elements.stateList,
      toggleSelection,
    });
  });
  elements.selectedStateChips?.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-state]");
    const clearButton = event.target.closest("[data-clear-all-states]");
    if (removeButton) {
      selectedStates.delete(removeButton.dataset.removeState || "");
      renderSelectedStateChips();
      syncStateOptions();
      state.filters.location = [...selectedStates].join("|");
      scheduleResetPageAndFetch({ preserveScroll: true, quiet: true });
      return;
    }
    if (clearButton) {
      selectedStates.clear();
      renderSelectedStateChips();
      syncStateOptions();
      state.filters.location = "";
      scheduleResetPageAndFetch({ preserveScroll: true, quiet: true });
    }
  });
  document.addEventListener("click", (event) => {
    if (!stateWrapper?.contains(event.target)) {
      closeList();
    }
    if (!specialtyWrapper?.contains(event.target)) {
      closeFilterOptionList(elements.specialtyInput, elements.specialtyList);
    }
  });
  renderSelectedStateChips();
  updateStateInput();
}

function updateStateInput() {
  if (!elements.stateInput) return;
  const count = selectedStates.size;
  elements.stateInput.value = count ? `${count} state${count === 1 ? "" : "s"} selected` : "";
  elements.stateInput.setAttribute("aria-label", count ? `State, ${count} selected` : "State");
}

function syncStateOptions() {
  if (!elements.stateList) return;
  filterOptionElements(elements.stateList).forEach((option) => {
    option.setAttribute("aria-selected", String(selectedStates.has(option.dataset.filterValue || "")));
  });
  updateStateInput();
}

function initSpecialtyDropdown() {
  if (!elements.specialtyInput || !elements.specialtyList) return;
  elements.specialtyInput.readOnly = true;
  elements.specialtyInput.placeholder = "Specialty";
  elements.specialtyInput.setAttribute("role", "combobox");
  elements.specialtyInput.setAttribute("aria-haspopup", "listbox");
  elements.specialtyInput.setAttribute("aria-controls", elements.specialtyList.id);
  elements.specialtyInput.setAttribute("aria-expanded", "false");
  elements.specialtyInput.setAttribute("aria-autocomplete", "none");
  elements.specialtyList.setAttribute("role", "listbox");
  elements.specialtyList.setAttribute("aria-multiselectable", "true");
  const closeList = (options) => closeFilterOptionList(elements.specialtyInput, elements.specialtyList, options);
  const renderList = () => {
    elements.specialtyList.innerHTML = specialties
      .map((spec) => {
        const slug = spec.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return `
        <li id="specialty-option-${slug}" role="option" tabindex="-1" data-filter-value="${escapeHTML(spec)}" aria-selected="${selectedSpecialties.has(spec) ? "true" : "false"}">
          <span class="filter-option-check" aria-hidden="true"></span>
          <span class="filter-option-label">${escapeHTML(spec)}</span>
        </li>`;
      })
      .join("");
  };
  const openList = (options) => {
    openFilterOptionList(elements.specialtyInput, elements.specialtyList, renderList, options);
  };
  const toggleSelection = (row) => {
    const value = row?.dataset.filterValue || "";
    if (!value) return;
    const selected = row.getAttribute("aria-selected") !== "true";
    row.setAttribute("aria-selected", String(selected));
    if (selected) selectedSpecialties.add(value);
    else selectedSpecialties.delete(value);
    updateSpecialtyInput();
    scheduleResetPageAndFetch({ preserveScroll: true, quiet: true });
  };
  elements.specialtyInput.addEventListener("click", (event) => {
    event.preventDefault();
    if (elements.specialtyList.classList.contains("show")) closeList();
    else openList();
  });
  elements.specialtyInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeList({ restoreFocus: true });
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openList({ moveFocus: true });
    }
  });
  elements.specialtyList.addEventListener("click", (event) => {
    const row = event.target.closest("[role='option'][data-filter-value]");
    if (row) toggleSelection(row);
  });
  elements.specialtyList.addEventListener("keydown", (event) => {
    handleFilterOptionListKeydown(event, {
      input: elements.specialtyInput,
      list: elements.specialtyList,
      toggleSelection,
    });
  });
  updateSpecialtyInput();
}

function renderSelectedStateChips() {
  if (!elements.selectedStateChips) return;
  const selected = [...selectedStates];
  elements.selectedStateChips.classList.toggle("has-items", selected.length > 0);
  elements.selectedStateChips.innerHTML = selected
    .map(
      (stateName) => `
        <span class="filter-chip">
          ${escapeHTML(stateName)}
          <button type="button" aria-label="Remove ${escapeHTML(stateName)}" data-remove-state="${escapeHTML(stateName)}">&times;</button>
        </span>`
    )
    .join("");
  if (selected.length > 1) {
    elements.selectedStateChips.insertAdjacentHTML(
      "beforeend",
      '<span class="filter-chip clear-chip"><button type="button" data-clear-all-states>Clear all</button></span>'
    );
  }
}

function updateSpecialtyInput() {
  if (!elements.specialtyInput) return;
  const count = selectedSpecialties.size;
  elements.specialtyInput.value = count ? `${count} specialt${count === 1 ? "y" : "ies"} selected` : "";
  elements.specialtyInput.setAttribute("aria-label", count ? `Specialty, ${count} selected` : "Specialty");
}

function resetPageAndFetch(options = {}) {
  updateFilterCount();
  if (filterFetchTimer) {
    clearTimeout(filterFetchTimer);
    filterFetchTimer = null;
  }
  state.page = 1;
  loadParalegals(options);
}

function scheduleResetPageAndFetch(options = {}) {
  updateFilterCount();
  if (filterFetchTimer) clearTimeout(filterFetchTimer);
  filterFetchTimer = setTimeout(() => {
    filterFetchTimer = null;
    state.page = 1;
    loadParalegals(options);
  }, 150);
}

async function loadParalegals(options = {}) {
  if (!elements.results || !elements.status) return;
  const preserveScroll = Boolean(options.preserveScroll);
  const quiet = Boolean(options.quiet);
  const scrollY = preserveScroll ? window.scrollY : null;
  if (!quiet) setResultsStatus("Loading paralegals…");
  const params = new URLSearchParams();
  params.set("page", state.page);
  params.set("limit", state.limit);
  params.set("sort", normalizeSortValue(state.filters.sort));

  const minYears = parseExperience(state.filters.experience);
  if (minYears) params.set("minYears", String(minYears));
  if (selectedStates.size) params.set("location", [...selectedStates].join("|"));
  if (selectedSpecialties.size) {
    params.set("practice", [...selectedSpecialties].join("|"));
  }

  try {
    const res = await fetch(`/public/paralegals?${params.toString()}`, {
      headers: { Accept: "application/json" },
      credentials: state.isLoggedIn ? "include" : "omit",
    });
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const data = contentType.includes("application/json")
      ? await res.json()
      : null;
    if (!res.ok) {
      throw new Error(data?.error || "Paralegal profiles are temporarily unavailable.");
    }
    if (!data || typeof data !== "object") {
      throw new Error("Paralegal profiles are temporarily unavailable.");
    }
    renderParalegals(Array.isArray(data.items) ? data.items : []);
    updatePagination({ total: data.total, pages: data.pages, page: data.page });
    if (preserveScroll && Number.isFinite(scrollY)) {
      requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
    }
  } catch (error) {
    console.error(error);
    renderParalegals([]);
    setResultsStatus(error.message || "Unable to load paralegals right now.", true);
  }
}

async function loadCases() {
  try {
    const res = await secureFetch("/api/cases/my-active", {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
      ? payload
      : [];
    availableCases = items.filter((item) => {
      const archived = Boolean(item.archived);
      const assigned = Boolean(
        item.acceptedParalegal ||
          item.assignedTo?.id ||
          item.assignedTo?._id ||
          item.paralegal?.id ||
          item.paralegal?._id ||
          item.paralegal ||
          item.paralegalId
      );
      return !archived && !assigned;
    });
  } catch (error) {
    console.warn("Unable to load cases", error);
    availableCases = [];
  }
  renderCaseOptions();
}

function renderParalegals(items) {
  elements.results.innerHTML = "";
  if (elements.status) {
    elements.results.appendChild(elements.status);
  }
  if (!items.length) {
    setResultsStatus("No paralegals match your filters yet.");
    return;
  }
  setResultsStatus("");
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const card = buildParalegalCard(item);
    if (card) fragment.appendChild(card);
  });
  elements.results.appendChild(fragment);
}

function buildParalegalCard(paralegal) {
  const paralegalId = String(paralegal._id || paralegal.id || paralegal.paralegalId || "");
  const presentation = normalizePresentation(paralegal.presentation, window.location.origin, {
    expectedKind: "card",
    expectedType: "profile",
    expectedId: paralegalId,
  });
  if (!presentation) return null;
  const name = presentation.object.title;
  const location = presentation.details.find((item) => item.label === "Location")?.value || "Location not specified";
  const specialties = (presentation.details.find((item) => item.label === "Practice areas")?.value || "").split(", ").filter(Boolean).slice(0, 2);
  const experience = formatExperience(paralegal.yearsExperience);
  const avatar = paralegal.avatarURL || AVATAR_PLACEHOLDER;
  const profileHref = presentation.links.self;

  const card = document.createElement("article");
  card.className = "paralegal-card";
  if (paralegalId) {
    card.dataset.paralegalId = paralegalId;
  }

  const photoLink = document.createElement("a");
  photoLink.className = "profile-photo-link profile-link";
  photoLink.href = profileHref;
  photoLink.addEventListener("click", (event) => {
    requireSignIn(event);
  });
  const img = document.createElement("img");
  img.src = avatar;
  img.alt = `Portrait of ${name}`;
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== AVATAR_PLACEHOLDER) img.src = AVATAR_PLACEHOLDER;
  }, { once: true });
  photoLink.appendChild(img);
  card.appendChild(photoLink);
  const heading = document.createElement("h3");
  const headingLink = document.createElement("a");
  headingLink.href = profileHref;
  headingLink.textContent = name;
  headingLink.className = "profile-name-link profile-link";
  headingLink.addEventListener("click", (event) => {
    requireSignIn(event);
  });
  heading.appendChild(headingLink);
  const content = document.createElement("div");
  content.className = "card-content";
  content.appendChild(heading);

  const intro = document.createElement("p");
  intro.textContent = `${specialties[0] || "Generalist"} · ${location}`;
  content.appendChild(intro);

  if (presentation.summary) {
    const bio = document.createElement("p");
    bio.textContent = getFirstSentence(presentation.summary);
    content.appendChild(bio);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.appendChild(buildMetaChip("Experience", experience));
  meta.appendChild(buildMetaChip("Status", presentation.status.label, { hideLabel: true }));
  content.appendChild(meta);
  card.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (state.canInvite) {
    const inquireBtn = document.createElement("button");
    inquireBtn.type = "button";
    inquireBtn.className = "action-btn invite-btn";
    inquireBtn.dataset.publicAction = "primary";
    inquireBtn.dataset.actionShape = "pill";
    inquireBtn.textContent = "Invite to matter";
    inquireBtn.addEventListener("click", () => openInquireModal({ id: paralegalId, name }));
    actions.appendChild(inquireBtn);
  }
  if (actions.children.length) {
    card.appendChild(actions);
  }

  card.addEventListener("click", (event) => {
    const isAction = event.target.closest(".action-btn");
    const isProfileLink = event.target.closest(".profile-link");
    if (isAction || isProfileLink || !paralegalId) return;
    if (requireSignIn(event)) return;
    window.location.href = profileHref;
  });

  return card;
}

function getFirstSentence(summary) {
  const clean = String(summary || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const firstSentenceMatch = clean.match(/^(.+?[.!?])(\s|$)/);
  return firstSentenceMatch ? firstSentenceMatch[1] : clean;
}

function buildMetaChip(label, value, options = {}) {
  const span = document.createElement("span");
  const hideLabel = Boolean(options.hideLabel);
  span.textContent = hideLabel ? value : `${label}: ${value}`;
  return span;
}

function setResultsStatus(message, isError = false) {
  if (!elements.status) return;
  elements.status.textContent = message || "";
  elements.status.classList.toggle("error", Boolean(isError));
  elements.status.style.display = message ? "block" : "none";
}

function updatePagination(data = {}) {
  state.total = Number(data.total || 0);
  state.pages = Number(data.pages || 1) || 1;
  updatePaginationLabel();
  if (elements.prevPage) elements.prevPage.disabled = state.page <= 1;
  if (elements.nextPage) elements.nextPage.disabled = state.page >= state.pages;
}

function updatePaginationLabel() {
  if (!elements.paginationLabel) return;
  const from = state.total ? (state.page - 1) * state.limit + 1 : 0;
  const to = Math.min(state.page * state.limit, state.total);
  const range = state.total ? `${from}-${to}` : "0";
  elements.paginationLabel.textContent = `Page ${state.page} of ${Math.max(state.pages, 1)} • Showing ${range} of ${state.total}`;
}

function openInquireModal(paralegal) {
  activeParalegal = paralegal;
  if (!elements.inquireModal) return;
  clearFieldError(elements.jobList);
  clearFieldError(elements.inquireMessage);
  elements.selectedParalegalText.textContent = `Select an open Matter for ${paralegal.name}.`;
  elements.inquireMessage.value = "";
  const firstOption = elements.jobList.querySelector("input[name='jobOption']");
  if (firstOption) firstOption.checked = false;
  elements.confirmInquire.disabled = !availableCases.length;
  elements.inquireModal.classList.add("show");
  elements.inquireModal.setAttribute("aria-hidden", "false");
  elements.inquireModal.removeAttribute("inert");
  activateDialogFocus(elements.inquireModal, {
    initialFocus: firstOption || elements.inquireMessage || elements.cancelInquire,
    onEscape: closeInquireModal,
  });
}

function closeInquireModal() {
  activeParalegal = null;
  elements.inquireModal?.classList.remove("show");
  elements.inquireModal?.setAttribute("aria-hidden", "true");
  elements.inquireModal?.setAttribute("inert", "");
  deactivateDialogFocus(elements.inquireModal);
  elements.inquireMessage.value = "";
  clearFieldError(elements.jobList);
  clearFieldError(elements.inquireMessage);
  const checked = elements.jobList?.querySelector("input[name='jobOption']:checked");
  if (checked) checked.checked = false;
}

function renderCaseOptions() {
  if (!elements.jobList) return;
  if (!availableCases.length) {
    elements.jobList.innerHTML = "<p>No open Matters are available. Create a Matter before inviting a paralegal.</p>";
    elements.confirmInquire.disabled = true;
    return;
  }
  const targetId = String(
    normalizeId(activeParalegal) ||
      normalizeId(activeParalegal?.paralegal) ||
      normalizeId(activeParalegal?.user) ||
      normalizeId(activeParalegal?.person)
  );
  const options = availableCases.map((c) => {
    const caseId = c.id || c._id;
    const inviteEntries = Array.isArray(c.invites) ? c.invites : [];
    const matchingInvite = inviteEntries.find(
      (invite) => normalizeId(invite?.paralegalId) && String(normalizeId(invite.paralegalId)) === targetId
    );
    const inviteStatus = String(matchingInvite?.status || "").toLowerCase();
    const assignedId =
      normalizeId(c.assignedTo?.id) ||
      normalizeId(c.assignedTo?._id) ||
      normalizeId(c.paralegalId) ||
      normalizeId(c.paralegal?.id) ||
      normalizeId(c.paralegal?._id) ||
      normalizeId(c.paralegal);
    const assigned = Boolean(assignedId || c.acceptedParalegal);
    const invited = targetId && (inviteStatus === "pending" || inviteStatus === "accepted");
    const disabled = invited || assigned;
    const statusLabel = invited
      ? "Invitation already sent to this paralegal"
      : assigned
      ? "A paralegal is already assigned"
      : "";
    return { caseId, title: c.title || "Untitled matter", disabled, statusLabel };
  });
  const visibleOptions = options.filter((opt) => opt.statusLabel !== "A paralegal is already assigned");
  const hasSelectable = visibleOptions.some((opt) => !opt.disabled);
  if (!visibleOptions.length) {
    elements.jobList.innerHTML = "<p>No open Matters are available. Create a Matter before inviting a paralegal.</p>";
    elements.confirmInquire.disabled = true;
    return;
  }
  elements.jobList.innerHTML = visibleOptions
    .map(
      (opt) => `
      <label class="job-option${opt.disabled ? " disabled" : ""}">
        <input type="radio" name="jobOption" value="${escapeHTML(opt.caseId)}" ${opt.disabled ? "disabled" : ""} aria-disabled="${opt.disabled ? "true" : "false"}">
        <span>${escapeHtml(opt.title)}${opt.statusLabel ? ` — ${escapeHtml(opt.statusLabel)}` : ""}</span>
      </label>`
    )
    .join("");
  elements.confirmInquire.disabled = !hasSelectable;
}

async function sendInquiry() {
  if (!activeParalegal || !elements.jobList) return;
  const selected = elements.jobList.querySelector("input[name='jobOption']:checked");
  clearFieldError(elements.jobList);
  if (!selected) {
    showFieldError(elements.jobList, "Select an open Matter before sending.");
    showToast("Select an open Matter first.", "err");
    return;
  }
  const message = (elements.inquireMessage.value || "").trim();
  const targetId = normalizeId(activeParalegal) || normalizeId(activeParalegal?.paralegal) || normalizeId(activeParalegal?.user) || normalizeId(activeParalegal?.person);
  const caseMeta = availableCases.find((c) => String(c.id || c._id) === String(selected.value));
  if (caseMeta && targetId) {
    const inviteEntries = Array.isArray(caseMeta.invites) ? caseMeta.invites : [];
    const matchingInvite = inviteEntries.find(
      (invite) => normalizeId(invite?.paralegalId) && String(normalizeId(invite.paralegalId)) === targetId
    );
    const inviteStatus = String(matchingInvite?.status || "").toLowerCase();
    const assignedId =
      normalizeId(caseMeta.assignedTo?.id) ||
      normalizeId(caseMeta.assignedTo?._id) ||
      normalizeId(caseMeta.paralegalId) ||
      normalizeId(caseMeta.paralegal?.id) ||
      normalizeId(caseMeta.paralegal?._id) ||
      normalizeId(caseMeta.paralegal);
    if (inviteStatus === "pending" || inviteStatus === "accepted") {
      showToast("Invitation already sent to this paralegal for this Matter.", "err");
      return;
    }
    if (assignedId || caseMeta.acceptedParalegal) {
      showToast("A paralegal is already assigned to this Matter.", "err");
      return;
    }
  }
  try {
    const res = await secureFetch(
      `/api/cases/${encodeURIComponent(selected.value)}/invite/${encodeURIComponent(activeParalegal.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: selected.value, message }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Unable to send invite");
    }
    showToast("Invite sent successfully.", "ok");
    closeInquireModal();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to send invite", "err");
  }
}

function parseExperience(value = "") {
  const match = value.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function normalizeSortValue(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "experience" || normalized === "alpha") return normalized;
  return "recent";
}


function formatExperience(years) {
  const num = Number(years);
  if (Number.isNaN(num)) return "Experience varies";
  if (num <= 0) return "Under a year";
  if (num >= 10) return "10+ years";
  return `${Math.round(num)}+ years`;
}


function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showFieldError(target, message) {
  if (!target) return;
  clearFieldError(target);
  target.classList?.add("input-error");
  if (typeof target.setAttribute === "function") {
    target.setAttribute("aria-invalid", "true");
  }
  const error = document.createElement("div");
  error.className = "field-error";
  error.textContent = message;
  const wrapper = target.closest(".field") || target.closest("[data-field-wrapper]");
  if (wrapper) wrapper.appendChild(error);
  else target.insertAdjacentElement("afterend", error);
}

function clearFieldError(target) {
  if (!target) return;
  target.classList?.remove("input-error");
  if (typeof target.removeAttribute === "function") {
    target.removeAttribute("aria-invalid");
  }
  const wrapper = target.closest(".field") || target.closest("[data-field-wrapper]");
  if (wrapper) {
    const existing = wrapper.querySelector(".field-error");
    if (existing) existing.remove();
    return;
  }
  const next = target.nextElementSibling;
  if (next?.classList.contains("field-error")) next.remove();
}

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    void showAlert(message, { title: type === "err" || type === "error" ? "Action unavailable" : "Notice" });
  }
}
