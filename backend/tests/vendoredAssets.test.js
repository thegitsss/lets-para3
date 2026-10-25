const fs = require("fs");
const path = require("path");
const { EXPECTED, validateCropperVendor } = require("../scripts/check-vendored-assets");

const repositoryRoot = path.resolve(__dirname, "../..");
const cropperRoot = path.join(repositoryRoot, "frontend/assets/libs/cropper");

function currentFixture() {
  return {
    manifest: JSON.parse(fs.readFileSync(path.join(cropperRoot, "vendor.json"), "utf8")),
    bundle: fs.readFileSync(path.join(cropperRoot, "cropper.main.js")),
    license: fs.readFileSync(path.join(cropperRoot, "LICENSE.cropperjs.txt"), "utf8"),
    profileHtml: fs.readFileSync(path.join(repositoryRoot, "frontend/profile-settings.html"), "utf8"),
    dashboardHtml: fs.readFileSync(path.join(repositoryRoot, "frontend/dashboard-attorney.html"), "utf8"),
    deadIntegrationExists: false,
  };
}

describe("vendored browser asset contract", () => {
  test("accepts the current licensed and byte-verified Cropper artifact", () => {
    expect(validateCropperVendor(currentFixture())).toEqual({ assets: 1, version: EXPECTED.version });
  });

  test("rejects silent bundle, provenance, license, and integration regressions", () => {
    const changedBundle = currentFixture();
    changedBundle.bundle = Buffer.concat([changedBundle.bundle, Buffer.from("\n")]);
    expect(() => validateCropperVendor(changedBundle)).toThrow(/bundle bytes/);

    const changedManifest = currentFixture();
    changedManifest.manifest.version = "1.6.2";
    expect(() => validateCropperVendor(changedManifest)).toThrow(/manifest version/);

    const missingLicense = currentFixture();
    missingLicense.license = "MIT";
    expect(() => validateCropperVendor(missingLicense)).toThrow(/complete upstream MIT license/);

    const staleIntegration = currentFixture();
    staleIntegration.deadIntegrationExists = true;
    expect(() => validateCropperVendor(staleIntegration)).toThrow(/duplicate attorney/);
  });
});
