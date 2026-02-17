import { secureFetch } from "./auth.js";

function getStoredUserSnapshot() {
  if (typeof window.getStoredUser === "function") {
    const stored = window.getStoredUser();
    if (stored && typeof stored.isFirstLogin === "boolean") return stored;
  }
  try {
    const raw = localStorage.getItem("lpc_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let onboardingState = null;
let onboardingPromise = null;

function normalizeOnboarding(raw = {}) {
  return {
    paralegalWelcomeDismissed: Boolean(raw?.paralegalWelcomeDismissed),
    paralegalTourCompleted: Boolean(raw?.paralegalTourCompleted),
    paralegalProfileTourCompleted: Boolean(raw?.paralegalProfileTourCompleted),
    attorneyTourCompleted: Boolean(raw?.attorneyTourCompleted),
  };
}

function getCachedOnboarding(user) {
  if (user?.onboarding && typeof user.onboarding === "object") {
    onboardingState = normalizeOnboarding(user.onboarding);
    return onboardingState;
  }
  return onboardingState || normalizeOnboarding({});
}

async function loadOnboardingState(user) {
  if (user?.onboarding && typeof user.onboarding === "object") {
    onboardingState = normalizeOnboarding(user.onboarding);
    return onboardingState;
  }
  if (onboardingState) return onboardingState;
  if (onboardingPromise) return onboardingPromise;
  onboardingPromise = (async () => {
    try {
      const res = await secureFetch("/api/users/me/onboarding", {
        headers: { Accept: "application/json" },
        suppressToast: true,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Unable to load onboarding state.");
      onboardingState = normalizeOnboarding(payload.onboarding || {});
      return onboardingState;
    } catch (err) {
      console.warn("Unable to load onboarding state", err);
      onboardingState = normalizeOnboarding({});
      return onboardingState;
    } finally {
      onboardingPromise = null;
    }
  })();
  return onboardingPromise;
}

async function updateOnboardingState(updates = {}, { markFirstLoginComplete = false } = {}) {
  try {
    const res = await secureFetch("/api/users/me/onboarding", {
      method: "PATCH",
      headers: { Accept: "application/json" },
      body: updates,
      suppressToast: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to update onboarding state.");
    onboardingState = normalizeOnboarding(payload.onboarding || {});
    if (typeof window.updateSessionUser === "function") {
      const nextUser = { onboarding: onboardingState };
      if (markFirstLoginComplete) nextUser.isFirstLogin = false;
      window.updateSessionUser(nextUser);
    }
    return onboardingState;
  } catch (err) {
    console.warn("Unable to update onboarding state", err);
    return getCachedOnboarding({});
  }
}

function markTourCompleted() {
  void updateOnboardingState({ attorneyTourCompleted: true }, { markFirstLoginComplete: true });
}

function isVisibleForTour(target) {
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(target);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
  return true;
}

let tourApi = null;
const ATTORNEY_TOUR_STEP_KEY = "lpc_attorney_tour_step";
const ATTORNEY_TOUR_ACTIVE_KEY = "lpc_attorney_tour_active";

function getStoredTourProgress() {
  try {
    const active = sessionStorage.getItem(ATTORNEY_TOUR_ACTIVE_KEY) === "1";
    if (!active) return null;
    const rawStep = sessionStorage.getItem(ATTORNEY_TOUR_STEP_KEY);
    const step = Number.parseInt(rawStep, 10);
    if (Number.isNaN(step)) return { step: 0 };
    return { step };
  } catch {
    return null;
  }
}

function setTourProgress(stepIndex) {
  try {
    sessionStorage.setItem(ATTORNEY_TOUR_ACTIVE_KEY, "1");
    sessionStorage.setItem(ATTORNEY_TOUR_STEP_KEY, String(stepIndex));
  } catch {}
}

function clearTourProgress() {
  try {
    sessionStorage.removeItem(ATTORNEY_TOUR_ACTIVE_KEY);
    sessionStorage.removeItem(ATTORNEY_TOUR_STEP_KEY);
  } catch {}
}

function resolveStepTarget(step, { visibleOnly = false } = {}) {
  const candidates = [];
  if (step?.target) candidates.push(step.target);
  if (step?.selector) {
    const node = document.querySelector(step.selector);
    if (node) candidates.push(node);
  }
  if (Array.isArray(step?.selectors)) {
    step.selectors.forEach((selector) => {
      const node = document.querySelector(selector);
      if (node) candidates.push(node);
    });
  }
  if (!candidates.length) return null;
  if (!visibleOnly) return candidates[0];
  return candidates.find((node) => isVisibleForTour(node)) || candidates[0];
}

function consumeReplayFlag() {
  let replay = false;
  try {
    if (sessionStorage.getItem("lpc_attorney_replay_tour") === "1") {
      replay = true;
      sessionStorage.removeItem("lpc_attorney_replay_tour");
    }
  } catch (_) {}
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("replayTour") === "1") {
      replay = true;
      params.delete("replayTour");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
  } catch (_) {}
  return replay;
}

async function initAttorneyTour(user = {}, options = {}) {
  const resumeStep = Number.isInteger(options.resumeStep) ? options.resumeStep : null;
  const force = Boolean(options.force) || resumeStep !== null;
  if (tourApi) {
    if (force) {
      if (resumeStep !== null) tourApi.showStep(resumeStep);
      else tourApi.start();
    }
    return;
  }

  const overlay = document.getElementById("attorneyTourOverlay");
  const modal = document.getElementById("attorneyTourModal");
  const tooltip = document.getElementById("attorneyTourTooltip");
  const startBtn = document.getElementById("attorneyTourStartBtn");
  const closeBtn = document.getElementById("attorneyTourCloseBtn");
  const tooltipCloseBtn = document.getElementById("attorneyTourTooltipCloseBtn");
  const backBtn = document.getElementById("attorneyTourBackBtn");
  const nextBtn = document.getElementById("attorneyTourNextBtn");
  const stepTitleEl = document.getElementById("attorneyTourStepTitle");
  const stepTextEl = document.getElementById("attorneyTourStepText");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const sidebarNav = document.getElementById("sidebarNav");
  let sidebarOpenedByTour = false;

  if (!overlay || !modal || !tooltip || !startBtn || !stepTextEl || !nextBtn || !backBtn) return;

  const stored = getStoredUserSnapshot();
  const effectiveUser = user || stored || {};
  const role = String(effectiveUser?.role || stored?.role || "").toLowerCase();
  const status = String(effectiveUser?.status || stored?.status || "").toLowerCase();
  const storedFlag = stored?.isFirstLogin;
  const userFlag = effectiveUser?.isFirstLogin;
  const isFirstLogin = typeof storedFlag === "boolean" ? storedFlag : Boolean(userFlag);

  if (role !== "attorney") return;
  if (status && status !== "approved") return;
  if (!force && !isFirstLogin) return;

  const onboarding = await loadOnboardingState(effectiveUser);
  if (!force && onboarding?.attorneyTourCompleted) return;
  if (!force) markTourCompleted();

  const steps = [
    {
      selector: "#headerUser",
      title: "Create your profile",
      text: "Click your profile menu, then choose Account Settings to complete your attorney profile.",
      placement: "bottom",
      align: "end",
    },
    {
      selectors: [
        "#addPaymentMethodBtn",
        "#replacePaymentMethodBtn",
        "#openPortalBtn",
        "#paymentMethodSummary",
      ],
      view: "billing",
      title: "Fund Cases",
      text: "Add a payment method so cases can be funded when you hire. Let's-ParaConnect is partnered with Stripe, and payments are processed through Stripe. Funds remain within Stripe's infrastructure until you approve release.",
    },
    {
      selectors: ['[data-case-quick="create"]', '[data-quick-link="create-case"]'],
      view: "cases",
      title: "Create a case",
      text: "Start a new matter with scope, tasks, and timeline.",
    },
    {
      selector: '[data-quick-link="browse-paralegals"]',
      view: "home",
      title: "Browse paralegals",
      text: "Find vetted paralegals and invite the right fit to your case. Paralegals can also apply to matters if you prefer not to invite directly.",
    },
  ];

  const tourSteps = steps.filter((step) => resolveStepTarget(step));
  if (!tourSteps.length) return;

  let stepIndex = -1;
  let activeTarget = null;

  const setSidebarOpen = (open) => {
    document.body.classList.toggle("nav-open", Boolean(open));
    if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const isMobileSidebarMode = () => window.matchMedia("(max-width: 1024px)").matches;

  const ensureSidebarVisibleForTarget = (target) => {
    if (!target || !sidebarNav) {
      if (sidebarOpenedByTour) {
        setSidebarOpen(false);
        sidebarOpenedByTour = false;
      }
      return;
    }
    const isSidebarTarget = sidebarNav.contains(target);
    if (isMobileSidebarMode() && isSidebarTarget) {
      const alreadyOpen = document.body.classList.contains("nav-open");
      if (!alreadyOpen) sidebarOpenedByTour = true;
      setSidebarOpen(true);
      return;
    }
    if (sidebarOpenedByTour) {
      setSidebarOpen(false);
      sidebarOpenedByTour = false;
    }
  };

  const clearHighlight = () => {
    if (activeTarget) activeTarget.classList.remove("tour-highlight");
    activeTarget = null;
  };

  const showOverlay = () => {
    overlay.classList.add("is-active");
    overlay.setAttribute("aria-hidden", "false");
  };

  const hideOverlay = () => {
    ensureSidebarVisibleForTarget(null);
    overlay.classList.remove("is-active", "spotlight");
    overlay.setAttribute("aria-hidden", "true");
    modal.classList.remove("is-active");
    tooltip.classList.remove("is-active");
    clearHighlight();
  };

  const positionSpotlight = (target) => {
    const rect = target.getBoundingClientRect();
    const padding = 10;
    overlay.style.setProperty("--spot-x", `${rect.left - padding}px`);
    overlay.style.setProperty("--spot-y", `${rect.top - padding}px`);
    overlay.style.setProperty("--spot-w", `${rect.width + padding * 2}px`);
    overlay.style.setProperty("--spot-h", `${rect.height + padding * 2}px`);
  };

  const positionTooltip = (target, options = {}) => {
    const rect = target.getBoundingClientRect();
    tooltip.classList.add("is-active");
    const tipRect = tooltip.getBoundingClientRect();
    const padding = 12;
    const gap = 16;
    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;
    const spaceBottom = window.innerHeight - rect.bottom;
    const spaceTop = rect.top;

    const fits = {
      right: spaceRight >= tipRect.width + gap,
      left: spaceLeft >= tipRect.width + gap,
      bottom: spaceBottom >= tipRect.height + gap,
      top: spaceTop >= tipRect.height + gap,
    };

    let placement = options.placement && fits[options.placement] ? options.placement : "right";
    if (!fits[placement]) {
      if (fits.right) placement = "right";
      else if (fits.left) placement = "left";
      else if (fits.bottom) placement = "bottom";
      else if (fits.top) placement = "top";
      else placement = spaceRight >= spaceLeft ? "right" : "left";
    }

    tooltip.classList.remove("arrow-left", "arrow-right", "arrow-top", "arrow-bottom");
    tooltip.classList.add(`arrow-${placement}`);

    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    let top = 0;
    let left = 0;

    if (placement === "right") {
      top = clamp(rect.top + rect.height / 2 - tipRect.height / 2, padding, window.innerHeight - tipRect.height - padding);
      left = Math.min(window.innerWidth - tipRect.width - padding, rect.right + gap);
      const arrowTop = clamp(rect.top + rect.height / 2 - top - 8, 16, tipRect.height - 20);
      tooltip.style.setProperty("--arrow-top", `${arrowTop}px`);
    } else if (placement === "left") {
      top = clamp(rect.top + rect.height / 2 - tipRect.height / 2, padding, window.innerHeight - tipRect.height - padding);
      left = Math.max(padding, rect.left - tipRect.width - gap);
      const arrowTop = clamp(rect.top + rect.height / 2 - top - 8, 16, tipRect.height - 20);
      tooltip.style.setProperty("--arrow-top", `${arrowTop}px`);
    } else if (placement === "bottom") {
      if (options.align === "start") {
        left = clamp(rect.left, padding, window.innerWidth - tipRect.width - padding);
      } else if (options.align === "end") {
        left = clamp(rect.right - tipRect.width, padding, window.innerWidth - tipRect.width - padding);
      } else {
        left = clamp(rect.left + rect.width / 2 - tipRect.width / 2, padding, window.innerWidth - tipRect.width - padding);
      }
      top = Math.min(window.innerHeight - tipRect.height - padding, rect.bottom + gap);
      const arrowLeft = clamp(rect.left + rect.width / 2 - left - 8, 16, tipRect.width - 20);
      tooltip.style.setProperty("--arrow-left", `${arrowLeft}px`);
    } else {
      if (options.align === "start") {
        left = clamp(rect.left, padding, window.innerWidth - tipRect.width - padding);
      } else if (options.align === "end") {
        left = clamp(rect.right - tipRect.width, padding, window.innerWidth - tipRect.width - padding);
      } else {
        left = clamp(rect.left + rect.width / 2 - tipRect.width / 2, padding, window.innerWidth - tipRect.width - padding);
      }
      top = Math.max(padding, rect.top - tipRect.height - gap);
      const arrowLeft = clamp(rect.left + rect.width / 2 - left - 8, 16, tipRect.width - 20);
      tooltip.style.setProperty("--arrow-left", `${arrowLeft}px`);
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  };

  const showIntro = () => {
    setTourProgress(-1);
    showOverlay();
    ensureSidebarVisibleForTarget(null);
    overlay.classList.remove("spotlight");
    modal.classList.add("is-active");
    tooltip.classList.remove("is-active");
    clearHighlight();
  };

  const setProfileMenuOpen = (open) => {
    const trigger = document.getElementById("headerUser");
    const menu = document.getElementById("profileDropdown");
    if (!trigger || !menu) return;
    menu.classList.toggle("show", open);
    menu.setAttribute("aria-hidden", open ? "false" : "true");
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const navigateToView = (view) => {
    if (!view) return;
    const link = document.querySelector(`[data-view-target="${view}"]`);
    if (link && typeof link.click === "function") {
      link.click();
      return;
    }
    const targetHash = `#${view}`;
    if (String(window.location.hash || "") !== targetHash) {
      window.location.hash = view;
    }
  };

  const showStep = (index) => {
    if (!tourSteps[index]) return;
    stepIndex = index;
    setTourProgress(stepIndex);
    const step = tourSteps[index];
    const run = () => {
      setProfileMenuOpen(Boolean(step.openProfileMenu));
      const target = resolveStepTarget(step, { visibleOnly: true });
      if (!target) return;
      clearHighlight();
      activeTarget = target;
      activeTarget.classList.add("tour-highlight");
      if (stepTitleEl) stepTitleEl.textContent = step.title || "";
      stepTextEl.textContent = step.text || "";
      backBtn.disabled = index === 0;
      backBtn.style.visibility = index === 0 ? "hidden" : "visible";
      nextBtn.textContent = index === tourSteps.length - 1 ? "Let's Get Started" : "Next";

      showOverlay();
      ensureSidebarVisibleForTarget(target);
      modal.classList.remove("is-active");
      overlay.classList.add("spotlight");

      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      }

      const start = performance.now();
      const sync = () => {
        if (!overlay.classList.contains("is-active") || !overlay.classList.contains("spotlight")) return;
        positionSpotlight(target);
        positionTooltip(target, step);
        if (performance.now() - start < 380) {
          requestAnimationFrame(sync);
        }
      };
      requestAnimationFrame(sync);
    };

    if (step.view) {
      clearHighlight();
      overlay.classList.remove("spotlight");
      tooltip.classList.remove("is-active");
      setProfileMenuOpen(Boolean(step.openProfileMenu));
      navigateToView(step.view);
      setTimeout(() => {
        run();
      }, 240);
      return;
    }

    run();
  };

  const completeTour = () => {
    tooltip.classList.remove("is-active");
    setProfileMenuOpen(false);
    hideOverlay();
    clearTourProgress();
  };

  const startAttorneyOnboarding = () => {
    try {
      sessionStorage.setItem("lpc_attorney_onboarding_step", "profile");
      sessionStorage.removeItem("lpc_attorney_onboarding_modal_seen_profile");
      sessionStorage.removeItem("lpc_attorney_onboarding_modal_seen_payment");
      sessionStorage.removeItem("lpc_attorney_onboarding_modal_seen_case");
    } catch (_) {}
  };

  const buildProfileTourUrl = (href = "profile-settings.html", options = {}) => {
    const { prompt = false, step = "profile" } = options;
    try {
      const url = new URL(href, window.location.href);
      url.searchParams.set("tour", "1");
      url.searchParams.set("onboardingStep", step);
      if (prompt) {
        url.searchParams.set("profilePrompt", "1");
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      const suffix = `?tour=1&onboardingStep=${encodeURIComponent(step)}`;
      return prompt ? `profile-settings.html${suffix}&profilePrompt=1` : `profile-settings.html${suffix}`;
    }
  };

  startBtn.addEventListener("click", () => showStep(0));
  closeBtn?.addEventListener("click", () => {
    completeTour();
    startAttorneyOnboarding();
    window.location.href = buildProfileTourUrl("profile-settings.html", { prompt: true, step: "profile" });
  });
  tooltipCloseBtn?.addEventListener("click", () => {
    completeTour();
    startAttorneyOnboarding();
    window.location.href = buildProfileTourUrl("profile-settings.html", { prompt: true, step: "profile" });
  });
  backBtn.addEventListener("click", () => {
    if (stepIndex <= 0) return showIntro();
    showStep(stepIndex - 1);
  });
  nextBtn.addEventListener("click", () => {
    if (stepIndex < tourSteps.length - 1) return showStep(stepIndex + 1);
    completeTour();
    startAttorneyOnboarding();
    window.location.href = buildProfileTourUrl("profile-settings.html", { prompt: true, step: "profile" });
  });

  window.addEventListener("resize", () => {
    if (overlay.classList.contains("is-active") && tooltip.classList.contains("is-active") && activeTarget) {
      showStep(stepIndex);
    }
  });

  tourApi = {
    start: showIntro,
    showStep,
    complete: completeTour,
  };

  if (resumeStep !== null) {
    if (resumeStep === -1) {
      showIntro();
    } else {
      showStep(Math.max(0, Math.min(resumeStep, tourSteps.length - 1)));
    }
  } else {
    showIntro();
  }
}

async function bootAttorneyTour() {
  let user = null;
  if (typeof window.requireRole === "function") {
    user = await window.requireRole("attorney");
  }
  if (!user) {
    const stored = getStoredUserSnapshot();
    user = stored || {};
  }
  const forceReplay = consumeReplayFlag();
  const resume = forceReplay ? null : getStoredTourProgress();
  if (forceReplay) clearTourProgress();
  setTimeout(
    () =>
      initAttorneyTour(user || {}, {
        force: Boolean(forceReplay || resume),
        resumeStep: resume?.step ?? null,
      }),
    300
  );
}

async function replayAttorneyTour() {
  let user = null;
  if (typeof window.requireRole === "function") {
    user = await window.requireRole("attorney");
  }
  if (!user) {
    user = getStoredUserSnapshot() || {};
  }
  try {
    const hash = String(window.location.hash || "").toLowerCase();
    if (!hash.startsWith("#home")) {
      window.location.hash = "home";
    }
  } catch (_) {}
  setTimeout(() => {
    void initAttorneyTour(user || {}, { force: true });
  }, 200);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootAttorneyTour();
  }, { once: true });
} else {
  void bootAttorneyTour();
}

window.startAttorneyTour = () => {
  void replayAttorneyTour();
};

window.addEventListener("lpc:attorney-tour", () => {
  void replayAttorneyTour();
});
