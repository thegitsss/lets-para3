const mongoose = require("mongoose");

const AuditLog = require("../models/AuditLog");
const Case = require("../models/Case");
const PlatformIncome = require("../models/PlatformIncome");
const StorageDeletionTask = require("../models/StorageDeletionTask");
const User = require("../models/User");
const SupportMutation = require("../models/SupportMutation");
const {
  finalizeAccountDataRemoval,
  getDurableAccountRecordSummary,
} = require("../services/userDeletion");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const originalBucket = process.env.S3_BUCKET;
const originalRegion = process.env.S3_REGION;

async function createUser(overrides = {}) {
  return User.create({
    firstName: "Removal",
    lastName: "Candidate",
    email: `removal-${new mongoose.Types.ObjectId()}@example.com`,
    password: "a sufficiently long removal passphrase",
    role: "attorney",
    status: "denied",
    state: "DE",
    disabled: true,
    deleted: true,
    deletedAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  });
}

beforeAll(async () => {
  process.env.S3_BUCKET = "private-removal-test-bucket";
  process.env.S3_REGION = "us-east-1";
  await connect();
});

afterAll(async () => {
  if (typeof originalBucket === "undefined") delete process.env.S3_BUCKET;
  else process.env.S3_BUCKET = originalBucket;
  if (typeof originalRegion === "undefined") delete process.env.S3_REGION;
  else process.env.S3_REGION = originalRegion;
  await closeDatabase();
});

beforeEach(clearDatabase);

describe("account personal-data removal", () => {
  test("removes private Assistant receipts and captured retry input with their owner", async () => {
    const owner = await createUser(), other = await createUser();
    for (const user of [owner, other]) await SupportMutation.create({ ownerId: user._id, conversationId: new mongoose.Types.ObjectId(), role: user.role,
      requestId: require('node:crypto').randomUUID(), action: 'send', fingerprint: 'synthetic', input: { text: 'Private saved question', sourcePage: '', pageContext: {} },
      state: 'retryable', active: true, prepared: { assistantReply: { text: 'Private draft reply' } } });
    await finalizeAccountDataRemoval(owner._id);
    expect(await SupportMutation.countDocuments({ ownerId: owner._id })).toBe(0);
    expect(await SupportMutation.countDocuments({ ownerId: other._id })).toBe(1);
  });
  test("minimizes direct identifiers but preserves matter and financial ledgers", async () => {
    const attorney = await createUser({
      firstName: "Avery",
      lastName: "Counsel",
      email: "avery.removal@example.com",
      phoneNumber: "+13025550123",
      lawFirm: "Avery Counsel LLC",
      bio: "Professional biography",
      stripeCustomerId: "cus_retained_financial_reference",
    });
    const resumeKey = `paralegal-resumes/${attorney._id}/resume-1760000000000-aabbccddeeff.pdf`;
    attorney.resumeURL = resumeKey;
    await attorney.save();
    const paralegal = await createUser({
      role: "paralegal",
      email: "paralegal.removal-test@example.com",
    });
    const matter = await Case.create({
      title: "Retained completed matter",
      practiceArea: "business",
      details: "Historical matter evidence must not be destroyed by account removal.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "completed",
      paymentReleased: true,
      paidOutAt: new Date(),
      completedAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_retained_removal",
      totalAmount: 50000,
      currency: "usd",
    });
    await PlatformIncome.create({
      caseId: matter._id,
      operationKey: "removal-retained-income",
      attorneyId: attorney._id,
      paralegalId: paralegal._id,
      feeAmount: 5000,
      stripeMode: "test",
    });
    await AuditLog.create({
      actor: attorney._id,
      actorRole: "attorney",
      action: "case.create",
      targetType: "case",
      targetId: String(matter._id),
      case: matter._id,
    });

    const result = await finalizeAccountDataRemoval(attorney._id, {
      now: new Date("2026-08-14T14:00:00.000Z"),
    });

    expect(result.mode).toBe("minimized");
    expect(result.retainedRecordTypes).toEqual(expect.arrayContaining(["matters", "platformIncome"]));
    const minimized = await User.findById(attorney._id).select("+password +authProviders").lean();
    expect(minimized).toMatchObject({
      firstName: "Deactivated",
      lastName: "User",
      email: `deleted-${attorney._id}@redacted.invalid`,
      phoneNumber: null,
      lawFirm: "",
      bio: "",
      resumeURL: null,
      disabled: true,
      deleted: true,
      personalDataStatus: "minimized",
      stripeCustomerId: "cus_retained_financial_reference",
    });
    expect(minimized.password).not.toBe(attorney.password);
    expect(minimized.authProviders).toEqual([]);
    expect(await Case.countDocuments({ _id: matter._id })).toBe(1);
    expect(await PlatformIncome.countDocuments({ caseId: matter._id })).toBe(1);
    expect(await AuditLog.countDocuments({ case: matter._id })).toBe(1);
    expect(await StorageDeletionTask.findOne({ key: resumeKey }).lean()).toMatchObject({ status: "pending" });
  });

  test("fully removes an unused deactivated account while retaining immutable audit evidence", async () => {
    const user = await createUser({ email: "unused.removal@example.com" });
    await AuditLog.create({
      actorRole: "admin",
      action: "admin.user.delete",
      targetType: "user",
      targetId: String(user._id),
    });

    expect(await getDurableAccountRecordSummary(user._id)).toEqual({});
    const result = await finalizeAccountDataRemoval(user._id);

    expect(result).toMatchObject({ mode: "purged", retainedRecordTypes: [] });
    expect(await User.findById(user._id)).toBeNull();
    expect(await AuditLog.countDocuments({ targetId: String(user._id) })).toBe(1);
  });

  test("refuses to process data removal before deactivation", async () => {
    const active = await createUser({
      email: "active.removal@example.com",
      status: "approved",
      disabled: false,
      deleted: false,
      deletedAt: null,
    });

    await expect(finalizeAccountDataRemoval(active._id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await User.findById(active._id)).toBeTruthy();
  });
});
