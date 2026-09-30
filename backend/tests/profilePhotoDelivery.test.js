const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { Readable } = require("stream");
const request = require("supertest");

process.env.S3_BUCKET = "test-bucket";
process.env.S3_REGION = "us-east-1";

const mockSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor() {
      this.send = mockSend;
    }
  }
  class GetObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class GetObjectTaggingCommand {
    constructor(input) {
      this.input = input;
    }
  }
  return { S3Client, GetObjectCommand, GetObjectTaggingCommand };
});

const User = require("../models/User");
const publicDirectoryRouter = require("../routes/publicParalegalDirectory");
const usersRouter = require("../routes/users");
const {
  buildPublicProfilePhotoUrl,
  extractProfilePhotoKey,
} = require("../services/profilePhotoDelivery");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/public/paralegals", publicDirectoryRouter);
  instance.use("/api/users", usersRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const token = jwt.sign(
    { id: String(user._id), role: user.role, email: user.email, status: user.status },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
  return `token=${token}`;
}

function legacyUrl(userId, filename = "profile-1700000000000.jpg", bucket = "test-bucket") {
  return `https://${bucket}.s3.us-east-1.amazonaws.com/profile-photos/${userId}/${filename}`;
}

async function createPublicParalegal(overrides = {}) {
  const id = overrides._id || new User()._id;
  return User.create({
    _id: id,
    firstName: "Public",
    lastName: "Paralegal",
    email: `public-${id}@example.com`,
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "CA",
    bio: "Experienced public paralegal profile.",
    skills: ["Case management"],
    practiceAreas: ["Civil Litigation"],
    resumeURL: `paralegal-resumes/${id}/resume.pdf`,
    profilePhotoStatus: "approved",
    profileImage: legacyUrl(id),
    avatarURL: legacyUrl(id),
    pendingProfileImage: "",
    preferences: { hideProfile: false },
    ...overrides,
  });
}

function imageObject(body = "photo", overrides = {}) {
  const bytes = Buffer.from(body);
  return {
    Body: Readable.from(bytes),
    ContentType: "image/jpeg",
    ContentLength: bytes.length,
    ETag: '"profile-etag"',
    ...overrides,
  };
}

beforeAll(connect);
afterAll(closeDatabase);

beforeEach(async () => {
  await clearDatabase();
  mockSend.mockReset();
  mockSend.mockImplementation(async () => imageObject());
});

describe("Private S3 profile-photo delivery", () => {
  test("strict legacy parser accepts only the configured bucket, owner, and profile namespace", () => {
    const ownerId = "64b000000000000000000001";
    const validKey = `profile-photos/${ownerId}/profile-1700000000000.jpg`;
    expect(extractProfilePhotoKey(validKey, {
      bucket: "test-bucket",
      region: "us-east-1",
      ownerId,
    })).toBe(validKey);
    expect(extractProfilePhotoKey(legacyUrl(ownerId), {
      bucket: "test-bucket",
      region: "us-east-1",
      ownerId,
    })).toBe(validKey);

    const rejected = [
      legacyUrl(ownerId, "profile-1700000000000.jpg", "wrong-bucket"),
      `https://test-bucket.s3.us-east-1.amazonaws.com/profile-photos/64b000000000000000000002/profile-1700000000000.jpg`,
      `https://test-bucket.s3.us-east-1.amazonaws.com/cases/${ownerId}/documents/private.pdf`,
      `https://test-bucket.s3.us-east-1.amazonaws.com/profile-photos/${ownerId}/%2e%2e/cases/private.jpg`,
      `profile-photos/${ownerId}/../cases/private.jpg`,
      `profile-photos/${ownerId}/profile-1700000000000.jpg?key=cases/private.pdf`,
    ];
    rejected.forEach((value) => {
      expect(extractProfilePhotoKey(value, {
        bucket: "test-bucket",
        region: "us-east-1",
        ownerId,
      })).toBe("");
    });
  });

  test("approved public legacy photo streams through the LPC route with safe cache headers", async () => {
    const profile = await createPublicParalegal();
    const response = await request(app).get(`/api/public/paralegals/${profile._id}/photo`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toMatch(/public, max-age=3600/);
    expect(response.headers.etag).toBe('"profile-etag"');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toEqual({
      Bucket: "test-bucket",
      Key: `profile-photos/${profile._id}/profile-1700000000000.jpg`,
    });
  });

  test("directory projection returns only the canonical LPC photo URL", async () => {
    const profile = await createPublicParalegal();
    const response = await request(app).get("/api/public/paralegals?limit=5");

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    const item = response.body.items[0];
    expect(item.avatarURL).toMatch(new RegExp(`^/api/public/paralegals/${profile._id}/photo\\?v=\\d+$`));
    expect(item.profileImage).toBe(item.avatarURL);
    expect(item.photoUrl).toBe(item.avatarURL);
    expect(JSON.stringify(item)).not.toContain("s3.amazonaws.com");
    expect(JSON.stringify(item)).not.toContain("profile-photos/");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("full public Profile projection is reachable and contains only the canonical LPC photo URL", async () => {
    const profile = await createPublicParalegal();
    const response = await request(app).get(`/api/public/paralegals/${profile._id}`);

    expect(response.status).toBe(200);
    expect(response.body.profileImage).toMatch(
      new RegExp(`^/api/public/paralegals/${profile._id}/photo(?:\\?v=[0-9]+)?$`)
    );
    expect(response.body.avatarURL).toBe(response.body.profileImage);
    expect(response.body.photoUrl).toBe(response.body.profileImage);
    expect(JSON.stringify({
      avatarURL: response.body.avatarURL,
      profileImage: response.body.profileImage,
      profileImageOriginal: response.body.profileImageOriginal,
      pendingProfileImage: response.body.pendingProfileImage,
      pendingProfileImageOriginal: response.body.pendingProfileImageOriginal,
    })).not.toMatch(/amazonaws\.com|profile-photos\//i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("authenticated self projection rewrites a legacy S3 photo reference", async () => {
    const profile = await createPublicParalegal();
    const response = await request(app)
      .get("/api/users/me")
      .set("Cookie", authCookieFor(profile));

    expect(response.status).toBe(200);
    expect(response.body.profileImage).toMatch(
      new RegExp(`^/api/public/paralegals/${profile._id}/photo(?:\\?v=[0-9]+)?$`)
    );
    expect(response.body.avatarURL).toBe(response.body.profileImage);
    expect(JSON.stringify({
      avatarURL: response.body.avatarURL,
      profileImage: response.body.profileImage,
      profileImageOriginal: response.body.profileImageOriginal,
      pendingProfileImage: response.body.pendingProfileImage,
      pendingProfileImageOriginal: response.body.pendingProfileImageOriginal,
    })).not.toMatch(/amazonaws\.com|profile-photos\//i);
  });

  test("approved but nonpublic owner photo stays on the authenticated delivery path", async () => {
    const owner = await createPublicParalegal({
      bio: "",
      preferences: { hideProfile: true },
    });
    const attorney = await User.create({
      firstName: "Unrelated",
      lastName: "Attorney",
      email: "unrelated-photo-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
    });

    const selfProjection = await request(app)
      .get("/api/users/me")
      .set("Cookie", authCookieFor(owner));
    expect(selfProjection.status).toBe(200);
    expect(selfProjection.body.profileImage).toMatch(
      new RegExp(`^/api/users/profile-photo/${owner._id}(?:\\?v=[0-9]+)?$`)
    );

    const ownerImage = await request(app)
      .get(`/api/users/profile-photo/${owner._id}`)
      .set("Cookie", authCookieFor(owner));
    expect(ownerImage.status).toBe(200);

    const unrelatedImage = await request(app)
      .get(`/api/users/profile-photo/${owner._id}`)
      .set("Cookie", authCookieFor(attorney));
    expect(unrelatedImage.status).toBe(404);

    const publicImage = await request(app).get(`/api/public/paralegals/${owner._id}/photo`);
    expect(publicImage.status).toBe(404);
  });

  test("new key-backed records render without a database migration", async () => {
    const id = new User()._id;
    const profile = await createPublicParalegal({
      _id: id,
      profileImage: buildPublicProfilePhotoUrl(id),
      avatarURL: buildPublicProfilePhotoUrl(id),
      profileImageKey: `profile-photos/${id}/profile-1700000000001.jpg`,
    });
    const response = await request(app).get(`/api/public/paralegals/${profile._id}/photo`);
    expect(response.status).toBe(200);
    expect(mockSend.mock.calls[0][0].input.Key).toBe(`profile-photos/${id}/profile-1700000000001.jpg`);
  });

  test("a related attorney can read an approved nonpublic photo without exposing private variants or bypassing blocks", async () => {
    const profile = await createPublicParalegal({ bio: "", preferences: { hideProfile: true } });
    const attorney = await User.create({ firstName: "Related", lastName: "Attorney", email: "related-photo@example.com", password: "Password123!", role: "attorney", status: "approved", state: "NY" });
    const Case = require("../models/Case");
    await Case.collection.insertOne({ attorney: attorney._id, paralegal: profile._id, title: "Photo relationship", status: "in progress" });
    const get = (suffix = "") => request(app).get(`/api/users/profile-photo/${profile._id}${suffix}`).set("Cookie", authCookieFor(attorney));
    const photo = await get();
    expect(photo.status).toBe(200);
    expect(photo.headers["cache-control"]).toMatch(/^private/);
    expect(mockSend.mock.calls.at(-1)[0].input.Key).toBe(`profile-photos/${profile._id}/profile-1700000000000.jpg`);
    for (const variant of ["pending", "pending-original", "approved-original"]) {
      mockSend.mockClear();
      expect((await get(`?variant=${variant}`)).status).toBe(404);
      expect(mockSend).not.toHaveBeenCalled();
    }
    for (const changes of [{ profilePhotoStatus: "rejected" }, { status: "pending" }, { disabled: true }, { deleted: true }]) {
      await User.updateOne({ _id: profile._id }, { $set: { profilePhotoStatus: "approved", status: "approved", disabled: false, deleted: false, ...changes } });
      mockSend.mockClear();
      expect((await get()).status).toBe(404);
      expect(mockSend).not.toHaveBeenCalled();
    }
    await User.updateOne({ _id: profile._id }, { $set: { profilePhotoStatus: "approved", status: "approved", disabled: false, deleted: false } });
    await require("../models/Block").create({ blockerId: profile._id, blockedId: attorney._id, blockerRole: "paralegal", blockedRole: "attorney", active: true });
    mockSend.mockClear();
    expect((await get()).status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ["random id", "/api/public/paralegals/not-an-id/photo"],
    ["encoded traversal", "/api/public/paralegals/%2e%2e%2fcases/photo"],
  ])("%s fails closed", async (_label, path) => {
    const response = await request(app).get(path);
    expect([400, 404]).toContain(response.status);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ["attorney", { role: "attorney" }],
    ["unapproved", { status: "pending" }],
    ["hidden", { preferences: { hideProfile: true } }],
    ["rejected photo", { profilePhotoStatus: "rejected" }],
    ["deleted", { deleted: true }],
    ["pending replacement", { pendingProfileImage: "/api/users/profile-photo/placeholder?variant=pending" }],
  ])("%s profile has no public photo", async (_label, overrides) => {
    const profile = await createPublicParalegal(overrides);
    const response = await request(app).get(`/api/public/paralegals/${profile._id}/photo`);
    expect(response.status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("wrong-bucket, Matter-key, missing, non-image, and oversized records fail closed", async () => {
    const wrongBucket = await createPublicParalegal();
    wrongBucket.profileImage = legacyUrl(wrongBucket._id, "profile-1700000000000.jpg", "wrong-bucket");
    wrongBucket.avatarURL = wrongBucket.profileImage;
    await wrongBucket.save();
    expect((await request(app).get(`/api/public/paralegals/${wrongBucket._id}/photo`)).status).toBe(404);

    const matterKey = await createPublicParalegal();
    matterKey.profileImage = `cases/${matterKey._id}/documents/private.jpg`;
    matterKey.avatarURL = matterKey.profileImage;
    await matterKey.save();
    expect((await request(app).get(`/api/public/paralegals/${matterKey._id}/photo`)).status).toBe(404);

    const missing = await createPublicParalegal();
    mockSend.mockRejectedValueOnce(Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    }));
    expect((await request(app).get(`/api/public/paralegals/${missing._id}/photo`)).status).toBe(404);

    const nonImage = await createPublicParalegal();
    mockSend.mockResolvedValueOnce(imageObject("not-image", { ContentType: "text/html" }));
    expect((await request(app).get(`/api/public/paralegals/${nonImage._id}/photo`)).status).toBe(404);

    const oversized = await createPublicParalegal();
    mockSend.mockResolvedValueOnce(imageObject("small", { ContentLength: 5 * 1024 * 1024 + 1 }));
    expect((await request(app).get(`/api/public/paralegals/${oversized._id}/photo`)).status).toBe(404);
  });

  test("conditional request returns 304 without streaming the image again", async () => {
    const profile = await createPublicParalegal();
    const response = await request(app)
      .get(`/api/public/paralegals/${profile._id}/photo`)
      .set("If-None-Match", '"profile-etag"');
    expect(response.status).toBe(304);
    expect(response.headers.etag).toBe('"profile-etag"');
  });

  test("pending owner preview is authenticated and isolated from other users", async () => {
    const owner = await createPublicParalegal({
      profilePhotoStatus: "pending_review",
      pendingProfileImage: "/api/users/profile-photo/placeholder?variant=pending",
      pendingProfileImageKey: "",
    });
    owner.pendingProfileImageKey = `profile-photos/${owner._id}/profile-1700000000002.jpg`;
    await owner.save();
    const other = await createPublicParalegal();

    const own = await request(app)
      .get(`/api/users/profile-photo/${owner._id}?variant=pending`)
      .set("Cookie", authCookieFor(owner));
    expect(own.status).toBe(200);
    expect(own.headers["cache-control"]).toMatch(/^private/);

    mockSend.mockClear();
    const denied = await request(app)
      .get(`/api/users/profile-photo/${owner._id}?variant=pending`)
      .set("Cookie", authCookieFor(other));
    expect(denied.status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
