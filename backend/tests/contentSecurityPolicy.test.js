const fs = require("fs");
const path = require("path");
const {
  collectInlineScriptHashes,
  inlineScriptBodies,
  sha256Source,
  upgradeInsecureRequestsDirective,
} = require("../utils/contentSecurityPolicy");

const frontendDirectory = path.resolve(__dirname, "../../frontend");

describe("content security policy", () => {
  test("every repository-controlled inline script has an exact CSP hash", () => {
    const hashes = new Set(collectInlineScriptHashes(frontendDirectory));
    let scriptCount = 0;

    for (const name of fs.readdirSync(frontendDirectory)) {
      if (!name.endsWith(".html")) continue;
      const source = fs.readFileSync(path.join(frontendDirectory, name), "utf8");
      for (const body of inlineScriptBodies(source)) {
        scriptCount += 1;
        expect(hashes.has(sha256Source(body))).toBe(true);
      }
    }

    expect(scriptCount).toBeGreaterThan(0);
    expect(hashes.size).toBeGreaterThan(0);
  });

  test("frontend HTML does not use inline event handlers", () => {
    for (const name of fs.readdirSync(frontendDirectory)) {
      if (!name.endsWith(".html")) continue;
      const source = fs.readFileSync(path.join(frontendDirectory, name), "utf8");
      expect(source).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    }
  });

  test("HTTP development remains usable in Safari while production upgrades insecure requests", () => {
    expect(upgradeInsecureRequestsDirective(false)).toBeNull();
    expect(upgradeInsecureRequestsDirective(true)).toEqual([]);
  });
});
