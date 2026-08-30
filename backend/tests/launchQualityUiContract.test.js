const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Prompt 5 launch-quality UI contracts", () => {
  test("the login surface is explicitly exempt from the authenticated-page guard", () => {
    const html = read("frontend/login.html");
    expect(html).toMatch(/<body[^>]*data-public-page="true"/);
  });

  test("shared public UI honors reduced-motion preferences and the accessibility override", () => {
    const sharedStyles = read("frontend/assets/styles/styles.css");
    expect(sharedStyles).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(sharedStyles).toMatch(/html\.accessibility-mode[\s\S]*scroll-behavior: auto !important/);
    expect(sharedStyles).toMatch(/animation-duration: 0\.01ms !important/);
  });

  test("attention cues stop without requiring interaction", () => {
    const profileSettings = read("frontend/profile-settings.html");
    const attorneyDashboard = read("frontend/dashboard-attorney.html");
    expect(profileSettings).not.toMatch(/animation:\s*(?:onboardingPulse|scrollCueDrift)[^;]*\binfinite\b/);
    expect(attorneyDashboard).not.toMatch(/animation:\s*(?:onboardingPulse|hirePulse)[^;]*\binfinite\b/);
  });

  test("homepage motion is viewport-aware and honors reduced motion", () => {
    const html = read("frontend/index.html");
    const script = read("frontend/assets/scripts/homepage.js");
    const styles = read("frontend/assets/styles/homepage.css");
    const hybridStyles = read("frontend/assets/styles/homepage-hybrid.css");
    const fonts = read("frontend/assets/styles/fonts.css");
    const heroMarkup = html.slice(
      html.indexOf('<section class="editorial-hero"'),
      html.indexOf('<section class="workflow"')
    );
    expect(html).not.toMatch(/hero-product|hero__matter-axis/);
    expect(heroMarkup).toContain("For solo and small-firm attorneys");
    expect(heroMarkup).toContain("Your caseload grew.");
    expect(heroMarkup).toContain("Your payroll doesn’t have to.");
    expect(heroMarkup).toContain("Publish free. Fund only when you hire.");
    expect(heroMarkup).not.toMatch(/<(?:img|canvas|svg)\b/);
    expect(fonts).toMatch(/font-family: 'Sarabun';[\s\S]{0,120}font-style: italic;[\s\S]{0,120}font-weight: 200/);
    expect(hybridStyles).toMatch(/editorial-hero-word-enter/);
    expect(hybridStyles).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.lpc-home--editorial/);
    expect(script).toMatch(/requestAnimationFrame/);
    expect(script).toMatch(/IntersectionObserver/);
    expect(script).toMatch(/configureCinematicMotion/);
    expect(script).toMatch(/cinematicResizeObserver/);
    expect(script).toMatch(/shouldAnimate\(\)/);
    expect(script).toMatch(/!reducedMotion\.matches/);
    expect(script).toMatch(/document\.visibilityState !== "hidden"/);
    expect(script).toMatch(/this\.render\(0\)/);
    expect(styles).toMatch(/\.home-reveal\.is-revealed/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.js \.home-reveal/);
    expect(styles).not.toMatch(/hero-product|hero__matter-axis|--hero-(?:copy|product|white|handoff)/);
  });

  test("Profile mobile navigation is derived from the authenticated viewer role", () => {
    const html = read("frontend/profile-paralegal.html");
    const script = read("frontend/assets/scripts/profile-paralegal.js");
    expect(html).toMatch(/data-profile-mobile-nav="home"/);
    expect(html).toMatch(/data-profile-mobile-nav="browse"/);
    expect(html).toMatch(/data-profile-mobile-nav="matters"/);
    expect(script).toMatch(/function hydrateMobileNavigation/);
    expect(script).toMatch(/state\.viewerRole === "attorney"/);
    expect(script).toMatch(/Browse Paralegals[\s\S]*dashboard-attorney\.html#cases/);
    expect(script).toMatch(/Browse Matters[\s\S]*dashboard-paralegal\.html#cases/);
    expect(script).toMatch(/Boolean\(payload\?\.hasDefault \|\| payload\?\.paymentMethod\)/);
  });

  test("Matter skip navigation opens only an authorized Messages tab", () => {
    const html = read("frontend/case-detail.html");
    const script = read("frontend/assets/scripts/case-detail.js");
    expect(html).toMatch(/id="matterMessagesSkipLink" hidden>Skip to Matter messages/);
    expect(html).toMatch(/id="case-messages"[^>]*tabindex="-1"/);
    expect(script).toMatch(/matterMessagesSkipLink\.hidden = !allowed\.has\("messages"\)/);
    expect(script).toMatch(/state\.availableMatterTabs\.has\("messages"\)[\s\S]*activateMatterTab\("messages"/);
  });

  test("consequential Matter dialogs trap and restore focus and keep Escape active", () => {
    const script = read("frontend/assets/scripts/case-detail.js");
    expect(script).toMatch(/const popupFocusState = new WeakMap/);
    expect(script).toMatch(/function bindPopupEscape/);
    expect(script).toMatch(/event\.key !== "Tab"/);
    expect(script).toMatch(/focusState\.priorFocus\.focus/);
    expect(script).toMatch(/data-complete-cancel data-popup-initial/);
    expect(script).toMatch(/data-withdraw-cancel data-popup-initial/);
    expect(script).not.toMatch(/if \(event\.key === "Escape"\)[\s\S]{0,100}\{ once: true \}/);
  });

  test("Create Matter exposes required state and associates field errors", () => {
    const html = read("frontend/create-case.html");
    expect(html).toMatch(/Matter Title <span class="field-requirement">Required/);
    expect(html).toMatch(/id="caseDescription"[^>]*required/);
    expect(html).toMatch(/id="caseTaskInput"[^>]*aria-describedby="caseTaskHelper"/);
    expect(html).toMatch(/error\.id = `\$\{field\.id \|\| "field"\}-error`/);
    expect(html).toMatch(/field\.setAttribute\("aria-describedby"/);
    expect(html).toMatch(/Describe the Matter, its goals, and the expected deliverables/);
    expect(html).toMatch(/parseCompAmount\(value\) >= 400/);
    expect(html).toMatch(/Enter a compensation amount of at least \$400\./);
    expect(html).not.toContain("/api/payments/payment-method/default");
    expect(html).not.toContain("hasDefaultPaymentMethod");
    expect(html).not.toContain('"Add a payment method in Payments before posting a Matter."');
    expect(html).not.toContain('"Open Billing"');
  });

  test("Browse and completed-Matter recovery paths are durable", () => {
    const dashboard = read("frontend/dashboard-paralegal.html");
    const dashboardScript = read("frontend/assets/scripts/paralegal-dashboard.js");
    const browseScript = read("frontend/assets/scripts/views/browse-jobs.js");
    const registry = require("../../frontend/assets/scripts/productivity-command-registry.js");
    expect(dashboardScript).toMatch(/browse-jobs\.html\?caseId=/);
    expect(dashboard).toMatch(/completedMattersRequested \? "#cases-completed" : "#cases"/);
    expect(dashboard).toMatch(/data-retry-active-matters/);
    expect(dashboard).toMatch(/data-retry-completed-matters/);
    expect(browseScript).toMatch(/Available Matters could not be loaded/);
    expect(browseScript).toMatch(/retry\.textContent = "Retry"/);
    expect(registry.resolveCommand("paralegal.completed_matters", { role: "paralegal" })).toEqual(
      expect.objectContaining({ href: "/dashboard-paralegal.html#cases-completed", navigationOnly: true })
    );
  });

  test("customer-facing terminology stays aligned to the Matter product model", () => {
    const attorneyDashboard = read("frontend/dashboard-attorney.html");
    const paralegalDashboard = read("frontend/dashboard-paralegal.html");
    const paralegalFaq = read("frontend/paralegal-faq.html");
    const paralegalHelp = read("frontend/paralegalhelp.html");
    const browseParalegals = read("frontend/assets/scripts/browse-paralegals.js");
    const attorneyTour = read("frontend/assets/scripts/attorney-dashboard.js");
    const supportDrawer = read("frontend/assets/scripts/utils/support-drawer.js");
    const attorneySupportTools = read("backend/ai/supportAgentTools.js");
    const paralegalSupportTools = read("backend/ai/paralegalSupportAgentTools.js");
    const conversationService = read("backend/services/support/conversationService.js");

    expect(attorneyDashboard).toMatch(/Completed Matters/);
    expect(attorneyDashboard).not.toMatch(/Completed Jobs|No completed jobs/i);
    expect(paralegalDashboard).toMatch(/Search by Matter title or practice area/);
    expect(paralegalFaq).toMatch(/which Matters to apply for|Matter compensation handled/);
    expect(paralegalHelp).toMatch(/Browse Matters|My Matters & Applications|Working a Matter|Matter workspace/);
    expect(browseParalegals).toMatch(/No open Matters are available\. Create a Matter/);
    expect(browseParalegals).toMatch(/Invite to matter|Select an open Matter/);
    expect(attorneyTour).toMatch(/Fund Matters|Create a Matter|invite the right fit to your Matter/);
    expect(supportDrawer).toMatch(/Ask about a Matter|Where can I see my Matters/);
    expect(attorneySupportTools).toMatch(/ctaLabel: "Post a Matter"/);
    expect(paralegalSupportTools).toMatch(/ctaLabel: "My Matters & Applications"/);
    expect(conversationService).toMatch(/ctaLabel: "Browse Matters"/);
    expect(conversationService).toMatch(/inside each Matter workspace/);
    expect(conversationService).not.toMatch(/(?:ctaLabel|label): "(?:Browse cases|Cases|Cases & Files|Cases and Applications|Case workspace|Open case|View cases|Completed cases)"/);
  });

  test("Application dialog has an accessible name, bounded input, focus containment, and confirmed title", () => {
    const script = read("frontend/assets/scripts/views/browse-jobs.js");
    expect(script).toMatch(/aria-labelledby="jobApplyTitle" aria-describedby="jobApplyHelp"/);
    expect(script).toMatch(/maxlength="\$\{APPLY_MAX_CHARS\}"/);
    expect(script).toMatch(/function trapDialogFocus/);
    expect(script).toMatch(/const submittedTitle = currentApplyJob\?\.title/);
    expect(script).toMatch(/closeApplyModal\(\{ restoreFocus: false \}\)/);
    expect(script).not.toMatch(/applyTitle\.textContent = `Apply to \$\{escapeHtml/);
  });

  test("Matter files expose quarantine states instead of presenting unsafe actions", () => {
    const html = read("frontend/case-detail.html");
    const script = read("frontend/assets/scripts/case-detail.js");
    const fileView = read("frontend/assets/scripts/case-files-view.js");
    expect(script).toMatch(/function getFileSecurityPresentation/);
    expect(script).toMatch(/security scan in progress/i);
    expect(script).toMatch(/refreshFileSecurityStatus/);
    expect(script).toMatch(/approveButton\.disabled = !docId \|\| !security\.ready/);
    expect(script).toMatch(/requestButton\.disabled = !docId \|\| !security\.ready/);
    expect(html).toMatch(/\.case-documents-item\.is-security-pending/);
    expect(fileView).toMatch(/fileSecurityPresentation/);
    expect(fileView).toMatch(/Open details/);
    expect(fileView).toMatch(/const caseId = file\.caseId \|\| ""/);
    expect(fileView).not.toMatch(/file\.caseId \|\| file\.id/);
  });

  test("Attorney entry points expose only owned page modes and no retired review workflow", () => {
    const dashboard = read("frontend/dashboard-attorney.html");
    const settings = read("frontend/profile-settings.html");
    const attorney = read("frontend/assets/scripts/attorney-tabs.js");
    expect(dashboard).toMatch(/window\.__ATTORNEY_PAGE__ = "overview"/);
    expect(settings).toMatch(/window\.__ATTORNEY_PAGE__ = "profile-settings"/);
    expect(attorney).not.toMatch(/case "(?:messages|cases|review|case-files|tasks)"/);
    expect(attorney).not.toMatch(
      /reviewContainer|revisionModal|uploadModal|reviewSelection|uploadSelection|openReviewFile|uploadToS3/
    );
    expect(attorney).not.toMatch(
      /initCaseFilesPage|caseFilesUploadWrapper|caseFilesContainer|initMessagesPage|data-message-cases|data-chat-send/
    );
  });
});
