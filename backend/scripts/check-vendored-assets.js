const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "../..");
const cropperRoot = path.join(repositoryRoot, "frontend/assets/libs/cropper");
const EXPECTED = Object.freeze({
  name: "cropperjs",
  version: "2.1.1",
  license: "MIT",
  asset: "dist/cropper.min.js",
  assetSha512:
    "b8401b1afac32e08ca4ff0ea80893dc4eb19adc4f59e7d9cd60700d9267ab8e291317dba475a349e457d2631418a2bddf0bb583158843ca789becd29d2119e79",
  packageIntegrity:
    "sha512-FDJMarkY+/SepYarPZsvkG2LmI2PElecciMFnvBiBIoKnFYua/scprC5qejCLLyuX2jEqJRS2njbAsHxfjtIXA==",
});

function fail(message) {
  const error = new Error(`[vendored-assets] ${message}`);
  error.code = "VENDORED_ASSET_CONTRACT_FAILED";
  throw error;
}

function sha512(source) {
  return crypto.createHash("sha512").update(source).digest("hex");
}

function validateCropperVendor({ manifest, bundle, license, profileHtml, dashboardHtml, deadIntegrationExists }) {
  for (const [field, expected] of Object.entries(EXPECTED)) {
    if (manifest?.[field] !== expected) fail(`Cropper manifest ${field} must equal ${expected}.`);
  }
  if (manifest?.source !== `https://registry.npmjs.org/cropperjs/-/cropperjs-${EXPECTED.version}.tgz`) {
    fail("Cropper manifest must identify the immutable official npm package source.");
  }
  if (!String(bundle).startsWith(`/*! Cropper.js v${EXPECTED.version} |`)) {
    fail("Cropper bundle must retain its upstream version and license banner.");
  }
  if (sha512(bundle) !== EXPECTED.assetSha512) {
    fail("Cropper bundle bytes do not match the independently verified upstream artifact.");
  }
  if (!/^The MIT License \(MIT\)/.test(String(license)) || !String(license).includes("Copyright 2015-present Chen Fengyuan")) {
    fail("Cropper's complete upstream MIT license must ship with the bundle.");
  }
  const scriptReference = `assets/libs/cropper/cropper.main.js?v=${EXPECTED.version}`;
  if (!String(profileHtml).includes(scriptReference)) {
    fail("Profile settings must load the versioned Cropper asset.");
  }
  if (/cropper\.main\.css/.test(String(profileHtml))) {
    fail("The removed Cropper 1.x stylesheet must not be loaded.");
  }
  if (/attorney-settings\.js/.test(String(dashboardHtml)) || deadIntegrationExists) {
    fail("The unreachable duplicate attorney Cropper integration must remain removed.");
  }
  return { assets: 1, version: EXPECTED.version };
}

function main() {
  const result = validateCropperVendor({
    manifest: JSON.parse(fs.readFileSync(path.join(cropperRoot, "vendor.json"), "utf8")),
    bundle: fs.readFileSync(path.join(cropperRoot, "cropper.main.js")),
    license: fs.readFileSync(path.join(cropperRoot, "LICENSE.cropperjs.txt"), "utf8"),
    profileHtml: fs.readFileSync(path.join(repositoryRoot, "frontend/profile-settings.html"), "utf8"),
    dashboardHtml: fs.readFileSync(path.join(repositoryRoot, "frontend/dashboard-attorney.html"), "utf8"),
    deadIntegrationExists: fs.existsSync(path.join(repositoryRoot, "frontend/assets/scripts/attorney-settings.js")),
  });
  console.log(`[vendored-assets] ${result.assets} asset passed (Cropper.js ${result.version}).`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED,
  sha512,
  validateCropperVendor,
};
