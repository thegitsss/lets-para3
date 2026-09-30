const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PATCH_RECIPES } = require("../services/incidents/patchService");
const { runNotificationUiVerification } = require("../services/incidents/verificationService");

const relativeFile = "frontend/assets/scripts/utils/notifications.js";
let worktreePath;
let repaired;

beforeAll(() => {
  worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-notification-repair-test-"));
  const target = path.join(worktreePath, relativeFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "../..", relativeFile), target);
  PATCH_RECIPES.find(recipe => recipe.key === "notifications.style-injection").execute({ worktreePath });
  repaired = fs.readFileSync(target, "utf8");
});
afterAll(() => { if (worktreePath) fs.rmSync(worktreePath, { recursive: true, force: true }); });

test("the actual notification recipe initializes successfully and repeated registration creates one style", () => {
  expect(runNotificationUiVerification(repaired)).toMatchObject({ ok: true, missing: [] });
});

test("the verifier rejects the audited undefined identifier even when every old string check passes", () => {
  const broken = repaired.replace('  const NOTIFICATION_STYLE_ID = "lpc-notification-fade-styles";\n', "");
  const result = runNotificationUiVerification(broken);
  expect(result.ok).toBe(false);
  expect(result.checks.filter(check => !["runtime-registration", "idempotent-registration"].includes(check.key)).every(check => check.passed)).toBe(true);
  expect(result.missing.join(" ")).toContain("NOTIFICATION_STYLE_ID is not defined");
});

test("a duplicate registration cannot pass simply because the expected strings remain in comments", () => {
  const broken = repaired.replace("if (document.getElementById(NOTIFICATION_STYLE_ID)) return;", "// if (document.getElementById(NOTIFICATION_STYLE_ID)) return;");
  const result = runNotificationUiVerification(broken);
  expect(result.ok).toBe(false);
  expect(result.checks.find(check => check.key === "idempotent-registration").passed).toBe(false);
});

test("a runtime error elsewhere in the generated notification module blocks acceptance", () => {
  expect(runNotificationUiVerification(`${repaired}\nthrow new Error('startup regression');`)).toMatchObject({ ok: false });
});
