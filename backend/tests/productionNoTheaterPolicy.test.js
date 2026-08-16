const path = require("path");
const {
  FORBIDDEN_PATTERNS,
  historicalDocumentIssue,
  legacyCaseUserCopyIssue,
  operationalDocumentIssues,
  silentOperationalFailureIssue,
} = require("../scripts/check-production-no-theater");

describe("production no-theater policy", () => {
  test("rejects swallowed promise and catch failures in backend runtime code", () => {
    const runtimePath = path.resolve(__dirname, "../routes/payments.js");
    expect(silentOperationalFailureIssue(runtimePath, "await persist().catch(() => {});" )).toBe(true);
    expect(silentOperationalFailureIssue(runtimePath, "try { await persist(); } catch {}" )).toBe(true);
    expect(
      silentOperationalFailureIssue(
        runtimePath,
        'await persist().catch((error) => logger.error("Persistence failed", error));'
      )
    ).toBe(false);
  });

  test("does not apply backend operational logging policy to frontend code", () => {
    const frontendPath = path.resolve(__dirname, "../../frontend/assets/scripts/app.js");
    expect(silentOperationalFailureIssue(frontendPath, "optionalImport().catch(() => {});" )).toBe(false);
  });

  test("rejects stale or unsafe instructions in active launch-operator documents", () => {
    const operatorPath = path.resolve(__dirname, "../../ATTORNEY_TEST_CHECKLIST.md");
    const historicalPath = path.resolve(__dirname, "../../docs/historical-note.md");

    for (const source of [
      "## Billing / Payment Method",
      "Post a Case",
      "Open paralegal-applications.html.",
      "We'll follow up within 1 business day.",
      "Recommended: 70% (no hard cap)",
      "Use 4242 4242 4242 4242.",
      "Open the War Room.",
      "Scheduled monitoring checks every 10 minutes.",
      "Send a founder email alert at admin@lets-paraconnect.com.",
      "The AI Control Room is intentionally read-only.",
    ]) {
      expect(operationalDocumentIssues(operatorPath, source)).not.toEqual([]);
    }
    expect(operationalDocumentIssues(operatorPath, "Open Payments and create a Matter.")).toEqual([]);
    expect(operationalDocumentIssues(historicalPath, "Post a Case")).toEqual([]);
  });

  test("requires superseded planning records to identify their historical status and current authority", () => {
    const historicalPath = path.resolve(
      __dirname,
      "../../docs/LPC_PREMIUM_REMEDIATION_PLAN.md"
    );
    expect(historicalDocumentIssue(
      historicalPath,
      "# Old plan\n\nThis looks current."
    )).toMatch(/identify itself as historical/i);
    expect(historicalDocumentIssue(
      historicalPath,
      "# Old plan\n\n> Historical plan: superseded."
    )).toMatch(/current launch certification/i);
    expect(historicalDocumentIssue(
      historicalPath,
      "# Old plan\n\n> Historical plan: use docs/LAUNCH_CERTIFICATION_CURRENT.md."
    )).toBe("");
  });

  test("rejects legacy Case and Job terminology at user-facing runtime boundaries", () => {
    const routePath = path.resolve(__dirname, "../routes/cases.js");
    const frontendPath = path.resolve(__dirname, "../../frontend/assets/scripts/case-detail.js");
    const frontendHtmlPath = path.resolve(__dirname, "../../frontend/terms.html");
    const internalModelPath = path.resolve(__dirname, "../models/Case.js");

    expect(legacyCaseUserCopyIssue(routePath, 'return res.json({ error: "Case not found" });')).toBe(true);
    expect(legacyCaseUserCopyIssue(routePath, 'return res.json({ error: "Job not found" });')).toBe(true);
    expect(legacyCaseUserCopyIssue(routePath, 'const error = new Error("Case not found");')).toBe(true);
    expect(legacyCaseUserCopyIssue(routePath, 'const title = record.title || "Untitled Case";')).toBe(true);
    expect(legacyCaseUserCopyIssue(frontendPath, 'showToast("Unable to load this case.");')).toBe(true);
    expect(legacyCaseUserCopyIssue(frontendHtmlPath, '<h2>Flat-Fee Cases</h2>')).toBe(true);
    expect(legacyCaseUserCopyIssue(frontendPath, '<label>Related case id</label>')).toBe(true);
    expect(legacyCaseUserCopyIssue(frontendPath, 'const headers = ["Case ID", "Case Title"];')).toBe(true);
    expect(legacyCaseUserCopyIssue(frontendPath, '<a href="/workspace">Continue to case</a>')).toBe(true);
    expect(legacyCaseUserCopyIssue(routePath, 'return res.json({ error: "Matter not found" });')).toBe(false);
    expect(legacyCaseUserCopyIssue(routePath, 'const title = record.title || "Untitled Matter";')).toBe(false);
    expect(legacyCaseUserCopyIssue(frontendPath, 'fetch(`/api/cases/${caseId}`);')).toBe(false);
    expect(legacyCaseUserCopyIssue(internalModelPath, 'const targetType = "case";')).toBe(false);
  });

  test("rejects public promotion of retired or inactive social channels", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    expect(reasonsFor("https://www.facebook.com/LetsParaConnect/")).toContain(
      "promotes the retired Facebook channel outside retained audit records"
    );
    expect(reasonsFor("https://www.instagram.com/letsparaconnect/")).toContain(
      "promotes an inactive Instagram channel"
    );
    expect(reasonsFor("https://www.linkedin.com/company/lets-paraconnect/")).toEqual([]);
  });

  test("rejects retired environment controls at production boundaries", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    expect(reasonsFor("if (process.env.AGENT_SCHEDULER_ENABLED) startScheduler();")).toContain(
      "references a retired local environment control with no production owner"
    );
    expect(reasonsFor("const location = process.env.WEATHER_LOCATION;")).toContain(
      "references a retired local environment control with no production owner"
    );
    expect(reasonsFor("const location = process.env.APP_BASE_URL;")).toEqual([]);
  });

  test("rejects affirmative escrow-service copy while allowing the required disclaimer", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    expect(reasonsFor("Workspace access opens once escrow is funded.")).toContain(
      "uses affirmative escrow-service language instead of the Stripe funding and release contract"
    );
    expect(reasonsFor("LPC is not an escrow service.")).toEqual([]);
    expect(reasonsFor("Payment remains secured until completion.")).toContain(
      "describes a funded Stripe payment as secured custody instead of verified funding"
    );
    expect(reasonsFor("Payments are processed securely through Stripe.")).toEqual([]);
    expect(reasonsFor("Complete & Release Funds")).toContain(
      "uses custody-style release-funds copy instead of the implemented Stripe payment-release workflow"
    );
    expect(reasonsFor("Confirming will release Matter funds.")).toContain(
      "uses custody-style release-funds copy instead of the implemented Stripe payment-release workflow"
    );
    expect(reasonsFor("Complete & Release Payment")).toEqual([]);
    for (const claim of [
      "Funds & Payments",
      "Active Funds",
      "Opening Funds & Payments",
      "Open Funds",
      "Payment method needs to be updated before funds can be released.",
      "Fund the Matter before releasing funds.",
      "Releasing funds...",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "labels LPC as a funds-holding surface instead of describing Stripe-processed payments"
      );
    }
    expect(reasonsFor("Funded Matter Payments")).toEqual([]);
    expect(reasonsFor("Releasing payment...")).toEqual([]);
    for (const claim of [
      "Funds were released to Stripe.",
      "Funds were not released.",
      "No funds were made available.",
      "I cannot verify that funds were sent.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "describes a payment or payout state as LPC-held funds"
      );
    }
    expect(reasonsFor("Your payout was released to Stripe.")).toEqual([]);
    for (const claim of ["Invoices & Receipts", "View all invoices and receipts in Payments."]) {
      expect(reasonsFor(claim)).toContain(
        "advertises invoices even though the product exposes payment history and Matter receipts"
      );
    }
    expect(reasonsFor("Payment History & Receipts")).toEqual([]);
    for (const claim of ["Funds are released", "Payment Received", "payout received", "Authorized · release at completion"]) {
      expect(reasonsFor(claim)).toContain(
        "misstates a Stripe funding, payment-release, or payout state"
      );
    }
    expect(reasonsFor("Payout Released")).toEqual([]);
    expect(reasonsFor("Apply for approved opportunities.")).toContain(
      "implies LPC approves Matter opportunities instead of publishing open Attorney postings"
    );
    expect(reasonsFor("Apply to open Matters.")).toEqual([]);
  });

  test("rejects fixed provider payout-arrival promises", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    expect(reasonsFor("Deposit timing typically ranges from 3–5 business days.")).toContain(
      "hard-codes a provider payout-arrival promise instead of using current Stripe state"
    );
    expect(reasonsFor("First payouts generally take 7-14 days.")).toContain(
      "hard-codes a provider payout-arrival promise instead of using current Stripe state"
    );
    expect(reasonsFor("Check Stripe for the current estimated arrival.")).toEqual([]);
  });

  test("rejects unsupported review, vetting, and matching claims", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    expect(reasonsFor("We'll resolve this within 24 hours.")).toContain(
      "promises an unsupported admin-resolution SLA"
    );
    for (const claim of ["vetted paralegals", "elite paralegals", "best matches"]) {
      expect(reasonsFor(claim)).toContain(
        "claims vetting, elite status, or matching that the approval workflow does not establish"
      );
    }
    expect(reasonsFor("Applications are reviewed before approval.")).toEqual([]);
  });

  test("rejects unsupported recommendation, relevance-scoring, and document-verification copy", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    for (const claim of [
      "Used for location-relevant matter matching.",
      "Profiles are shown as needed for matching and collaboration.",
      "Strong relevance",
      "Relevant fit",
      "Relevant experience",
      '<option value="">Recommended</option>',
    ]) {
      expect(reasonsFor(claim)).toContain(
        "implies automated matching, relevance scoring, or recommendation that the browse-and-apply workflow does not provide"
      );
    }
    for (const claim of [
      "Share verified certifications with attorneys.",
      "Upload a resume so attorneys can verify your expertise.",
      "The platform fee supports a secure workspace and identity verification.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "overstates document verification or platform-fee capabilities beyond the implemented account-review workflow"
      );
    }
    expect(reasonsFor("Sort by newest application.")).toEqual([]);
    expect(reasonsFor("Profiles are reviewed before approval.")).toEqual([]);
    expect(reasonsFor("LPC may also highlight certain Paralegal profiles.")).toContain(
      "reserves an unsupported profile-promotion workflow after recommendation features were removed"
    );
    expect(reasonsFor("Paralegals may opt into profile browsing.")).toEqual([]);
    for (const claim of [
      "User profiles, reviews, ratings, and other information",
      "PROFILES, MATTERS, REVIEWS, RATINGS, OR OTHER MATERIALS",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "describes user reviews and ratings that the product does not provide"
      );
    }
    expect(reasonsFor("Profiles and other user-provided information")).toEqual([]);
    expect(reasonsFor("A highly curated professional platform.")).toContain(
      "uses unsubstantiated curation positioning instead of the implemented approval-based access model"
    );
    expect(reasonsFor("An approval-based professional platform.")).toEqual([]);
    for (const claim of [
      "founding paralegals",
      "founding attorneys",
      "early access to jobs",
      "onboarding paralegals first",
      "Opportunities will begin appearing as attorney onboarding expands.",
      "prelaunch",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "exposes retired phased-launch positioning after both user roles are available"
      );
    }
    expect(reasonsFor("Our verification team is reviewing your credentials.")).toContain(
      "claims a specialized verification team instead of the implemented application-review workflow"
    );
    expect(reasonsFor("Our team is reviewing your application.")).toEqual([]);
    for (const claim of [
      "We require this information to complete verification before approval.",
      "Your bar number is used only for verification.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "describes application review as credential verification"
      );
    }
    expect(reasonsFor("Your bar number is used to review your application.")).toEqual([]);
    for (const claim of ["Verification review", "No paralegals awaiting verification."]) {
      expect(reasonsFor(claim)).toContain(
        "labels the admissions queue as credential verification"
      );
    }
    expect(reasonsFor("Admissions review")).toEqual([]);
    for (const claim of [
      "Your account may be subject to identity and credential verification.",
      "Validation of information provided in your account against third-party databases.",
      "Verification of government-issued identification.",
      "Verification of professional credentials or employment history.",
      "Confirmation of bar membership or professional standing.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "describes a background or credential-verification program that the admission workflow does not implement"
      );
    }
    expect(reasonsFor("We review submitted application information for completeness and consistency.")).toEqual([]);
    for (const claim of [
      "Professional profile and verification information",
      "Professional or verification information from sources used to review an application",
      "Review applications and professional qualifications",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "describes submitted application data as independently verified professional information"
      );
    }
    expect(reasonsFor("Professional profile and application information")).toEqual([]);
    expect(reasonsFor("Verification pending")).toContain(
      "fabricates a pending verification state when payment evidence is unavailable"
    );
    expect(reasonsFor("Payment status unavailable")).toEqual([]);
    for (const claim of [
      "Applicants must demonstrate verifiable legal support experience.",
      "LPC may request verification materials.",
      "Failure to provide requested verification may result in denial.",
      "The applicant must be authorized to work with U.S.-based attorneys.",
      "Admission is intentionally limited in order to preserve quality.",
      "Applicants may reapply in the future.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "describes admissions criteria or a reapplication workflow that LPC does not implement"
      );
    }
    expect(reasonsFor("A PDF résumé is required with the application.")).toEqual([]);
    for (const claim of [
      "Please provide any requested verification materials.",
      "All work is fully remote.",
      "Applicants must have a four-year degree, a paralegal certificate, or relevant legal-office experience.",
      "Profiles are reviewed for platform access and professional fit.",
      "They are experienced professionals with prior law-firm and professional office experience.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "overstates application review, admissions criteria, or remote-work guarantees beyond the implemented workflow"
      );
    }
    expect(reasonsFor("LPC’s workflow supports remote collaboration.")).toEqual([]);
    expect(reasonsFor("Payments")).toEqual([]);
    expect(reasonsFor("Billing & Payments")).toContain(
      "uses the retired billing destination name instead of Payments"
    );
    expect(reasonsFor("dashboard-attorney.html#billing")).toContain(
      "links to a retired attorney dashboard hash instead of the stable Payments destination"
    );
    expect(reasonsFor("LPC may require the payment of a buyout fee.")).toContain(
      "reserves an undisclosed automatic fee instead of requiring advance written disclosure and agreement"
    );
    expect(reasonsFor("The account may be placed on probationary status.")).toContain(
      "describes an account probation state or automatic deadline threshold the product does not implement"
    );
    expect(reasonsFor("The site adheres to applicable laws such as the Americans with Disabilities Act.")).toContain(
      "claims legal accessibility compliance without a completed independent conformance review"
    );
    expect(reasonsFor("Our current design and engineering target is WCAG 2.2 Level AA.")).toEqual([]);
    expect(reasonsFor("No attorney-client communications or client funds are permitted on the Platform.")).toContain(
      "conflates client-facing communications and trust funds with authorized Matter collaboration"
    );
    expect(reasonsFor("The Platform must not be used to hold client trust funds.")).toEqual([]);
    expect(reasonsFor("LPC will not use User Content for external marketing purposes without permission, except where such content has been made publicly available.")).toContain(
      "reserves a public-content marketing exception beyond the stated privacy contract"
    );
    for (const claim of [
      "The minimum posted amount helps ensure serious, professional legal work.",
      "To maintain quality and alignment with professional-level work, LPC enforces a minimum.",
      "This supports focused, professionally scoped engagements.",
    ]) {
      expect(reasonsFor(claim)).toContain(
        "treats the minimum Matter amount as a guarantee of quality or adequate scope"
      );
    }
    expect(reasonsFor("The minimum is a posting requirement, not a guarantee of scope, quality, or fit.")).toEqual([]);
    expect(reasonsFor("Let’s-ParaConnect Verification Division")).toContain(
      "fabricates an organizational division that does not exist"
    );
    expect(reasonsFor("Let’s-ParaConnect")).toEqual([]);
  });

  test("rejects the retired password-reset lifetime", () => {
    const reasons = FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test("Reset links currently expire after 48 hours."))
      .map(({ reason }) => reason);

    expect(reasons).toContain("describes the retired password-reset lifetime");
  });

  test("rejects available-soon runtime theater", () => {
    const reasons = FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test("Commenting will be available soon."))
      .map(({ reason }) => reason);

    expect(reasons).toContain("exposes unfinished runtime behavior or copy");
  });

  test("rejects fabricated Matter-description filler", () => {
    const reasons = FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test("Additional details will be provided once accepted."))
      .map(({ reason }) => reason);

    expect(reasons).toContain("fabricates placeholder Matter scope instead of requiring authored content");
  });

  test("rejects contradictory Stripe-processing charge claims", () => {
    const reasonsFor = (source) => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(source))
      .map(({ reason }) => reason);

    for (const claim of ["LPC covers all Stripe processing fees", "Stripe processing fees also apply"]) {
      expect(reasonsFor(claim)).toContain(
        "uses an ambiguous Stripe-processing charge claim instead of the displayed-total contract"
      );
    }
    expect(reasonsFor("No separate Stripe processing line item is added beyond the displayed total.")).toEqual([]);
    expect(reasonsFor("LPC charges a platform fee in connection with completed Matters.")).toContain(
      "collapses the attorney-at-hire and paralegal-after-completion fees into an incorrect single timing claim"
    );
    expect(
      reasonsFor(
        "The Attorney fee is added at hire, and the Paralegal fee is deducted from completed, paid work before payout."
      )
    ).toEqual([]);
    expect(reasonsFor("The paralegal will be paid the Matter amount presented.")).toContain(
      "states gross Matter compensation as the Paralegal's net payout without the disclosed platform-fee deduction"
    );
    expect(reasonsFor("The disclosed Paralegal platform fee is deducted from gross compensation before payout.")).toEqual([]);
  });
});
