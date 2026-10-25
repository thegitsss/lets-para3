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

  test("records MIT selection for the two reviewed SPDX alternatives without changing their evidence", () => {
    const evidence = sbomWith([
      component("expand-template", "(MIT OR WTFPL)"),
      component("rc", "(BSD-2-Clause OR MIT OR Apache-2.0)"),
    ]);
    const before = JSON.stringify(evidence);
    expect(validateProductionLicenses(evidence).licenseChoices).toEqual([
      { component: "expand-template@1.0.0", expression: "(MIT OR WTFPL)", selected: "MIT" },
      { component: "rc@1.0.0", expression: "(BSD-2-Clause OR MIT OR Apache-2.0)", selected: "MIT" },
    ]);
    expect(JSON.stringify(evidence)).toBe(before);
  });

  test.each(["WTFPL", "(MIT AND WTFPL)", "(MIT OR AGPL-3.0-only)", "MIT WITH unknown-exception", "(MIT OR WTFPL) trailing"])(
    "keeps unreviewed expression %s closed",
    expression => expect(() => validateProductionLicenses(sbomWith([component("unreviewed", expression)]))).toThrow(/explicit legal review/)
  );
});
