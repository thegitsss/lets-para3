const path = require("path");
const {
  enrichMissingLicenses,
  manifestLicenseEntries,
  npmInvocation,
  npmTreeInvocation,
  validateProductionTree,
  validateSbom,
} = require("../scripts/generate-production-sbom");

describe("production SBOM contract", () => {
  test("normalizes legacy package-manifest license declarations", () => {
    expect(manifestLicenseEntries({ license: "MIT" })).toEqual([{ license: { id: "MIT" } }]);
    expect(
      manifestLicenseEntries({ licenses: [{ type: "MIT" }, { type: "MIT" }, { type: "ISC" }] })
    ).toEqual([{ license: { id: "MIT" } }, { license: { id: "ISC" } }]);
    expect(manifestLicenseEntries({})).toEqual([]);
  });

  test("does not trust package paths outside node_modules", () => {
    const sbom = {
      components: [
        {
          name: "backend",
          version: "1.0.0",
          properties: [{ name: "cdx:npm:package:path", value: "package.json" }],
        },
      ],
    };
    expect(enrichMissingLicenses(sbom, path.resolve(__dirname, ".."))).toEqual({ enriched: 0 });
    expect(sbom.components[0].licenses).toBeUndefined();
  });

  test("accepts a CycloneDX 1.5 backend dependency graph", () => {
    expect(
      validateSbom({
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        metadata: { component: { name: "backend" } },
        components: [{ name: "express" }],
        dependencies: [{ ref: "backend@1.0.0", dependsOn: ["express"] }],
      })
    ).toEqual({ components: 1, dependencies: 1 });
  });

  test("rejects incomplete documents and ambiguous npm execution", () => {
    expect(() => validateSbom({ bomFormat: "CycloneDX", specVersion: "1.4" })).toThrow(/1\.5/);
    expect(() => npmInvocation({})).toThrow(/through npm/);

    const invocation = npmInvocation({ npm_execpath: path.resolve("/tmp/npm-cli.js") });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.resolve("/tmp/npm-cli.js"),
      "sbom",
      "--omit=dev",
      "--sbom-format=cyclonedx",
    ]);
    expect(npmTreeInvocation({ npm_execpath: path.resolve("/tmp/npm-cli.js") }).args).toEqual([
      path.resolve("/tmp/npm-cli.js"),
      "ls",
      "--omit=dev",
      "--all",
      "--json",
    ]);
  });

  test("rejects extraneous, missing, or otherwise invalid installed production trees", () => {
    expect(validateProductionTree({ name: "backend" }, 0)).toEqual({ problems: 0 });
    expect(() => validateProductionTree({
      problems: ["extraneous: retired-runtime@1.0.0 node_modules/retired-runtime"],
    }, 1)).toThrow(/production dependency tree is not clean/i);
    expect(() => validateProductionTree({}, 1)).toThrow(/npm ls exited with status 1/i);
  });
});
