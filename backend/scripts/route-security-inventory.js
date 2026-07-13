const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const routesDir = path.join(repoRoot, "backend/routes");
const outFile = path.join(repoRoot, "docs/LPC_ROUTE_SECURITY_INVENTORY.md");

const ROUTE_RE = /router\.(post|put|patch|delete)\s*\(/g;

const mountByFile = {
  "account.js": "/api/account",
  "admin.js": "/api/admin",
  "adminApprovals.js": "/api/admin/approvals",
  "adminEngineering.js": "/api/admin/engineering",
  "adminKnowledge.js": "/api/admin/knowledge",
  "adminMarketing.js": "/api/admin/marketing",
  "adminSales.js": "/api/admin/sales",
  "adminSupport.js": "/api/admin/support",
  "aiAdmin.js": "/api/admin/ai",
  "aiChat.js": "/api/ai-chat",
  "applications.js": "/api/applications",
  "auth.js": "/api/auth",
  "autonomousActions.js": "/api/admin/autonomous-actions",
  "blocks.js": "/api/blocks",
  "caseDrafts.js": "/api/case-drafts",
  "caseTasks.js": "/api/cases/:caseId/tasks",
  "cases.js": "/api/cases",
  "ccoAutonomyHarness.js": "/api/admin/support/dev/cco-autonomy",
  "chat.js": "/api/chat",
  "checklist.js": "/api/checklist",
  "controlRoomE2eHarness.js": "/api/admin/ai-control-room/dev/e2e",
  "directorPortal.js": "/api/director",
  "disputes.js": "/api/disputes",
  "events.js": "/api/events",
  "incidentAdmin.js": "/api/admin/incidents",
  "incidents.js": "/api/incidents",
  "jobs.js": "/api/jobs",
  "messages.js": "/api/messages",
  "notifications.js": "/api/notifications",
  "paralegals.js": "/api/paralegals",
  "payments.js": "/api/payments",
  "paymentsWebhook.js": "/api/webhooks/stripe",
  "public.js": "/api/public and /public",
  "stripe.js": "/api/stripe",
  "support.js": "/api/support",
  "tasks.js": "/api/tasks",
  "uploads.js": "/api/uploads",
  "users.js": "/api/users and /api/paralegals",
  "waitlist.js": "/api/waitlist",
};

const fileRateLimitNotes = {
  "auth.js": "App-level limits for login/register/reset/resend.",
  "cases.js": "App-level /api/cases and /api limit.",
  "messages.js": "App-level /api/messages and /api limit.",
  "uploads.js": "App-level /api/uploads and /api limit.",
  "public.js": "Route-level public limits plus app-level /api limit.",
  "paymentsWebhook.js": "Webhook endpoint; no browser rate-limit expected.",
  "waitlist.js": "App-level /api limit only.",
};

function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

function findCallEnd(src, openParenIdx) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openParenIdx; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function firstRoutePath(call) {
  const m = call.match(/router\.(?:post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\1/);
  return m ? m[2] : "(dynamic path)";
}

function hasBefore(src, line, pattern) {
  const before = src.split("\n").slice(0, Math.max(0, line - 1)).join("\n");
  return pattern.test(before);
}

function classify(file, call, beforeLineText) {
  const whole = `${beforeLineText}\n${call}`;
  if (file === "paymentsWebhook.js") return "webhook/system-only";
  if (/requireRole\(["'`]admin/.test(whole)) return "admin-only";
  if (/requireRole\(["'`]director/.test(whole)) return "director-only";
  if (/requireRole\(["'`]attorney/.test(whole) && !/paralegal/.test(whole)) return "attorney-only";
  if (/requireRole\(["'`]paralegal/.test(whole) && !/attorney/.test(whole)) return "paralegal-only";
  if (/verifyToken\.optional/.test(whole)) return "public/optional-auth";
  if (/verifyToken|auth\b|router\.use\(verifyToken|router\.use\(auth|requireApproved/.test(whole)) return "authenticated";
  if (file === "auth.js" || file === "public.js" || file === "waitlist.js" || file === "incidents.js") return "public";
  return "authenticated/needs-review";
}

function rowStatus({ csrf, classification, file, call }) {
  if (csrf) return "verified";
  if (classification === "webhook/system-only") return "exempt";
  if (file === "controlRoomE2eHarness.js") return "exempt";
  if (file === "auth.js") return "exempt-review";
  if (file === "waitlist.js") return "exempt-review";
  if (file === "incidents.js" && /verifyToken\.optional/.test(call)) return "exempt-review";
  if (classification === "public") return "exempt-review";
  return "open";
}

function csrfNote({ csrf, status, classification, file }) {
  if (csrf) return "Protected by csrfProtection/protectMutations/mutatingGuards.";
  if (classification === "webhook/system-only") return "Exempt: Stripe webhook requires raw body/signature verification, not browser CSRF.";
  if (file === "controlRoomE2eHarness.js") return "Exempt: dev E2E harness route gated by harness enablement and shared secret; not mounted as a normal production browser surface.";
  if (file === "auth.js") return "Exempt-review: public auth flow; protected by auth-specific validation/rate limits, but logout/session CSRF should be reviewed.";
  if (file === "waitlist.js") return "Exempt-review: public lead capture; app-level rate limit only.";
  if (file === "incidents.js") return "Exempt-review: support incident intake; may be optional-auth public intake.";
  if (status === "open") return "Missing explicit CSRF or exemption.";
  return "Needs review.";
}

function mdEscape(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".js")).sort();
const rows = [];

for (const file of files) {
  const abs = path.join(routesDir, file);
  const src = fs.readFileSync(abs, "utf8");
  let match;
  while ((match = ROUTE_RE.exec(src))) {
    const method = match[1].toUpperCase();
    const openIdx = src.indexOf("(", match.index);
    const end = findCallEnd(src, openIdx);
    if (end === -1) continue;
    const call = src.slice(match.index, end + 1);
    const line = lineOf(src, match.index);
    const beforeLineText = src.split("\n").slice(0, line).join("\n");
    const routePath = firstRoutePath(call);
    const auth =
      /verifyToken|auth\b|router\.use\(verifyToken|router\.use\(auth|requireControlRoomE2eHarnessSecret|requireCcoAutonomyHarnessEnabled|stripe\.webhooks\.constructEvent/.test(
        `${beforeLineText}\n${call}`
      )
        ? "yes"
        : "no/public";
    const approved = /requireApproved|requireApprovedUser|router\.use\(requireApproved/.test(`${beforeLineText}\n${call}`)
      ? "yes"
      : "no/public-or-special";
    const roleMatch = `${beforeLineText}\n${call}`.match(/requireRole\(([^)]*)\)/);
    const role = roleMatch ? roleMatch[1].replace(/\s+/g, " ").trim() : "none/implicit";
    const csrf = /csrfProtection|protectMutations|mutatingGuards|csrfMiddleware/.test(call) || hasBefore(src, line, /router\.use\(protectMutations\)/);
    const rateLimit =
      /rateLimit|mutatingGuards|protectMutations/.test(call) || fileRateLimitNotes[file] || "App-level /api limit where mounted.";
    const audit = /AuditLog|logAction|publishEvent|publishEventSafe|audit/i.test(call) ? "yes/in-route" : "not detected";
    const classification = classify(file, call, beforeLineText);
    const status = rowStatus({ csrf, classification, file, call });
    rows.push({
      method,
      routePath,
      file,
      line,
      mount: mountByFile[file] || "(mount not mapped)",
      auth,
      approved,
      role,
      csrf: csrf ? "yes" : "no",
      csrfNote: csrfNote({ csrf, status, classification, file }),
      rateLimit,
      audit,
      classification,
      status,
      evidence: `${file}:${line}`,
    });
  }
}

const counts = rows.reduce((acc, row) => {
  acc[row.status] = (acc[row.status] || 0) + 1;
  return acc;
}, {});

const open = rows.filter((row) => row.status === "open");
const exempt = rows.filter((row) => row.status.startsWith("exempt"));

const lines = [];
lines.push("# LPC Route Security Inventory");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("Scope: every `router.post`, `router.put`, `router.patch`, and `router.delete` declaration under `backend/routes`. This is a static inventory; route groups with `router.use(...)` middleware are detected heuristically and should be reviewed when a route is marked `open` or `exempt-review`.");
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push(`- Total mutating routes inventoried: ${rows.length}`);
lines.push(`- Verified CSRF/protected: ${counts.verified || 0}`);
lines.push(`- Open security review items: ${counts.open || 0}`);
lines.push(`- CSRF-exempt or exemption-review items: ${(counts.exempt || 0) + (counts["exempt-review"] || 0)}`);
lines.push("");
lines.push("## Open Items");
lines.push("");
if (!open.length) {
  lines.push("No open mutating routes detected by the static inventory.");
} else {
  lines.push("| Method | Full route | File | Auth | Role/approval | CSRF | Rate limiting | Audit | Class | Status | Evidence |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of open) {
    lines.push(
      `| ${row.method} | ${mdEscape(row.mount + row.routePath)} | ${mdEscape(row.file + ":" + row.line)} | ${mdEscape(row.auth)} | ${mdEscape(`${row.role}; approved=${row.approved}`)} | ${mdEscape(row.csrfNote)} | ${mdEscape(row.rateLimit)} | ${mdEscape(row.audit)} | ${mdEscape(row.classification)} | ${row.status} | ${mdEscape(row.evidence)} |`
    );
  }
}
lines.push("");
lines.push("## CSRF Exemptions / Exemption Review");
lines.push("");
lines.push("| Method | Full route | File | Reason | Status | Evidence |");
lines.push("| --- | --- | --- | --- | --- | --- |");
for (const row of exempt) {
  lines.push(
    `| ${row.method} | ${mdEscape(row.mount + row.routePath)} | ${mdEscape(row.file + ":" + row.line)} | ${mdEscape(row.csrfNote)} | ${row.status} | ${mdEscape(row.evidence)} |`
  );
}
lines.push("");
lines.push("## Full Inventory");
lines.push("");
lines.push("| Method | Full route | File | Auth | Role/approval | CSRF | Rate limiting | Audit logging | Class | Status | Verification evidence |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) {
  lines.push(
    `| ${row.method} | ${mdEscape(row.mount + row.routePath)} | ${mdEscape(row.file + ":" + row.line)} | ${mdEscape(row.auth)} | ${mdEscape(`${row.role}; approved=${row.approved}`)} | ${mdEscape(row.csrfNote)} | ${mdEscape(row.rateLimit)} | ${mdEscape(row.audit)} | ${mdEscape(row.classification)} | ${row.status} | ${mdEscape(row.evidence)} |`
  );
}
lines.push("");

fs.writeFileSync(outFile, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ outFile, total: rows.length, counts, open: open.length, exemptions: exempt.length }, null, 2));
