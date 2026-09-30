const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const accountRouter = require("../routes/account");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/account", accountRouter);
  instance.use((err, _req, res, _next) => res.status(500).json({ error: err?.message || "Server error" }));
  return instance;
})();

function authCookieFor(user) {
  const token = jwt.sign({
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  }, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

beforeAll(connect);
beforeEach(clearDatabase);
afterAll(closeDatabase);

describe("dashboard saved view routes", () => {
  test("persists, reloads, and deletes a scoped attorney Matter view", async () => {
    const attorney = await User.create({
      firstName: "Avery",
      lastName: "Counsel",
      email: "saved.views.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
    });
    const cookie = authCookieFor(attorney);
    const create = await request(app)
      .post("/api/account/dashboard-views")
      .set("Cookie", cookie)
      .send({
        expectedOwnerId: String(attorney._id), id: require("crypto").randomUUID(), revision: null,
        scope: "attorney_matters",
        name: "Probate due soon",
        filters: { view: "active", practice: "Probate", deadline: "7_days", sort: "deadline", ignored: "discard" },
      });
    expect(create.status).toBe(201);
    expect(create.body.view).toEqual(expect.objectContaining({
      scope: "attorney_matters",
      name: "Probate due soon",
      filters: expect.objectContaining({ practice: "Probate", deadline: "7_days", sort: "deadline" }),
    }));
    expect(create.body.view.filters).not.toHaveProperty("ignored");

    const freshSession = await request(app)
      .get("/api/account/dashboard-views?scope=attorney_matters")
      .set("Cookie", cookie);
    expect(freshSession.status).toBe(200);
    expect(freshSession.body.views).toHaveLength(1);
    expect(freshSession.body.views[0].name).toBe("Probate due soon");

    const wrongRoleScope = await request(app)
      .get("/api/account/dashboard-views?scope=paralegal_applications")
      .set("Cookie", cookie);
    expect(wrongRoleScope.status).toBe(403);

    const removed = await request(app)
      .delete(`/api/account/dashboard-views/attorney_matters/${encodeURIComponent(create.body.view.id)}`)
      .set("Cookie", cookie).send({ expectedOwnerId: String(attorney._id), revision: create.body.view.revision });
    expect(removed.status).toBe(200);
    const afterDelete = await User.findById(attorney._id).lean();
    expect(afterDelete.preferences.dashboardViews).toHaveLength(0);
  });

  test("rejects unregistered scopes and duplicate names", async () => {
    const paralegal = await User.create({
      firstName: "Parker",
      lastName: "Para",
      email: "saved.views.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
    });
    const cookie = authCookieFor(paralegal);
    const invalid = await request(app)
      .post("/api/account/dashboard-views")
      .set("Cookie", cookie)
      .send({ scope: "admin", name: "Admin view", filters: {} });
    expect(invalid.status).toBe(400);

    const payload = {
      scope: "paralegal_applications",
      expectedOwnerId: String(paralegal._id), id: require("crypto").randomUUID(), revision: null,
      name: "Recent litigation",
      filters: { practice: "Litigation", dateRange: "30", sort: "newest" },
    };
    expect((await request(app).post("/api/account/dashboard-views").set("Cookie", cookie).send(payload)).status).toBe(201);
    expect((await request(app).post("/api/account/dashboard-views").set("Cookie", cookie).send({ ...payload, id: require("crypto").randomUUID() })).status).toBe(409);
  });
});


test('Paralegal saved views reject account replacement and stale deletion, and retry creates once',async()=>{
 const user=await User.create({firstName:'Casey',lastName:'Para',email:'para-views-guard@example.com',password:'Password123!',role:'paralegal',status:'approved'});
 const cookie=authCookieFor(user),scope='paralegal_applications';
 const body={scope,name:'My applications',id:require('crypto').randomUUID(),revision:null,expectedOwnerId:String(user._id),filters:{search:'discovery',status:'submitted',practice:'Civil Litigation',dateRange:'all',sort:'newest'}};
 const post=value=>request(app).post('/api/account/dashboard-views').set('Cookie',cookie).send(value);
 expect((await post({...body,expectedOwnerId:undefined})).status).toBe(403);
 expect((await post({...body,expectedOwnerId:'0'.repeat(24)})).status).toBe(403);
 expect((await post({...body,revision:undefined})).status).toBe(428);
 const first=await post(body);expect(first.status).toBe(201);
 const retry=await post(body);expect(retry.status).toBe(200);expect(retry.body.view).toEqual(first.body.view);
 const changed=await post({...body,name:'Changed in another tab',revision:first.body.view.revision});expect(changed.status).toBe(200);
 const remove=value=>request(app).delete(`/api/account/dashboard-views/${scope}/${body.id}`).set('Cookie',cookie).send(value);
 expect((await remove({expectedOwnerId:'0'.repeat(24),revision:changed.body.view.revision})).status).toBe(403);
 expect((await remove({expectedOwnerId:String(user._id),revision:first.body.view.revision})).status).toBe(409);
 const stored=await User.findById(user._id).lean();expect(stored.preferences.dashboardViews).toHaveLength(1);expect(stored.preferences.dashboardViews[0].name).toBe('Changed in another tab');
 expect((await remove({expectedOwnerId:String(user._id),revision:changed.body.view.revision})).status).toBe(200);
});
