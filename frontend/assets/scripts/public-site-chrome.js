(() => {
  "use strict";

  const headerMarkup = `
    <header class="home-header" data-home-header data-public-header>
      <div class="home-header__inner">
        <a class="home-brand" href="/index.html" aria-label="Let’s-ParaConnect home">Let<span aria-hidden="true" class="home-brand__apostrophe">’</span>s-ParaConnect</a>
        <nav class="home-nav home-nav--desktop" aria-label="Primary navigation">
          <a href="/index.html#how">How It Works</a>
          <a href="/index.html#for-attorneys">For Attorneys</a>
          <a href="/index.html#for-paralegals">For Paralegals</a>
          <a href="/browse-paralegals.html">Browse Paralegals</a>
        </nav>
        <div class="home-header__actions">
          <a class="header-signin" href="/login.html" data-auth-action data-public-action="text">Sign In</a>
          <button class="header-signout" type="button" data-logout-action data-public-action="text" hidden>Log Out</button>
          <a class="button button--small button--ink" href="/signup.html" data-signup-action data-public-action="primary" data-action-shape="pill" data-action-size="compact">Create an account</a>
          <button class="mobile-nav-toggle" type="button" aria-expanded="false" aria-controls="mobileNav" aria-label="Open navigation" data-mobile-nav-toggle data-public-action="icon"><span aria-hidden="true"></span><span aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="mobile-nav" id="mobileNav" aria-hidden="true" data-mobile-nav>
        <nav aria-label="Mobile navigation">
          <a href="/index.html#how">How It Works</a>
          <a href="/index.html#for-attorneys">For Attorneys</a>
          <a href="/index.html#for-paralegals">For Paralegals</a>
          <a href="/browse-paralegals.html">Browse Paralegals</a>
        </nav>
        <div class="mobile-nav__actions">
          <a href="/login.html" data-auth-action data-public-action="text">Sign In</a>
          <button type="button" data-logout-action data-public-action="text" hidden>Log Out</button>
          <a class="button button--ink" href="/signup.html" data-signup-action data-public-action="primary" data-action-shape="pill">Create an account</a>
        </div>
      </div>
    </header>`;

  const footerMarkup = `
    <footer class="home-footer" data-public-footer>
      <div class="home-footer__inner">
        <p class="home-footer__statement"><span>Legal work.</span><span>Clearly connected.</span></p>
        <nav class="home-footer__directory" aria-label="Footer navigation">
          <details open><summary>Platform</summary><div class="home-footer__links"><a href="/index.html#how">How It Works</a><a href="/index.html#for-attorneys">For Attorneys</a><a href="/index.html#for-paralegals">For Paralegals</a><a href="/browse-paralegals.html">Browse Paralegals</a></div></details>
          <details open><summary>For Attorneys</summary><div class="home-footer__links"><a href="/signup.html?role=attorney">Post a Matter</a><a href="/attorney-faq.html">Attorney FAQ</a><a href="/contact.html">Contact</a></div></details>
          <details open><summary>For Paralegals</summary><div class="home-footer__links"><a href="/signup.html?role=paralegal">Apply to Join</a><a href="/paralegal-faq.html">Paralegal FAQ</a><a href="/paralegal-admission.html">Our Vetting Process</a></div></details>
          <details open><summary>Legal</summary><div class="home-footer__links"><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="/accessibility.html">Accessibility</a></div></details>
        </nav>
        <div class="home-footer__bottom">
          <a class="home-footer__brand" href="/index.html" aria-label="Let’s-ParaConnect home">Let<span aria-hidden="true" class="home-brand__apostrophe">’</span>s-ParaConnect</a>
          <p>Copyright © 2026 Let’s-ParaConnect. All rights reserved.</p>
          <button type="button" class="accessibility-toggle" aria-pressed="false" aria-label="Accessibility mode" data-public-action="icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm5 7h-3v13h-2v-6h-2v6H8V9H5V7h12v2z"></path></svg><span>Accessibility</span></button>
        </div>
      </div>
    </footer>`;

  const existingHeader = document.querySelector("[data-public-header]");
  const existingFooter = document.querySelector("[data-public-footer]");
  if (existingHeader) existingHeader.outerHTML = headerMarkup;
  if (existingFooter) existingFooter.outerHTML = footerMarkup;
  document.body.classList.add("public-site-chrome");

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
  window.addEventListener("resize", () => { if (window.innerWidth > 960) setMenu(false); });
  window.addEventListener("scroll", () => header?.classList.toggle("is-scrolled", window.scrollY > 24), { passive: true });
  setMenu(false);

  const footerMedia = window.matchMedia("(max-width: 734px)");
  const syncFooter = () => document.querySelectorAll(".home-footer__directory details").forEach((item) => { item.open = !footerMedia.matches; });
  syncFooter();
  footerMedia.addEventListener?.("change", syncFooter);

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
    document.querySelectorAll("[data-auth-action]").forEach((link) => { link.textContent = dashboard ? "Dashboard" : "Sign In"; link.href = dashboard || "/login.html"; });
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
      button.textContent = "Try Log Out Again";
    }
  }));
})();
