const fs = require("fs");
const path = require("path");
const {
  parseDependabot,
  validateCodeowners,
  validateDependabot,
  validateNpmConfiguration,
  validatePackageScripts,
} = require("../scripts/check-repository-policy");

const repositoryRoot = path.resolve(__dirname, "../..");

describe("repository policy contract", () => {
  test("the current candidate protects every file and monitors both dependency ecosystems", () => {
    const codeowners = fs.readFileSync(path.join(repositoryRoot, ".github/CODEOWNERS"), "utf8");
    const dependabot = fs.readFileSync(path.join(repositoryRoot, ".github/dependabot.yml"), "utf8");
    const npmrc = fs.readFileSync(path.join(repositoryRoot, "backend/.npmrc"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "backend/package.json"), "utf8"));
    expect(validateCodeowners(codeowners)).toEqual({ owners: 1 });
    expect(validateDependabot(parseDependabot(dependabot))).toEqual({ ecosystems: 2 });
    expect(validateNpmConfiguration(npmrc)).toEqual({ npmSettings: 3 });
    expect(validatePackageScripts(packageJson)).toEqual({ packageScriptPolicies: 5 });
  });

  test("rejects CODEOWNERS policies that let new files bypass review", () => {
    expect(() => validateCodeowners("/backend/routes/ @owner\n")).toThrow(/root catch-all/);
  });

  test("rejects missing or under-scheduled dependency ecosystems", () => {
    const config = parseDependabot(
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /backend\n    schedule:\n      interval: monthly\n    labels: [dependencies, security]\n    open-pull-requests-limit: 5\n"
    );
    expect(() => validateDependabot(config)).toThrow(/GitHub Actions/);

    config.updates.push({
      "package-ecosystem": "github-actions",
      directory: "/",
      schedule: { interval: "weekly" },
      labels: ["dependencies", "security"],
    });
    expect(() => validateDependabot(config)).toThrow(/at least weekly/);
  });

  test("rejects implicit audit submission or package-manager drift", () => {
    expect(() => validateNpmConfiguration("engine-strict=false\naudit=true\nfund=false\n")).toThrow(
      /runtime drift/
    );
    expect(() => validateNpmConfiguration("engine-strict=true\naudit=true\nfund=false\n")).toThrow(
      /implicit install-time audit/
    );
  });

  test("rejects theatrical health checks and incomplete release chains", () => {
    const base = {
      scripts: {
        "check:backend-reachability": "node scripts/check-backend-reachability.js",
        "check:candidate": "node scripts/check-release-candidate.js",
        "verify:production": "node scripts/verify-production-surface.js",
        "test:ci": "npm run check:backend-reachability",
        "migrate:production:apply": "npm run migrate:profile-urls:apply",
        "release:verify": "npm run check:candidate && npm test",
      },
    };
    expect(validatePackageScripts(base)).toEqual({ packageScriptPolicies: 5 });
    expect(() =>
      validatePackageScripts({ ...base, scripts: { ...base.scripts, health: `node -e "console.log('ok')"` } })
    ).toThrow(/only prints success/);
    expect(() =>
      validatePackageScripts({ ...base, scripts: { ...base.scripts, "test:ci": "npm test" } })
    ).toThrow(/runtime reachability/);
    expect(() =>
      validatePackageScripts({ ...base, scripts: { ...base.scripts, "release:verify": "npm test" } })
    ).toThrow(/dirty or mismatched candidate/);
    expect(() =>
      validatePackageScripts({ ...base, scripts: { ...base.scripts, "verify:production": "" } })
    ).toThrow(/post-deploy production-surface gate/);
  });
});
