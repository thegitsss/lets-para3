"use strict";

const fs = require("fs");
const path = require("path");
const {
  MONGO_RECONCILIATION_OPTIONS,
  PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT,
  assertDryRunArguments,
  assertSanitizedReport,
  createMongoRetrievalFacade,
  createStripeRetrievalFacade,
  resolvePrivateOutputPath,
  sha256,
  validateReconciliationEnvironment,
  verifyMongoReadOnlyIdentity,
} = {
  ...require("../services/reconciliationPreflightService"),
  ...require("../services/productionFundingReconciliationService"),
};
const {
  runProductionFundingReconciliation,
} = require("../services/productionFundingReconciliationService");
const { execute } = require("../scripts/reconcile-production-funding-evidence");

const TEST_CASE_ID = "64b000000000000000000001";
const LIVE_CASE_ID = "64b000000000000000000002";
const ACCOUNT_ID = "acct_synthetic_lpc_reconcile";

function validEnvironment(overrides = {}) {
  const syntheticUri = new URL("mongodb+srv://prod-cluster.mongodb.net/lpcprod");
  syntheticUri.username = "readonly";
  syntheticUri.password = "masked";
  return {
    MONGODB_RECONCILE_READONLY_URI: syntheticUri.toString(),
    MONGODB_RECONCILE_EXPECTED_DATABASE: "lpcprod",
    MONGODB_RECONCILE_EXPECTED_HOST: "prod-cluster.mongodb.net",
    STRIPE_RECONCILE_TEST_KEY: "rk_test_synthetic_reconcile",
    STRIPE_RECONCILE_LIVE_KEY: "rk_live_synthetic_reconcile",
    STRIPE_RECONCILE_EXPECTED_ACCOUNT_FINGERPRINT: sha256(ACCOUNT_ID),
    ...overrides,
  };
}

function financialObjects(mode, caseId) {
  const live = mode === "live";
  const suffix = `${mode}_synthetic`;
  const balanceTransaction = {
    id: `txn_${suffix}`,
    type: "charge",
    amount: 48800,
    fee: 1445,
    net: 47355,
    currency: "usd",
    livemode: live,
  };
  const charge = {
    id: `ch_${suffix}`,
    amount: 48800,
    amount_refunded: mode === "test" ? 100 : 0,
    currency: "usd",
    paid: true,
    captured: true,
    refunded: mode === "test",
    disputed: false,
    livemode: live,
    payment_intent: `pi_${suffix}`,
    balance_transaction: balanceTransaction,
  };
  const paymentIntent = {
    id: `pi_${suffix}`,
    status: "succeeded",
    amount: 48800,
    amount_received: 48800,
    currency: "usd",
    livemode: live,
    metadata: { caseId, unrelatedPrivateValue: "must_not_escape" },
    transfer_group: `case_${caseId}`,
    latest_charge: charge,
  };
  return { balanceTransaction, charge, paymentIntent };
}

function rawStripeClient(mode, caseId, { mismatch = false } = {}) {
  const live = mode === "live";
  const objects = financialObjects(mode, caseId);
  const effectiveLive = mismatch ? !live : live;
  const withMode = (value) => ({ ...value, livemode: effectiveLive });
  return {
    accounts: { retrieve: jest.fn(async () => ({ id: ACCOUNT_ID })) },
    paymentIntents: {
      retrieve: jest.fn(async () => withMode(objects.paymentIntent)),
      create: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
    },
    charges: { retrieve: jest.fn(async () => withMode(objects.charge)), capture: jest.fn() },
    balanceTransactions: { retrieve: jest.fn(async () => withMode(objects.balanceTransaction)) },
    refunds: {
      retrieve: jest.fn(async (id) => ({ id, amount: 100, currency: "usd", status: "succeeded", livemode: live })),
      list: jest.fn(async () => ({
        data: mode === "test" ? [{
          id: "re_test_synthetic",
          amount: 100,
          currency: "usd",
          status: "succeeded",
          livemode: false,
          payment_intent: "pi_test_synthetic",
        }] : [],
        has_more: false,
      })),
      create: jest.fn(),
    },
    disputes: {
      retrieve: jest.fn(),
      list: jest.fn(async () => ({
        data: [{
          id: `dp_${mode}_synthetic`,
          amount: 200,
          currency: "usd",
          status: "needs_response",
          livemode: live,
          charge: `ch_${mode}_synthetic`,
        }],
        has_more: false,
      })),
      update: jest.fn(),
      close: jest.fn(),
    },
    transfers: {
      retrieve: jest.fn(async (id) => ({ id, amount: 30000, currency: "usd", livemode: live })),
      list: jest.fn(async () => ({ data: [], has_more: false })),
      create: jest.fn(),
      createReversal: jest.fn(),
    },
    customers: { retrieve: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  };
}

function stripeFacades() {
  return {
    test: createStripeRetrievalFacade({
      client: rawStripeClient("test", TEST_CASE_ID),
      mode: "test",
      expectedAccountFingerprint: sha256(ACCOUNT_ID),
    }),
    live: createStripeRetrievalFacade({
      client: rawStripeClient("live", LIVE_CASE_ID),
      mode: "live",
      expectedAccountFingerprint: sha256(ACCOUNT_ID),
    }),
  };
}

function fakeInventory() {
  const testObjects = financialObjects("test", TEST_CASE_ID);
  const liveObjects = financialObjects("live", LIVE_CASE_ID);
  const cases = [
    {
      _id: TEST_CASE_ID,
      paymentIntentId: testObjects.paymentIntent.id,
      lockedTotalAmount: 40000,
      totalAmount: 40000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 8800,
      currency: "usd",
      stripeMode: "test",
    },
    {
      _id: LIVE_CASE_ID,
      paymentIntentId: liveObjects.paymentIntent.id,
      lockedTotalAmount: 40000,
      totalAmount: 40000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 8800,
      currency: "usd",
      stripeMode: "live",
    },
  ];
  const operations = [
    {
      _id: "64c000000000000000000001",
      caseId: LIVE_CASE_ID,
      operationKey: `funding:${LIVE_CASE_ID}:${liveObjects.paymentIntent.id}`,
      kind: "funding",
      status: "succeeded",
      stripeObjectId: liveObjects.paymentIntent.id,
      stripePaymentIntentId: liveObjects.paymentIntent.id,
      stripeChargeId: liveObjects.charge.id,
      stripeBalanceTransactionId: liveObjects.balanceTransaction.id,
      grossAmount: 48800,
      processingFeeAmount: 1445,
      netAmount: 47355,
      currency: "usd",
      stripeMode: "live",
      livemode: true,
      evidenceVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    {
      _id: "64c000000000000000000002",
      caseId: TEST_CASE_ID,
      operationKey: "refund:synthetic",
      kind: "refund",
      status: "succeeded",
      stripeRefundId: "re_test_synthetic",
      amount: 100,
      currency: "usd",
      stripeMode: "test",
    },
    {
      _id: "64c000000000000000000003",
      caseId: TEST_CASE_ID,
      operationKey: "chargeback:synthetic",
      kind: "chargeback",
      status: "open",
      stripeDisputeId: "dp_test_synthetic",
      amount: 200,
      currency: "usd",
      stripeMode: "test",
    },
    {
      _id: "64c000000000000000000004",
      caseId: LIVE_CASE_ID,
      operationKey: "payout:synthetic",
      kind: "payout",
      status: "succeeded",
      stripeTransferId: "tr_live_synthetic",
      amount: 30000,
      currency: "usd",
      stripeMode: "live",
    },
  ];
  return {
    cases,
    paymentoperations: operations,
    payouts: [{ caseId: LIVE_CASE_ID, amountPaid: 30000, transferId: "tr_live_synthetic", status: "paid" }],
    platformincomes: [{ caseId: LIVE_CASE_ID, feeAmount: 8800 }],
    webhookevents: [{
      eventId: "evt_live_synthetic",
      provider: "stripe",
      type: "charge.succeeded",
      status: "processed",
      stripeMode: "live",
    }],
    financialadjustments: [{ caseId: TEST_CASE_ID, amount: 200, currency: "usd", stripeMode: "test" }],
  };
}

function fakeMongo({ changeSnapshot = false } = {}) {
  const data = fakeInventory();
  const collections = ["cases", "paymentoperations", "payouts", "platformincomes", "webhookevents", "financialadjustments"];
  const snapshotCalls = new Map();
  return {
    listCollectionNames: jest.fn(async () => collections),
    findMany: jest.fn(async (name) => data[name] || []),
    countDocuments: jest.fn(async (name) => (data[name] || []).length),
    listIndexes: jest.fn(async (name) => [{
      name: `${name}_synthetic_index`,
      key: { caseId: 1 },
      unique: name === "financialadjustments",
    }]),
    snapshotCollection: jest.fn(async (name) => {
      const calls = (snapshotCalls.get(name) || 0) + 1;
      snapshotCalls.set(name, calls);
      return {
        count: (data[name] || []).length + (changeSnapshot && name === "paymentoperations" && calls > 1 ? 1 : 0),
        latestUpdatedAt: "2026-08-30T12:00:00.000Z",
        evidenceWatermark: sha256(`${name}:${calls > 1 && changeSnapshot && name === "paymentoperations" ? "changed" : "stable"}`),
      };
    }),
  };
}

describe("Phase 4C production reconciliation preflight", () => {
  test("disables MongoDB auto-index and auto-create behavior", () => {
    expect(MONGO_RECONCILIATION_OPTIONS).toEqual(expect.objectContaining({
      autoIndex: false,
      autoCreate: false,
      retryWrites: false,
    }));
  });

  test("runner source cannot initialize models, collections, indexes, or application startup", () => {
    const source = fs.readFileSync(path.join(__dirname, "../scripts/reconcile-production-funding-evidence.js"), "utf8");
    expect(source).not.toMatch(/require\(["']\.\.\/models\//);
    expect(source).not.toMatch(/\.(?:createCollection|createIndex|syncIndexes|init)\s*\(/);
    expect(source).not.toMatch(/require\(["']\.\.\/index["']\)/);
  });

  test.each([
    ["mongodb://localhost/lpcprod", "MONGODB_NON_PRODUCTION_IDENTITY"],
    ["mongodb://prod.example.com/lpc-staging", "MONGODB_NON_PRODUCTION_DATABASE"],
    ["mongodb://prod.example.com/test", "MONGODB_NON_PRODUCTION_DATABASE"],
  ])("rejects local and non-production MongoDB identity %s", (uri, code) => {
    expect(() => validateReconciliationEnvironment(validEnvironment({
      MONGODB_RECONCILE_READONLY_URI: uri,
      MONGODB_RECONCILE_EXPECTED_HOST: uri.includes("localhost") ? "localhost" : "prod.example.com",
      MONGODB_RECONCILE_EXPECTED_DATABASE: uri.slice(uri.lastIndexOf("/") + 1),
    }))).toThrow(expect.objectContaining({ code }));
  });

  test("missing credentials and unrestricted Stripe keys abort during configuration", () => {
    expect(() => validateReconciliationEnvironment(validEnvironment({ STRIPE_RECONCILE_TEST_KEY: "" })))
      .toThrow(expect.objectContaining({ code: "RECONCILIATION_CONFIGURATION_MISSING" }));
    expect(() => validateReconciliationEnvironment(validEnvironment({ STRIPE_RECONCILE_LIVE_KEY: "sk_live_not_restricted" })))
      .toThrow(expect.objectContaining({ code: "STRIPE_LIVE_RESTRICTED_KEY_REQUIRED" }));
  });

  test("test and live Stripe keys cannot be substituted", () => {
    expect(() => validateReconciliationEnvironment(validEnvironment({
      STRIPE_RECONCILE_TEST_KEY: "rk_live_wrong_mode",
    }))).toThrow(expect.objectContaining({ code: "STRIPE_TEST_RESTRICTED_KEY_REQUIRED" }));
    expect(() => validateReconciliationEnvironment(validEnvironment({
      STRIPE_RECONCILE_LIVE_KEY: "rk_test_wrong_mode",
    }))).toThrow(expect.objectContaining({ code: "STRIPE_LIVE_RESTRICTED_KEY_REQUIRED" }));
  });

  test("dry-run command requires acknowledgment and rejects every apply argument", () => {
    const acknowledged = `--acknowledge=${PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT}`;
    expect(() => assertDryRunArguments([acknowledged, "--output=/private/tmp/report.json", "--apply"]))
      .toThrow(expect.objectContaining({ code: "DRY_RUN_APPLY_ARGUMENT_REJECTED" }));
    expect(() => assertDryRunArguments([acknowledged, "--output=/private/tmp/report.json", "--apply=true"]))
      .toThrow(expect.objectContaining({ code: "DRY_RUN_APPLY_ARGUMENT_REJECTED" }));
    expect(() => assertDryRunArguments([acknowledged, "--output=/private/tmp/report.json", "--confirm=anything"]))
      .toThrow(expect.objectContaining({ code: "DRY_RUN_APPLY_ARGUMENT_REJECTED" }));
    expect(() => assertDryRunArguments([acknowledged, "--output=/private/tmp/report.json", "--expected-records=1"]))
      .toThrow(expect.objectContaining({ code: "DRY_RUN_APPLY_ARGUMENT_REJECTED" }));
  });

  test("detailed output must be absolute, outside the repository, and new", () => {
    const repositoryRoot = path.resolve(__dirname, "../..");
    expect(() => resolvePrivateOutputPath("report.json", repositoryRoot))
      .toThrow(expect.objectContaining({ code: "RECONCILIATION_OUTPUT_NOT_ABSOLUTE" }));
    expect(() => resolvePrivateOutputPath(path.join(repositoryRoot, "report.json"), repositoryRoot))
      .toThrow(expect.objectContaining({ code: "RECONCILIATION_OUTPUT_INSIDE_REPOSITORY" }));
  });

  test("connected database mismatch aborts before commands or financial queries", async () => {
    const command = jest.fn();
    const collection = jest.fn();
    const connection = {
      db: { databaseName: "wrongprod", command, collection },
      client: { options: { srvHost: "prod-cluster.mongodb.net" } },
    };
    await expect(verifyMongoReadOnlyIdentity(connection, {
      expectedDatabase: "lpcprod",
      expectedHost: "prod-cluster.mongodb.net",
      expectedHostFingerprint: "",
    })).rejects.toMatchObject({ code: "MONGODB_CONNECTED_DATABASE_MISMATCH" });
    expect(command).not.toHaveBeenCalled();
    expect(collection).not.toHaveBeenCalled();
  });

  test("server-confirmed mutation privileges reject the connection", async () => {
    const connection = {
      db: {
        databaseName: "lpcprod",
        command: jest.fn(async (command) => command.hello ? { ok: 1 } : ({
          authInfo: {
            authenticatedUserPrivileges: [{
              actions: ["find", "listCollections", "listIndexes", "createSearchIndexes"],
            }],
          },
        })),
      },
      client: { options: { srvHost: "prod-cluster.mongodb.net" } },
    };
    await expect(verifyMongoReadOnlyIdentity(connection, {
      expectedDatabase: "lpcprod",
      expectedHost: "prod-cluster.mongodb.net",
      expectedHostFingerprint: "",
    })).rejects.toMatchObject({ code: "MONGODB_WRITE_PRIVILEGE_DETECTED" });
  });

  test("MongoDB retrieval facade exposes no mutation method", () => {
    const facade = createMongoRetrievalFacade({ db: {} });
    expect(Object.keys(facade).sort()).toEqual([
      "countDocuments", "findMany", "listCollectionNames", "listIndexes", "snapshotCollection",
    ]);
  });

  test("Stripe facade exposes only mode-bound retrieval and list methods", () => {
    const facade = stripeFacades().test;
    expect(Object.keys(facade).sort()).toEqual([
      "account", "balanceTransactions", "charges", "disputes", "mode", "paymentIntents", "refunds", "transfers",
    ]);
    expect(Object.keys(facade.account)).toEqual(["retrieve"]);
    expect(Object.keys(facade.paymentIntents)).toEqual(["retrieve"]);
    expect(Object.keys(facade.charges)).toEqual(["retrieve"]);
    expect(Object.keys(facade.balanceTransactions)).toEqual(["retrieve"]);
    expect(Object.keys(facade.refunds).sort()).toEqual(["list", "retrieve"]);
    expect(Object.keys(facade.disputes).sort()).toEqual(["list", "retrieve"]);
    expect(Object.keys(facade.transfers).sort()).toEqual(["list", "retrieve"]);
    expect(JSON.stringify(Object.keys(facade))).not.toMatch(/create|update|delete|cancel|capture|confirm|reverse/i);
  });

  test("Stripe mode mismatch aborts and minimal facade strips unrelated private fields", async () => {
    const client = rawStripeClient("test", TEST_CASE_ID, { mismatch: true });
    const facade = createStripeRetrievalFacade({
      client,
      mode: "test",
      expectedAccountFingerprint: sha256(ACCOUNT_ID),
    });
    await expect(facade.paymentIntents.retrieve("pi_test_synthetic"))
      .rejects.toMatchObject({ code: "STRIPE_OBJECT_MODE_MISMATCH" });

    const safeFacade = stripeFacades().test;
    const intent = await safeFacade.paymentIntents.retrieve("pi_test_synthetic");
    expect(intent.metadata).toEqual({ caseId: TEST_CASE_ID });
    expect(JSON.stringify(intent)).not.toContain("must_not_escape");
  });

  test("report includes required inventories, indexes, disputes, snapshots, and mode aggregates", async () => {
    const report = await runProductionFundingReconciliation({
      mongo: fakeMongo(),
      stripeFacades: stripeFacades(),
      clock: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(report).toEqual(expect.objectContaining({
      authoritative: true,
      inventory: expect.objectContaining({
        caseFundingRecords: 2,
        paymentOperations: 4,
        payouts: 1,
        platformIncome: 1,
        refundEvidence: expect.any(Array),
        webhookEvents: expect.objectContaining({ count: 1 }),
        indexes: expect.objectContaining({ platformincomes: expect.any(Object) }),
      }),
      snapshot: expect.objectContaining({ unchanged: true, opening: expect.any(Object), closing: expect.any(Object) }),
      byMode: expect.objectContaining({
        test: expect.objectContaining({ disputes: expect.any(Object), aggregates: expect.any(Object) }),
        live: expect.objectContaining({ disputes: expect.any(Object), aggregates: expect.any(Object) }),
      }),
      classifications: expect.objectContaining({
        refunded: expect.any(Number),
        disputed: expect.any(Number),
        ambiguous: expect.any(Number),
        conflicting_evidence: expect.any(Number),
        missing_stripe_object: expect.any(Number),
      }),
      futureBackfill: expect.objectContaining({ eligibleCount: expect.any(Number) }),
    }));
    expect(report.byMode.live.aggregates.paralegalPayouts).toBe(30000);
    expect(report.byMode.live.aggregates.platformIncome).toBe(8800);
    expect(report.classifications.refunded).toBeGreaterThan(0);
    expect(report.classifications.disputed).toBeGreaterThan(0);
    expect(() => assertSanitizedReport(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/(?:pi|ch|txn|tr|re|dp|evt)_(?:test|live)_synthetic/);
    expect(JSON.stringify(report)).not.toContain(TEST_CASE_ID);
  });

  test("a changed closing snapshot invalidates authority and removes the apply count", async () => {
    const report = await runProductionFundingReconciliation({
      mongo: fakeMongo({ changeSnapshot: true }),
      stripeFacades: stripeFacades(),
      clock: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(report.authoritative).toBe(false);
    expect(report.snapshot.unchanged).toBe(false);
    expect(report.futureBackfill.eligibleCount).toBeNull();
    expect(report.futureBackfill.canProceedWithoutAddingIndexes).toBe(false);
  });

  test("sensitive values and full identifiers fail report validation", () => {
    expect(() => assertSanitizedReport({ email: "person@example.com" }))
      .toThrow(expect.objectContaining({ code: "RECONCILIATION_REPORT_SENSITIVE_DATA" }));
    expect(() => assertSanitizedReport({ id: "pi_full_identifier_123456" }))
      .toThrow(expect.objectContaining({ code: "RECONCILIATION_REPORT_SENSITIVE_DATA" }));
    expect(() => assertSanitizedReport({ id: TEST_CASE_ID }))
      .toThrow(expect.objectContaining({ code: "RECONCILIATION_REPORT_SENSITIVE_DATA" }));
  });

  test("missing configuration aborts execute before client or connection construction", async () => {
    const createConnection = jest.fn();
    await expect(execute({
      args: [
        `--acknowledge=${PRODUCTION_RETRIEVAL_ACKNOWLEDGMENT}`,
        `/private/tmp/lpc-reconcile-${process.pid}.json`.replace(/^/, "--output="),
      ],
      env: {},
      createConnection,
    })).rejects.toMatchObject({ code: "RECONCILIATION_CONFIGURATION_MISSING" });
    expect(createConnection).not.toHaveBeenCalled();
  });
});
