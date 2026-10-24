#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const { SUPPORTED_STRIPE_API_VERSION } = require("../utils/productionOrigin");
const {
  MONGO_RECONCILIATION_OPTIONS,
  assertDryRunArguments,
  createMongoRetrievalFacade,
  createStripeRetrievalFacade,
  resolvePrivateOutputPath,
  validateReconciliationEnvironment,
  verifyMongoReadOnlyIdentity,
} = require("../services/reconciliationPreflightService");
const {
  runProductionFundingReconciliation,
} = require("../services/productionFundingReconciliationService");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");

function createRestrictedStripeFacade(key, mode, expectedAccountFingerprint) {
  const client = new Stripe(key, {
    apiVersion: process.env.STRIPE_API_VERSION || SUPPORTED_STRIPE_API_VERSION,
    maxNetworkRetries: 1,
    telemetry: false,
    timeout: 20_000,
  });
  return createStripeRetrievalFacade({ client, mode, expectedAccountFingerprint });
}

function writePrivateReport(outputPath, report, fileSystem = fs) {
  const descriptor = fileSystem.openSync(outputPath, "wx", 0o600);
  try {
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

async function execute({
  args = process.argv.slice(2),
  env = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  createConnection = () => mongoose.createConnection(),
  outputWriter = writePrivateReport,
  stdout = process.stdout,
} = {}) {
  const { outputPath } = assertDryRunArguments(args);
  const configuration = validateReconciliationEnvironment(env);
  const privateOutputPath = resolvePrivateOutputPath(outputPath, repositoryRoot);

  const stripeFacades = {
    test: createRestrictedStripeFacade(
      configuration.stripeTestKey,
      "test",
      configuration.stripeAccountFingerprint
    ),
    live: createRestrictedStripeFacade(
      configuration.stripeLiveKey,
      "live",
      configuration.stripeAccountFingerprint
    ),
  };

  const connection = createConnection();
  try {
    await connection.openUri(configuration.mongoUri, MONGO_RECONCILIATION_OPTIONS);
    await verifyMongoReadOnlyIdentity(connection, configuration);
    const mongo = createMongoRetrievalFacade(connection);
    const report = await runProductionFundingReconciliation({ mongo, stripeFacades });
    outputWriter(privateOutputPath, report);
    stdout.write(`${JSON.stringify({
      completed: true,
      authoritative: report.authoritative,
      outputWritten: true,
      futureBackfillEligibleCount: report.futureBackfill.eligibleCount,
      manualReviewCount: report.futureBackfill.manualReviewCount,
    })}\n`);
    return report;
  } finally {
    await connection.close().catch(() => {});
  }
}

if (require.main === module) {
  execute().catch((error) => {
    const code = /^[A-Z0-9_]+$/.test(String(error?.code || ""))
      ? error.code
      : "PRODUCTION_RECONCILIATION_FAILED";
    process.stderr.write(`Production reconciliation stopped safely (${code}).\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REPOSITORY_ROOT,
  execute,
  writePrivateReport,
};
