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
const MarketingPublishAttempt = require("../models/MarketingPublishAttempt");
const MarketingPublishIntent = require("../models/MarketingPublishIntent");
const User = require("../models/User");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminMarketingRouter = require("../routes/adminMarketing");
const linkedinPublisher = require("../services/marketing/linkedinPublisher");
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
  const response = await request(app)
    .post("/api/admin/marketing/publishing/channel-connections/linkedin_company")
    .set("Cookie", authCookieFor(admin))
    .send({
      organizationName: "Let's ParaConnect",
      organizationId: "123456789",
      organizationUrn: "urn:li:organization:123456789",
      accessToken: "linkedin-access-token-1234",
      apiVersion: "202503",
      scopeSnapshot: ["w_organization_social", "rw_organization_admin"],
      ...overrides,
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
      })
    );
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
