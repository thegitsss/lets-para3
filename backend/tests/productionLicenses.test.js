const { validateProductionLicenses } = require("../scripts/check-production-licenses");

function sbomWith(components) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    components,
  };
}

function component(name, license) {
  return {
    name,
    version: "1.0.0",
    licenses: license ? [{ license: { id: license } }] : [],
  };
}

describe("production dependency license policy", () => {
  test("accepts only the explicitly reviewed permissive production licenses", () => {
    expect(
      validateProductionLicenses(
        sbomWith([
          component("alpha", "MIT"),
          component("beta", "Apache-2.0"),
          component("gamma", "BSD-3-Clause"),
        ])
      )
    ).toEqual({
      components: 3,
      licenses: { "Apache-2.0": 1, "BSD-3-Clause": 1, MIT: 1 },
    });
  });

  test("fails closed for missing, unreviewed, or malformed license evidence", () => {
    expect(() => validateProductionLicenses(sbomWith([component("missing")]))).toThrow(/missing license metadata/);
    expect(() => validateProductionLicenses(sbomWith([component("copyleft", "AGPL-3.0-only")]))).toThrow(
      /explicit legal review/
    );
    expect(() => validateProductionLicenses({ bomFormat: "CycloneDX", specVersion: "1.4" })).toThrow(/1\.5/);
  });
});
