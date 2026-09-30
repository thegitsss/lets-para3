const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(repositoryRoot, "frontend");
const backendRuntimeRoots = [
  "ai",
  "middleware",
  "models",
  "routes",
  "scheduler",
  "services",
  "utils",
].map((directory) => path.join(backendRoot, directory));
const OPERATIONAL_DOCUMENT_FILES = [
  "ATTORNEY_TEST_CHECKLIST.md",
  "PARALEGAL_TEST_CHECKLIST.md",
  "WITHDRAWAL_FLOW_CHECKLIST.md",
  "SUPPORT_MACROS.md",
  "ROLLBACK_PLAN.md",
  "FOUNDER_BROWSER_QA_CHECKLIST.md",
  "LAUNCH_CHECKLIST.md",
  "docs/BROWSER_SUPPORT.md",
  "docs/README.md",
  "docs/LPC_AI_OPERATING_MANUAL.md",
  "docs/RELEASE_GATES.md",
  "docs/attorney-assistant/PACKAGE_8_OPERATIONS.md",
  "docs/paralegal-assistant/PACKAGE_8_OPERATIONS.md",
  "backend/docs/incident-runner.md",
  "backend/docs/production-operations.md",
  "backend/backup-recovery.md",
].map((fileName) => path.join(repositoryRoot, fileName));
const HISTORICAL_DOCUMENT_FILES = [
  "docs/LPC_145K_500K_AUDIT.md",
  "docs/LPC_ROLE_CAPABILITY_AUDIT.md",
  "docs/LPC_PREMIUM_PRODUCT_UPGRADE_SPEC.md",
  "docs/LPC_PREMIUM_READINESS_DEFINITION.md",
  "docs/LPC_PREMIUM_REMEDIATION_PLAN.md",
  "docs/LPC_PREMIUM_EXECUTION_TRACKER.md",
].map((fileName) => path.join(repositoryRoot, fileName));
const SOURCE_EXTENSIONS = new Set([".css", ".html", ".js", ".md", ".mjs"]);
const FORBIDDEN_PATTERNS = [
  {
    pattern: /\bprovider\s*:\s*["']placeholder["']/i,
    reason: "returns a successful placeholder provider",
  },
  {
    pattern: /\bnextStep\s*:\s*["']Implement\b/i,
    reason: "ships an implementation instruction as runtime output",
  },
  {
    pattern: /\b(?:DEMO|MOCK|FAKE)_(?:MODE|DATA|RECORDS)\b/i,
    reason: "contains a production demo/mock data switch",
  },
  {
    pattern:
      /\b(?:AGENT_SCHEDULER_ENABLED|ENABLE_DOC_PREVIEW_CONVERSION|MESSAGE_NOTIFY_COOLDOWN_MS|NOTIFY_TO|OPENAI_MARKETING_MODEL|OPENAI_SALES_MODEL|SMTP_POOL|UPLOAD_DIR|WEATHER_API_KEY|WEATHER_LAT|WEATHER_LOCATION|WEATHER_LON)\b/,
    reason: "references a retired local environment control with no production owner",
  },
  {
    pattern: /URLSearchParams[^\n]{0,160}\.get\(["']demo["']\)/i,
    reason: "enables demo behavior from a URL parameter",
  },
  {
    pattern: /\b(?:coming soon|available soon|not implemented|under construction|not available yet)\b/i,
    reason: "exposes unfinished runtime behavior or copy",
  },
  {
    pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/,
    reason: "contains unmanaged launch debt",
  },
  {
    pattern: /data-page-loader|\bminimumVisibleMs\b/i,
    reason: "uses a full-screen or deliberately delayed loading splash instead of contextual loading state",
  },
  {
    pattern: /https:\/\/www\.facebook\.com\/LetsParaConnect\/?/i,
    reason: "promotes the retired Facebook channel outside retained audit records",
  },
  {
    pattern: /https:\/\/www\.instagram\.com\/letsparaconnect\/?/i,
    reason: "promotes an inactive Instagram channel",
  },
  {
    pattern: /\b(?:3\s*[–-]\s*5\s+business days|7\s*[–-]\s*14\s+days)\b/i,
    reason: "hard-codes a provider payout-arrival promise instead of using current Stripe state",
  },
  {
    pattern: /\b(?:we(?:'|’)ll|we will)\s+resolve[^.\n]{0,80}\bwithin\s+24\s+hours\b/i,
    reason: "promises an unsupported admin-resolution SLA",
  },
  {
    pattern: /\b(?:vetted paralegals?|elite paralegals?|best matches)\b/i,
    reason: "claims vetting, elite status, or matching that the approval workflow does not establish",
  },
  {
    pattern:
      /\b(?:matter matching|as needed for matching|strong relevance|relevant fit|relevant experience)\b|<option[^>]*>\s*Recommended\s*<\/option>/i,
    reason: "implies automated matching, relevance scoring, or recommendation that the browse-and-apply workflow does not provide",
  },
  {
    pattern: /\bmay also highlight certain Paralegal profiles\b/i,
    reason: "reserves an unsupported profile-promotion workflow after recommendation features were removed",
  },
  {
    pattern: /\b(?:user profiles, reviews, ratings|profiles, matters, reviews, ratings)\b/i,
    reason: "describes user reviews and ratings that the product does not provide",
  },
  {
    pattern:
      /\b(?:verified certifications?|attorneys can verify your expertise)\b|\bplatform fee[^.\n]{0,320}\b(?:secure workspace|identity verification)\b/i,
    reason: "overstates document verification or platform-fee capabilities beyond the implemented account-review workflow",
  },
  {
    pattern: /\bhighly curated professional platform\b/i,
    reason: "uses unsubstantiated curation positioning instead of the implemented approval-based access model",
  },
  {
    pattern: /\b(?:founding (?:paralegals|attorneys)|early access to jobs|onboarding paralegals first|opportunities will begin appearing as attorney onboarding expands|prelaunch)\b/i,
    reason: "exposes retired phased-launch positioning after both user roles are available",
  },
  {
    pattern: /\bverification team is reviewing your credentials\b/i,
    reason: "claims a specialized verification team instead of the implemented application-review workflow",
  },
  {
    pattern:
      /\b(?:complete verification before approval|bar number is used only for verification)\b/i,
    reason: "describes application review as credential verification",
  },
  {
    pattern: /\b(?:Verification review|paralegals awaiting verification)\b/i,
    reason: "labels the admissions queue as credential verification",
  },
  {
    pattern:
      /\b(?:identity and credential verification|validation of information provided in your account against third-party databases|verification of government-issued identification|verification of professional credentials or employment history|confirmation of bar membership or professional standing)\b/i,
    reason: "describes a background or credential-verification program that the admission workflow does not implement",
  },
  {
    pattern:
      /\b(?:professional profile and verification information|professional or verification information from sources used to review an application|review applications and professional qualifications)\b/i,
    reason: "describes submitted application data as independently verified professional information",
  },
  {
    pattern: /\bVerification pending\b/i,
    reason: "fabricates a pending verification state when payment evidence is unavailable",
  },
  {
    pattern:
      /\b(?:verifiable legal support experience|request verification materials|failure to provide requested verification|authorized to work with U\.S\.-based attorneys|admission is intentionally limited in order to preserve quality|applicants may reapply in the future)\b/i,
    reason: "describes admissions criteria or a reapplication workflow that LPC does not implement",
  },
  {
    pattern:
      /\b(?:requested verification materials|all work is fully remote|four-year degree, a paralegal certificate, or relevant legal-office experience|reviewed for platform access and professional fit|experienced professionals with prior law-firm and professional office experience)\b/i,
    reason: "overstates application review, admissions criteria, or remote-work guarantees beyond the implemented workflow",
  },
  {
    pattern: /\b(?:Billing & Payments|Billing & payments|Where is Billing & Payments\?)\b/i,
    reason: "uses the retired billing destination name instead of Payments",
  },
  {
    pattern: /dashboard-attorney\.html#billing\b/i,
    reason: "links to a retired attorney dashboard hash instead of the stable Payments destination",
  },
  {
    pattern: /\bmay require the payment of a buyout fee\b/i,
    reason: "reserves an undisclosed automatic fee instead of requiring advance written disclosure and agreement",
  },
  {
    pattern: /\b(?:place on probation|probationary status|pattern of three \(3\) missed deadlines)\b/i,
    reason: "describes an account probation state or automatic deadline threshold the product does not implement",
  },
  {
    pattern: /\badheres to applicable laws such as the Americans with Disabilities Act\b/i,
    reason: "claims legal accessibility compliance without a completed independent conformance review",
  },
  {
    pattern: /\bno attorney-client communications or client funds are permitted on the Platform\b/i,
    reason: "conflates client-facing communications and trust funds with authorized Matter collaboration",
  },
  {
    pattern: /\bwill not use User Content for external marketing purposes without permission, except where such content has been made publicly available\b/i,
    reason: "reserves a public-content marketing exception beyond the stated privacy contract",
  },
  {
    pattern: /\b(?:minimum posted amount[^.\n]{0,100}ensure serious, professional legal work|to maintain quality and alignment with professional-level work|supports focused, professionally scoped engagements)\b/i,
    reason: "treats the minimum Matter amount as a guarantee of quality or adequate scope",
  },
  {
    pattern: /\bLet['’]s-ParaConnect Verification Division\b/i,
    reason: "fabricates an organizational division that does not exist",
  },
  {
    pattern: /\breset links?[^.\n]{0,80}\b48\s+hours\b/i,
    reason: "describes the retired password-reset lifetime",
  },
  {
    pattern: /\badditional details will be provided\b/i,
    reason: "fabricates placeholder Matter scope instead of requiring authored content",
  },
  {
    pattern: /\b(?:LPC covers(?: all)? Stripe processing fees|Stripe processing fees also apply)\b/i,
    reason: "uses an ambiguous Stripe-processing charge claim instead of the displayed-total contract",
  },
  {
    pattern: /\b(?:Escrow release|escrowed funds|shows escrow as|escrow is funded|while escrow,\s*payout)\b/i,
    reason: "uses affirmative escrow-service language instead of the Stripe funding and release contract",
  },
  {
    pattern: /\bpayment\s+(?:is|remains)\s+secured\b|\$?\d[\d,.]*\s+secured\b/i,
    reason: "describes a funded Stripe payment as secured custody instead of verified funding",
  },
  {
    pattern:
      /\b(?:LPC (?:has )?released funds|complete (?:the )?matter and release funds|complete\s*(?:&|and)\s*release funds|release Matter funds|unable to release funds|couldn['’]t release funds|use release funds instead)\b/i,
    reason: "uses custody-style release-funds copy instead of the implemented Stripe payment-release workflow",
  },
  {
    pattern:
      /\b(?:Funds\s*(?:&|&amp;)\s*Payments|Active Funds|Opening Funds\s*(?:&|&amp;)\s*Payments|Open Funds|before funds can be released|before releasing funds|Releasing funds)\b/i,
    reason: "labels LPC as a funds-holding surface instead of describing Stripe-processed payments",
  },
  {
    pattern: /\b(?:Funds were released to Stripe|Funds were not released|No funds were made available|verify that funds were sent)\b/i,
    reason: "describes a payment or payout state as LPC-held funds",
  },
  {
    pattern: /\b(?:Invoices\s*(?:&|&amp;)\s*Receipts|view all invoices and receipts)\b/i,
    reason: "advertises invoices even though the product exposes payment history and Matter receipts",
  },
  {
    pattern:
      /\bfunds? (?:are )?released\b|\bpayment received\b|\bpayout received\b|\bAuthorized\s*[·-]\s*release at completion\b/i,
    reason: "misstates a Stripe funding, payment-release, or payout state",
  },
  {
    pattern: /\bapproved opportunities\b/i,
    reason: "implies LPC approves Matter opportunities instead of publishing open Attorney postings",
  },
  {
    pattern: /\bcharges a platform fee in connection with completed Matters\b/i,
    reason: "collapses the attorney-at-hire and paralegal-after-completion fees into an incorrect single timing claim",
  },
  {
    pattern: /\bparalegal will be paid the Matter amount presented\b/i,
    reason: "states gross Matter compensation as the Paralegal's net payout without the disclosed platform-fee deduction",
  },
];
const SILENT_FAILURE_PATTERN = /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)|\bcatch\s*\{\s*\}/;
const OPERATIONAL_DOCUMENT_FORBIDDEN_PATTERNS = [
  {
    pattern:
      /\b(?:Billing\s*\/\s*Payment Method|Billing page|Billing view|Create a Case|Post a Case|Browse Open Jobs|Apply to a Job|Assigned Cases|Case Workspace)\b/i,
    reason: "directs launch operators to retired customer terminology",
  },
  {
    pattern: /\bparalegal-(?:applications|assigned|invitations)\.html\b/i,
    reason: "directs launch operators to a compatibility redirect instead of the canonical dashboard workflow",
  },
  {
    pattern:
      /\b(?:we(?:'|’)ll|we will)\s+(?:resolve|respond|follow up)[^.\n]{0,100}\bwithin\s+(?:24\s+hours?|one\s+business\s+day|1\s+business\s+day)\b/i,
    reason: "promises an unsupported support-response or resolution SLA",
  },
  {
    pattern: /\bno hard cap\b/i,
    reason: "contradicts the enforced attorney partial-payout cap",
  },
  {
    pattern: /\b(?:4242[ -]?){3}4242\b|\b5555[ -]?5555[ -]?5555[ -]?4444\b/,
    reason: "hard-codes provider test-card data in an operator document instead of requiring an approved environment fixture",
  },
  {
    pattern: /\b(?:War Room|scheduled monitoring checks every 10 minutes|cron-based scheduler runs every 10 minutes)\b/i,
    reason: "describes a retired operator label or stale production cadence",
  },
  {
    pattern: /\b(?:founder )?(?:email )?(?:alert|notification)[^.\n]{0,100}\badmin@lets-paraconnect\.com\b/i,
    reason: "treats a source fallback address as verified production alert configuration",
  },
  {
    pattern: /\bAI Control Room[^.\n]{0,100}\b(?:entirely |intentionally )?read-only\b/i,
    reason: "describes the governed Control Room as wholly read-only",
  },
];
const LEGACY_CASE_USER_COPY_PATTERN =
  /(?:\b(?:error|msg|message|summary|reason|label|title|copy|recommendation|category|description)\s*(?::|=)\s*|\b(?:throw new Error|new Error|showToast|notify|showAlert|setStatus)\s*\()\s*["'`][^"'`\n]*\b(?:case|job)(?:s)?\b/i;
const LEGACY_CASE_FALLBACK_PATTERN =
  /\|\|\s*["'`](?:Untitled\s+)?(?:Case|Job)(?:s)?(?:\s+(?:update|posting|record))?["'`]/;
const LEGACY_CASE_VISIBLE_HTML_PATTERN =
  />[^<\n]*\b(?:Case|Cases|Job|Jobs)\b[^<\n]*</;
const LEGACY_CASE_FIELD_LABEL_PATTERN =
  /["'`](?:Related\s+|Legacy\s+)?(?:Case|Job)\s+(?:ID|Title|Name|Amount)(?:\s+\([^)]+\))?["'`]/i;
const LEGACY_CASE_VISIBLE_FIELD_PATTERN =
  />[^<\n]*\b(?:Related|Legacy)\s+(?:case|job)\s+(?:ID|Title|Name|Amount)\b[^<\n]*</i;
const LEGACY_CASE_ACTION_HTML_PATTERN =
  />[^<\n]*\b(?:Continue\s+to|Open|View|Back\s+to|Go\s+to|Search|Browse|Create|Post|Apply\s+to|Complete|Fund)\s+(?:a\s+|the\s+)?(?:case|job)s?\b[^<\n]*</i;
const LEGACY_CASE_USER_COPY_BACKEND_FILES = new Set([
  path.join(backendRoot, "email", "templates.js"),
  path.join(backendRoot, "utils", "notifyUser.js"),
  path.join(backendRoot, "utils", "authz.js"),
  path.join(backendRoot, "utils", "blocks.js"),
  path.join(backendRoot, "services", "caseLifecycle.js"),
  path.join(backendRoot, "services", "withdrawalLifecycle.js"),
  path.join(backendRoot, "services", "support", "contextResolverService.js"),
  path.join(backendRoot, "services", "support", "conversationService.js"),
  path.join(backendRoot, "services", "support", "responsePacketService.js"),
  path.join(backendRoot, "services", "support", "ticketService.js"),
  path.join(backendRoot, "services", "lpcEvents", "routerService.js"),
  path.join(backendRoot, "ai", "supportAgentTools.js"),
]);

function silentOperationalFailureIssue(filePath, source = "") {
  const isBackendRuntime = backendRuntimeRoots.some(
    (root) => filePath === root || filePath.startsWith(`${root}${path.sep}`)
  );
  return isBackendRuntime && SILENT_FAILURE_PATTERN.test(String(source));
}

function legacyCaseUserCopyIssue(filePath, source = "") {
  const isFrontend = filePath === frontendRoot || filePath.startsWith(`${frontendRoot}${path.sep}`);
  const routesRoot = path.join(backendRoot, "routes");
  const isBackendUserBoundary =
    filePath === routesRoot ||
    filePath.startsWith(`${routesRoot}${path.sep}`) ||
    LEGACY_CASE_USER_COPY_BACKEND_FILES.has(filePath);
  const text = String(source);
  return (
    (isFrontend || isBackendUserBoundary) &&
    (LEGACY_CASE_USER_COPY_PATTERN.test(text) ||
      LEGACY_CASE_FALLBACK_PATTERN.test(text) ||
      (isFrontend &&
        (LEGACY_CASE_FIELD_LABEL_PATTERN.test(text) ||
          LEGACY_CASE_VISIBLE_FIELD_PATTERN.test(text) ||
          LEGACY_CASE_VISIBLE_HTML_PATTERN.test(text) ||
          LEGACY_CASE_ACTION_HTML_PATTERN.test(text))))
  );
}

function operationalDocumentIssues(filePath, source = "") {
  if (!OPERATIONAL_DOCUMENT_FILES.includes(filePath)) return [];
  return OPERATIONAL_DOCUMENT_FORBIDDEN_PATTERNS
    .filter(({ pattern }) => pattern.test(String(source)))
    .map(({ reason }) => reason);
}

function historicalDocumentIssue(filePath, source = "") {
  if (!HISTORICAL_DOCUMENT_FILES.includes(filePath)) return "";
  const lead = String(source).slice(0, 1_500);
  if (!/^#[^\n]+\n\n> Historical\b/.test(lead)) {
    return "must identify itself as historical immediately below its title";
  }
  if (!/LAUNCH_CERTIFICATION_CURRENT\.md/.test(lead)) {
    return "must direct readers to the current launch certification";
  }
  return "";
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function run() {
  const sourceFiles = [...backendRuntimeRoots, frontendRoot]
    .flatMap(walk)
    .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)))
    .concat(OPERATIONAL_DOCUMENT_FILES.filter((filePath) => fs.existsSync(filePath)));
  const failures = [];
  sourceFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    FORBIDDEN_PATTERNS.forEach(({ pattern, reason }) => {
      if (pattern.test(source)) failures.push(`${relative(filePath)} ${reason}`);
    });
    if (silentOperationalFailureIssue(filePath, source)) {
      failures.push(`${relative(filePath)} silently discards an operational failure`);
    }
    if (legacyCaseUserCopyIssue(filePath, source)) {
      failures.push(`${relative(filePath)} exposes legacy Case/Job terminology in user-facing runtime copy`);
    }
    operationalDocumentIssues(filePath, source).forEach((reason) => {
      failures.push(`${relative(filePath)} ${reason}`);
    });
  });
  HISTORICAL_DOCUMENT_FILES.forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      failures.push(`${relative(filePath)} is missing from the governed historical record`);
      return;
    }
    const issue = historicalDocumentIssue(filePath, fs.readFileSync(filePath, "utf8"));
    if (issue) failures.push(`${relative(filePath)} ${issue}`);
  });

  if (failures.length) {
    console.error("Production no-theater check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Production no-theater check passed (${sourceFiles.length} production/operator files and ${HISTORICAL_DOCUMENT_FILES.length} governed historical records).`
  );
}

if (require.main === module) run();

module.exports = {
  FORBIDDEN_PATTERNS,
  historicalDocumentIssue,
  operationalDocumentIssues,
  legacyCaseUserCopyIssue,
  silentOperationalFailureIssue,
  run,
};
