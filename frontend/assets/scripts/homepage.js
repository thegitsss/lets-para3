(() => {
  "use strict";

  const header = document.querySelector("[data-home-header]");
  const headerHero = document.querySelector(".editorial-hero");
  const mobileToggle = document.querySelector("[data-mobile-nav-toggle]");
  const mobileNav = document.querySelector("[data-mobile-nav]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  // iOS browser chrome can resize the viewport during a swipe. Keep the
  // long pinned workflow stable until the layout width changes (rotation).
  const mobileScrollViewport = window.matchMedia("(max-width: 640px) and (pointer: coarse)");
  let mobileScrollWidth = 0;
  const syncMobileScrollViewport = () => {
    if (!mobileScrollViewport.matches) {
      document.documentElement.style.removeProperty("--mobile-scroll-vh");
      mobileScrollWidth = 0;
      return;
    }
    if (mobileScrollWidth === window.innerWidth) return;
    mobileScrollWidth = window.innerWidth;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;width:0;height:100svh;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height || window.innerHeight;
    probe.remove();
    document.documentElement.style.setProperty("--mobile-scroll-vh", `${height / 100}px`);
  };
  syncMobileScrollViewport();
  window.addEventListener("resize", syncMobileScrollViewport, { passive: true });
  mobileScrollViewport.addEventListener("change", syncMobileScrollViewport);

  const footerDirectoryMedia = window.matchMedia("(max-width: 900px)");
  const footerDirectories = Array.from(document.querySelectorAll(".home-footer__directory details"));
  const syncFooterDirectories = () => {
    footerDirectories.forEach((directory) => {
      directory.open = !footerDirectoryMedia.matches;
    });
  };

  syncFooterDirectories();
  footerDirectoryMedia.addEventListener?.("change", syncFooterDirectories);

  const syncHeaderSurface = () => {
    if (!header) return;
    const fadeDistance = Math.max(280, Math.min(420, window.innerHeight * 0.4));
    const progress = clamp(window.scrollY / fadeDistance);
    const editorialHero = document.body.classList.contains("lpc-home--editorial");
    const useInkForeground = editorialHero || progress >= 0.52;
    header.style.setProperty("--header-surface-alpha", (progress * 0.94).toFixed(3));
    header.style.setProperty("--header-surface-blur", `${(progress * 16).toFixed(2)}px`);
    header.style.setProperty("--header-foreground", useInkForeground ? "rgb(26, 34, 48)" : "rgb(255, 255, 255)");
    header.classList.toggle("has-ink", useInkForeground);
    header.classList.toggle("is-scrolled", progress >= 0.98);
    header.classList.toggle("is-past-hero", !!headerHero &&
      headerHero.getBoundingClientRect().bottom <= header.getBoundingClientRect().bottom);
  };

  syncHeaderSurface();
  window.addEventListener("scroll", syncHeaderSurface, { passive: true });
  window.addEventListener("resize", syncHeaderSurface);

  const editorialDetails = document.querySelector(".editorial-hero__details");
  let editorialParallaxFrame = 0;
  const syncEditorialParallax = () => {
    editorialParallaxFrame = 0;
    if (!editorialDetails) return;
    const motionDisabled = reducedMotion.matches || document.body.classList.contains("accessibility-mode");
    const progress = motionDisabled ? 0 : clamp(window.scrollY / Math.max(1, window.innerHeight * 0.52));
    editorialDetails.style.setProperty("--editorial-copy-x", `${(24 * progress).toFixed(1)}px`);
    editorialDetails.style.setProperty("--editorial-copy-y", `${(145 * progress).toFixed(1)}px`);
    editorialDetails.style.setProperty("--editorial-actions-x", `${(-34 * progress).toFixed(1)}px`);
    editorialDetails.style.setProperty("--editorial-actions-y", `${(245 * progress).toFixed(1)}px`);
    editorialDetails.style.setProperty("--editorial-note-x", `${(44 * progress).toFixed(1)}px`);
    editorialDetails.style.setProperty("--editorial-note-y", `${(345 * progress).toFixed(1)}px`);
    editorialDetails.style.setProperty("--editorial-copy-rotate", `${(0.7 * progress).toFixed(2)}deg`);
    editorialDetails.style.setProperty("--editorial-actions-rotate", `${(-1.3 * progress).toFixed(2)}deg`);
    editorialDetails.style.setProperty("--editorial-depth-scale", (1 + (progress * 0.075)).toFixed(4));
  };
  const scheduleEditorialParallax = () => {
    if (editorialParallaxFrame) return;
    editorialParallaxFrame = window.requestAnimationFrame(syncEditorialParallax);
  };
  window.addEventListener("scroll", scheduleEditorialParallax, { passive: true });
  window.addEventListener("resize", scheduleEditorialParallax, { passive: true });
  reducedMotion.addEventListener("change", scheduleEditorialParallax);
  new MutationObserver(scheduleEditorialParallax).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
  syncEditorialParallax();

  const lazyScrollMedia = window.matchMedia("(min-width: 900px) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
  let lazyScrollFrame = 0;
  let lazyScrollPosition = window.scrollY;
  let lazyScrollTarget = window.scrollY;

  const canNestedScrollerMove = (start, delta) => {
    for (let node = start instanceof Element ? start : null; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (!/(auto|scroll)/.test(style.overflowY) || node.scrollHeight <= node.clientHeight + 1) continue;
      if (delta < 0 && node.scrollTop > 0) return true;
      if (delta > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
    }
    return false;
  };

  const stopLazyScroll = () => {
    if (lazyScrollFrame) window.cancelAnimationFrame(lazyScrollFrame);
    lazyScrollFrame = 0;
    lazyScrollPosition = window.scrollY;
    lazyScrollTarget = window.scrollY;
    document.documentElement.classList.remove("is-lazy-scrolling");
  };

  const animateLazyScroll = () => {
    const distance = lazyScrollTarget - lazyScrollPosition;
    lazyScrollPosition += distance * 0.09;
    if (Math.abs(distance) < 0.5) {
      window.scrollTo(0, lazyScrollTarget);
      stopLazyScroll();
      return;
    }
    window.scrollTo(0, lazyScrollPosition);
    lazyScrollFrame = window.requestAnimationFrame(animateLazyScroll);
  };

  window.addEventListener("wheel", (event) => {
    if (
      !lazyScrollMedia.matches ||
      document.body.classList.contains("accessibility-mode") ||
      event.ctrlKey ||
      event.metaKey ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
      !event.deltaY ||
      canNestedScrollerMove(event.target, event.deltaY)
    ) return;

    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
    if (!lazyScrollFrame) {
      lazyScrollPosition = window.scrollY;
      lazyScrollTarget = window.scrollY;
      document.documentElement.classList.add("is-lazy-scrolling");
    }
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const requestedTarget = lazyScrollTarget + (event.deltaY * unit * 0.55);
    const maxLead = window.innerHeight * 0.75;
    lazyScrollTarget = clamp(requestedTarget, Math.max(0, lazyScrollPosition - maxLead), Math.min(maxScroll, lazyScrollPosition + maxLead));
    if (!lazyScrollFrame) lazyScrollFrame = window.requestAnimationFrame(animateLazyScroll);
  }, { passive: false });

  lazyScrollMedia.addEventListener?.("change", stopLazyScroll);
  window.addEventListener("pagehide", stopLazyScroll);

  class MatterField {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d", { alpha: true });
      this.mode = canvas.dataset.matterField || "hero";
      this.section = canvas.closest("[data-matter-field-host]") || canvas.closest("section");
      this.width = 0;
      this.height = 0;
      this.introStartTime = null;
      this.nodes = [];
      this.frameId = 0;
      this.parallaxFrameId = 0;
      this.isVisible = !("IntersectionObserver" in window);
      this.pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };

      if (!this.context || !this.section) return;

      this.resize = this.resize.bind(this);
      this.animate = this.animate.bind(this);
      this.syncAnimation = this.syncAnimation.bind(this);
      this.syncParallax = this.syncParallax.bind(this);
      this.scheduleParallax = this.scheduleParallax.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);

      if ("ResizeObserver" in window) {
        this.resizeObserver = new ResizeObserver(this.resize);
        this.resizeObserver.observe(this.section);
      } else {
        window.addEventListener("resize", this.resize, { passive: true });
      }

      this.resize();

      if ("IntersectionObserver" in window) {
        this.visibilityObserver = new IntersectionObserver((entries) => {
          this.isVisible = entries.some((entry) => entry.isIntersecting);
          this.syncAnimation();
        }, { rootMargin: "160px 0px", threshold: 0 });
        this.visibilityObserver.observe(this.section);
      }

      reducedMotion.addEventListener("change", this.syncAnimation);
      document.addEventListener("visibilitychange", this.syncAnimation);
      this.accessibilityObserver = new MutationObserver(() => {
        this.syncAnimation();
        this.scheduleParallax();
      });
      this.accessibilityObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

      if (this.mode === "hero" && window.matchMedia("(pointer: fine)").matches) {
        this.section.addEventListener("pointermove", this.onPointerMove, { passive: true });
        this.section.addEventListener("pointerleave", () => {
          this.pointer.targetX = 0;
          this.pointer.targetY = 0;
        }, { passive: true });
      }

      if (["paths", "closing"].includes(this.mode)) {
        window.addEventListener("scroll", this.scheduleParallax, { passive: true });
        window.addEventListener("resize", this.scheduleParallax, { passive: true });
        reducedMotion.addEventListener("change", this.scheduleParallax);
        this.syncParallax();
      }

      this.syncAnimation();
    }

    scheduleParallax() {
      if (this.parallaxFrameId) return;
      this.parallaxFrameId = window.requestAnimationFrame(this.syncParallax);
    }

    syncParallax() {
      this.parallaxFrameId = 0;
      if (!["paths", "closing"].includes(this.mode)) return;
      const motionDisabled = reducedMotion.matches || document.body.classList.contains("accessibility-mode");
      if (motionDisabled) {
        this.canvas.style.setProperty("--paths-field-y", "0px");
        return;
      }
      const rect = this.section.getBoundingClientRect();
      const viewportHeight = Math.max(1, window.innerHeight);
      const progress = clamp((viewportHeight - rect.top) / (viewportHeight + rect.height));
      const centered = (progress - 0.5) * 2;
      const parallaxDistance = this.mode === "paths" ? 320 : 220;
      this.canvas.style.setProperty("--paths-field-y", `${(centered * parallaxDistance).toFixed(1)}px`);
    }

    onPointerMove(event) {
      const rect = this.section.getBoundingClientRect();
      this.pointer.targetX = clamp((event.clientX - rect.left) / rect.width, 0, 1) - 0.5;
      this.pointer.targetY = clamp((event.clientY - rect.top) / rect.height, 0, 1) - 0.5;
    }

    shouldAnimate() {
      return (
        this.isVisible &&
        !reducedMotion.matches &&
        !document.body.classList.contains("accessibility-mode") &&
        document.visibilityState !== "hidden"
      );
    }

    animate(timestamp) {
      this.frameId = 0;
      if (!this.shouldAnimate()) return;
      this.render(timestamp * 0.001);
      this.frameId = window.requestAnimationFrame(this.animate);
    }

    syncAnimation() {
      if (!this.shouldAnimate()) {
        if (this.frameId) window.cancelAnimationFrame(this.frameId);
        this.frameId = 0;
        this.render(0);
        return;
      }
      if (!this.frameId) this.frameId = window.requestAnimationFrame(this.animate);
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
        const count = this.width < 680 ? 840 : this.width < 1100 ? 1200 : 1900;
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
      const count = this.width < 680 ? 32 : 58;

      this.nodes = Array.from({ length: count }, (_, index) => {
        const angle = random() * Math.PI * 2;
        const radiusX = this.width * (0.19 + random() * 0.34);
        const radiusY = this.height * (0.1 + random() * 0.22);
        const side = Math.cos(angle) >= 0 ? 1 : -1;
        const route = random();
        const featured = index < labels.length;

        if (["closing", "paths"].includes(this.mode)) {
          const closingRadiusX = this.width * (0.3 + random() * 0.19);
          const pathsFieldHeight = Math.min(this.height, Math.max(620, window.innerHeight));
          const isParallaxField = this.mode === "paths";
          const closingRadiusY = isParallaxField
            ? pathsFieldHeight * (0.2 + random() * 0.24)
            : this.height * (0.28 + random() * 0.22);
          return {
            angle,
            baseX: this.width * 0.5 + Math.cos(angle) * closingRadiusX,
            baseY: (isParallaxField ? pathsFieldHeight * 0.5 : this.height * 0.5) + Math.sin(angle) * closingRadiusY,
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
        context.font = '200 9px "Sarabun", sans-serif';
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
      if (this.introStartTime === null) this.introStartTime = time;
      const introRaw = reducedMotion.matches ? 1 : clamp((time - this.introStartTime) / 1.9);
      const intro = 1 - Math.pow(1 - introRaw, 3);
      const centerX = width * 0.5;
      const centerY = height * 0.51;
      const radius = Math.min(width * 0.47, height * 0.58);
      const narrowViewport = width < 680;
      const particleRadiusX = narrowViewport ? width * 0.54 : radius * 1.34;
      const particleRadiusY = narrowViewport ? height * 0.54 : radius * 0.9;
      const glowRadius = narrowViewport ? Math.max(width, height) * 0.58 : radius * 1.08;

      this.pointer.x += (this.pointer.targetX - this.pointer.x) * 0.045;
      this.pointer.y += (this.pointer.targetY - this.pointer.y) * 0.045;

      const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowRadius);
      glow.addColorStop(0, "rgba(36, 53, 76, 0.18)");
      glow.addColorStop(0.58, "rgba(180, 151, 90, 0.035)");
      glow.addColorStop(1, "rgba(3, 5, 7, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      const rotation = time * 0.055 + this.pointer.x * 0.34;
      const tilt = -0.22 + this.pointer.y * 0.22;
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
        const x = centerX + sphereX * particleRadiusX * spread * ringWarp + this.pointer.x * 18;
        const y = centerY + rotatedY * particleRadiusY * spread + this.pointer.y * 12;
        const pulse = 0.78 + Math.sin(time * 0.8 + node.phase) * 0.22;
        const alpha = node.alpha * perspective * intro;
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
      const isPathsField = this.mode === "paths";
      const isMobilePathsField = isPathsField && this.width <= 640;
      const positions = this.nodes.map((node) => ({
        x: node.baseX + Math.sin(time * node.speed + node.phase) * 7,
        y: node.baseY + Math.cos(time * node.speed * 0.8 + node.phase) * 5,
      }));

      positions.forEach((position, index) => {
        const next = positions[(index + 1) % positions.length];
        context.beginPath();
        context.moveTo(position.x, position.y);
        context.lineTo(next.x, next.y);
        context.strokeStyle = isPathsField
          ? `rgba(100, 149, 237, ${index % 4 === 0 ? (isMobilePathsField ? 0.52 : 0.34) : (isMobilePathsField ? 0.3 : 0.17)})`
          : `rgba(77, 89, 107, ${index % 4 === 0 ? 0.11 : 0.045})`;
        context.lineWidth = isMobilePathsField ? 0.9 : 0.65;
        context.stroke();
      });

      this.nodes.forEach((node, index) => {
        const position = positions[index];
        if (node.featured) {
          context.save();
          context.font = '200 9px "Sarabun", sans-serif';
          context.textAlign = "center";
          context.fillStyle = isPathsField
            ? `rgba(76, 124, 211, ${isMobilePathsField ? 0.9 : 0.8})`
            : "rgba(128, 101, 44, 0.52)";
          context.fillText(node.label, position.x, position.y + 17);
          context.restore();
        }
        context.beginPath();
        context.arc(position.x, position.y, node.radius, 0, Math.PI * 2);
        context.fillStyle = isPathsField
          ? (index % 5 === 0
            ? `rgba(100, 149, 237, ${isMobilePathsField ? 0.96 : 0.92})`
            : `rgba(100, 149, 237, ${isMobilePathsField ? 0.8 : 0.68})`)
          : (index % 5 === 0 ? "rgba(180, 151, 90, 0.55)" : "rgba(58, 72, 92, 0.28)");
        context.fill();
      });

    }

    render(time) {
      if (!this.context || !this.width || !this.height) return;
      this.context.clearRect(0, 0, this.width, this.height);
      if (["closing", "paths"].includes(this.mode)) this.renderClosing(time);
      else this.renderHero(time);
    }
  }

  document.querySelectorAll("[data-matter-field]").forEach((canvas) => {
    new MatterField(canvas);
  });

  const revealTargets = Array.from(document.querySelectorAll([
    ".hero-bridge__inner",
    ".workflow__intro > *",
    ".workflow-chapter",
    ".workflow-canvas-wrap",
    ".assistant-showcase__intro",
    ".assistant-stage",
    ".path-scene__copy",
    ".audience-interface",
    ".trust-band article",
    ".clarity-section__intro",
    ".fee-card",
    ".home-faq",
    ".closing-scene__content",
    ".role-action",
    ".home-footer__top > *",
  ].join(",")));

  revealTargets.forEach((element) => {
    const siblings = revealTargets.filter((candidate) => candidate.parentElement === element.parentElement);
    const siblingIndex = Math.max(0, siblings.indexOf(element));
    element.classList.add("home-reveal");
    element.style.setProperty("--home-reveal-delay", `${Math.min(siblingIndex * 80, 240)}ms`);
    element.addEventListener("focusin", () => element.classList.add("is-revealed"));
  });

  const revealReachedContentImmediately = () => {
    const viewportHeight = window.innerHeight;
    revealTargets.forEach((element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.bottom < 0 || bounds.top > viewportHeight) return;
      element.classList.add("is-revealed", "is-fast-revealed");
    });
    document.querySelectorAll("[data-scroll-scene]").forEach((scene) => {
      const bounds = scene.getBoundingClientRect();
      if (bounds.bottom < 0 || bounds.top > viewportHeight) return;
      scene.classList.add("is-fast-revealed");
    });
  };

  const revealAnchorTargetImmediately = (hash = window.location.hash) => {
    if (!hash || hash === "#") return;
    let target = null;
    try {
      target = document.querySelector(hash);
    } catch {
      return;
    }
    if (!target) return;
    revealTargets.forEach((element) => {
      if (element !== target && !target.contains(element)) return;
      element.classList.add("is-revealed", "is-fast-revealed");
    });
    const scene = target.closest("[data-scroll-scene]") || target.querySelector("[data-scroll-scene]");
    scene?.classList.add("is-fast-revealed");
  };

  let previousScrollY = window.scrollY;
  window.addEventListener("scroll", () => {
    const distance = Math.abs(window.scrollY - previousScrollY);
    if (distance > Math.max(480, window.innerHeight * 0.9)) {
      revealReachedContentImmediately();
    }
    previousScrollY = window.scrollY;
  }, { passive: true });

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest('a[href^="#"]');
    if (!anchor) return;
    revealAnchorTargetImmediately(anchor.hash);
  });
  window.addEventListener("hashchange", () => revealAnchorTargetImmediately());
  if (window.location.hash) window.requestAnimationFrame(() => revealAnchorTargetImmediately());

  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    revealTargets.forEach((element) => element.classList.add("is-revealed"));
  } else {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-revealed");
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: "40px 0px -4%", threshold: 0.01 });
    revealTargets.forEach((element) => revealObserver.observe(element));
  }

  const setMobileNav = (open) => {
    if (!header || !mobileToggle || !mobileNav) return;
    header.classList.toggle("is-open", open);
    document.body.classList.toggle("nav-open", open);
    mobileToggle.setAttribute("aria-expanded", String(open));
    mobileToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    mobileNav.setAttribute("aria-hidden", String(!open));
    mobileNav.toggleAttribute("inert", !open);

    if (!open && document.activeElement && mobileNav.contains(document.activeElement)) {
      mobileToggle.focus();
    }
  };

  setMobileNav(false);

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
  const workflowChapters = document.querySelector(".workflow-chapters");
  const workflowMobileCount = document.querySelector("[data-workflow-mobile-count]");
  const mobileWorkflowQuery = window.matchMedia("(max-width: 640px)");
  const desktopRail = desktopCanvas?.querySelector(".matter-rail");
  const mobileWorkflowStage = document.querySelector("[data-mobile-workflow-stage]");
  const mobileWorkflowStageHeading = document.querySelector(".workflow-mobile-stage__heading");
  const mobileWorkflowStageNumber = mobileWorkflowStageHeading?.querySelector(".workflow-mobile-stage__number");
  const mobileWorkflowStageTitle = mobileWorkflowStageHeading?.querySelector("h3");
  const mobileWorkflowStageCopy = mobileWorkflowStageHeading?.querySelector("p");
  let activeWorkflowState = "1";
  const mobilePreview = (source) => {
    const clone = source.cloneNode(true);
    const context = desktopCanvas?.querySelector(".product-topbar")?.cloneNode(true);
    if (context) { context.classList.add("workflow-preview-context"); clone.prepend(context); }
    return clone;
  };
  const stateForMobile = (state) => {
    const source = desktopStates.find((panel) => panel.dataset.state === state);
    const target = document.querySelector(`[data-mobile-workflow-state="${state}"]`);
    if (!source || !target || target.childElementCount) return;
    const clone = mobilePreview(source);
    clone.classList.add("is-active");
    clone.removeAttribute("aria-hidden");
    target.appendChild(clone);
  };

  ["1", "2", "3", "4", "5", "6"].forEach(stateForMobile);

  if (mobileWorkflowStage && !mobileWorkflowStage.childElementCount) {
    desktopStates.forEach((source) => {
      const clone = mobilePreview(source);
      const frame = document.createElement("div");
      frame.className = "workflow-mobile-stage__frame";
      while (clone.firstChild) frame.appendChild(clone.firstChild);
      clone.appendChild(frame);
      clone.classList.toggle("is-active", source.dataset.state === "1");
      clone.setAttribute("aria-hidden", String(source.dataset.state !== "1"));
      mobileWorkflowStage.appendChild(clone);
    });
  }

  if (desktopStates.length && mobileWorkflowStage?.querySelectorAll(".workflow-state").length === desktopStates.length) {
    document.body.classList.add("workflow-enhanced");
  }

  const fitMobileWorkflowState = () => {
    if (!mobileWorkflowQuery.matches || !mobileWorkflowStage) return;
    const panel = mobileWorkflowStage.querySelector(".workflow-state.is-active");
    const frame = panel?.querySelector(".workflow-mobile-stage__frame");
    if (!panel || !frame) return;
    frame.style.setProperty("--mobile-workflow-scale", "1");
    const availableHeight = Math.max(1, panel.clientHeight - 20);
    const naturalHeight = Math.max(1, frame.scrollHeight);
    frame.style.setProperty(
      "--mobile-workflow-scale",
      Math.min(1, availableHeight / naturalHeight).toFixed(3),
    );
  };

  window.addEventListener("resize", () => window.requestAnimationFrame(fitMobileWorkflowState));

  const updateRail = (rail, state) => {
    if (!rail) return;
    rail.dataset.matterRail = state;
    Array.from(rail.querySelectorAll(":scope > div")).forEach((step, index) => {
      step.classList.toggle("is-active", index + 1 <= Number(state));
      step.classList.toggle("is-current", index + 1 === Number(state));
    });
  };

  const setWorkflowState = (state, direction = Number(state) >= Number(activeWorkflowState) ? "down" : "up") => {
    if (!desktopCanvas) return;
    activeWorkflowState = state;
    desktopCanvas.dataset.workflowState = state;
    desktopCanvas.dataset.scrollDirection = direction;
    if (workflowChapters) workflowChapters.dataset.workflowState = state;
    document.querySelector("[data-workflow-prev]")?.toggleAttribute("disabled", state === "1");
    document.querySelector("[data-workflow-next]")?.toggleAttribute("disabled", Number(state) === chapters.length);
    if (workflowMobileCount) workflowMobileCount.textContent = `Step ${state} of ${chapters.length}`;
    if (mobileWorkflowStage) {
      mobileWorkflowStage.querySelectorAll(".workflow-state").forEach((panel) => {
        const isActive = panel.dataset.state === state;
        panel.classList.toggle("is-active", isActive);
        panel.setAttribute("aria-hidden", String(!isActive));
      });
      window.requestAnimationFrame(fitMobileWorkflowState);
    }
    const activeChapter = chapters.find((chapter) => chapter.dataset.workflowChapter === state);
    if (activeChapter && mobileWorkflowStageHeading) {
      if (mobileWorkflowStageNumber) mobileWorkflowStageNumber.textContent = String(state).padStart(2, "0");
      if (mobileWorkflowStageTitle) mobileWorkflowStageTitle.innerHTML = activeChapter.querySelector("h3")?.innerHTML || "";
      if (mobileWorkflowStageCopy) mobileWorkflowStageCopy.textContent = activeChapter.querySelector("p")?.textContent || "";
      mobileWorkflowStageHeading.classList.remove("is-changing");
      void mobileWorkflowStageHeading.offsetWidth;
      mobileWorkflowStageHeading.classList.add("is-changing");
    }
    desktopStates.forEach((panel) => {
      const isActive = panel.dataset.state === state;
      panel.classList.toggle("is-active", isActive);
      panel.setAttribute("aria-hidden", String(!isActive));
    });

    chapters.forEach((chapter, index) => {
      const chapterNumber = index + 1;
      chapter.classList.toggle("is-active", chapterNumber === Number(state));
      chapter.classList.toggle("is-complete", chapterNumber < Number(state));
    });
    updateRail(desktopRail, state);
  };

  chapters.forEach((chapter) => {
    chapter.addEventListener("focusin", () => {
      setWorkflowState(chapter.dataset.workflowChapter || "1");
    });
  });

  setWorkflowState(activeWorkflowState, "down");

  if (workflowChapters && chapters.length) {
    let workflowSwipeFrame = 0;
    let previousWorkflowScrollLeft = workflowChapters.scrollLeft;

    const centerWorkflowChapter = (chapter, behavior = "smooth") => {
      if (!chapter || !mobileWorkflowQuery.matches) return;
      const left = chapter.offsetLeft - ((workflowChapters.clientWidth - chapter.offsetWidth) / 2);
      workflowChapters.scrollTo({
        left: Math.max(0, left),
        behavior: reducedMotion.matches ? "auto" : behavior,
      });
    };

    document.querySelectorAll("[data-workflow-prev], [data-workflow-next]").forEach((button) => {
      button.addEventListener("click", () => {
        const delta = button.hasAttribute("data-workflow-next") ? 1 : -1;
        centerWorkflowChapter(chapters[clamp(Number(activeWorkflowState) - 1 + delta, 0, chapters.length - 1)]);
      });
    });

    const syncWorkflowSwipe = () => {
      workflowSwipeFrame = 0;
      if (!mobileWorkflowQuery.matches) return;
      const viewportCenter = workflowChapters.scrollLeft + (workflowChapters.clientWidth / 2);
      const direction = workflowChapters.scrollLeft >= previousWorkflowScrollLeft ? "down" : "up";
      previousWorkflowScrollLeft = workflowChapters.scrollLeft;
      const closestChapter = chapters.reduce((closest, chapter) => {
        const chapterCenter = chapter.offsetLeft + (chapter.offsetWidth / 2);
        const distance = Math.abs(viewportCenter - chapterCenter);
        return distance < closest.distance ? { chapter, distance } : closest;
      }, { chapter: chapters[0], distance: Number.POSITIVE_INFINITY }).chapter;
      const state = closestChapter.dataset.workflowChapter || "1";
      if (state !== activeWorkflowState) setWorkflowState(state, direction);
    };

    const scheduleWorkflowSwipe = () => {
      if (workflowSwipeFrame) return;
      workflowSwipeFrame = window.requestAnimationFrame(syncWorkflowSwipe);
    };

    workflowChapters.addEventListener("scroll", scheduleWorkflowSwipe, { passive: true });
    workflowChapters.addEventListener("keydown", (event) => {
      if (!mobileWorkflowQuery.matches || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = Math.max(0, chapters.findIndex((chapter) => chapter.dataset.workflowChapter === activeWorkflowState));
      const nextIndex = clamp(currentIndex + (event.key === "ArrowRight" ? 1 : -1), 0, chapters.length - 1);
      const nextChapter = chapters[nextIndex];
      setWorkflowState(nextChapter.dataset.workflowChapter || "1", event.key === "ArrowRight" ? "down" : "up");
      centerWorkflowChapter(nextChapter);
    });
    mobileWorkflowQuery.addEventListener("change", () => {
      previousWorkflowScrollLeft = workflowChapters.scrollLeft;
      if (mobileWorkflowQuery.matches) centerWorkflowChapter(chapters[Number(activeWorkflowState) - 1], "auto");
    });
    syncWorkflowSwipe();
  }

  if (chapters.length) {
    let workflowFrame = 0;
    let previousWorkflowScrollY = window.scrollY;

    const syncWorkflowState = () => {
      workflowFrame = 0;
      if (mobileWorkflowQuery.matches) return;
      const activationLine = window.innerHeight * 0.48;
      const direction = window.scrollY >= previousWorkflowScrollY ? "down" : "up";
      previousWorkflowScrollY = window.scrollY;
      let closestChapter = chapters[0];
      let closestDistance = Number.POSITIVE_INFINITY;

      chapters.forEach((chapter) => {
        const rect = chapter.getBoundingClientRect();
        const distance = activationLine < rect.top
          ? rect.top - activationLine
          : activationLine > rect.bottom
            ? activationLine - rect.bottom
            : 0;
        if (distance < closestDistance) {
          closestDistance = distance;
          closestChapter = chapter;
        }
      });

      const state = closestChapter.dataset.workflowChapter || "1";
      if (state !== activeWorkflowState) setWorkflowState(state, direction);
    };

    const scheduleWorkflowSync = () => {
      if (workflowFrame) return;
      workflowFrame = window.requestAnimationFrame(syncWorkflowState);
    };

    window.addEventListener("scroll", scheduleWorkflowSync, { passive: true });
    window.addEventListener("resize", scheduleWorkflowSync);
    syncWorkflowState();
  }

  const cinematicMotionQuery = window.matchMedia("(min-width: 1100px) and (min-height: 650px) and (prefers-reduced-motion: no-preference)");
  const cinematicSceneDefinitions = [
    {
      selector: ".hero-bridge",
      layers: [[".hero-bridge__inner", "rise", 0.08, 0.34]],
    },
    {
      selector: ".workflow__intro",
      layers: [
        [".workflow__intro-title", "lateral-left", 0.08, 0.34],
        [".workflow__intro-support", "lateral-right", 0.18, 0.44],
      ],
    },
    {
      selector: ".assistant-showcase",
      progressMode: "lower-third-section",
      exitStart: 0.98,
      exitEnd: 1,
      layers: [
        [".assistant-preview", "assistant-float", 0.64, 0.86],
      ],
    },
    {
      selector: ".paths__heading",
      layers: [
        [".eyebrow", "rise", 0.08, 0.30],
        ["h2", "depth", 0.14, 0.38],
      ],
    },
    {
      selector: ".paths-motion-stage",
      kind: "horizontal-paths",
      layers: [
        [".path-scene--attorney .path-scene__copy", "lateral-left", 0.04, 0.18],
        [".path-scene--attorney .audience-interface", "lateral-right", 0.07, 0.22],
        [".path-scene--attorney .audience-interface__topbar", "rise", 0.12, 0.24],
        [".path-scene--attorney .audience-matter", "rise", 0.17, 0.29],
        [".path-scene--attorney .audience-attention", "rise", 0.22, 0.33],
        [".path-scene--paralegal .path-scene__copy", "lateral-left", 0.43, 0.57],
        [".path-scene--paralegal .audience-interface", "lateral-right", 0.46, 0.61],
        [".path-scene--paralegal .audience-interface__topbar", "rise", 0.51, 0.63],
        [".path-scene--paralegal .available-project", "rise", 0.55, 0.66],
        [".path-scene--paralegal .active-assignment", "rise", 0.59, 0.69],
        [".path-scene--paralegal .audience-payment", "rise", 0.63, 0.72],
      ],
    },
    {
      selector: ".clarity-section",
      layers: [
        [".clarity-section__intro", "rise", 0.02, 0.12],
        [".fee-card", "lateral-right", 0.04, 0.14],
        [".fee-card__row:nth-of-type(1)", "rise", 0.07, 0.16],
        [".fee-card__row:nth-of-type(2)", "rise", 0.08, 0.17],
        [".fee-card__row:nth-of-type(3)", "rise", 0.09, 0.18],
      ],
    },
    {
      selector: ".closing-scene",
      layers: [
        [".closing-scene__content > .eyebrow", "rise", 0.08, 0.28],
        [".closing-scene__content > h2", "depth", 0.14, 0.36],
        [".closing-scene__content > p:not(.eyebrow)", "rise", 0.22, 0.42],
        [".role-actions", "rise", 0.30, 0.54],
      ],
    },
  ];
  const cinematicMotionProfiles = {
    rise: { x: 0, y: 72, scale: 0.98, rotate: 0, exitX: 0, exitY: -52 },
    "lateral-left": { x: 0, y: 64, scale: 0.975, rotate: 0, exitX: 0, exitY: -28 },
    "lateral-right": { x: 0, y: 64, scale: 0.975, rotate: 0, exitX: 0, exitY: -28 },
    depth: { x: 0, y: 110, scale: 0.92, rotate: 2.4, exitX: 0, exitY: -62 },
    card: { x: 0, y: 86, scale: 0.94, rotate: 0, exitX: 0, exitY: -48 },
    "assistant-float": { x: 0, y: 56, scale: 0.975, rotate: 0, exitX: 0, exitY: 0 },
  };
  let cinematicScenes = [];
  let cinematicFrame = 0;
  let cinematicAccessibilityMode = document.body.classList.contains("accessibility-mode");
  const cinematicResizeObserver = "ResizeObserver" in window
    ? new ResizeObserver(() => {
      cinematicScenes.forEach((scene) => {
        scene.top = documentOffsetTop(scene.element);
        scene.height = Math.max(1, scene.element.offsetHeight);
      });
      scheduleCinematicMotion();
    })
    : null;

  const smoothProgress = (start, end, value) => {
    const progress = clamp((value - start) / Math.max(0.001, end - start));
    return progress * progress * (3 - (2 * progress));
  };

  const documentOffsetTop = (element) => {
    let top = 0;
    for (let node = element; node; node = node.offsetParent) top += node.offsetTop;
    return top;
  };

  const clearCinematicMotion = () => {
    document.body.classList.remove("home-cinematic-motion");
    cinematicResizeObserver?.disconnect();
    cinematicScenes.forEach(({ element, layers }) => {
      element.removeAttribute("data-scroll-scene");
      element.classList.remove("is-fast-revealed");
      element.style.removeProperty("--motion-progress");
      element.style.removeProperty("--motion-enter");
      element.style.removeProperty("--motion-exit");
      element.style.removeProperty("--motion-reveal-inset");
      element.style.removeProperty("--paths-attorney-x");
      element.style.removeProperty("--paths-attorney-scale");
      element.style.removeProperty("--paths-paralegal-x");
      element.style.removeProperty("--paths-paralegal-scale");
      element.style.removeProperty("--assistant-launch-progress");
      element.style.removeProperty("--assistant-launch-scale");
      element.style.removeProperty("--assistant-chat-progress");
      element.style.removeProperty("--assistant-chat-x");
      element.style.removeProperty("--assistant-chat-scale");
      element.style.removeProperty("--assistant-chat-clip");
      element.style.removeProperty("--assistant-workspace-scale");
      element.style.removeProperty("--assistant-workspace-dim");
      element.style.removeProperty("--assistant-deadline-highlight");
      element.style.removeProperty("--assistant-assigned-highlight");
      layers.forEach(({ element: layer }) => {
        layer.removeAttribute("data-motion-layer");
        layer.style.removeProperty("--motion-layer-progress");
        layer.style.removeProperty("--motion-layer-x");
        layer.style.removeProperty("--motion-layer-y");
        layer.style.removeProperty("--motion-layer-scale");
        layer.style.removeProperty("--motion-layer-rotate");
        layer.style.removeProperty("--motion-layer-opacity");
      });
    });
    cinematicScenes = [];
  };

  const syncCinematicMotion = () => {
    cinematicFrame = 0;
    if (!cinematicScenes.length) return;
    const viewportHeight = window.innerHeight;
    const scrollPosition = window.scrollY;

    cinematicScenes.forEach((scene) => {
      const top = scene.top;
      const height = scene.height;
      const targetProgress = scene.progressMode === "lower-third-section"
        ? clamp(
          (scrollPosition - (top - (viewportHeight * (2 / 3)))) /
          Math.max(1, (top + height - viewportHeight) - (top - (viewportHeight * (2 / 3))))
        )
        : clamp((scrollPosition + viewportHeight - top) / (height + viewportHeight));
      const progress = targetProgress;
      const progressValue = Number(progress.toFixed(4));
      if (scene.progress === progressValue) return;
      scene.progress = progressValue;
      const enter = smoothProgress(0.04, 0.34, progress);
      const exit = smoothProgress(scene.exitStart, scene.exitEnd, progress);
      scene.element.style.setProperty("--motion-progress", progress.toFixed(4));
      scene.element.style.setProperty("--motion-enter", enter.toFixed(4));
      scene.element.style.setProperty("--motion-exit", exit.toFixed(4));
      scene.element.style.setProperty("--motion-reveal-inset", `${((1 - enter) * 100).toFixed(2)}%`);
      if (scene.kind === "horizontal-paths") {
        const horizontalProgress = smoothProgress(0.40, 0.64, progress);
        scene.element.style.setProperty("--paths-attorney-x", `${(-104 * horizontalProgress).toFixed(3)}%`);
        scene.element.style.setProperty("--paths-attorney-scale", (1 - (horizontalProgress * 0.035)).toFixed(4));
        scene.element.style.setProperty("--paths-paralegal-x", `${(104 * (1 - horizontalProgress)).toFixed(3)}%`);
        scene.element.style.setProperty("--paths-paralegal-scale", (0.965 + (horizontalProgress * 0.035)).toFixed(4));
      }
      if (scene.kind === "assistant-sequence") {
        const launcherProgress = smoothProgress(0.22, 0.29, progress);
        const chatProgress = smoothProgress(0.28, 0.38, progress);
        const deadlineHighlight = smoothProgress(0.41, 0.49, progress);
        scene.element.style.setProperty("--assistant-launch-progress", launcherProgress.toFixed(4));
        scene.element.style.setProperty("--assistant-launch-scale", (1 + (launcherProgress * 0.16)).toFixed(4));
        scene.element.style.setProperty("--assistant-chat-progress", chatProgress.toFixed(4));
        scene.element.style.setProperty("--assistant-chat-x", `${((1 - chatProgress) * 100).toFixed(2)}%`);
        scene.element.style.setProperty("--assistant-chat-scale", "1");
        scene.element.style.setProperty("--assistant-chat-clip", "0%");
        scene.element.style.setProperty("--assistant-workspace-scale", "1");
        scene.element.style.setProperty("--assistant-workspace-dim", (chatProgress * 0.08).toFixed(4));
        scene.element.style.setProperty("--assistant-deadline-highlight", deadlineHighlight.toFixed(4));
        scene.element.style.setProperty("--assistant-assigned-highlight", "0");
      }
      scene.layers.forEach((layer) => {
        const layerProgress = smoothProgress(layer.start, layer.end, progress);
        const profile = cinematicMotionProfiles[layer.type] || cinematicMotionProfiles.rise;
        const remaining = 1 - layerProgress;
        const x = (profile.x * remaining) + (profile.exitX * exit);
        const y = (profile.y * remaining) + (profile.exitY * exit);
        const scale = 1 - (remaining * (1 - profile.scale)) - (exit * 0.016);
        const rotate = (profile.rotate * remaining) - (profile.rotate * exit * 0.35);
        const opacity = clamp(layerProgress);
        layer.element.style.setProperty("--motion-layer-progress", layerProgress.toFixed(4));
        layer.element.style.setProperty("--motion-layer-x", `${x.toFixed(2)}px`);
        layer.element.style.setProperty("--motion-layer-y", `${y.toFixed(2)}px`);
        layer.element.style.setProperty("--motion-layer-scale", scale.toFixed(4));
        layer.element.style.setProperty("--motion-layer-rotate", `${rotate.toFixed(3)}deg`);
        layer.element.style.setProperty("--motion-layer-opacity", opacity.toFixed(4));
      });
    });

  };

  const scheduleCinematicMotion = () => {
    if (cinematicFrame) return;
    cinematicFrame = window.requestAnimationFrame(syncCinematicMotion);
  };

  const configureCinematicMotion = () => {
    if (
      !cinematicMotionQuery.matches ||
      document.body.classList.contains("accessibility-mode")
    ) {
      clearCinematicMotion();
      return;
    }

    clearCinematicMotion();
    cinematicScenes = cinematicSceneDefinitions.map((definition) => {
      const element = document.querySelector(definition.selector);
      if (!element) return null;
      element.setAttribute("data-scroll-scene", "");
      const layers = definition.layers.flatMap(([selector, type, start, end]) =>
        Array.from(element.querySelectorAll(selector)).map((layer) => {
          layer.setAttribute("data-motion-layer", type);
          return { element: layer, type, start, end };
        }));
      return {
        element,
        layers,
        kind: definition.kind || "standard",
        progressMode: definition.progressMode || "viewport",
        exitStart: definition.exitStart ?? 0.78,
        exitEnd: definition.exitEnd ?? 0.98,
        top: documentOffsetTop(element),
        height: Math.max(1, element.offsetHeight),
        progress: null,
      };
    }).filter(Boolean);
    cinematicScenes.forEach((scene) => cinematicResizeObserver?.observe(scene.element));
    document.body.classList.add("home-cinematic-motion");
    syncCinematicMotion();
  };

  window.addEventListener("scroll", scheduleCinematicMotion, { passive: true });
  window.addEventListener("resize", scheduleCinematicMotion);
  window.addEventListener("load", scheduleCinematicMotion, { once: true });
  cinematicMotionQuery.addEventListener("change", configureCinematicMotion);
  new MutationObserver(() => {
    const accessibilityMode = document.body.classList.contains("accessibility-mode");
    if (accessibilityMode === cinematicAccessibilityMode) return;
    cinematicAccessibilityMode = accessibilityMode;
    configureCinematicMotion();
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
  configureCinematicMotion();

  const resolveDashboard = (user) => {
    if (String(user?.status || "").toLowerCase() !== "approved") return "";
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
      link.textContent = authenticated ? "Dashboard" : "Sign in";
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
      logout.textContent = "Try signing out again";
    }
  });

  void syncAuthNavigation();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void syncAuthNavigation();
  });
  window.addEventListener("storage", () => void syncAuthNavigation());
})();
