"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT = "production-retrieval-only";
const MONGO_RECONCILIATION_OPTIONS = Object.freeze({
  serverSelectionTimeoutMS: 15_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 60_000,
  maxPoolSize: 3,
  autoIndex: false,
  autoCreate: false,
  readPreference: "primary",
  readConcern: Object.freeze({ level: "majority" }),
  retryWrites: false,
});

const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  "MONGODB_RECONCILE_READONLY_URI",
  "MONGODB_RECONCILE_EXPECTED_DATABASE",
  "STRIPE_RECONCILE_TEST_KEY",
  "STRIPE_RECONCILE_LIVE_KEY",
  "STRIPE_RECONCILE_EXPECTED_ACCOUNT_FINGERPRINT",
]);

const MONGO_RETRIEVAL_ACTIONS = new Set([
  "changeStream",
  "collStats",
  "dbHash",
  "dbStats",
  "find",
  "killCursors",
  "listCollections",
  "listDatabases",
  "listIndexes",
  "listSearchIndexes",
  "planCacheRead",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function argumentValue(name, args = process.argv.slice(2)) {
  const prefix = `${name}=`;
  const match = args.find((value) => String(value).startsWith(prefix));
  return match ? String(match).slice(prefix.length) : "";
}

function assertDryRunArguments(args = process.argv.slice(2)) {
  const forbidden = args.find((value) =>
    value === "--apply" ||
    String(value).startsWith("--apply=") ||
    value === "--confirm" ||
    String(value).startsWith("--confirm=") ||
    value === "--expected-records" ||
    String(value).startsWith("--expected-records=")
  );
  if (forbidden) {
    throw safeError("The production reconciliation dry run rejects every apply-mode argument.", "DRY_RUN_APPLY_ARGUMENT_REJECTED");
  }
  const unexpected = args.find((value) =>
    !String(value).startsWith("--acknowledge=") && !String(value).startsWith("--output=")
  );
  if (unexpected) {
    throw safeError("The production reconciliation dry run received an unsupported argument.", "DRY_RUN_ARGUMENT_REJECTED");
  }
  if (argumentValue("--acknowledge", args) !== PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT) {
    throw safeError(
      `Dry run requires --acknowledge=${PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT}.`,
      "PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT_REQUIRED"
    );
  }
  const outputPath = argumentValue("--output", args);
  if (!outputPath) {
    throw safeError("Dry run requires an absolute --output path outside the repository.", "RECONCILIATION_OUTPUT_REQUIRED");
  }
  return { outputPath };
}

function resolvePrivateOutputPath(outputPath, repositoryRoot) {
  if (!path.isAbsolute(String(outputPath || ""))) {
    throw safeError("The reconciliation output path must be absolute.", "RECONCILIATION_OUTPUT_NOT_ABSOLUTE");
  }
  const root = fs.realpathSync(String(repositoryRoot || process.cwd()));
  const parent = fs.realpathSync(path.dirname(outputPath));
  const resolved = path.join(parent, path.basename(outputPath));
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw safeError("Detailed reconciliation output cannot be written inside the repository.", "RECONCILIATION_OUTPUT_INSIDE_REPOSITORY");
  }
  if (fs.existsSync(resolved)) {
    throw safeError("The reconciliation output path already exists and will not be overwritten.", "RECONCILIATION_OUTPUT_EXISTS");
  }
  return resolved;
}

function parseMongoIdentity(uri) {
  const raw = String(uri || "").trim();
  const schemeMatch = raw.match(/^(mongodb(?:\+srv)?):\/\//i);
  if (!schemeMatch) throw safeError("The reconciliation MongoDB URI is invalid.", "MONGODB_RECONCILE_URI_INVALID");
  const remainder = raw.slice(schemeMatch[0].length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex < 0) throw safeError("The reconciliation MongoDB URI must name one database.", "MONGODB_DATABASE_REQUIRED");
  const authority = remainder.slice(0, slashIndex);
  const pathAndQuery = remainder.slice(slashIndex + 1);
  const databaseName = decodeURIComponent(pathAndQuery.split(/[?]/, 1)[0] || "").trim();
  const hostMaterial = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const hosts = hostMaterial
    .split(",")
    .map((entry) => entry.trim().replace(/^\[/, "").replace(/\](?::\d+)?$/, "").replace(/:\d+$/, "").toLowerCase())
    .filter(Boolean)
    .sort();
  if (!hosts.length || !databaseName) {
    throw safeError("The reconciliation MongoDB URI has an ambiguous server or database identity.", "MONGODB_IDENTITY_AMBIGUOUS");
  }
  return {
    scheme: schemeMatch[1].toLowerCase(),
    hosts,
    hostFingerprint: sha256(hosts.join(",")),
    databaseName,
  };
}

function assertProductionMongoIdentity(identity, expected = {}) {
  const rejectedHost = identity.hosts.some((host) =>
    /(^|\.)(localhost|local|development|dev|staging|stage|test|sandbox|demo)(\.|$)|^127\.|^0\.0\.0\.0$|^::1$/i.test(host)
  );
  if (rejectedHost) {
    throw safeError("Localhost and non-production MongoDB identities are rejected.", "MONGODB_NON_PRODUCTION_IDENTITY");
  }
  if (/^(admin|config|local|test)$|(?:^|[-_])(dev|development|staging|stage|test|sandbox|demo)(?:$|[-_])/i.test(identity.databaseName)) {
    throw safeError("The configured MongoDB database is not an approved production identity.", "MONGODB_NON_PRODUCTION_DATABASE");
  }
  if (!expected.databaseName || identity.databaseName !== expected.databaseName) {
    throw safeError("The configured MongoDB database does not match the expected production database.", "MONGODB_DATABASE_IDENTITY_MISMATCH");
  }
  const expectedHost = String(expected.host || "").trim().toLowerCase();
  const expectedFingerprint = String(expected.hostFingerprint || "").trim().toLowerCase();
  if (!expectedHost && !expectedFingerprint) {
    throw safeError("An approved MongoDB cluster hostname or fingerprint is required.", "MONGODB_CLUSTER_IDENTITY_REQUIRED");
  }
  if (expectedHost && !identity.hosts.includes(expectedHost)) {
    throw safeError("The MongoDB cluster hostname does not match the approved identity.", "MONGODB_CLUSTER_IDENTITY_MISMATCH");
  }
  if (expectedFingerprint && identity.hostFingerprint !== expectedFingerprint) {
    throw safeError("The MongoDB cluster fingerprint does not match the approved identity.", "MONGODB_CLUSTER_IDENTITY_MISMATCH");
  }
  return true;
}

function assertRestrictedStripeKey(key, expectedMode) {
  const raw = String(key || "").trim();
  const expectedPrefix = `rk_${expectedMode}_`;
  if (!raw.startsWith(expectedPrefix) || raw.length <= expectedPrefix.length) {
    throw safeError(
      `A restricted ${expectedMode}-mode Stripe reconciliation key is required.`,
      `STRIPE_${expectedMode.toUpperCase()}_RESTRICTED_KEY_REQUIRED`
    );
  }
  return raw;
}

function validateReconciliationEnvironment(env = process.env) {
  for (const key of REQUIRED_ENVIRONMENT_KEYS) {
    if (!String(env[key] || "").trim()) {
      throw safeError(`Missing required reconciliation configuration: ${key}.`, "RECONCILIATION_CONFIGURATION_MISSING");
    }
  }
  const mongoIdentity = parseMongoIdentity(env.MONGODB_RECONCILE_READONLY_URI);
  assertProductionMongoIdentity(mongoIdentity, {
    databaseName: String(env.MONGODB_RECONCILE_EXPECTED_DATABASE || "").trim(),
    host: String(env.MONGODB_RECONCILE_EXPECTED_HOST || "").trim(),
    hostFingerprint: String(env.MONGODB_RECONCILE_EXPECTED_HOST_FINGERPRINT || "").trim(),
  });
  const testKey = assertRestrictedStripeKey(env.STRIPE_RECONCILE_TEST_KEY, "test");
  const liveKey = assertRestrictedStripeKey(env.STRIPE_RECONCILE_LIVE_KEY, "live");
  if (testKey === liveKey) {
    throw safeError("Test and live Stripe reconciliation keys must be separate.", "STRIPE_MODE_KEY_SUBSTITUTION_REJECTED");
  }
  const accountFingerprint = String(env.STRIPE_RECONCILE_EXPECTED_ACCOUNT_FINGERPRINT || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(accountFingerprint)) {
    throw safeError("The expected Stripe account fingerprint must be a SHA-256 value.", "STRIPE_ACCOUNT_FINGERPRINT_INVALID");
  }
  return {
    mongoUri: String(env.MONGODB_RECONCILE_READONLY_URI).trim(),
    mongoIdentity,
    expectedDatabase: String(env.MONGODB_RECONCILE_EXPECTED_DATABASE).trim(),
    expectedHost: String(env.MONGODB_RECONCILE_EXPECTED_HOST || "").trim().toLowerCase(),
    expectedHostFingerprint: String(env.MONGODB_RECONCILE_EXPECTED_HOST_FINGERPRINT || "").trim().toLowerCase(),
    stripeTestKey: testKey,
    stripeLiveKey: liveKey,
    stripeAccountFingerprint: accountFingerprint,
  };
}

function assertAllowedOptions(options, allowedKeys, resource) {
  const keys = Object.keys(options || {});
  const unexpected = keys.find((key) => !allowedKeys.includes(key));
  if (unexpected) throw safeError(`Unsupported ${resource} retrieval option.`, "STRIPE_RETRIEVAL_OPTION_REJECTED");
}

function assertAllowedExpansions(options, allowed, resource) {
  assertAllowedOptions(options, ["expand"], resource);
  const expansions = Array.isArray(options?.expand) ? options.expand : [];
  if (expansions.some((entry) => !allowed.includes(String(entry)))) {
    throw safeError(`Unsupported ${resource} expansion.`, "STRIPE_RETRIEVAL_EXPANSION_REJECTED");
  }
}

function assertStripeObjectMode(value, expectedMode) {
  const expectedLivemode = expectedMode === "live";
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    if (typeof candidate.livemode === "boolean" && candidate.livemode !== expectedLivemode) {
      throw safeError("Stripe object mode contradicts the selected reconciliation facade.", "STRIPE_OBJECT_MODE_MISMATCH");
    }
    if (Array.isArray(candidate.data)) candidate.data.forEach(visit);
  };
  visit(value);
  return value;
}

function objectId(value) {
  return String(value?.id || value || "");
}

function minimalBalanceTransaction(value) {
  if (!value || typeof value !== "object") return objectId(value);
  return Object.freeze({
    id: objectId(value),
    type: String(value.type || ""),
    amount: Number(value.amount),
    fee: Number(value.fee),
    net: Number(value.net),
    currency: String(value.currency || ""),
    source: objectId(value.source),
    ...(typeof value.livemode === "boolean" ? { livemode: value.livemode } : {}),
  });
}

function minimalCharge(value) {
  if (!value || typeof value !== "object") return objectId(value);
  return Object.freeze({
    id: objectId(value),
    amount: Number(value.amount),
    amount_refunded: Number(value.amount_refunded || 0),
    currency: String(value.currency || ""),
    paid: value.paid === true,
    captured: value.captured === true,
    refunded: value.refunded === true,
    disputed: value.disputed === true,
    livemode: value.livemode === true,
    payment_intent: objectId(value.payment_intent),
    balance_transaction: minimalBalanceTransaction(value.balance_transaction),
  });
}

function minimalPaymentIntent(value) {
  const charges = Array.isArray(value?.charges?.data)
    ? value.charges.data.map(minimalCharge)
    : [];
  return Object.freeze({
    id: objectId(value),
    status: String(value?.status || ""),
    amount: Number(value?.amount),
    amount_received: Number(value?.amount_received),
    currency: String(value?.currency || ""),
    livemode: value?.livemode === true,
    metadata: Object.freeze({ caseId: String(value?.metadata?.caseId || "") }),
    transfer_group: String(value?.transfer_group || ""),
    latest_charge: minimalCharge(value?.latest_charge),
    charges: Object.freeze({ data: Object.freeze(charges) }),
  });
}

function minimalRefund(value) {
  return Object.freeze({
    id: objectId(value),
    amount: Number(value?.amount),
    currency: String(value?.currency || ""),
    status: String(value?.status || ""),
    livemode: value?.livemode === true,
    charge: objectId(value?.charge),
    payment_intent: objectId(value?.payment_intent),
  });
}

function minimalDispute(value) {
  return Object.freeze({
    id: objectId(value),
    amount: Number(value?.amount),
    currency: String(value?.currency || ""),
    status: String(value?.status || ""),
    livemode: value?.livemode === true,
    charge: objectId(value?.charge),
  });
}

function minimalTransfer(value) {
  return Object.freeze({
    id: objectId(value),
    amount: Number(value?.amount),
    amount_reversed: Number(value?.amount_reversed || 0),
    currency: String(value?.currency || ""),
    livemode: value?.livemode === true,
    reversed: value?.reversed === true,
    transfer_group: String(value?.transfer_group || ""),
  });
}

function minimalList(value, mapper) {
  return Object.freeze({
    data: Object.freeze((Array.isArray(value?.data) ? value.data : []).map(mapper)),
    has_more: value?.has_more === true,
  });
}

function frozenMethods(methods) {
  return Object.freeze(methods);
}

function createStripeRetrievalFacade({ client, mode, expectedAccountFingerprint }) {
  if (!client || !["test", "live"].includes(mode)) {
    throw safeError("A mode-bound Stripe retrieval client is required.", "STRIPE_FACADE_CONFIGURATION_INVALID");
  }
  const invoke = async (fn, args, resource) => {
    if (typeof fn !== "function") throw safeError(`Stripe ${resource} retrieval is unavailable.`, "STRIPE_RETRIEVAL_UNAVAILABLE");
    try {
      return assertStripeObjectMode(await fn(...args), mode);
    } catch (error) {
      if (error?.code && String(error.code).startsWith("STRIPE_")) throw error;
      throw safeError(`Stripe ${mode}-mode ${resource} retrieval failed.`, "STRIPE_RETRIEVAL_FAILED");
    }
  };
  const facade = {
    mode,
    account: frozenMethods({
      retrieve: async () => {
        const account = await invoke(client.accounts?.retrieve?.bind(client.accounts), [], "account");
        if (!account?.id || sha256(account.id) !== expectedAccountFingerprint) {
          throw safeError("Stripe account identity does not match the approved LPC account.", "STRIPE_ACCOUNT_IDENTITY_MISMATCH");
        }
        return Object.freeze({ verified: true, mode });
      },
    }),
    paymentIntents: frozenMethods({
      retrieve: async (id, options = {}) => {
        assertAllowedExpansions(options, ["latest_charge.balance_transaction", "charges.data.balance_transaction"], "PaymentIntent");
        return minimalPaymentIntent(await invoke(
          client.paymentIntents?.retrieve?.bind(client.paymentIntents),
          [id, options],
          "PaymentIntent"
        ));
      },
    }),
    charges: frozenMethods({
      retrieve: async (id, options = {}) => {
        assertAllowedExpansions(options, ["balance_transaction"], "Charge");
        return minimalCharge(await invoke(client.charges?.retrieve?.bind(client.charges), [id, options], "Charge"));
      },
    }),
    balanceTransactions: frozenMethods({
      retrieve: async (id) => minimalBalanceTransaction(await invoke(
        client.balanceTransactions?.retrieve?.bind(client.balanceTransactions), [id], "Balance Transaction"
      )),
    }),
    refunds: frozenMethods({
      retrieve: async (id) => minimalRefund(await invoke(client.refunds?.retrieve?.bind(client.refunds), [id], "Refund")),
      list: async (options = {}) => {
        assertAllowedOptions(options, ["charge", "payment_intent", "limit", "starting_after", "created"], "Refund");
        return minimalList(await invoke(client.refunds?.list?.bind(client.refunds), [options], "Refund list"), minimalRefund);
      },
    }),
    disputes: frozenMethods({
      retrieve: async (id) => minimalDispute(await invoke(client.disputes?.retrieve?.bind(client.disputes), [id], "Dispute")),
      list: async (options = {}) => {
        assertAllowedOptions(options, ["limit", "starting_after", "created"], "Dispute");
        return minimalList(await invoke(client.disputes?.list?.bind(client.disputes), [options], "Dispute list"), minimalDispute);
      },
    }),
    transfers: frozenMethods({
      retrieve: async (id) => minimalTransfer(await invoke(client.transfers?.retrieve?.bind(client.transfers), [id], "Transfer")),
      list: async (options = {}) => {
        assertAllowedOptions(options, ["limit", "starting_after", "created", "transfer_group"], "Transfer");
        return minimalList(await invoke(client.transfers?.list?.bind(client.transfers), [options], "Transfer list"), minimalTransfer);
      },
    }),
  };
  Object.values(facade).forEach((value) => {
    if (value && typeof value === "object") Object.freeze(value);
  });
  return Object.freeze(facade);
}

function connectedHostCandidates(connection) {
  const values = [];
  const srvHost = connection?.client?.options?.srvHost;
  if (srvHost) values.push(String(srvHost).toLowerCase());
  const hosts = connection?.client?.options?.hosts;
  if (Array.isArray(hosts)) {
    hosts.forEach((host) => values.push(String(host?.host || host || "").toLowerCase()));
  }
  return [...new Set(values.filter(Boolean))].sort();
}

async function verifyMongoReadOnlyIdentity(connection, configuration) {
  if (!connection?.db) throw safeError("Dedicated MongoDB reconciliation connection is unavailable.", "MONGODB_CONNECTION_UNAVAILABLE");
  if (connection.db.databaseName !== configuration.expectedDatabase) {
    throw safeError("Connected MongoDB database identity does not match the approved production database.", "MONGODB_CONNECTED_DATABASE_MISMATCH");
  }
  const connectedHosts = connectedHostCandidates(connection);
  if (!connectedHosts.length) {
    throw safeError("Connected MongoDB cluster identity could not be established.", "MONGODB_CONNECTED_CLUSTER_UNKNOWN");
  }
  if (configuration.expectedHost && !connectedHosts.includes(configuration.expectedHost)) {
    throw safeError("Connected MongoDB host does not match the approved production cluster.", "MONGODB_CONNECTED_CLUSTER_MISMATCH");
  }
  if (
    configuration.expectedHostFingerprint &&
    sha256(connectedHosts.join(",")) !== configuration.expectedHostFingerprint
  ) {
    throw safeError("Connected MongoDB cluster fingerprint does not match the approved identity.", "MONGODB_CONNECTED_CLUSTER_MISMATCH");
  }
  let status;
  try {
    await connection.db.command({ hello: 1 });
    status = await connection.db.command({ connectionStatus: 1, showPrivileges: true });
  } catch (_error) {
    throw safeError("MongoDB could not confirm reconciliation identity and privileges.", "MONGODB_READONLY_CONFIRMATION_FAILED");
  }
  const privileges = status?.authInfo?.authenticatedUserPrivileges;
  if (!Array.isArray(privileges) || !privileges.length) {
    throw safeError("MongoDB did not provide server-confirmed read-only privileges.", "MONGODB_READONLY_PRIVILEGES_UNCONFIRMED");
  }
  const actions = new Set(privileges.flatMap((privilege) =>
    Array.isArray(privilege.actions) ? privilege.actions.map(String) : []
  ));
  const nonRetrievalAction = [...actions].find((action) => !MONGO_RETRIEVAL_ACTIONS.has(action));
  if (nonRetrievalAction) {
    throw safeError(
      "MongoDB reconciliation credentials expose a non-retrieval privilege.",
      "MONGODB_WRITE_PRIVILEGE_DETECTED"
    );
  }
  for (const requiredAction of ["find", "listCollections", "listIndexes"]) {
    if (!actions.has(requiredAction)) {
      throw safeError("MongoDB reconciliation credentials lack a required retrieval privilege.", "MONGODB_READ_PRIVILEGE_MISSING");
    }
  }
  return Object.freeze({ databaseVerified: true, clusterVerified: true, readOnlyVerified: true });
}

function createMongoRetrievalFacade(connection) {
  if (!connection?.db) throw safeError("Dedicated MongoDB connection is required.", "MONGODB_CONNECTION_UNAVAILABLE");
  const collection = (name) => connection.db.collection(String(name));
  return Object.freeze({
    listCollectionNames: async () => (await connection.db.listCollections({}, { nameOnly: true }).toArray())
      .map((entry) => String(entry.name || ""))
      .filter(Boolean),
    findMany: async (name, filter = {}, projection = {}, sort = { _id: 1 }) =>
      collection(name).find(filter, { projection }).sort(sort).toArray(),
    countDocuments: async (name, filter = {}) => collection(name).countDocuments(filter),
    snapshotCollection: async (name, filter = {}) => {
      const projection = {
        _id: 1,
        caseId: 1,
        operationKey: 1,
        kind: 1,
        status: 1,
        amount: 1,
        currency: 1,
        stripeMode: 1,
        livemode: 1,
        paymentIntentId: 1,
        escrowIntentId: 1,
        hiringClaimPaymentIntentId: 1,
        stripeObjectId: 1,
        stripePaymentIntentId: 1,
        stripeChargeId: 1,
        stripeBalanceTransactionId: 1,
        stripeRefundId: 1,
        stripeTransferId: 1,
        stripeDisputeId: 1,
        grossAmount: 1,
        processingFeeAmount: 1,
        netAmount: 1,
        refundAmount: 1,
        transferAmount: 1,
        amountPaid: 1,
        feeAmount: 1,
        transferId: 1,
        eventId: 1,
        type: 1,
        provider: 1,
        adjustmentType: 1,
        direction: 1,
        evidenceVerifiedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      const rows = await collection(name).find(filter, { projection }).sort({ _id: 1 }).toArray();
      const latest = rows.reduce((value, row) => {
        const candidate = row.updatedAt || row.createdAt;
        return candidate && (!value || new Date(candidate) > new Date(value)) ? candidate : value;
      }, null);
      return {
        count: rows.length,
        latestUpdatedAt: latest ? new Date(latest).toISOString() : null,
        evidenceWatermark: sha256(JSON.stringify(rows)),
      };
    },
    listIndexes: async (name) => collection(name).listIndexes().toArray(),
  });
}

module.exports = {
  MONGO_RECONCILIATION_OPTIONS,
  MONGO_RETRIEVAL_ACTIONS,
  PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT,
  argumentValue,
  assertDryRunArguments,
  assertProductionMongoIdentity,
  assertRestrictedStripeKey,
  assertStripeObjectMode,
  createMongoRetrievalFacade,
  createStripeRetrievalFacade,
  parseMongoIdentity,
  resolvePrivateOutputPath,
  sha256,
  validateReconciliationEnvironment,
  verifyMongoReadOnlyIdentity,
};
