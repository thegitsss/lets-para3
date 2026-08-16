(() => {
  "use strict";

  const header = document.querySelector("[data-home-header]");
  const mobileToggle = document.querySelector("[data-mobile-nav-toggle]");
  const mobileNav = document.querySelector("[data-mobile-nav]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

  const syncHeaderSurface = () => {
    if (!header) return;
    const fadeDistance = Math.max(280, Math.min(420, window.innerHeight * 0.4));
    const progress = clamp(window.scrollY / fadeDistance);
    const useInkForeground = progress >= 0.52;
    header.style.setProperty("--header-surface-alpha", (progress * 0.94).toFixed(3));
    header.style.setProperty("--header-surface-blur", `${(progress * 16).toFixed(2)}px`);
    header.style.setProperty("--header-foreground", useInkForeground ? "rgb(26, 34, 48)" : "rgb(255, 255, 255)");
    header.classList.toggle("has-ink", useInkForeground);
    header.classList.toggle("is-scrolled", progress >= 0.98);
  };

  syncHeaderSurface();
  window.addEventListener("scroll", syncHeaderSurface, { passive: true });
  window.addEventListener("resize", syncHeaderSurface);

  class MatterField {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d", { alpha: true });
      this.mode = canvas.dataset.matterField || "hero";
      this.section = canvas.closest("section");
      this.width = 0;
      this.height = 0;
      this.nodes = [];

      if (!this.context || !this.section) return;

      this.resize = this.resize.bind(this);

      if ("ResizeObserver" in window) {
        this.resizeObserver = new ResizeObserver(this.resize);
        this.resizeObserver.observe(this.section);
      } else {
        window.addEventListener("resize", this.resize, { passive: true });
      }

      this.resize();
    }

    resize() {
      const rect = this.section.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      if (width === this.width && height === this.height && this.canvas.width === Math.round(width * dpr)) {
        return;
      }

      this.width = width;
      this.height = height;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.buildNodes();
      this.render(0);
    }

    randomFactory(seed) {
      let value = seed >>> 0;
      return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
      };
    }

    buildNodes() {
      const random = this.randomFactory(this.mode === "hero" ? 2841 : 650);
      const labels = ["SCOPE", "FILES", "DEADLINE", "PEOPLE", "MESSAGES", "PAYMENT"];
      if (this.mode === "hero") {
        const count = this.width < 680 ? 720 : this.width < 1100 ? 1200 : 1900;
        this.nodes = Array.from({ length: count }, (_, index) => {
          const band = random();
          const theta = random() * Math.PI * 2;
          const latitude = Math.asin(random() * 2 - 1);
          return {
            theta,
            latitude,
            shell: 0.72 + random() * 0.34,
            size: 0.55 + random() * (index % 13 === 0 ? 2.8 : 1.45),
            phase: random() * Math.PI * 2,
            speed: 0.035 + random() * 0.075,
            gold: band > 0.83,
            alpha: 0.28 + random() * 0.7,
          };
        });
        return;
      }
      const count =
        this.width < 680
            ? 32
            : 58;

      this.nodes = Array.from({ length: count }, (_, index) => {
        const angle = random() * Math.PI * 2;
        const radiusX = this.width * (0.19 + random() * 0.34);
        const radiusY = this.height * (0.1 + random() * 0.22);
        const side = Math.cos(angle) >= 0 ? 1 : -1;
        const route = random();
        const featured = index < labels.length;

        if (this.mode === "closing") {
          const closingRadiusX = this.width * (0.3 + random() * 0.19);
          const closingRadiusY = this.height * (0.28 + random() * 0.22);
          return {
            angle,
            baseX: this.width * 0.5 + Math.cos(angle) * closingRadiusX,
            baseY: this.height * 0.5 + Math.sin(angle) * closingRadiusY,
            radius: 0.7 + random() * 1.7,
            phase: random() * Math.PI * 2,
            speed: 0.18 + random() * 0.4,
            featured: featured && this.width > 760,
            label: labels[index] || "",
          };
        }

        return {
          angle,
          baseX: this.width * 0.5 + Math.cos(angle) * radiusX,
          baseY: this.height * 0.33 + Math.sin(angle) * radiusY,
          targetX: this.width * 0.5 + side * (26 + (1 - route) * Math.min(this.width * 0.28, 360)),
          targetY: this.height * (0.17 + route * 0.31),
          radius: 0.65 + random() * 1.85,
          phase: random() * Math.PI * 2,
          speed: 0.22 + random() * 0.54,
          featured,
          label: labels[index] || "",
          cardWidth: 34 + random() * 18,
          cardHeight: 42 + random() * 18,
          rotation: (random() - 0.5) * 0.34,
        };
      }).sort((a, b) => a.angle - b.angle);
    }

    roundedRect(context, x, y, width, height, radius) {
      const corner = Math.min(radius, width / 2, height / 2);
      context.beginPath();
      context.moveTo(x + corner, y);
      context.arcTo(x + width, y, x + width, y + height, corner);
      context.arcTo(x + width, y + height, x, y + height, corner);
      context.arcTo(x, y + height, x, y, corner);
      context.arcTo(x, y, x + width, y, corner);
      context.closePath();
    }

    drawDocument(node, x, y, time, alpha) {
      const context = this.context;
      const pulse = 1 + Math.sin(time * node.speed + node.phase) * 0.025;
      const width = node.cardWidth * pulse;
      const height = node.cardHeight * pulse;

      context.save();
      context.translate(x, y);
      context.rotate(node.rotation + Math.sin(time * 0.16 + node.phase) * 0.025);
      this.roundedRect(context, -width / 2, -height / 2, width, height, 5);
      context.fillStyle = `rgba(236, 230, 214, ${0.055 * alpha})`;
      context.fill();
      context.strokeStyle = `rgba(215, 193, 143, ${0.42 * alpha})`;
      context.lineWidth = 0.8;
      context.stroke();

      context.fillStyle = `rgba(236, 230, 214, ${0.55 * alpha})`;
      for (let line = 0; line < 3; line += 1) {
        context.fillRect(-width * 0.28, -height * 0.16 + line * 6, width * (line === 2 ? 0.34 : 0.56), 1);
      }
      context.restore();

      if (node.label) {
        context.save();
        context.font = '500 9px "Sarabun", sans-serif';
        context.letterSpacing = "1.3px";
        context.textAlign = "center";
        context.fillStyle = `rgba(227, 211, 172, ${0.65 * alpha})`;
        context.fillText(node.label, x, y + height / 2 + 17);
        context.restore();
      }
    }

    renderHero(time) {
      this.renderParticleHero(time);
      return;
    }

    renderParticleHero(time) {
      const context = this.context;
      const width = this.width;
      const height = this.height;
      const centerX = width * 0.5;
      const centerY = height * 0.51;
      const radius = Math.min(width * 0.47, height * 0.58);

      const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 1.08);
      glow.addColorStop(0, "rgba(36, 53, 76, 0.18)");
      glow.addColorStop(0.58, "rgba(180, 151, 90, 0.035)");
      glow.addColorStop(1, "rgba(3, 5, 7, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      const rotation = 0;
      const tilt = -0.22;
      const cosTilt = Math.cos(tilt);
      const sinTilt = Math.sin(tilt);
      const spread = 1;

      this.nodes.forEach((node) => {
        const longitude = node.theta + rotation + Math.sin(time * node.speed + node.phase) * 0.08;
        const cosLat = Math.cos(node.latitude);
        const sphereX = Math.cos(longitude) * cosLat * node.shell;
        const sphereY = Math.sin(node.latitude) * node.shell;
        const sphereZ = Math.sin(longitude) * cosLat * node.shell;
        const rotatedY = sphereY * cosTilt - sphereZ * sinTilt;
        const rotatedZ = sphereY * sinTilt + sphereZ * cosTilt;
        const perspective = 0.72 + (rotatedZ + 1) * 0.22;
        const ringWarp = 0.82 + Math.abs(Math.sin(longitude * 1.5 + node.phase)) * 0.22;
        const x = centerX + sphereX * radius * 1.34 * spread * ringWarp;
        const y = centerY + rotatedY * radius * 0.9 * spread;
        const pulse = 0.78 + Math.sin(time * 0.8 + node.phase) * 0.22;
        const alpha = node.alpha * perspective;
        context.beginPath();
        context.arc(x, y, node.size * perspective * pulse, 0, Math.PI * 2);
        context.fillStyle = node.gold
          ? `rgba(215, 193, 143, ${alpha})`
          : `rgba(157, 183, 219, ${alpha * 0.82})`;
        context.fill();
      });
    }

    renderClosing(time) {
      const context = this.context;
      const width = this.width;
      const height = this.height;
      const positions = this.nodes.map((node) => ({
        x: node.baseX + Math.sin(time * node.speed + node.phase) * 7,
        y: node.baseY + Math.cos(time * node.speed * 0.8 + node.phase) * 5,
      }));

      positions.forEach((position, index) => {
        const next = positions[(index + 1) % positions.length];
        context.beginPath();
        context.moveTo(position.x, position.y);
        context.lineTo(next.x, next.y);
        context.strokeStyle = `rgba(77, 89, 107, ${index % 4 === 0 ? 0.11 : 0.045})`;
        context.lineWidth = 0.65;
        context.stroke();
      });

      this.nodes.forEach((node, index) => {
        const position = positions[index];
        if (node.featured) {
          context.save();
          context.font = '500 9px "Sarabun", sans-serif';
          context.textAlign = "center";
          context.fillStyle = "rgba(128, 101, 44, 0.52)";
          context.fillText(node.label, position.x, position.y + 17);
          context.restore();
        }
        context.beginPath();
        context.arc(position.x, position.y, node.radius, 0, Math.PI * 2);
        context.fillStyle = index % 5 === 0 ? "rgba(180, 151, 90, 0.55)" : "rgba(58, 72, 92, 0.28)";
        context.fill();
      });

      const ring = context.createRadialGradient(width * 0.5, height * 0.5, 70, width * 0.5, height * 0.5, width * 0.47);
      ring.addColorStop(0, "rgba(255, 255, 255, 0)");
      ring.addColorStop(0.58, "rgba(180, 151, 90, 0.025)");
      ring.addColorStop(1, "rgba(180, 151, 90, 0.12)");
      context.fillStyle = ring;
      context.fillRect(0, 0, width, height);
    }

    render(time) {
      if (!this.context || !this.width || !this.height) return;
      this.context.clearRect(0, 0, this.width, this.height);
      if (this.mode === "closing") this.renderClosing(time);
      else this.renderHero(time);
    }
  }

  document.querySelectorAll("[data-matter-field]").forEach((canvas) => {
    new MatterField(canvas);
  });

  const setMobileNav = (open) => {
    if (!header || !mobileToggle || !mobileNav) return;
    header.classList.toggle("is-open", open);
    document.body.classList.toggle("nav-open", open);
    mobileToggle.setAttribute("aria-expanded", String(open));
    mobileToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    mobileNav.setAttribute("aria-hidden", String(!open));

    if (open) {
      mobileNav.querySelector("a")?.focus();
    } else if (document.activeElement && mobileNav.contains(document.activeElement)) {
      mobileToggle.focus();
    }
  };

  mobileToggle?.addEventListener("click", () => {
    setMobileNav(mobileToggle.getAttribute("aria-expanded") !== "true");
  });

  mobileNav?.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMobileNav(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header?.classList.contains("is-open")) {
      setMobileNav(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 960 && header?.classList.contains("is-open")) {
      setMobileNav(false);
    }
  });

  const desktopCanvas = document.querySelector("[data-workflow-canvas]");
  const desktopStates = Array.from(desktopCanvas?.querySelectorAll(".workflow-state") || []);
  const chapters = Array.from(document.querySelectorAll("[data-workflow-chapter]"));
  const workflowControls = Array.from(document.querySelectorAll("[data-workflow-select]"));
  const desktopRail = desktopCanvas?.querySelector(".matter-rail");
  const desktopWorkflowStatus = desktopCanvas?.querySelector(".product-topbar .status-chip");
  const workflowStatusLabels = {
    1: "Accepting Applications",
    2: "Applications Received",
    3: "In Progress",
    4: "Awaiting Review",
    5: "Completed",
    6: "Payout Released",
  };
  const stateForMobile = (state) => {
    const source = desktopStates.find((panel) => panel.dataset.state === state);
    const target = document.querySelector(`[data-mobile-workflow-state="${state}"]`);
    if (!source || !target || target.childElementCount) return;
    const clone = source.cloneNode(true);
    clone.classList.add("is-active");
    clone.removeAttribute("aria-hidden");
    target.appendChild(clone);
  };

  ["1", "2", "3", "4", "5", "6"].forEach(stateForMobile);

  const updateRail = (rail, state) => {
    if (!rail) return;
    rail.dataset.matterRail = state;
    Array.from(rail.querySelectorAll(":scope > div")).forEach((step, index) => {
      step.classList.toggle("is-active", index + 1 <= Number(state));
    });
  };

  const setWorkflowState = (state) => {
    if (!desktopCanvas) return;
    desktopCanvas.dataset.workflowState = state;
    if (desktopWorkflowStatus) {
      desktopWorkflowStatus.textContent = workflowStatusLabels[state] || "Matter active";
    }
    desktopStates.forEach((panel) => {
      const isActive = panel.dataset.state === state;
      panel.classList.toggle("is-active", isActive);
      panel.setAttribute("aria-hidden", String(!isActive));
    });

    chapters.forEach((chapter) => {
      chapter.classList.toggle("is-active", chapter.dataset.workflowChapter === state);
    });
    workflowControls.forEach((control) => {
      control.setAttribute("aria-pressed", String(control.dataset.workflowSelect === state));
    });

    updateRail(desktopRail, state);
  };

  chapters.forEach((chapter) => {
    chapter.addEventListener("focusin", () => {
      setWorkflowState(chapter.dataset.workflowChapter || "1");
    });
  });

  workflowControls.forEach((control) => {
    control.addEventListener("click", () => {
      setWorkflowState(control.dataset.workflowSelect || "1");
    });
  });

  const assistantShowcase = document.querySelector(".assistant-showcase");
  if (assistantShowcase) {
    const assistantStage = assistantShowcase.querySelector(".assistant-stage");
    const assistantRole = assistantShowcase.querySelector("[data-assistant-role]");
    const assistantQuestion = assistantShowcase.querySelector("[data-assistant-question]");
    const assistantAnswer = assistantShowcase.querySelector("[data-assistant-answer]");
    const assistantAction = assistantShowcase.querySelector("[data-assistant-action]");
    const assistantSuggestionOne = assistantShowcase.querySelector('[data-assistant-suggestion="1"]');
    const assistantSuggestionTwo = assistantShowcase.querySelector('[data-assistant-suggestion="2"]');
    const assistantNavLabel = assistantShowcase.querySelector("[data-assistant-nav-label]");
    const assistantRecordLabel = assistantShowcase.querySelector("[data-assistant-record-label]");
    const assistantWorkspaceStatus = assistantShowcase.querySelector("[data-assistant-workspace-status]");
    const assistantContextLabel = assistantShowcase.querySelector("[data-assistant-context-label]");
    const assistantRowOneLabel = assistantShowcase.querySelector("[data-assistant-row-one-label]");
    const assistantRowOneValue = assistantShowcase.querySelector("[data-assistant-row-one-value]");
    const assistantRowTwoLabel = assistantShowcase.querySelector("[data-assistant-row-two-label]");
    const assistantRowTwoValue = assistantShowcase.querySelector("[data-assistant-row-two-value]");
    const assistantRowThreeLabel = assistantShowcase.querySelector("[data-assistant-row-three-label]");
    const assistantRowThreeValue = assistantShowcase.querySelector("[data-assistant-row-three-value]");
    const assistantActivityOne = assistantShowcase.querySelector("[data-assistant-activity-one]");
    const assistantActivityTwo = assistantShowcase.querySelector("[data-assistant-activity-two]");
    const assistantActivityThree = assistantShowcase.querySelector("[data-assistant-activity-three]");
    const assistantViewControls = Array.from(assistantShowcase.querySelectorAll("[data-assistant-view-select]"));
    const assistantViews = {
      attorney: {
        role: "Attorney Assistant",
        question: "Has payment for this matter been released?",
        answer: "Yes. LPC recorded the $650 payment release after Medical Records Chronology was marked complete. Stripe provides the payout status.",
        action: "Open the completed matter",
        suggestionOne: "What files were submitted?",
        suggestionTwo: "Open the completed matter",
        nav: "Billing",
        recordLabel: "Completed matter",
        workspaceStatus: "Payout Released",
        contextLabel: "Completion record · Personal Injury",
        rowOneLabel: "Status",
        rowOneValue: "Completed",
        rowTwoLabel: "Submitted files",
        rowTwoValue: "2 approved",
        rowThreeLabel: "Payment",
        rowThreeValue: "$650 · Release recorded",
        activityOne: "Chronology and source index received",
        activityTwo: "Completion approved",
        activityThree: "Payment release recorded",
      },
      paralegal: {
        role: "Paralegal Assistant",
        question: "Were my submitted files approved?",
        answer: "Yes. Both files were approved, and the $533 payout was released after the $117 platform fee. Stripe provides the current payout status.",
        action: "Open the completed assignment",
        suggestionOne: "When was payment released?",
        suggestionTwo: "View the completed assignment",
        nav: "Payouts",
        recordLabel: "Completed assignment",
        workspaceStatus: "Payout Released",
        contextLabel: "Assignment record · Personal Injury",
        rowOneLabel: "Assignment",
        rowOneValue: "Completed",
        rowTwoLabel: "Deliverables",
        rowTwoValue: "2 approved",
        rowThreeLabel: "Earnings",
        rowThreeValue: "$533 · Released",
        activityOne: "Final files submitted",
        activityTwo: "Attorney approved work",
        activityThree: "$533 payout released",
      },
    };
    let activeAssistantView = "attorney";
    let assistantSwapTimer = 0;

    const renderAssistantView = (view) => {
      assistantViewControls.forEach((control) => {
        control.setAttribute("aria-pressed", String(control.dataset.assistantViewSelect === view));
      });
      if (view === activeAssistantView || !assistantViews[view]) return;
      activeAssistantView = view;
      assistantStage?.classList.add("is-switching");
      window.clearTimeout(assistantSwapTimer);
      assistantSwapTimer = window.setTimeout(() => {
        const content = assistantViews[view];
        assistantShowcase.dataset.assistantView = view;
        if (assistantRole) assistantRole.textContent = content.role;
        if (assistantQuestion) assistantQuestion.textContent = content.question;
        if (assistantAnswer) assistantAnswer.textContent = content.answer;
        if (assistantAction?.firstChild) assistantAction.firstChild.nodeValue = `${content.action} `;
        if (assistantSuggestionOne) assistantSuggestionOne.textContent = content.suggestionOne;
        if (assistantSuggestionTwo) assistantSuggestionTwo.textContent = content.suggestionTwo;
        if (assistantNavLabel) assistantNavLabel.textContent = content.nav;
        if (assistantRecordLabel) assistantRecordLabel.textContent = content.recordLabel;
        if (assistantWorkspaceStatus) assistantWorkspaceStatus.textContent = content.workspaceStatus;
        if (assistantContextLabel) assistantContextLabel.textContent = content.contextLabel;
        if (assistantRowOneLabel) assistantRowOneLabel.textContent = content.rowOneLabel;
        if (assistantRowOneValue) assistantRowOneValue.textContent = content.rowOneValue;
        if (assistantRowTwoLabel) assistantRowTwoLabel.textContent = content.rowTwoLabel;
        if (assistantRowTwoValue) assistantRowTwoValue.textContent = content.rowTwoValue;
        if (assistantRowThreeLabel) assistantRowThreeLabel.textContent = content.rowThreeLabel;
        if (assistantRowThreeValue) assistantRowThreeValue.textContent = content.rowThreeValue;
        if (assistantActivityOne) assistantActivityOne.textContent = content.activityOne;
        if (assistantActivityTwo) assistantActivityTwo.textContent = content.activityTwo;
        if (assistantActivityThree) assistantActivityThree.textContent = content.activityThree;
        assistantStage?.classList.remove("is-switching");
      }, reducedMotion.matches ? 0 : 260);
    };

    assistantShowcase.dataset.assistantView = activeAssistantView;
    assistantViewControls.forEach((control) => {
      control.addEventListener("click", () => {
        renderAssistantView(control.dataset.assistantViewSelect || "attorney");
      });
    });

  }

  const resolveDashboard = (user) => {
    if (String(user?.status || "").toLowerCase() !== "approved") return "";
    if (user?.legalAcceptanceRequired === true) return "legal-acceptance.html";
    const role = String(user?.role || "").toLowerCase();
    if (role === "admin") return "admin-dashboard.html";
    if (role === "director") return "director-portal.html";
    if (role === "paralegal") return "dashboard-paralegal.html";
    if (role === "attorney") return "dashboard-attorney.html";
    return "";
  };

  const fetchCurrentUser = async () => {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      return response.ok ? payload?.user || null : null;
    } catch {
      return null;
    }
  };

  let authSyncId = 0;
  const syncAuthNavigation = async () => {
    const syncId = ++authSyncId;
    const user = await fetchCurrentUser();
    if (syncId !== authSyncId) return;
    const dashboard = resolveDashboard(user);
    const authenticated = Boolean(dashboard);
    const approvedAttorney =
      Boolean(user) &&
      user?.status === "approved" &&
      String(user?.role || "").toLowerCase() === "attorney";

    document.querySelectorAll("[data-auth-action]").forEach((link) => {
      link.textContent = authenticated ? "Dashboard" : "Sign In";
      link.href = authenticated ? dashboard : "login.html";
      if (authenticated) link.setAttribute("data-authenticated", "true");
      else link.removeAttribute("data-authenticated");
    });

    document.querySelectorAll("[data-signup-action]").forEach((link) => {
      link.hidden = authenticated;
    });

    document.querySelectorAll("[data-logout-action]").forEach((button) => {
      button.hidden = !authenticated;
    });

    document.querySelectorAll("[data-post-matter-action]").forEach((link) => {
      link.href = approvedAttorney ? "create-case.html" : "signup.html";
    });
  };

  document.addEventListener("click", async (event) => {
    const logout = event.target.closest("[data-logout-action]");
    if (!logout) return;
    event.preventDefault();
    logout.disabled = true;

    try {
      const auth = await import("./auth.js");
      const loggedOut = await auth.logout("index.html");
      if (!loggedOut) throw new Error("Logout was not confirmed by the server.");
    } catch {
      logout.disabled = false;
      logout.textContent = "Try Log Out Again";
    }
  });

  void syncAuthNavigation();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void syncAuthNavigation();
  });
  window.addEventListener("storage", () => void syncAuthNavigation());
})();
