"use strict";

const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(backendRoot, "..");
const scriptsRoot = path.join(backendRoot, "scripts");
const { E2E_SUITES, buildJUnit } = require("../scripts/run-e2e-suite");

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), "utf8");
}

describe("browser runtime and E2E policy", () => {
  test("keeps the production PDF browser available without a redundant postinstall", () => {
    const manifest = JSON.parse(read("package.json"));
    const lockfile = JSON.parse(read("package-lock.json"));

    expect(manifest.dependencies?.puppeteer).toBe("^25.7.0");
    expect(manifest.devDependencies?.puppeteer).toBeUndefined();
    expect(manifest.devDependencies?.playwright).toBe("^1.58.2");
    expect(manifest.scripts?.postinstall).toBeUndefined();
    expect(manifest.allowScripts?.["puppeteer@25.7.0"]).toBe(true);
    expect(lockfile.packages?.[""]?.dependencies?.puppeteer).toBe("^25.7.0");
    expect(lockfile.packages?.["node_modules/puppeteer"]?.dev).not.toBe(true);
    expect(fs.existsSync(path.join(scriptsRoot, "install-puppeteer-browser.js"))).toBe(false);
  });

  test("uses one production browser launcher and an existing receipt logo", () => {
    const lifecycle = read("services/caseLifecycle.js");
    const browserRuntime = read("utils/puppeteerBrowser.js");

    expect(lifecycle).toContain('require("../utils/puppeteerBrowser")');
    expect(lifecycle).not.toMatch(/puppeteer\.launch|import\(["']puppeteer["']\)/);
    expect(browserRuntime.match(/puppeteer\.launch/g)).toHaveLength(1);
    expect(lifecycle).toContain('"Cleanfav.png"');
    expect(fs.existsSync(path.join(repositoryRoot, "frontend", "Cleanfav.png"))).toBe(true);
  });

  test("browser E2E flows use the shared launcher and real pointer interactions", () => {
    const browserScripts = fs.readdirSync(scriptsRoot)
      .filter((name) => /^e2e-.*\.js$/.test(name))
      .map((name) => ({ name, source: read(`scripts/${name}`) }))
      .filter(({ source }) => source.includes("launchPuppeteer("));

    expect(browserScripts.length).toBeGreaterThan(0);
    for (const { name, source } of browserScripts) {
      expect(source).toContain('require("./puppeteerBrowser")');
      expect(source).not.toMatch(/require\(["']puppeteer["']\)|puppeteer\.launch/);
      expect(source).not.toMatch(/ElementHandle\.prototype\.click|__safeClickPatched|function\s+safeClick/);
      expect(source).not.toMatch(/page\.evaluate\([\s\S]{0,500}?\.click\(/);
      expect(source).not.toMatch(/page\.evaluate\([\s\S]{0,1200}?\/withdraw/);
      expect(source).not.toMatch(/dispatchEvent\s*\(|requestSubmit\s*\(|\.submit\s*\(/);
      expect(name).toMatch(/^e2e-/);
    }
  });

  test("critical release verification includes both Attorney generations and retains V2 evidence", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["test:playwright:critical"]).toContain("npm run test:playwright:support");
    expect(scripts["test:playwright:critical"]).toContain("npm run test:playwright:attorney-v2");
    expect(scripts["test:playwright:attorney-v2"]).toContain("tests/playwright/attorney-v2/playwright.config.js");
    expect(scripts["test:playwright:attorney-v2"]).toContain("--fail-on-flaky-tests");
    expect(read("tests/playwright/attorney-v2/playwright.config.js")).toContain('buildPlaywrightReporters("playwright-attorney-v2")');
  });

  test("the aggregate E2E command includes every launch journey and emits JUnit", () => {
    const manifest = JSON.parse(read("package.json"));
    expect(manifest.scripts?.["test:e2e"]).toBe("node scripts/run-e2e-suite.js");
    expect(E2E_SUITES).toEqual([
      "e2e-auth.js",
      "e2e-profile.js",
      "e2e-validation.js",
      "e2e-job-escrow.js",
      "e2e-matching.js",
      "e2e-messaging.js",
      "e2e-admin.js",
      "e2e-error-handling.js",
      "e2e-payouts.js",
      "e2e-attorney-onboarding.js",
      "e2e-paralegal-tour.js",
      "e2e-case-realtime.js",
      "e2e-withdrawal-flow.js",
    ]);
    for (const suite of E2E_SUITES) {
      expect(fs.existsSync(path.join(scriptsRoot, suite))).toBe(true);
    }
    expect(buildJUnit([
      { name: "example.js", passed: true, seconds: 0.25, message: "", output: "ok" },
    ])).toContain('<testsuite name="LPC full E2E" tests="1" failures="0"');
  });
});
