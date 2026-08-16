const mongoose = require("mongoose");
const StorageDeletionTask = require("../models/StorageDeletionTask");
const User = require("../models/User");
const {
  activatePersonalStorageDeletion,
  processPersonalStorageDeletionTasks,
  stagePersonalStorageDeletion,
} = require("../services/personalStorageDeletion");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const env = { S3_BUCKET: "private-test-bucket", S3_REGION: "us-east-1" };

async function createUser(overrides = {}) {
  return User.create({
    firstName: "Storage",
    lastName: "Owner",
    email: `storage-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    ...overrides,
  });
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("personal storage deletion outbox", () => {
  test("rejects keys outside the user's validated personal prefixes", async () => {
    const owner = await createUser();
    await expect(
      stagePersonalStorageDeletion(
        {
          ownerId: owner._id,
          keys: [`profile-photos/${new mongoose.Types.ObjectId()}/profile-1760000000000.jpg`],
          reason: "test",
        },
        { env }
      )
    ).rejects.toMatchObject({ code: "INVALID_STORAGE_DELETION_KEY" });
  });

  test("deletes activated tasks and retains a short-lived audit receipt", async () => {
    const owner = await createUser();
    const key = `paralegal-resumes/${owner._id}/resume-1760000000000.pdf`;
    const ids = await stagePersonalStorageDeletion(
      { ownerId: owner._id, keys: [key], reason: "resume_replaced" },
      { env }
    );
    await activatePersonalStorageDeletion(ids, { now: new Date("2026-08-13T12:00:00.000Z") });
    const s3 = { send: jest.fn().mockResolvedValue({}) };

    const result = await processPersonalStorageDeletionTasks(
      { now: new Date("2026-08-13T12:00:00.000Z") },
      { env, s3 }
    );

    expect(result.deleted).toBe(1);
    expect(s3.send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: env.S3_BUCKET, Key: key } }));
    const task = await StorageDeletionTask.findById(ids[0]).lean();
    expect(task.status).toBe("deleted");
    expect(task.deletedAt).toEqual(new Date("2026-08-13T12:00:00.000Z"));
    expect(task.expiresAt).toBeInstanceOf(Date);
  });

  test("cancels an abandoned held task when the object is still referenced", async () => {
    const owner = await createUser();
    const key = `paralegal-certificates/${owner._id}/certificate-1760000000000-aabbccddeeff.pdf`;
    owner.certificateURL = key;
    await owner.save();
    const stagedAt = new Date("2026-08-13T11:00:00.000Z");
    const ids = await stagePersonalStorageDeletion(
      { ownerId: owner._id, keys: [key], reason: "certificate_replaced", now: stagedAt },
      { env }
    );
    const s3 = { send: jest.fn() };

    const result = await processPersonalStorageDeletionTasks(
      { now: new Date("2026-08-13T12:00:00.000Z") },
      { env, s3 }
    );

    expect(result.cancelled).toBe(1);
    expect(result.deleted).toBe(0);
    expect(s3.send).not.toHaveBeenCalled();
    expect((await StorageDeletionTask.findById(ids[0]).lean()).status).toBe("cancelled");
  });

  test("retries transient S3 failures without storing error messages or object content", async () => {
    const owner = await createUser();
    const key = `paralegal-writing-samples/${owner._id}/writing-sample-1760000000000-aabbccddeeff.pdf`;
    const ids = await stagePersonalStorageDeletion(
      { ownerId: owner._id, keys: [key], reason: "sample_replaced" },
      { env }
    );
    await activatePersonalStorageDeletion(ids, { now: new Date("2026-08-13T12:00:00.000Z") });
    const failure = new Error("do not persist provider details");
    failure.name = "ServiceUnavailable";

    const result = await processPersonalStorageDeletionTasks(
      { now: new Date("2026-08-13T12:00:00.000Z") },
      { env, s3: { send: jest.fn().mockRejectedValue(failure) } }
    );

    expect(result.retried).toBe(1);
    const task = await StorageDeletionTask.findById(ids[0]).lean();
    expect(task.status).toBe("retrying");
    expect(task.attempts).toBe(1);
    expect(task.lastErrorCode).toBe("ServiceUnavailable");
    expect(JSON.stringify(task)).not.toContain(failure.message);
  });

  test("cancels a claimed deletion when its object becomes live again", async () => {
    const owner = await createUser();
    const key = `paralegal-resumes/${owner._id}/resume-1760000000000.pdf`;
    const ids = await stagePersonalStorageDeletion(
      { ownerId: owner._id, keys: [key], reason: "resume_replaced" },
      { env }
    );
    await activatePersonalStorageDeletion(ids, { now: new Date("2026-08-13T12:00:00.000Z") });
    owner.resumeURL = key;
    await owner.save();
    const s3 = { send: jest.fn() };

    const result = await processPersonalStorageDeletionTasks(
      { now: new Date("2026-08-13T12:01:00.000Z") },
      { env, s3 }
    );

    expect(result.cancelled).toBe(1);
    expect(result.deleted).toBe(0);
    expect(s3.send).not.toHaveBeenCalled();
    expect((await StorageDeletionTask.findById(ids[0]).lean()).status).toBe("cancelled");
  });

  test("blocks a tampered bucket or owner prefix before calling S3", async () => {
    const owner = await createUser();
    const foreignOwner = new mongoose.Types.ObjectId();
    const task = await StorageDeletionTask.create({
      bucket: "unexpected-bucket",
      key: `paralegal-resumes/${foreignOwner}/resume-1760000000000.pdf`,
      ownerId: owner._id,
      reason: "tampered_test_record",
      status: "pending",
      eligibleAt: new Date("2026-08-13T12:00:00.000Z"),
    });
    const s3 = { send: jest.fn() };

    const result = await processPersonalStorageDeletionTasks(
      { now: new Date("2026-08-13T12:01:00.000Z") },
      { env, s3 }
    );

    expect(result.blocked).toBe(1);
    expect(s3.send).not.toHaveBeenCalled();
    const stored = await StorageDeletionTask.findById(task._id).lean();
    expect(stored).toEqual(expect.objectContaining({
      status: "blocked",
      attempts: 1,
      lastErrorCode: "STORAGE_BUCKET_MISMATCH",
    }));
  });
});
