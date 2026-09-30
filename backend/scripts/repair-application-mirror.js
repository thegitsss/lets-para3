"use strict";

if (require.main === module) require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const service = require("../services/applicationMirrorRepair");
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require("../utils/mongooseOperationPolicy");

const HELP = "Inspect one application mirror: npm run maintenance:application-mirror -- --application=<id> --matter=<id> --owner=<id>\nApply the reviewed repair: add --apply --revision=<inspection revision> --confirm=REPAIR_APPLICATION_MIRROR\nUses MONGO_URI; inspection is the default. Never runs as part of normal application traffic.\n";

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const values = new Map();
  for (const arg of argv) {
    const match = /^(--(?:application|matter|owner|revision|confirm))=(.+)$/.exec(arg);
    const key = match?.[1] || arg;
    if ((!match && arg !== "--apply") || values.has(key)) throw new Error("Invalid or duplicate maintenance argument.");
    values.set(key, match ? match[2] : true);
  }
  const input = { applicationId: values.get("--application"), caseId: values.get("--matter"), ownerId: values.get("--owner") };
  if (Object.values(input).some(value => !/^[a-f0-9]{24}$/i.test(value || ""))) throw new Error("Supply exact application, Matter and attorney owner IDs.");
  const apply = values.has("--apply");
  const revision = values.get("--revision");
  if (apply && (!/^[a-f0-9]{64}$/.test(revision || "") || values.get("--confirm") !== "REPAIR_APPLICATION_MIRROR")) throw new Error("Apply requires the inspection revision and explicit confirmation.");
  if (!apply && (revision || values.has("--confirm"))) throw new Error("Revision and confirmation are accepted only with --apply.");
  return { input, apply, revision };
}

async function run(argv, { mongoUri = process.env.MONGO_URI, database = mongoose, repairService = service } = {}) {
  const options = parseArgs(argv);
  if (options.help) return HELP;
  const uri = requireMongoUri(mongoUri);
  try {
    // Inspection must not create collections or indexes in the selected database.
    await database.connect(uri, { ...MONGO_OPERATION_OPTIONS, autoCreate: false });
    const result = options.apply
      ? await repairService.repair(options.input, options.revision)
      : repairService.summary(await repairService.inspect(options.input));
    // The service summary contains IDs/status/counts/revision, never profile or application text.
    return { mode: options.apply ? "apply" : "inspect", ...result };
  } finally {
    await database.disconnect();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => {
    process.stdout.write(typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    const safeMessage = error.code === "APPLICATION_REPAIR_UNSAFE"
      ? "Repair refused: records are inconsistent or changed after inspection. Review the selected records."
      : "Maintenance command failed. Check arguments and database access; do not assume a repair succeeded.";
    process.stderr.write(`${safeMessage}\nUse --help for usage.\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
