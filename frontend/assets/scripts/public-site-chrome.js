(() => {

  "use strict";
  import('/assets/scripts/utils/row-actions-bootstrap.mjs').catch(() => {});

  const headerMarkup = `
    <header class="home-header" data-home-header data-public-header>
      <div class="home-header__inner">
        <a class="home-brand lpc-brand-lockup" href="/index.html" aria-label="Let’s-ParaConnect home"><svg class="home-brand__mountain" viewBox="7 20 50 22" fill="none" stroke="currentColor" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.25 39.63C13 39 16.8 34.1 20.1 31.5S23.9 30.4 25.2 30.2C27 29.9 30.4 25.2 32.63 22.38C35 24.3 37.8 29.3 39.2 30.6S42.9 31.5 44.7 33.4S47.7 34.8 49.9 36.7S52.9 38.9 54.8 39.4" /></svg><span class="home-brand__name">Let<span aria-hidden="true" class="home-brand__apostrophe">’</span>s-ParaConnect</span></a>
        <nav class="home-nav home-nav--desktop" aria-label="Primary navigation">
          <a href="/index.html#how">How It Works</a>
          <a href="/attorney-faq.html">For Attorneys</a>
          <a href="/paralegal-faq.html">For Paralegals</a>
          <a href="/browse-paralegals.html">Browse Paralegals</a>
        </nav>
        <div class="home-header__actions">
          <a class="header-signin" href="/login.html" data-auth-action data-public-action="text">Sign in</a>
          <button class="header-signout" type="button" data-logout-action data-public-action="text" hidden>Sign out</button>
          <a class="button button--small button--ink" href="/signup.html" data-signup-action data-public-action="primary" data-action-shape="pill" data-action-size="compact">Create an account</a>
          <button class="mobile-nav-toggle" type="button" aria-expanded="false" aria-controls="mobileNav" aria-label="Open navigation" data-mobile-nav-toggle data-public-action="icon"><span aria-hidden="true"></span><span aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="mobile-nav" id="mobileNav" aria-hidden="true" data-mobile-nav>
        <nav aria-label="Mobile navigation">
          <a href="/index.html#how">How It Works</a>
          <a href="/attorney-faq.html">For Attorneys</a>
          <a href="/paralegal-faq.html">For Paralegals</a>
          <a href="/browse-paralegals.html">Browse Paralegals</a>
        </nav>
        <div class="mobile-nav__actions">
          <a href="/login.html" data-auth-action data-public-action="text">Sign in</a>
          <button type="button" data-logout-action data-public-action="text" hidden>Sign out</button>
          <a class="button button--ink" href="/signup.html" data-signup-action data-public-action="primary" data-action-shape="pill">Create an account</a>
        </div>
      </div>
    </header>`;

  const footerMarkup = `
    <footer class="home-footer" data-public-footer>
      <div class="home-footer__inner">
        <p class="home-footer__statement"><span>Legal work.</span><span>Clearly connected.</span></p>
        <nav class="home-footer__directory" aria-label="Footer navigation">
          <details open><summary>Platform</summary><div class="home-footer__links"><a href="/index.html#how">How It Works</a><a href="/attorney-faq.html">For Attorneys</a><a href="/paralegal-faq.html">For Paralegals</a><a href="/browse-paralegals.html">Browse Paralegals</a></div></details>
          <details open><summary>For Attorneys</summary><div class="home-footer__links"><a href="/signup.html?role=attorney">Post a Matter</a><a href="/attorney-faq.html">Attorney FAQ</a><a href="/contact.html">Contact</a></div></details>
          <details open><summary>For Paralegals</summary><div class="home-footer__links"><a href="/signup.html?role=paralegal">Apply to Join</a><a href="/paralegal-faq.html">Paralegal FAQ</a><a href="/paralegal-admission.html">Our Application Review</a></div></details>
          <details open><summary>Legal</summary><div class="home-footer__links"><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="/security.html">Security &amp; Confidentiality</a><a href="/accessibility.html">Accessibility</a></div></details>
        </nav>
        <div class="home-footer__bottom">
          <div class="home-footer__identity">
            <a class="home-footer__brand lpc-brand-lockup" href="/index.html" aria-label="Let’s-ParaConnect home"><svg class="home-brand__mountain" viewBox="7 20 50 22" fill="none" stroke="currentColor" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.25 39.63C13 39 16.8 34.1 20.1 31.5S23.9 30.4 25.2 30.2C27 29.9 30.4 25.2 32.63 22.38C35 24.3 37.8 29.3 39.2 30.6S42.9 31.5 44.7 33.4S47.7 34.8 49.9 36.7S52.9 38.9 54.8 39.4" /></svg><span class="home-brand__name">Let<span aria-hidden="true" class="home-brand__apostrophe">’</span>s-ParaConnect</span></a>
            <p>Copyright © 2026 Let’s-ParaConnect. All rights reserved.</p>
          </div>
          <button type="button" class="accessibility-toggle" aria-pressed="false" aria-label="Accessibility mode" data-public-action="icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm5 7h-3v13h-2v-6h-2v6H8V9H5V7h12v2z"></path></svg><span>Accessibility</span></button>
        </div>
      </div>
    </footer>`;

  const existingHeader = document.querySelector("[data-public-header]");
  const existingFooter = document.querySelector("[data-public-footer]");
  if (existingHeader) existingHeader.outerHTML = headerMarkup;
  if (existingFooter && existingFooter.dataset.footerStatic !== "current") existingFooter.outerHTML = footerMarkup;
  document.body.classList.add("public-site-chrome");

  // Mobile footer navigation should open documents at the top, including revisits.
  document.querySelector(".home-footer__directory")?.addEventListener("click", (event) => {
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const link = event.target.closest("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destination = new URL(link.href, window.location.href);
    if (destination.origin !== window.location.origin || destination.hash) return;
    destination.hash = "top";
    event.preventDefault();
    window.location.assign(destination.href);
  });


  const header = document.querySelector("[data-home-header]");
  const toggle = document.querySelector("[data-mobile-nav-toggle]");
  const mobileNav = document.querySelector("[data-mobile-nav]");
  const setMenu = (open) => {
    if (!header || !toggle || !mobileNav) return;
    header.classList.toggle("is-open", open);
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    mobileNav.setAttribute("aria-hidden", String(!open));
    mobileNav.toggleAttribute("inert", !open);
    if (!open && document.activeElement && mobileNav.contains(document.activeElement)) {
      toggle.focus();
    }
  };
  toggle?.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
  mobileNav?.addEventListener("click", (event) => { if (event.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || toggle?.getAttribute("aria-expanded") !== "true") return;
    setMenu(false);
    toggle.focus();
  });
  window.addEventListener("resize", () => { if (window.innerWidth > 1100) setMenu(false); });
  window.addEventListener("scroll", () => header?.classList.toggle("is-scrolled", window.scrollY > 24), { passive: true });
  setMenu(false);

  const footerMedia = window.matchMedia("(max-width: 900px)");
  const syncFooter = () => document.querySelectorAll(".home-footer__directory details").forEach((item) => { item.open = !footerMedia.matches; });
  syncFooter();
  footerMedia.addEventListener?.("change", syncFooter);

  // Keep content rendered until its closing animation finishes (including WebKit).
  const accordionMedia = window.matchMedia("(max-width: 900px)");
  const animatedAccordions = Array.from(document.querySelectorAll(".home-faq details, .home-footer__directory details"));
  const accordionStates = new Map();
  const animateAccordion = (item, expanding) => {
    const state = accordionStates.get(item);
    const start = item.getBoundingClientRect().height;
    state.animation?.cancel();
    state.expanding = expanding;
    item.style.height = "";
    item.style.overflow = "hidden";
    item.open = true;
    const fullHeight = item.getBoundingClientRect().height;
    const style = getComputedStyle(item);
    const closedHeight = item.querySelector("summary").getBoundingClientRect().height +
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const finish = () => {
      item.open = expanding;
      item.style.height = "";
      item.style.overflow = "";
      state.animation = null;
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const animation = item.animate([
      { height: `${start}px` },
      { height: `${expanding ? fullHeight : closedHeight}px` },
    ], { duration: 380, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
    state.animation = animation;
    animation.onfinish = finish;
    item.dispatchEvent(new Event("lpc-accordion-motion"));
  };
  animatedAccordions.forEach((item) => {
    const state = { animation: null, expanding: item.open, name: item.getAttribute("name") };
    accordionStates.set(item, state);
    const sync = () => {
      state.animation?.cancel();
      state.animation = null;
      item.style.height = "";
      item.style.overflow = "";
      item.classList.toggle("mobile-smooth-accordion", accordionMedia.matches);
      if (state.name) {
        if (accordionMedia.matches) item.removeAttribute("name");
        else item.setAttribute("name", state.name);
      }
    };
    sync();
    accordionMedia.addEventListener?.("change", sync);
    item.querySelector("summary")?.addEventListener("click", (event) => {
      if (!accordionMedia.matches || event.defaultPrevented) return;
      event.preventDefault();
      const expanding = state.animation ? !state.expanding : !item.open;
      if (expanding && state.name) animatedAccordions.forEach((other) => {
        const otherState = accordionStates.get(other);
        if (other !== item && otherState.name === state.name && other.open &&
            (!otherState.animation || otherState.expanding)) animateAccordion(other, false);
      });
      animateAccordion(item, expanding);
    });
  });

  // Follow the expanding list each frame so scrolling ends with the expansion.
  document.querySelectorAll(".home-footer__directory details").forEach((category) => {
    let revealFrame = 0;
    const scheduleReveal = () => {
      window.cancelAnimationFrame(revealFrame);
      const reveal = () => {
        revealFrame = 0;
        const state = accordionStates.get(category);
        if (!category.open || !accordionMedia.matches || (state.animation && !state.expanding)) return;
        const viewport = window.visualViewport;
        const viewportTop = viewport?.offsetTop || 0;
        const viewportBottom = viewportTop + (viewport?.height || window.innerHeight) - 16;
        const headerBottom = document.querySelector(".home-header")?.getBoundingClientRect().bottom || 0;
        const topLimit = Math.max(viewportTop, headerBottom) + 12;
        const bounds = category.getBoundingClientRect();
        const distance = Math.min(bounds.bottom - viewportBottom, bounds.top - topLimit);
        if (distance > 0) window.scrollBy({ top: distance, behavior: "instant" });
        if (state.animation && state.expanding) revealFrame = window.requestAnimationFrame(reveal);
      };
      revealFrame = window.requestAnimationFrame(reveal);
    };
    category.addEventListener("toggle", scheduleReveal);
    category.addEventListener("lpc-accordion-motion", scheduleReveal);
  });


  const dashboardFor = (user) => {
    if (String(user?.status || "").toLowerCase() !== "approved") return "";
    const role = String(user?.role || "").toLowerCase();
    if (role === "attorney") return "/dashboard-attorney.html";
    if (role === "paralegal") return "/dashboard-paralegal.html";
    if (role === "admin") return "/admin-dashboard.html";
    if (role === "director") return "/director-portal.html";
    return "";
  };

  const syncAuth = async () => {
    let user = null;
    try {
      const response = await fetch("/api/auth/me", { credentials: "include", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) user = payload?.user || null;
    } catch {
      user = null;
    }
    const dashboard = dashboardFor(user);
    document.querySelectorAll("[data-auth-action]").forEach((link) => { link.textContent = dashboard ? "Dashboard" : "Sign in"; link.href = dashboard || "/login.html"; });
    document.querySelectorAll("[data-signup-action]").forEach((link) => { link.hidden = Boolean(dashboard); });
    document.querySelectorAll("[data-logout-action]").forEach((button) => { button.hidden = !dashboard; });
  };
  void syncAuth();

  document.querySelectorAll("[data-logout-action]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const auth = await import("./auth.js");
      const loggedOut = await auth.logout("index.html");
      if (!loggedOut) throw new Error("Logout was not confirmed.");
    } catch {
      button.disabled = false;
      button.textContent = "Try signing out again";
    }
  }));
})();
