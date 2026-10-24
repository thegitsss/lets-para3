const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const User = require("../models/User");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
const router = require("../routes/publicParalegalDirectory");
const app = express();
app.use(cookieParser());
app.use("/api/public/paralegals", router);
app.use("/public/paralegals", router);
// Exercise the historical implementation independently, too.
app.use("/legacy-public", require("../routes/public"));
const paths = ["/api/public/paralegals", "/public/paralegals", "/legacy-public/paralegals"];

beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase);

async function actor(role) {
  return User.create({ firstName: "Directory", lastName: "Member", email: `${role}@directory-access.test`, password: "Synthetic directory password!", role, status: "approved", state: "NY", bio: "Legal research and filing support.", practiceAreas: ["Litigation"], skills: ["Research"], resumeURL: "paralegal-resumes/directory/resume.pdf", profilePhotoStatus: "approved", profileImage: "profile-photos/directory/approved.jpg", preferences: { hideProfile: false } });
}

test("public visitors can browse without a member session", async () => {
  const candidate = await actor("paralegal");
  for (const path of paths) {
    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    expect(response.body.items.map(item => item.id)).toContain(String(candidate._id));
    expect(response.headers["cache-control"]).toContain("no-store");
  }
});

test.each(["attorney", "admin"])("signed-in %s retains directory access", async role => {
  const user = await actor(role);
  for (const path of paths) expect((await request(app).get(path).set("Cookie", authCookieFor(user))).status).toBe(200);
});

test("signed-in paralegals cannot browse through either alias or the historical route", async () => {
  const user = await actor("paralegal");
  for (const path of paths) {
    for (const credential of ["cookie", "bearer"]) {
      const cookie = authCookieFor(user);
      const read = request(app).get(`${path}?sort=alpha&location=NY`);
      if (credential === "cookie") read.set("Cookie", cookie);
      else read.set("Authorization", `Bearer ${cookie.slice("token=".length)}`);
      const response = await read;
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("PARALEGAL_DIRECTORY_UNAVAILABLE");
      expect(response.body.items).toBeUndefined();
      expect(response.headers["cache-control"]).toContain("no-store");
    }
  }
  // Listing restrictions do not break viewing one's own public profile.
  expect((await request(app).get(`/api/public/paralegals/${user._id}`).set("Cookie", authCookieFor(user))).status).toBe(200);
});
