const { parseExactPackageManager, validateRuntimeVersions } = require("../scripts/verify-runtime");

describe("runtime policy", () => {
  test("requires an exact npm packageManager pin", () => {
    expect(parseExactPackageManager("npm@11.16.0")).toBe("11.16.0");
    expect(() => parseExactPackageManager("npm@^11.16.0")).toThrow(/exact npm version/);
    expect(() => parseExactPackageManager("pnpm@10.0.0")).toThrow(/exact npm version/);
  });

  test("accepts the pinned npm version and a security-patched Node minor", () => {
    expect(
      validateRuntimeVersions({
        expectedNode: "24.18.0",
        actualNode: "24.19.1",
        expectedNpm: "11.16.0",
        actualNpm: "11.16.0",
      })
    ).toEqual({ warning: null });
  });

  test("rejects package-manager drift", () => {
    expect(() =>
      validateRuntimeVersions({
        expectedNode: "24.18.0",
        actualNode: "24.18.0",
        expectedNpm: "11.16.0",
        actualNpm: "11.17.0",
      })
    ).toThrow(/npm 11\.16\.0 is required/);
  });

  test("allows only the explicit local Node override", () => {
    expect(
      validateRuntimeVersions({
        expectedNode: "24.18.0",
        actualNode: "22.0.0",
        expectedNpm: "11.16.0",
        actualNpm: "11.16.0",
        allowOlderRuntime: true,
      }).warning
    ).toMatch(/Node 24\.18\.0/);
    expect(() =>
      validateRuntimeVersions({
        expectedNode: "24.18.0",
        actualNode: "22.0.0",
        expectedNpm: "11.16.0",
        actualNpm: "11.16.0",
      })
    ).toThrow(/Node 24\.18\.0/);
  });
});
