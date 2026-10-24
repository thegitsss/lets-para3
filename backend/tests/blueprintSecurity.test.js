const fs = require("fs");
const path = require("path");
const { parseYaml, validateDeploymentContract } = require("../scripts/check-render-blueprint");
function blueprint() { return parseYaml(fs.readFileSync(path.resolve(__dirname, "../../render.yaml"), "utf8"), "render.yaml"); }
function service(doc, suffix) { return doc.services.find(entry => entry.name === `lets-para3${suffix}`); }
test("prepared Blueprint satisfies the strict deployment contract without deploying", () => {
  expect(() => validateDeploymentContract(blueprint())).not.toThrow();
});
test.each([
  ["", "S3_MALWARE_SCAN_REQUIRED", "false"],
  ["", "REQUIRE_DATA_ENCRYPTION", "false"],
  ["", "S3_LEGACY_UPLOAD_MANIFEST", "/tmp/unreviewed.json"],
  ["-automation", "S3_LEGACY_UPLOAD_MANIFEST", "/tmp/unreviewed.json"],
  ["-ops-monitor", "ATLAS_CLUSTER_TYPE", "replica_set"],
  ["-ops-monitor", "MONITOR_REQUIRE_BACKUP", "false"],
  ["-ops-monitor", "MONITOR_SEND_OWNER_ALERTS", "false"],
])("rejects unsafe configuration %s %s", (suffix, key, value) => {
  const doc = blueprint();
  service(doc, suffix).envVars.find(entry => entry.key === key).value = value;
  expect(() => validateDeploymentContract(doc)).toThrow();
});
test.each(["", "-automation"])("manifest pin is a required secret on %s", suffix => {
  const doc = blueprint();
  const target = service(doc, suffix);
  target.envVars = target.envVars.filter(entry => entry.key !== "S3_LEGACY_UPLOAD_MANIFEST_SHA256");
  expect(() => validateDeploymentContract(doc)).toThrow();
});
