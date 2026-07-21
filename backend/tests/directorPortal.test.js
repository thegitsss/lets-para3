const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../services/director/mailImportService", () => {
  const actual = jest.requireActual("../services/director/mailImportService");
  return {
    ...actual,
    fetchZohoMessages: jest.fn(),
  };
});
jest.mock("../utils/email", () => jest.fn().mockResolvedValue({ messageId: "test-message" }));

const Case = require("../models/Case");
const DirectorOutreachRecord = require("../models/DirectorOutreachRecord");
const DirectorOutreachEvent = require("../models/DirectorOutreachEvent");
const DirectorProfile = require("../models/DirectorProfile");
const PlatformIncome = require("../models/PlatformIncome");
const User = require("../models/User");
const adminDirectorsRouter = require("../routes/adminDirectors");
const directorRouter = require("../routes/directorPortal");
const {
  autoImportDirectorMail,
  processAutomaticDirectorFollowUps,
} = require("../services/director/directorPortalService");
const mailImportService = require("../services/director/mailImportService");
const sendEmail = require("../utils/email");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/director", directorRouter);
  instance.use("/api/admin/directors", adminDirectorsRouter);
  instance.use((err, _req, res, _next) => {
    res.status(err?.statusCode || 500).json({ error: err?.message || "Server error" });
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

function daysAgo(days, hour = 12) {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date;
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

async function createDirector() {
  return User.create({
    firstName: "Skyler",
    lastName: "Director",
    email: "skyler@lets-paraconnect.com",
    password: "Password123!",
    role: "director",
    status: "approved",
    emailVerified: true,
  });
}

async function createAdmin() {
  return User.create({
    firstName: "Samantha",
    lastName: "Admin",
    email: "samantha@lets-paraconnect.com",
    password: "Password123!",
    role: "admin",
    status: "approved",
    emailVerified: true,
  });
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  process.env.DIRECTOR_SMTP_SKYLER_USER = "skyler@lets-paraconnect.com";
  process.env.DIRECTOR_SMTP_SKYLER_PASS = "test-director-password";
  mailImportService.fetchZohoMessages.mockReset();
  sendEmail.mockClear();
});

describe("Director portal", () => {
  test("sends portal outreach from locked director template and logs the record", async () => {
    const director = await createDirector();
    await DirectorProfile.create({
      userId: director._id,
      email: director.email,
      zohoEmail: director.email,
      displayName: "Skyler Director",
      outreachSubject: "for matters that need an extra hand next",
      outreachTemplateText: "Hi {{attorneyName}},\n\nLocked body stays unchanged.",
    });

    const res = await request(app)
      .post("/api/director/outreach")
      .set("Cookie", authCookieFor(director))
      .send({
        attorneyName: "Jordan Ellis",
        attorneyEmail: "jordan@example-law.com",
        state: "TX",
      });

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      "jordan@example-law.com",
      "for matters that need an extra hand next",
      expect.stringContaining("Hi Jordan Ellis,"),
      expect.objectContaining({
        text: "Hi Jordan Ellis,\n\nLocked body stays unchanged.",
        from: "\"Skyler Director\" <skyler@lets-paraconnect.com>",
        replyTo: "skyler@lets-paraconnect.com",
        smtp: expect.objectContaining({
          user: "skyler@lets-paraconnect.com",
          pass: "test-director-password",
        }),
      })
    );

    const record = await DirectorOutreachRecord.findOne({ attorneyEmail: "jordan@example-law.com" }).lean();
    expect(record).toEqual(
      expect.objectContaining({
        attorneyName: "Jordan Ellis",
        state: "TX",
        stage: "outreach_sent",
        source: "portal_send",
      })
    );
    expect(record.firstOutreachSentAt).toBeTruthy();

    const event = await DirectorOutreachEvent.findOne({ recordId: record._id, eventType: "outreach_sent" }).lean();
    expect(event).toEqual(
      expect.objectContaining({
        attorneyEmail: "jordan@example-law.com",
        provider: "smtp",
        summary: "Initial outreach sent from Director Portal.",
      })
    );

    const duplicate = await request(app)
      .post("/api/director/outreach")
      .set("Cookie", authCookieFor(director))
      .send({
        attorneyName: "Jordan Ellis",
        attorneyEmail: "jordan@example-law.com",
        state: "TX",
      });
    expect(duplicate.status).toBe(409);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  test("imports today's outreach from sent Zoho messages without requiring a state assignment", async () => {
    const director = await createDirector();
    mailImportService.fetchZohoMessages.mockResolvedValue([
      {
        subject: "for matters that need an extra hand next",
        toAddress: "\"Jordan Ellis\" <jordan@example-law.com>",
        sentDate: "2026-06-28T14:00:00.000Z",
        messageId: "zoho-1",
      },
    ]);

    const res = await request(app)
      .post("/api/director/import-today")
      .set("Cookie", authCookieFor(director))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const record = await DirectorOutreachRecord.findOne({ attorneyEmail: "jordan@example-law.com" }).lean();
    expect(record).toEqual(
      expect.objectContaining({
        directorEmail: "skyler@lets-paraconnect.com",
        attorneyName: "Jordan Ellis",
        state: "",
        stage: "outreach_sent",
      })
    );
  });

  test("imports sent Zoho outreach using the current director subject line", async () => {
    const director = await createDirector();
    mailImportService.fetchZohoMessages.mockResolvedValue([
      {
        subject: "On-demand paralegal support for your firm",
        toAddress: "\"Morgan Lee\" <morgan@example-law.com>",
        sentDate: "2026-06-28T15:00:00.000Z",
        messageId: "zoho-current-subject-1",
      },
    ]);

    const res = await request(app)
      .post("/api/director/import-today")
      .set("Cookie", authCookieFor(director))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const record = await DirectorOutreachRecord.findOne({ attorneyEmail: "morgan@example-law.com" }).lean();
    expect(record).toEqual(
      expect.objectContaining({
        directorEmail: "skyler@lets-paraconnect.com",
        attorneyName: "Morgan Lee",
        stage: "outreach_sent",
      })
    );
  });

  test("uses a recent lookback window for manual sent-mail imports", async () => {
    const director = await createDirector();
    mailImportService.fetchZohoMessages.mockResolvedValue([]);
    const before = Date.now();

    const res = await request(app)
      .post("/api/director/import-today")
      .set("Cookie", authCookieFor(director))
      .send({});

    expect(res.status).toBe(200);
    expect(mailImportService.fetchZohoMessages).toHaveBeenCalledTimes(1);
    const call = mailImportService.fetchZohoMessages.mock.calls[0][0];
    const lookbackHours = (before - new Date(call.fromDate).getTime()) / (60 * 60 * 1000);
    expect(lookbackHours).toBeGreaterThanOrEqual(35.9);
    expect(lookbackHours).toBeLessThanOrEqual(36.1);
    expect(new Date(call.toDate).getTime()).toBeGreaterThanOrEqual(before);
  });

  test("auto-imports director sent mail and replies without a portal click", async () => {
    const director = await createDirector();
    mailImportService.fetchZohoMessages.mockImplementation(async ({ folderKind }) => {
      if (folderKind === "sent") {
        return [
          {
            subject: "for matters that need an extra hand next",
            toAddress: "\"Jordan Ellis\" <jordan@example-law.com>",
            sentDate: "2026-06-28T14:00:00.000Z",
            messageId: "zoho-sent-1",
          },
        ];
      }
      if (folderKind === "inbox") {
        return [
          {
            subject: "Re: for matters that need an extra hand next",
            fromAddress: "\"Jordan Ellis\" <jordan@example-law.com>",
            receivedDate: "2026-06-29T15:00:00.000Z",
            messageId: "zoho-reply-1",
            snippet: "I have a question about the platform.",
          },
        ];
      }
      return [];
    });

    const result = await autoImportDirectorMail({
      directorUserId: director._id,
      fromDate: new Date("2026-06-28T00:00:00.000Z"),
      toDate: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(result).toEqual(
      expect.objectContaining({
        scannedDirectors: 1,
        sentImported: 1,
        repliesImported: 1,
        failed: 0,
      })
    );
    expect(mailImportService.fetchZohoMessages).toHaveBeenCalledWith(
      expect.objectContaining({ folderKind: "sent" })
    );
    expect(mailImportService.fetchZohoMessages).toHaveBeenCalledWith(
      expect.objectContaining({ folderKind: "inbox" })
    );

    const record = await DirectorOutreachRecord.findOne({ attorneyEmail: "jordan@example-law.com" }).lean();
    expect(record).toEqual(
      expect.objectContaining({
        directorEmail: "skyler@lets-paraconnect.com",
        attorneyName: "Jordan Ellis",
        stage: "founder_attention",
      })
    );
    expect(record.lastReplyAt).toBeTruthy();

    const profile = await DirectorProfile.findOne({ userId: director._id }).lean();
    expect(profile).toEqual(
      expect.objectContaining({
        zohoLastSyncStatus: "success",
      })
    );
    expect(profile.zohoLastSyncAt).toBeTruthy();
    expect(profile.zohoLastSyncSummary).toContain("Auto-sync scanned");
  });

  test("prevents duplicate attorney assignment across directors", async () => {
    const firstDirector = await createDirector();
    const secondDirector = await User.create({
      firstName: "Second",
      lastName: "Director",
      email: "second.director@lets-paraconnect.com",
      password: "Password123!",
      role: "director",
      status: "approved",
      emailVerified: true,
    });
    process.env.DIRECTOR_SMTP_SECOND_DIRECTOR_USER = "second.director@lets-paraconnect.com";
    process.env.DIRECTOR_SMTP_SECOND_DIRECTOR_PASS = "test-director-password";

    await DirectorProfile.create({
      userId: firstDirector._id,
      email: firstDirector.email,
      zohoEmail: firstDirector.email,
      displayName: "Skyler Director",
      outreachSubject: "for matters that need an extra hand next",
      outreachTemplateText: "Hi {{attorneyName}},\n\nLocked body.",
    });
    await DirectorProfile.create({
      userId: secondDirector._id,
      email: secondDirector.email,
      zohoEmail: secondDirector.email,
      displayName: "Second Director",
      outreachSubject: "for matters that need an extra hand next",
      outreachTemplateText: "Hi {{attorneyName}},\n\nLocked body.",
    });
    await DirectorOutreachRecord.create({
      directorUserId: firstDirector._id,
      directorEmail: firstDirector.email,
      attorneyEmail: "claimed@example-law.com",
      attorneyName: "Claimed Attorney",
      firstOutreachSentAt: new Date(),
      stage: "outreach_sent",
    });

    const res = await request(app)
      .post("/api/director/outreach")
      .set("Cookie", authCookieFor(secondDirector))
      .send({
        attorneyName: "Claimed Attorney",
        attorneyEmail: "claimed@example-law.com",
        state: "TX",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another director/i);
  });

  test("matches registrations, completed matters, and attorney-fee-only commission", async () => {
    const director = await createDirector();
    const attorney = await User.create({
      firstName: "Jordan",
      lastName: "Ellis",
      email: "jordan@example-law.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Para",
      lastName: "Legal",
      email: "para@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      emailVerified: true,
    });
    await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: attorney.email,
      attorneyName: "Jordan Ellis",
      firstOutreachSentAt: new Date("2026-06-01T12:00:00.000Z"),
      stage: "outreach_sent",
    });
    const caseDoc = await Case.create({
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      title: "Contract review",
      details: "Review documents.",
      status: "completed",
      completedAt: new Date("2026-06-20T12:00:00.000Z"),
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 22000,
      feeParalegalPct: 18,
      feeParalegalAmount: 18000,
    });
    await PlatformIncome.create({
      caseId: caseDoc._id,
      attorneyId: attorney._id,
      paralegalId: paralegal._id,
      feeAmount: 40000,
      stripeMode: "test",
    });

    const res = await request(app)
      .get("/api/director/records")
      .set("Cookie", authCookieFor(director));

    expect(res.status).toBe(200);
    expect(res.body.records[0]).toEqual(
      expect.objectContaining({
        attorneyEmail: attorney.email,
        state: "CA",
        stage: "commission_complete",
        commissionableMatterCount: 1,
        commissionEarnedCents: 11000,
      })
    );
  });

  test("returns analytics series from outreach records and matched platform outcomes", async () => {
    const director = await createDirector();
    const firstOutreachSentAt = daysAgo(6);
    const registeredAt = daysAgo(5);
    const followUpSentAt = daysAgo(4);
    const lastReplyAt = daysAgo(3);
    const firstMatterPostedAt = daysAgo(2);
    const firstMatterCompletedAt = daysAgo(1);
    const attorney = await User.create({
      firstName: "Jordan",
      lastName: "Ellis",
      email: "jordan@example-law.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      createdAt: registeredAt,
      state: "TX",
    });
    const paralegal = await User.create({
      firstName: "Para",
      lastName: "Legal",
      email: "para.analytics@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      emailVerified: true,
    });
    await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: attorney.email,
      attorneyName: "Jordan Ellis",
      firstOutreachSentAt,
      followUpSentAt,
      lastReplyAt,
      stage: "outreach_sent",
    });
    const caseDoc = await Case.create({
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      title: "Analytics matter",
      details: "Review documents.",
      status: "completed",
      createdAt: firstMatterPostedAt,
      completedAt: firstMatterCompletedAt,
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 22000,
    });
    await PlatformIncome.create({
      caseId: caseDoc._id,
      attorneyId: attorney._id,
      paralegalId: paralegal._id,
      feeAmount: 22000,
      stripeMode: "test",
    });

    const res = await request(app)
      .get("/api/director/analytics?days=30")
      .set("Cookie", authCookieFor(director));

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual(
      expect.objectContaining({
        emailsSent: 1,
        registrations: 1,
        followUps: 1,
        replies: 1,
        mattersPosted: 1,
        mattersCompleted: 1,
        commissionableMatters: 1,
        conversionRatePct: 100,
      })
    );
    const byDate = new Map(res.body.series.map((bucket) => [bucket.date, bucket]));
    expect(byDate.get(isoDate(firstOutreachSentAt)).emailsSent).toBe(1);
    expect(byDate.get(isoDate(registeredAt)).registrations).toBe(1);
    expect(byDate.get(isoDate(firstMatterPostedAt)).mattersPosted).toBe(1);
    expect(byDate.get(isoDate(firstMatterCompletedAt)).mattersCompleted).toBe(1);
  });

  test("filters overview and records by selected day range", async () => {
    const director = await createDirector();
    const recentAttorney = await User.create({
      firstName: "Recent",
      lastName: "Attorney",
      email: "recent@example-law.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      createdAt: new Date(),
      state: "TX",
    });
    await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: recentAttorney.email,
      attorneyName: "Recent Attorney",
      firstOutreachSentAt: new Date(),
      stage: "outreach_sent",
    });
    await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: "old@example-law.com",
      attorneyName: "Old Attorney",
      firstOutreachSentAt: new Date("2026-01-01T12:00:00.000Z"),
      stage: "outreach_sent",
    });

    const overview = await request(app)
      .get("/api/director/overview?rangeDays=1")
      .set("Cookie", authCookieFor(director));
    expect(overview.status).toBe(200);
    expect(overview.body.counts.total).toBe(1);
    expect(overview.body.attention).toEqual(
      expect.objectContaining({
        followUpsFailed: 0,
      })
    );

    const records = await request(app)
      .get("/api/director/records?rangeDays=1")
      .set("Cookie", authCookieFor(director));
    expect(records.status).toBe(200);
    expect(records.body.records).toHaveLength(1);
    expect(records.body.records[0].attorneyEmail).toBe(recentAttorney.email);
  });

  test("automatically sends follow-up when registered attorney has not posted a matter after eight days", async () => {
    const director = await createDirector();
    const attorney = await User.create({
      firstName: "Jordan",
      lastName: "Ellis",
      email: "jordan@example-law.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      createdAt: new Date("2026-06-29T12:00:00.000Z"),
    });
    await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: attorney.email,
      attorneyName: "Jordan Ellis",
      state: "TX",
      firstOutreachSentAt: new Date("2026-05-28T12:00:00.000Z"),
      stage: "outreach_sent",
    });

    const result = await processAutomaticDirectorFollowUps({
      directorUserId: director._id,
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("jordan@example-law.com");
    expect(sendEmail.mock.calls[0][1]).toBe("need help posting your first matter?");
    expect(sendEmail.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        replyTo: "skyler@lets-paraconnect.com",
        smtp: expect.objectContaining({
          user: "skyler@lets-paraconnect.com",
        }),
      })
    );

    const record = await DirectorOutreachRecord.findOne({ attorneyEmail: attorney.email }).lean();
    expect(record.followUpSentAt).toEqual(new Date("2026-07-10T12:00:00.000Z"));
    expect(record.stage).toBe("follow_up_sent");

    const secondRun = await processAutomaticDirectorFollowUps({
      directorUserId: director._id,
      now: new Date("2026-07-10T12:05:00.000Z"),
    });
    expect(secondRun.sent).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  test("marks automatic follow-up failures for admin visibility", async () => {
    const director = await createDirector();
    const attorney = await User.create({
      firstName: "Failure",
      lastName: "Case",
      email: "failure@example-law.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      createdAt: new Date("2026-06-29T12:00:00.000Z"),
    });
    await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: attorney.email,
      attorneyName: "Failure Case",
      firstOutreachSentAt: new Date("2026-05-28T12:00:00.000Z"),
      stage: "outreach_sent",
    });
    sendEmail.mockRejectedValueOnce(new Error("SMTP denied"));

    const result = await processAutomaticDirectorFollowUps({
      directorUserId: director._id,
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(result.failed).toBe(1);
    const record = await DirectorOutreachRecord.findOne({ attorneyEmail: attorney.email }).lean();
    expect(record.stage).toBe("follow_up_failed");
    expect(record.metadata.lastFollowUpError).toBe("SMTP denied");
  });

  test("admin director oversight returns queues, csv, and commission audit", async () => {
    const admin = await createAdmin();
    const director = await createDirector();
    const attorney = await User.create({
      firstName: "Audit",
      lastName: "Attorney",
      email: "audit@example-law.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "TX",
    });
    const paralegal = await User.create({
      firstName: "Audit",
      lastName: "Para",
      email: "audit.para@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      emailVerified: true,
    });
    const record = await DirectorOutreachRecord.create({
      directorUserId: director._id,
      directorEmail: director.email,
      attorneyEmail: attorney.email,
      attorneyName: "Audit Attorney",
      firstOutreachSentAt: new Date("2026-06-01T12:00:00.000Z"),
      lastReplyAt: new Date("2026-06-04T12:00:00.000Z"),
      founderAttentionAt: new Date("2026-06-04T12:00:00.000Z"),
      stage: "founder_attention",
    });
    const caseDoc = await Case.create({
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      title: "Audit matter",
      details: "Audit docs.",
      status: "completed",
      completedAt: new Date("2026-06-20T12:00:00.000Z"),
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 22000,
    });
    await PlatformIncome.create({
      caseId: caseDoc._id,
      attorneyId: attorney._id,
      paralegalId: paralegal._id,
      feeAmount: 22000,
      stripeMode: "test",
    });

    const overview = await request(app)
      .get("/api/admin/directors/overview")
      .set("Cookie", authCookieFor(admin));
    expect(overview.status).toBe(200);
    expect(overview.body.directors).toHaveLength(1);
    expect(overview.body.replies).toHaveLength(1);

    const audit = await request(app)
      .get(`/api/admin/directors/records/${record._id}/audit`)
      .set("Cookie", authCookieFor(admin));
    expect(audit.status).toBe(200);
    expect(audit.body.commissionAudit[0]).toEqual(
      expect.objectContaining({
        title: "Audit matter",
        attorneyPlatformFeeCents: 22000,
        directorCommissionCents: 11000,
      })
    );

    const csv = await request(app)
      .get("/api/admin/directors/records.csv")
      .set("Cookie", authCookieFor(admin));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Director,Attorney Name,Attorney Email");
    expect(csv.text).toContain("audit@example-law.com");
  });
});
