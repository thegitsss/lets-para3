const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPolicy() {
  const filePath = path.resolve(__dirname, "../../frontend/assets/scripts/utils/navigation-url.js");
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(/export function /g, "function ")
    .concat("\nmodule.exports = { normalizeHttpNavigationUrl, normalizeSameOriginPath };\n");
  const sandbox = { module: { exports: {} }, exports: {}, URL };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

const { normalizeHttpNavigationUrl, normalizeSameOriginPath } = loadPolicy();
const baseOrigin = "https://app.lets-paraconnect.com";

describe("browser navigation URL policy", () => {
  test("rejects executable, credential-bearing, cross-origin return, and control-character URLs", () => {
    expect(normalizeSameOriginPath("javascript:alert(1)", { baseOrigin })).toBe("");
    expect(normalizeSameOriginPath("https://evil.example/", { baseOrigin })).toBe("");
    expect(normalizeHttpNavigationUrl("https://user:secret@example.com/", { baseOrigin })).toBe("");
    expect(normalizeHttpNavigationUrl("https://example.com/a\u0000b", { baseOrigin })).toBe("");
  });

  test("normalizes same-origin paths without returning an absolute redirect", () => {
    expect(normalizeSameOriginPath("/dashboard-attorney.html?caseId=1#cases", { baseOrigin })).toBe(
      "/dashboard-attorney.html?caseId=1#cases"
    );
  });

  test("enforces provider host allowlists", () => {
    expect(
      normalizeHttpNavigationUrl("https://billing.stripe.com/p/session", {
        baseOrigin,
        allowedHosts: ["billing.stripe.com"],
      })
    ).toBe("https://billing.stripe.com/p/session");
    expect(
      normalizeHttpNavigationUrl("https://billing.stripe.com.evil.example/p/session", {
        baseOrigin,
        allowedHosts: ["billing.stripe.com"],
      })
    ).toBe("");
  });
});
