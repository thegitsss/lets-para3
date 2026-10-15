jest.mock("../services/marketing/linkedinPublisher", () => {
  const actual = jest.requireActual("../services/marketing/linkedinPublisher");
  return {
    ...actual,
    publishLinkedInCompanyPost: jest.fn(),
  };
});
jest.mock("axios");

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const axios = require("axios");

const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const MarketingChannelConnection = require("../models/MarketingChannelConnection");
const MarketingPublishAttempt = require("../models/MarketingPublishAttempt");
const MarketingPublishIntent = require("../models/MarketingPublishIntent");
const User = require("../models/User");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminMarketingRouter = require("../routes/adminMarketing");
const linkedinPublisher = require("../services/marketing/linkedinPublisher");
const { LINKEDIN_API_VERSION } = require("../services/marketing/linkedinApiPolicy");
const { decryptString, encryptString } = require("../utils/dataEncryption");
const channelConnectionService = require("../services/marketing/channelConnectionService");
const crypto = require("crypto");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "marketing-publishing-phase2-test-secret";
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || "linkedin-client-id";
process.env.LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || "linkedin-client-secret";
process.env.LINKEDIN_OAUTH_REDIRECT_URI =
  process.env.LINKEDIN_OAUTH_REDIRECT_URI ||
  "https://www.lets-paraconnect.com/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use("/api/admin/marketing", adminMarketingRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
    av: Number(user.authVersion || 0),
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function createAdmin() {
  return User.create({
    firstName: "Admin",
    lastName: "Owner",
    email: "marketing-publishing-phase2-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function seedKnowledge(admin) {
  const res = await request(app)
    .post("/api/admin/knowledge/sync")
    .set("Cookie", authCookieFor(admin))
    .send({});
  expect(res.status).toBe(200);
}

async function createPublishingCycle(admin, label = "Phase 2 cycle") {
  const cycleRes = await request(app)
    .post("/api/admin/marketing/publishing/cycles")
    .set("Cookie", authCookieFor(admin))
    .send({ cycleLabel: label });
  expect(cycleRes.status).toBe(201);
  return cycleRes.body.cycle;
}

async function saveLinkedInConnection(admin, overrides = {}) {
  const accessToken = String(overrides.accessToken || "linkedin-access-token-1234");
  const scopeSnapshot = overrides.scopeSnapshot || ["w_organization_social", "rw_organization_admin"];
  await MarketingChannelConnection.findOneAndUpdate(
    { channelKey: "linkedin_company" },
    {
      $set: {
        provider: "linkedin",
        isActive: true,
        encryptedAccessToken: encryptString(accessToken),
        accessTokenLast4: accessToken.slice(-4),
        scopeSnapshot,
        apiVersion: LINKEDIN_API_VERSION,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
  const response = await request(app)
    .post("/api/admin/marketing/publishing/channel-connections/linkedin_company")
    .set("Cookie", authCookieFor(admin))
    .send({
      organizationName: overrides.organizationName || "Let's ParaConnect",
      organizationId: overrides.organizationId || "123456789",
      organizationUrn: overrides.organizationUrn || "urn:li:organization:123456789",
    });
  expect(response.status).toBe(200);
  return response.body.connection;
}

function mockLinkedInValidationSuccess({
  organizationId = "123456789",
  organizationUrn = "urn:li:organization:123456789",
  organizationName = "Let's ParaConnect",
} = {}) {
  axios.post.mockImplementation(async (url) => {
    if (String(url).includes("accessToken")) {
      return {
        status: 200,
        data: {
          access_token: "oauth-access-token-1234",
          expires_in: 3600,
          scope: "openid profile email w_organization_social rw_organization_admin",
        },
      };
    }
    throw new Error(`Unexpected POST ${url}`);
  });

  axios.get.mockImplementation(async (url) => {
    const target = String(url);
    if (target.includes("/v2/userinfo")) {
      return {
        status: 200,
        data: {
          sub: "member-123",
          given_name: "Samantha",
          family_name: "Sider",
          email: "samantha@example.com",
        },
      };
    }
    if (target.includes("/v2/organizationAcls")) {
      return {
        status: 200,
        data: {
          elements: [{ organization: organizationUrn }],
        },
      };
    }
    if (target.includes("/rest/organizationsLookup")) {
      return {
        status: 200,
        data: {
          results: {
            [organizationId]: {
              localizedName: organizationName,
            },
          },
        },
      };
    }
    if (target.includes("/rest/organizationAuthorizations")) {
      return {
        status: 200,
        data: {
          status: {
            Approved: 1,
          },
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

function mockLinkedInAuthorizationDenied() {
  axios.post.mockResolvedValue({
    status: 200,
    data: {
      access_token: "oauth-access-token-1234",
      expires_in: 3600,
      scope: "openid profile email w_organization_social rw_organization_admin",
    },
  });
  axios.get.mockImplementation(async (url) => {
    const target = String(url);
    if (target.includes("/v2/userinfo")) {
      return {
        status: 200,
        data: {
          sub: "member-123",
          given_name: "Samantha",
          family_name: "Sider",
        },
      };
    }
    if (target.includes("/v2/organizationAcls")) {
      return {
        status: 200,
        data: {
          elements: [{ organization: "urn:li:organization:123456789" }],
        },
      };
    }
    if (target.includes("/rest/organizationsLookup")) {
      return {
        status: 200,
        data: {
          results: {
            "123456789": {
              localizedName: "Let's ParaConnect",
            },
          },
        },
      };
    }
    if (target.includes("/rest/organizationAuthorizations")) {
      return {
        status: 200,
        data: {
          status: {
            Approved: 0,
          },
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

async function validateLinkedInConnection(admin) {
  const res = await request(app)
    .post("/api/admin/marketing/publishing/channel-connections/linkedin_company/validate")
    .set("Cookie", authCookieFor(admin))
    .send({});
  expect(res.status).toBe(200);
  return res.body.connection;
}

async function startOAuth(admin, payload = {}) {
  const res = await request(app)
    .post("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/start")
    .set("Cookie", authCookieFor(admin))
    .send(payload);
  expect(res.status).toBe(200);
  return res.body.connectUrl;
}

function extractState(connectUrl = "") {
  return new URL(connectUrl).searchParams.get("state");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function holdOAuthExchange({ failure = false } = {}) {
  const entered = deferred();
  const release = deferred();
  const secondEntered = deferred();
  let exchanges = 0;
  axios.post.mockImplementation(async () => {
    exchanges += 1;
    entered.resolve();
    if (exchanges === 2) secondEntered.resolve();
    await release.promise;
    return failure
      ? { status: 401, data: { error_description: "Synthetic rejected authorization code" } }
      : { status: 200, data: {
        access_token: "oauth-access-token-1234", expires_in: 3600,
        scope: "openid profile email w_organization_social rw_organization_admin",
      } };
  });
  return { entered, release, secondEntered };
}

function holdMemberValidation() {
  const entered = deferred();
  const release = deferred();
  const original = axios.get.getMockImplementation();
  axios.get.mockImplementation(async (url, options) => {
    if (String(url).includes("/v2/userinfo")) {
      entered.resolve();
      await release.promise;
    }
    return original(url, options);
  });
  return { entered, release };
}

async function storedConnection() {
  return MarketingChannelConnection.findOne({ channelKey: "linkedin_company" }).lean();
}

function ownerIntentSnapshot(connection) {
  return {
    isActive: connection.isActive,
    status: connection.status,
    organizationId: connection.organizationId,
    organizationUrn: connection.organizationUrn,
    organizationName: connection.organizationName,
    encryptedAccessToken: connection.encryptedAccessToken,
    accessTokenLast4: connection.accessTokenLast4,
    tokenExpiresAt: connection.tokenExpiresAt,
    scopeSnapshot: connection.scopeSnapshot,
    oauthStateHash: connection.oauthStateHash,
    oauthStateExpiresAt: connection.oauthStateExpiresAt,
    oauthRequestedAt: connection.oauthRequestedAt,
    oauthRequestedBy: connection.oauthRequestedBy,
    oauthLastError: connection.oauthLastError,
    authorizationGranted: connection.authorizationGranted,
    lastValidationStatus: connection.lastValidationStatus,
    lastValidationNote: connection.lastValidationNote,
    intentVersion: connection.intentVersion,
    updatedBy: connection.updatedBy,
  };
}

async function approvePacket(admin, packetId) {
  const response = await request(app)
    .post(`/api/admin/marketing/draft-packets/${packetId}/approve`)
    .set("Cookie", authCookieFor(admin))
    .send({ note: "Approved for LinkedIn company." });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  linkedinPublisher.publishLinkedInCompanyPost.mockReset();
  axios.get.mockReset();
  axios.post.mockReset();
});

describe("Marketing publishing Phase 2", () => {
  test("OAuth connection state persists and validation moves the connection to connected_validated", async () => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();

    const connectUrl = await startOAuth(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
    });
    const callbackRes = await request(app)
      .get("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback")
      .query({
        code: "oauth-code-123",
        state: extractState(connectUrl),
      });

    expect(callbackRes.status).toBe(200);

    const connectionRes = await request(app)
      .get("/api/admin/marketing/publishing/channel-connections/linkedin_company")
      .set("Cookie", authCookieFor(admin));

    expect(connectionRes.status).toBe(200);
    expect(connectionRes.body.connection).toEqual(
      expect.objectContaining({
        status: "connected_validated",
        authorizationGranted: true,
        organizationId: "123456789",
        organizationUrn: "urn:li:organization:123456789",
        apiVersion: LINKEDIN_API_VERSION,
      })
    );
  });

  test("connection APIs reject browser-selected versions and raw provider credentials", async () => {
    const admin = await createAdmin();
    const cookie = authCookieFor(admin);

    const staleVersion = await request(app)
      .post("/api/admin/marketing/publishing/channel-connections/linkedin_company")
      .set("Cookie", cookie)
      .send({ apiVersion: "202503" });
    expect(staleVersion.status).toBe(400);

    const rawToken = await request(app)
      .post("/api/admin/marketing/publishing/channel-connections/linkedin_company")
      .set("Cookie", cookie)
      .send({ accessToken: "do-not-accept-browser-secrets" });
    expect(rawToken.status).toBe(400);

    const oauthOverride = await request(app)
      .post("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/start")
      .set("Cookie", cookie)
      .send({ apiVersion: "202503" });
    expect(oauthOverride.status).toBe(400);
  });

  test("admin API reports blocked connection state when organization authorization cannot be proven", async () => {
    const admin = await createAdmin();
    mockLinkedInAuthorizationDenied();

    const connectUrl = await startOAuth(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
    });
    await request(app)
      .get("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback")
      .query({
        code: "oauth-code-123",
        state: extractState(connectUrl),
      });

    const connectionRes = await request(app)
      .get("/api/admin/marketing/publishing/channel-connections/linkedin_company")
      .set("Cookie", authCookieFor(admin))
      .send();
    expect(connectionRes.status).toBe(200);
    expect(connectionRes.body.connection).toEqual(
      expect.objectContaining({
        status: "blocked",
        authorizationGranted: false,
      })
    );
  });

  test("connection stays blocked when org-posting scope is missing", async () => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
      scopeSnapshot: ["rw_organization_admin"],
    });

    const validateRes = await request(app)
      .post("/api/admin/marketing/publishing/channel-connections/linkedin_company/validate")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(validateRes.status).toBe(200);
    expect(validateRes.body.connection).toEqual(
      expect.objectContaining({
        status: "blocked",
        lastValidationNote: expect.stringMatching(/w_organization_social/i),
      })
    );
  });

  test("approved LinkedIn company packet returns ready publish readiness only when connection is validated", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    mockLinkedInValidationSuccess();
    await validateLinkedInConnection(admin);
    const cycle = await createPublishingCycle(admin, "Ready LinkedIn cycle");

    await approvePacket(admin, cycle.channels.linkedin_company.packetId);

    const readinessRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${cycle.channels.linkedin_company.packetId}/publish-readiness`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(readinessRes.status).toBe(200);
    expect(readinessRes.body.readiness).toEqual(
      expect.objectContaining({
        status: "ready",
        isReady: true,
        channelKey: "linkedin_company",
      })
    );
  });

  test("publish readiness stays blocked when connection is not validated", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    const cycle = await createPublishingCycle(admin, "Blocked by invalid connection");
    await approvePacket(admin, cycle.channels.linkedin_company.packetId);

    const readinessRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${cycle.channels.linkedin_company.packetId}/publish-readiness`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(readinessRes.status).toBe(200);
    expect(readinessRes.body.readiness.status).toBe("blocked");
    expect(readinessRes.body.readiness.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/authorization|validated/i)])
    );
  });

  test("publish simulation returns a ready dry-run without creating publish records", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    mockLinkedInValidationSuccess();
    await validateLinkedInConnection(admin);
    const cycle = await createPublishingCycle(admin, "Simulation-ready LinkedIn cycle");
    const packetId = cycle.channels.linkedin_company.packetId;

    await approvePacket(admin, packetId);

    const simulationRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-simulation`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(simulationRes.status).toBe(200);
    expect(simulationRes.body.simulation).toEqual(
      expect.objectContaining({
        dryRunOnly: true,
        status: "ready",
        wouldPublish: true,
        executionPlan: expect.objectContaining({
          provider: "linkedin",
          channelKey: "linkedin_company",
        }),
        checks: expect.arrayContaining([
          expect.objectContaining({ key: "approval", ok: true }),
          expect.objectContaining({ key: "connection", ok: true }),
        ]),
      })
    );
    expect(await MarketingPublishIntent.countDocuments({ packetId })).toBe(0);
    expect(await MarketingPublishAttempt.countDocuments({ packetId })).toBe(0);
  });

  test("publish simulation stays blocked truthfully for non-approved packets and creates no publish records", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    mockLinkedInValidationSuccess();
    await validateLinkedInConnection(admin);
    const cycle = await createPublishingCycle(admin, "Simulation-blocked LinkedIn cycle");
    const packetId = cycle.channels.linkedin_company.packetId;

    const simulationRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-simulation`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(simulationRes.status).toBe(200);
    expect(simulationRes.body.simulation).toEqual(
      expect.objectContaining({
        dryRunOnly: true,
        status: "blocked",
        wouldPublish: false,
        blockers: expect.arrayContaining([expect.stringMatching(/approved before it can be published/i)]),
        executionPlan: null,
      })
    );
    expect(await MarketingPublishIntent.countDocuments({ packetId })).toBe(0);
    expect(await MarketingPublishAttempt.countDocuments({ packetId })).toBe(0);
  });

  test("publish-now creates an intent and attempt and records success truthfully", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    mockLinkedInValidationSuccess();
    await validateLinkedInConnection(admin);
    const cycle = await createPublishingCycle(admin, "Successful LinkedIn publish");
    const packetId = cycle.channels.linkedin_company.packetId;

    await approvePacket(admin, packetId);
    linkedinPublisher.publishLinkedInCompanyPost.mockResolvedValue({
      providerResourceId: "urn:li:share:123456",
      providerResourceUrn: "urn:li:share:123456",
      permalink: "",
      publishedAt: new Date(),
      responseSnapshot: { status: 201, data: { id: "urn:li:share:123456" } },
    });

    const publishRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-now`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(publishRes.status).toBe(200);
    expect(publishRes.body.intent).toEqual(
      expect.objectContaining({
        status: "published",
        providerResourceUrn: "urn:li:share:123456",
      })
    );
    expect(publishRes.body.attempt).toEqual(
      expect.objectContaining({
        status: "succeeded",
        providerResourceUrn: "urn:li:share:123456",
      })
    );

    expect(await MarketingPublishIntent.countDocuments({ packetId })).toBe(1);
    expect(await MarketingPublishAttempt.countDocuments({ packetId })).toBe(1);

    const packetDetailRes = await request(app)
      .get(`/api/admin/marketing/draft-packets/${packetId}`)
      .set("Cookie", authCookieFor(admin));

    expect(packetDetailRes.status).toBe(200);
    expect(packetDetailRes.body.packet.publishHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "published",
          providerResourceUrn: "urn:li:share:123456",
        }),
      ])
    );

    const secondPublishRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-now`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(secondPublishRes.status).toBe(409);
  });

  test("publish failure is classified and packet remains approved", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    mockLinkedInValidationSuccess();
    await validateLinkedInConnection(admin);
    const cycle = await createPublishingCycle(admin, "Failing LinkedIn publish");
    const packetId = cycle.channels.linkedin_company.packetId;

    await approvePacket(admin, packetId);
    const providerError = new Error("LinkedIn provider unavailable.");
    providerError.statusCode = 503;
    linkedinPublisher.publishLinkedInCompanyPost.mockRejectedValue(providerError);

    const publishRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-now`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(publishRes.status).toBe(503);
    expect(publishRes.body.intent).toEqual(
      expect.objectContaining({
        status: "retryable_failed",
        failureClass: "transient",
      })
    );
    expect(publishRes.body.attempt).toEqual(
      expect.objectContaining({
        status: "failed",
        failureClass: "transient",
      })
    );

    const storedPacket = await MarketingDraftPacket.findById(packetId).lean();
    expect(storedPacket.approvalState).toBe("approved");
  });

  test("publish is blocked for non-approved packets", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);
    await saveLinkedInConnection(admin, {
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      accessToken: "linkedin-access-token-1234",
    });
    mockLinkedInValidationSuccess();
    await validateLinkedInConnection(admin);
    const cycle = await createPublishingCycle(admin, "Blocked LinkedIn publish");
    const packetId = cycle.channels.linkedin_company.packetId;

    const readinessRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-readiness`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(readinessRes.status).toBe(200);
    expect(readinessRes.body.readiness.status).toBe("blocked");
    expect(readinessRes.body.readiness.blockers).toEqual(
      expect.arrayContaining(["Packet must be approved before it can be published."])
    );

    const publishRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${packetId}/publish-now`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(publishRes.status).toBe(409);
    expect(await MarketingPublishIntent.countDocuments({ packetId })).toBe(0);
    expect(await MarketingPublishAttempt.countDocuments({ packetId })).toBe(0);
  });
});

describe("LinkedIn OAuth connection concurrency", () => {
  test("simultaneous callbacks consume a state once before exchanging its code", async () => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdOAuthExchange();
    const first = channelConnectionService.completeLinkedInOAuth({ code: "first-code", state });
    await held.entered.promise;
    const second = channelConnectionService.completeLinkedInOAuth({ code: "replayed-code", state });
    try {
      // The old implementation enters the transport twice. The corrected
      // implementation returns the replay failure while the first is held.
      await Promise.race([held.secondEntered.promise, second]);
      held.release.resolve();
      const results = await Promise.all([first, second]);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => /invalid or expired/.test(result.message))).toHaveLength(1);
      const stored = await storedConnection();
      expect(stored.oauthStateHash).toBe("");
      expect(stored.oauthStateExpiresAt).toBeNull();
      expect(stored.encryptedAccessToken).not.toContain("oauth-access-token-1234");
      expect(decryptString(stored.encryptedAccessToken)).toBe("oauth-access-token-1234");
      expect(JSON.stringify(results)).not.toMatch(/encryptedAccessToken|oauthStateHash|intentVersion/);
    } finally {
      held.release.resolve();
      await Promise.all([first, second]);
    }
  });

  test.each([false, true])("a newer authorization survives an older token exchange (failure=%s)", async (failure) => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdOAuthExchange({ failure });
    const callback = channelConnectionService.completeLinkedInOAuth({ code: "old-code", state });
    await held.entered.promise;
    try {
      const newer = extractState(await startOAuth(admin, {
        organizationId: "987654321", organizationName: "New organization selection",
      }));
      const snapshot = ownerIntentSnapshot(await storedConnection());
      expect(snapshot.oauthStateHash).toBe(crypto.createHash("sha256").update(newer).digest("hex"));
      held.release.resolve();
      const result = await callback;
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/changed|superseded/i);
      expect(ownerIntentSnapshot(await storedConnection())).toEqual(snapshot);
      expect(axios.get).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      await callback;
    }
  });

  test.each([false, true])("a same-value owner connection update supersedes an old callback (active=%s)", async (isActive) => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    await channelConnectionService.upsertChannelConnection({
      channelKey: "linkedin_company", actor: connectionOwnerActor(admin),
      payload: { isActive, organizationId: "123456789" },
    });
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdOAuthExchange();
    const callback = channelConnectionService.completeLinkedInOAuth({ code: "old-code", state });
    await held.entered.promise;
    try {
      await channelConnectionService.upsertChannelConnection({
        channelKey: "linkedin_company", actor: connectionOwnerActor(admin),
        payload: { isActive, organizationId: "123456789" },
      });
      const snapshot = ownerIntentSnapshot(await storedConnection());
      held.release.resolve();
      const result = await callback;
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/changed|superseded/i);
      expect(ownerIntentSnapshot(await storedConnection())).toEqual(snapshot);
      expect(axios.get).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      await callback;
    }
  });

  test("a newer authorization survives an old callback already validating its token", async () => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdMemberValidation();
    const callback = channelConnectionService.completeLinkedInOAuth({ code: "old-code", state });
    await held.entered.promise;
    try {
      await startOAuth(admin, { organizationId: "987654321", organizationName: "Current owner selection" });
      const snapshot = ownerIntentSnapshot(await storedConnection());
      held.release.resolve();
      const result = await callback;
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/changed|superseded/i);
      expect(ownerIntentSnapshot(await storedConnection())).toEqual(snapshot);
    } finally {
      held.release.resolve();
      await callback;
    }
  });

  test.each([false, true])("validation cannot save over a newer same-value owner update (active=%s)", async (isActive) => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    mockLinkedInValidationSuccess();
    const held = holdMemberValidation();
    const validation = channelConnectionService.validateLinkedInConnection({ actor: connectionOwnerActor(admin), forceRevalidate: true })
      .then((connection) => ({ connection }), (error) => ({ error }));
    await held.entered.promise;
    try {
      await channelConnectionService.upsertChannelConnection({
        channelKey: "linkedin_company", actor: connectionOwnerActor(admin),
        payload: { isActive, organizationId: "123456789", organizationName: "Let's ParaConnect" },
      });
      const snapshot = ownerIntentSnapshot(await storedConnection());
      held.release.resolve();
      const result = await validation;
      expect(result.error?.statusCode).toBe(409);
      expect(result.error?.message).toMatch(/changed|superseded/i);
      expect(ownerIntentSnapshot(await storedConnection())).toEqual(snapshot);
    } finally {
      held.release.resolve();
      await validation;
    }
  });

  test("expired and mismatched states cannot exchange a code or mutate the owner connection", async () => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    await MarketingChannelConnection.updateOne({ channelKey: "linkedin_company" }, {
      $set: { oauthStateExpiresAt: new Date(Date.now() - 1000) },
    });
    const snapshot = ownerIntentSnapshot(await storedConnection());
    for (const invalidState of [state, "different-state", ""]) {
      const result = await channelConnectionService.completeLinkedInOAuth({ code: "invalid-code", state: invalidState });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/invalid or expired/);
    }
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(ownerIntentSnapshot(await storedConnection())).toEqual(snapshot);
  });

  test("legacy connections without an intent version validate and advance safely on a new owner intent", async () => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    await MarketingChannelConnection.collection.updateOne({ channelKey: "linkedin_company" }, {
      $unset: { intentVersion: "" },
    });
    const result = await channelConnectionService.completeLinkedInOAuth({ code: "legacy-code", state });
    expect(result.ok).toBe(true);
    const previousVersion = (await storedConnection()).intentVersion || 0;
    const nextState = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    expect(nextState).not.toBe(state);
    expect((await storedConnection()).intentVersion).toBe(previousVersion + 1);
    const replay = await channelConnectionService.completeLinkedInOAuth({ code: "replay", state });
    expect(replay.ok).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test("legacy validation matches an absent generation without requiring a migration", async () => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    await MarketingChannelConnection.collection.updateOne({ channelKey: "linkedin_company" }, {
      $unset: { intentVersion: "" },
    });
    mockLinkedInValidationSuccess();
    const result = await channelConnectionService.validateLinkedInConnection({ actor: connectionOwnerActor(admin), forceRevalidate: true });
    expect(result.status).toBe("connected_validated");
    expect((await storedConnection()).intentVersion).toBeUndefined();
    await startOAuth(admin, { organizationId: "123456789" });
    expect((await storedConnection()).intentVersion).toBe(1);
  });

  test.each(["denial", "exchange_failure"])("a callback %s supersedes validation of a prior token", async (failureType) => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const heldExchange = failureType === "exchange_failure" ? holdOAuthExchange({ failure: true }) : null;
    const callback = heldExchange
      ? channelConnectionService.completeLinkedInOAuth({ code: "rejected-code", state }) : null;
    if (heldExchange) await heldExchange.entered.promise;
    const heldValidation = holdMemberValidation();
    const validation = channelConnectionService.validateLinkedInConnection({ actor: connectionOwnerActor(admin), forceRevalidate: true })
      .then((connection) => ({ connection }), (error) => ({ error }));
    await heldValidation.entered.promise;
    try {
      if (heldExchange) heldExchange.release.resolve();
      const failedCallback = callback ? await callback : await channelConnectionService.completeLinkedInOAuth({
        state, error: "access_denied", errorDescription: "Owner declined the synthetic connection",
      });
      expect(failedCallback.ok).toBe(false);
      const snapshot = ownerIntentSnapshot(await storedConnection());
      heldValidation.release.resolve();
      const result = await validation;
      expect(result.error?.statusCode).toBe(409);
      expect(ownerIntentSnapshot(await storedConnection())).toEqual(snapshot);
      expect(snapshot.lastValidationStatus).toBe("auth_failed");
      const replay = await channelConnectionService.completeLinkedInOAuth({ code: "replayed", state });
      expect(replay.message).toMatch(/invalid or expired/);
      expect(axios.post).toHaveBeenCalledTimes(heldExchange ? 1 : 0);
    } finally {
      heldExchange?.release.resolve();
      heldValidation.release.resolve();
      await Promise.all([validation, callback]);
    }
  });

  test("an exchanged token with no returned scopes cannot inherit a previous token's publishing permission", async () => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    axios.post.mockResolvedValue({ status: 200, data: { access_token: "new-unscoped-token", expires_in: 3600 } });
    const result = await channelConnectionService.completeLinkedInOAuth({ code: "unscoped-code", state });
    expect(result.ok).toBe(false);
    expect(result.connection.status).toBe("blocked");
    expect(result.connection.scopeSnapshot).toEqual([]);
    expect(result.message).toMatch(/missing required scopes/);
    expect(axios.get).not.toHaveBeenCalled();
    const stored = await storedConnection();
    expect(stored.authorizationGranted).toBe(false);
    expect(decryptString(stored.encryptedAccessToken)).toBe("new-unscoped-token");
  });
});

const OWNER_REVOCATIONS = [
  ["disabled", { disabled: true }],
  ["deleted", { deleted: true }],
  ["removed", null],
  ["reclassified", { role: "paralegal" }],
  ["unapproved", { status: "pending" }],
  ["session version changed", { authVersion: 1 }],
];

function connectionOwnerActor(admin) {
  return { actorType: "user", userId: admin._id, label: admin.email, authVersion: Number(admin.authVersion || 0) };
}

async function revokeConnectionOwner(admin, changes) {
  if (changes === null) await User.deleteOne({ _id: admin._id });
  else await User.updateOne({ _id: admin._id }, { $set: changes });
}

describe("LinkedIn current owner authority", () => {
  test("an unconfirmed state-issuance commit returns explicit uncertainty without an automatic retry", async () => {
    const admin = await createAdmin(); await saveLinkedInConnection(admin);
    const version = (await storedConnection()).intentVersion;
    const mongoose = require("mongoose"), startSession = mongoose.startSession.bind(mongoose);
    let commits = 0;
    const interception = jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => {
      const session = await startSession(...args), commit = session.commitTransaction.bind(session);
      session.commitTransaction = async (...options) => {
        await commit(...options); commits += 1;
        throw Object.assign(new Error("PRIVATE synthetic uncertain commit"), {
          hasErrorLabel: label => label === "UnknownTransactionCommitResult",
        });
      };
      return session;
    });
    try {
      const response = await request(app)
        .post("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/start")
        .set("Cookie", authCookieFor(admin)).send({ organizationId: "987654321" });
      expect(response.status).toBe(503); expect(response.body.code).toBe("ACCOUNT_WRITE_UNCONFIRMED");
      expect(response.body.error).toMatch(/could not be confirmed.*check the current state/i);
      expect(JSON.stringify(response.body)).not.toContain("PRIVATE");
      expect(commits).toBe(1);
      const stored = await storedConnection(); expect(stored.intentVersion).toBe(version + 1);
      expect(stored.organizationId).toBe("987654321"); expect(stored.oauthStateHash).not.toBe("");
      expect(axios.post).not.toHaveBeenCalled();
    } finally { interception.mockRestore(); }
  });

  test("an actual request verified before session revocation cannot issue OAuth using the newer database version", async () => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    const snapshot = await storedConnection();
    const findById = User.findById.bind(User);
    let revoked = false;
    const interception = jest.spyOn(User, "findById").mockImplementation((...args) => {
      const query = findById(...args), lean = query.lean.bind(query);
      query.lean = async (...options) => {
        const current = await lean(...options);
        if (!revoked && String(current?._id) === String(admin._id)) {
          revoked = true;
          // verifyToken receives its already-read account snapshot, while the
          // state-issuing service must arbitrate with the newer current record.
          await User.collection.updateOne({ _id: admin._id }, { $inc: { authVersion: 1 } });
        }
        return current;
      };
      return query;
    });
    try {
      const response = await request(app)
        .post("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/start")
        .set("Cookie", authCookieFor(admin)).send({ organizationId: "987654321" });
      expect(revoked).toBe(true);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACCOUNT_CHANGED");
      expect(response.body.error).toMatch(/sign in again/i);
      expect(await storedConnection()).toEqual(snapshot);
      expect(axios.post).not.toHaveBeenCalled();
    } finally { interception.mockRestore(); }
  });

  test.each(OWNER_REVOCATIONS)("an issued callback cannot exchange or mutate after its owner is %s", async (_label, changes) => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const snapshot = await storedConnection();
    await revokeConnectionOwner(admin, changes);
    const result = await channelConnectionService.completeLinkedInOAuth({ code: "revoked-owner-code", state });
    expect(result.ok).toBe(false);
    expect(result.connection).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await storedConnection()).toEqual(snapshot);
  });

  test.each(OWNER_REVOCATIONS)("a token exchange cannot commit after its owner is %s", async (_label, changes) => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdOAuthExchange();
    const callback = channelConnectionService.completeLinkedInOAuth({ code: "previously-authorized-code", state });
    await held.entered.promise;
    try {
      await revokeConnectionOwner(admin, changes);
      const snapshot = await storedConnection();
      held.release.resolve();
      const result = await callback;
      expect(result.ok).toBe(false);
      expect(result.connection).toBeNull();
      expect(await storedConnection()).toEqual(snapshot);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.get).not.toHaveBeenCalled();
    } finally { held.release.resolve(); await callback; }
  });

  test.each(OWNER_REVOCATIONS)("callback validation cannot commit after its owner is %s", async (_label, changes) => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdMemberValidation();
    const callback = channelConnectionService.completeLinkedInOAuth({ code: "previously-authorized-code", state });
    await held.entered.promise;
    try {
      await revokeConnectionOwner(admin, changes);
      const snapshot = await storedConnection();
      held.release.resolve();
      const result = await callback;
      expect(result.ok).toBe(false);
      expect(result.connection).toBeNull();
      expect(await storedConnection()).toEqual(snapshot);
      expect(snapshot.authorizationGranted).toBe(false);
      expect(axios.post).toHaveBeenCalledTimes(1);
    } finally { held.release.resolve(); await callback; }
  });

  test.each(OWNER_REVOCATIONS)("owner-requested validation cannot commit after its owner is %s", async (_label, changes) => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    mockLinkedInValidationSuccess();
    const held = holdMemberValidation();
    const validation = channelConnectionService.validateLinkedInConnection({ actor: connectionOwnerActor(admin), forceRevalidate: true })
      .then(connection => ({ connection }), error => ({ error }));
    await held.entered.promise;
    try {
      await revokeConnectionOwner(admin, changes);
      const snapshot = await storedConnection();
      held.release.resolve();
      const result = await validation;
      expect(result.error?.statusCode).toBe(403);
      expect(result.error?.code).toBe("ACCOUNT_CHANGED");
      expect(await storedConnection()).toEqual(snapshot);
    } finally { held.release.resolve(); await validation; }
  });

  test.each(OWNER_REVOCATIONS)("a request authenticated before its owner is %s cannot issue a new state", async (_label, changes) => {
    const admin = await createAdmin();
    await saveLinkedInConnection(admin);
    const actor = connectionOwnerActor(admin);
    const snapshot = await storedConnection();
    await revokeConnectionOwner(admin, changes);
    await expect(channelConnectionService.startLinkedInOAuth({ actor, hints: { organizationId: "987654321" } }))
      .rejects.toMatchObject({ statusCode: 403, code: "ACCOUNT_CHANGED" });
    expect(await storedConnection()).toEqual(snapshot);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("a revoked owner cannot persist callback denial or provider failure metadata", async () => {
    const admin = await createAdmin();
    mockLinkedInValidationSuccess();
    let state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    await revokeConnectionOwner(admin, { disabled: true });
    let snapshot = await storedConnection();
    let result = await channelConnectionService.completeLinkedInOAuth({ state, error: "access_denied" });
    expect(result.ok).toBe(false); expect(result.connection).toBeNull();
    expect(await storedConnection()).toEqual(snapshot);
    await User.updateOne({ _id: admin._id }, { $set: { disabled: false } });
    state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    const held = holdOAuthExchange({ failure: true });
    const callback = channelConnectionService.completeLinkedInOAuth({ state, code: "rejected-code" });
    await held.entered.promise;
    try {
      await revokeConnectionOwner(admin, { disabled: true });
      snapshot = await storedConnection(); held.release.resolve(); result = await callback;
      expect(result.ok).toBe(false); expect(result.connection).toBeNull();
      expect(await storedConnection()).toEqual(snapshot);
    } finally { held.release.resolve(); await callback; }
  });

  test("legacy pending OAuth without an issued authentication version must restart safely", async () => {
    const admin = await createAdmin(); mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    await MarketingChannelConnection.collection.updateOne({ channelKey: "linkedin_company" }, { $unset: { oauthRequestedAuthVersion: "" } });
    const snapshot = await storedConnection();
    const result = await channelConnectionService.completeLinkedInOAuth({ state, code: "legacy-unbound-code" });
    expect(result.ok).toBe(false); expect(result.connection).toBeNull();
    expect(await storedConnection()).toEqual(snapshot); expect(axios.post).not.toHaveBeenCalled();
  });

  test("OAuth uses the authenticated request version and keeps owner authority metadata internal", async () => {
    const admin = await createAdmin();
    await User.updateOne({ _id: admin._id }, { $set: { authVersion: 3 } }); admin.authVersion = 3;
    mockLinkedInValidationSuccess();
    const state = extractState(await startOAuth(admin, { organizationId: "123456789" }));
    expect((await storedConnection()).oauthRequestedAuthVersion).toBe(3);
    const result = await channelConnectionService.completeLinkedInOAuth({ state, code: "current-version-code" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/oauthRequestedAuthVersion|oauthRequestedBy|oauthStateHash|intentVersion|encryptedAccessToken/);
    expect((await storedConnection()).authorizationGranted).toBe(true);
  });
});
