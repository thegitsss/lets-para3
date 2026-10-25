const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const EmailVerificationToken = require("../models/EmailVerificationToken");
const AuthSession = require("../models/AuthSession");
const SignupReviewNotice = require("../models/SignupReviewNotification");
const reviewDelivery = require("../services/signupReviewNotifications");
const AuditLog = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const sendEmail = require("../utils/email");
const { sendVerificationEmail, buildEmailVerificationToken, verificationTokenHash } = require("../utils/emailVerification");
const app = express();
app.use(cookieParser(), express.json());
app.use("/api/auth", require("../routes/auth"));
app.use("/api/admin", require("../routes/admin"));
const PASSWORD = "An isolated email verification passphrase";
const verify = token => request(app).post("/api/auth/verify-email").send({ token });
async function fixture(role = "attorney", values = {}) {
  return User.create({ firstName: "Email", lastName: "Verification", email: `${role}.verification@example.test`, password: PASSWORD,
    role, status: "pending", emailVerified: false, state: "CA", ...values });
}
async function issue(user, email = user.email) {
  await sendVerificationEmail({ user, email });
  const mail = sendEmail.mock.calls.at(-1);
  return decodeURIComponent(mail[2].match(/token=([^&\s"'<>]+)/)[1]);
}
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockReset().mockResolvedValue({ ok: true }); });
afterEach(() => jest.restoreAllMocks());

test("links have independent random proofs, hashed storage and no time expiry", async () => {
  const user = await fixture();
  const first = await issue(user), second = await issue(user);
  expect(first).not.toBe(second);
  expect(jwt.decode(first).jti).toMatch(/^[a-f0-9]{64}$/);
  expect(jwt.decode(first)).not.toHaveProperty("exp");
  const proof = await EmailVerificationToken.findOne({ tokenHash: verificationTokenHash(first) }).lean();
  expect(proof.consumedAt).toBeNull();
  expect(proof.expiresAt).toBeNull();
  expect(JSON.stringify(proof)).not.toContain(first);
  expect(JSON.stringify(proof)).not.toContain(user.email);
  expect(sendEmail.mock.calls.at(-1)[3].text).toContain("only be used once");
  expect(sendEmail.mock.calls.at(-1)[3].text).not.toContain("expires");
});

for (const role of ["attorney", "paralegal"]) test(`${role}: email confirmation preserves review status and cannot grant portal access`, async () => {
  const user = await fixture(role);
  const response = await verify(await issue(user));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, alreadyVerified: false, accountStatus: "pending" });
  expect(response.headers["set-cookie"] || []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^token=[^;]/)]));
  const saved = await User.findById(user._id);
  expect(saved.emailVerified).toBe(true); expect(saved.status).toBe("pending");
  const login = await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
  expect(login.status).toBe(403); expect(login.body.msg).toContain("reviewing your application");
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
});

test("approval alone cannot sign in; verification then enables the approved account", async () => {
  const user = await fixture("attorney", { status: "approved" });
  const login = () => request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
  expect((await login()).status).toBe(403);
  expect((await verify(await issue(user))).body.accountStatus).toBe("approved");
  expect((await login()).status).toBe(200);
});

test("simultaneous confirmations consume once, audit once, and safely report an already-verified retry", async () => {
  const user = await fixture(); const token = await issue(user);
  const responses = await Promise.all([verify(token), verify(token)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(responses.filter(r => !r.body.alreadyVerified)).toHaveLength(1);
  expect(await AuditLog.countDocuments({ action: "auth.verify.success", targetId: user._id })).toBe(1);
  expect((await EmailVerificationToken.findOne({ tokenHash: verificationTokenHash(token) })).consumedAt).toBeInstanceOf(Date);
  await User.updateOne({ _id: user._id }, { $set: { status: "approved" } });
  expect((await verify(token)).body).toMatchObject({ alreadyVerified: true, accountStatus: "approved" });
  expect(await AuditLog.countDocuments({ action: "auth.verify.success", targetId: user._id })).toBe(1);
});

test("resending does not invalidate an earlier unexpired link", async () => {
  const user = await fixture(); const old = await issue(user);
  expect((await request(app).post("/api/auth/resend-verification").send({ email: user.email })).status).toBe(200);
  const latest = decodeURIComponent(sendEmail.mock.calls.at(-1)[2].match(/token=([^&\s"'<>]+)/)[1]);
  expect((await verify(old)).body.alreadyVerified).toBe(false);
  expect((await verify(latest)).body.alreadyVerified).toBe(true);
});

test("paralegal review link is emailed after verification, once across simultaneous confirmations", async () => {
  const user = await fixture("paralegal");
  const token = await issue(user);
  expect(sendEmail.mock.calls[0][2]).not.toContain("/paralegal-admission.html");
  const responses = await Promise.all([verify(token), verify(token)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  await verify(token);
  expect(await SignupReviewNotice.countDocuments({ userId: user._id })).toBe(1);
  expect(sendEmail.mock.calls.filter(call => call[1] === "Your email is verified")).toHaveLength(0);
  sendEmail.mockResolvedValue({ accepted: [user.email] });
  await Promise.all([reviewDelivery.processNotices(), reviewDelivery.processNotices()]);
  const confirmations = sendEmail.mock.calls.filter(call => call[1] === "Your email is verified");
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0][0]).toBe(user.email);
  expect(confirmations[0][2]).toContain("/paralegal-admission.html");
  expect(confirmations[0][3].text).toContain("Learn more about our application review");
  expect((await User.findById(user._id)).status).toBe("pending");
});

test("review confirmation delivery failure does not undo successful verification", async () => {
  const user = await fixture("paralegal");
  const token = await issue(user);
  sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic mail failure"), { responseCode: 451 }));
  expect((await verify(token)).body).toMatchObject({ ok: true, alreadyVerified: false });
  expect((await User.findById(user._id)).emailVerified).toBe(true);
  await reviewDelivery.processNotices();
  expect(await SignupReviewNotice.findOne({ userId: user._id }).lean()).toMatchObject({ status: "failed", attempts: 1 });
  await SignupReviewNotice.updateOne({ userId: user._id }, { $set: { nextAttemptAt: new Date(0) } });
  sendEmail.mockResolvedValue({ accepted: [user.email] });
  await reviewDelivery.processNotices();
  expect(await SignupReviewNotice.findOne({ userId: user._id }).lean()).toMatchObject({ status: "accepted", attempts: 2 });
});

test("review email is limited to pending paralegal applications", async () => {
  for (const [role, status] of [["attorney", "pending"], ["paralegal", "approved"], ["paralegal", "denied"]]) {
    const user = await fixture(role, { status, email: `${role}.${status}@example.test` });
    expect((await verify(await issue(user))).status).toBe(200);
  }
  expect(await SignupReviewNotice.countDocuments()).toBe(0);
  expect(sendEmail.mock.calls.filter(call => call[1] === "Your email is verified")).toHaveLength(0);
});

test("already-verified paralegal signup receipts include the review link, other receipts do not", () => {
  const { applicationReceived } = require("../email/accountTemplates");
  expect(applicationReceived({ role: "paralegal", emailVerified: true }).text).toContain("/paralegal-admission.html");
  expect(applicationReceived({ role: "paralegal", emailVerified: false }).html).not.toContain("/paralegal-admission.html");
  expect(applicationReceived({ role: "attorney", emailVerified: true }).html).not.toContain("/paralegal-admission.html");
});

test("still-valid legacy links work once and expired legacy links cannot be revived", async () => {
  const user = await fixture();
  const legacy = jwt.sign({ purpose: "verify-email", uid: String(user._id), email: user.email }, process.env.JWT_SECRET, { expiresIn: "60m" });
  expect((await verify(legacy)).body.alreadyVerified).toBe(false);
  expect((await verify(legacy)).body.alreadyVerified).toBe(true);
  const expired = jwt.sign({ purpose: "verify-email", uid: String(user._id), email: user.email }, process.env.JWT_SECRET, { expiresIn: -1 });
  expect((await verify(expired)).status).toBe(400);
});

test("expired, altered, unissued and deactivated proofs never verify an account", async () => {
  const user = await fixture(); const token = await issue(user);
  for (const value of [token.slice(0, -4) + "xxxx", buildEmailVerificationToken({ userId: user._id, email: user.email }), buildEmailVerificationToken({ userId: user._id, email: user.email, expiresIn: -1 })]) {
    expect((await verify(value)).status).toBe(400);
  }
  await User.updateOne({ _id: user._id }, { $set: { disabled: true } });
  expect((await verify(token)).status).toBe(400);
  expect((await User.findById(user._id)).emailVerified).toBe(false);
});

test("an old link cannot verify a different pending address", async () => {
  const user = await fixture("attorney", { pendingEmail: "first.pending@example.test" });
  const token = await issue(user, user.pendingEmail);
  await User.updateOne({ _id: user._id }, { $set: { pendingEmail: "second.pending@example.test" } });
  expect((await verify(token)).status).toBe(400);
  expect((await User.findById(user._id)).emailVerified).toBe(false);
});

test("an email correction, proof consumption and session revocation roll back together on failure", async () => {
  const user = await fixture("attorney", { status: "approved", emailVerified: true, pendingEmail: "corrected@example.test", authVersion: 7 });
  const token = await issue(user, user.pendingEmail);
  await AuthSession.create({ userId: user._id, sessionId: "verification-rollback-session", expiresAt: new Date(Date.now() + 60000) });
  const fail = jest.spyOn(AuthSession, "updateMany").mockRejectedValueOnce(new Error("Synthetic revocation failure"));
  expect((await verify(token)).status).toBe(503); fail.mockRestore();
  const before = await User.findById(user._id).select("+authVersion");
  expect(before.email).toBe(user.email); expect(before.pendingEmail).toBe(user.pendingEmail); expect(before.authVersion).toBe(7);
  expect((await EmailVerificationToken.findOne({ tokenHash: verificationTokenHash(token) })).consumedAt).toBeNull();
  expect((await AuthSession.findOne({ userId: user._id })).revokedAt).toBeNull();
  expect((await verify(token)).status).toBe(200);
  const after = await User.findById(user._id).select("+authVersion");
  expect(after.email).toBe(user.pendingEmail); expect(after.pendingEmail).toBeNull(); expect(after.authVersion).toBe(8);
  expect((await AuthSession.findOne({ userId: user._id })).revokedAt).toBeInstanceOf(Date);
});

test("admin-assisted correction preserves the saved application and documents and requires the new inbox", async () => {
  const applicant = await fixture("paralegal", { resumeURL: "retained/resume.pdf", certificateURL: "retained/certificate.pdf" });
  const admin = await fixture("admin", { status: "approved", emailVerified: true });
  const cookie = `token=${jwt.sign({ id: String(admin._id), role: "admin", status: "approved" }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
  const path = `/api/admin/users/${applicant._id}/email`;
  expect((await request(app).patch(path).send({ email: "corrected.applicant@example.test" })).status).not.toBe(200);
  const response = await request(app).patch(path).set("Cookie", cookie).send({ email: "corrected.applicant@example.test" });
  expect(response.status).toBe(200);
  const saved = await User.findById(applicant._id);
  expect(saved.email).toBe(applicant.email); expect(saved.pendingEmail).toBe("corrected.applicant@example.test");
  const mail = sendEmail.mock.calls.find(call => call[0] === saved.pendingEmail);
  const token = decodeURIComponent(mail[2].match(/token=([^&\s"'<>]+)/)[1]);
  expect((await verify(token)).body.accountStatus).toBe("pending");
  const verified = await User.findById(applicant._id);
  expect(verified.email).toBe("corrected.applicant@example.test");
  expect(verified.resumeURL).toBe(applicant.resumeURL); expect(verified.certificateURL).toBe(applicant.certificateURL);
  expect(verified.status).toBe("pending"); expect(await User.countDocuments({ role: "paralegal" })).toBe(1);
});


test("verification commits without waiting for SMTP and retains unknown delivery for review", async () => {
  const user = await fixture("paralegal");
  const token = await issue(user);
  sendEmail.mockClear();
  expect((await verify(token)).status).toBe(200);
  expect(sendEmail).not.toHaveBeenCalled();
  sendEmail.mockRejectedValue(Object.assign(new Error("Unknown SMTP outcome"), { code: "ETIMEDOUT" }));
  await reviewDelivery.processNotices();
  const calls = sendEmail.mock.calls.length;
  await reviewDelivery.processNotices();
  expect(sendEmail).toHaveBeenCalledTimes(calls);
  expect(await SignupReviewNotice.findOne({ userId: user._id }).lean()).toMatchObject({ status: "unknown", attempts: 1 });
});

test("saved review notice is skipped if the email or approval status changes before delivery", async () => {
  const user = await fixture("paralegal");
  await verify(await issue(user));
  await User.updateOne({ _id: user._id }, { $set: { status: "approved" } });
  sendEmail.mockClear();
  await reviewDelivery.processNotices();
  expect(sendEmail).not.toHaveBeenCalled();
  expect(await SignupReviewNotice.findOne({ userId: user._id }).lean()).toMatchObject({ status: "skipped" });
});

for (const role of ["attorney", "paralegal"]) test(`${role}: an issued verification link remains valid a year later`, async () => {
  const user = await fixture(role);
  const currentTime = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(currentTime - 366 * 86400000);
  let token;
  try { token = await issue(user); } finally { clock.mockRestore(); }
  expect(jwt.decode(token).iat).toBeLessThan(Math.floor(currentTime / 1000) - 365 * 86400);
  expect((await verify(token)).body).toMatchObject({ ok: true, alreadyVerified: false, accountStatus: "pending" });
  expect((await verify(token)).body.alreadyVerified).toBe(true);
  expect(await AuditLog.countDocuments({ action: "auth.verify.success", targetId: user._id })).toBe(1);
});

test("tracked time-limited links issued before this change keep their original validity", async () => {
  const user = await fixture();
  const token = buildEmailVerificationToken({ userId: user._id, email: user.email, expiresIn: "60m" });
  await EmailVerificationToken.create({ tokenHash: verificationTokenHash(token), userId: user._id, expiresAt: new Date(jwt.decode(token).exp * 1000) });
  expect((await verify(token)).body).toMatchObject({ ok: true, alreadyVerified: false });
});

test("a non-expiring token without a persisted random proof cannot introduce a legacy link", async () => {
  const user = await fixture();
  const token = jwt.sign({ purpose: "verify-email", uid: String(user._id), email: user.email }, process.env.JWT_SECRET);
  expect((await verify(token)).status).toBe(400);
  expect(await EmailVerificationToken.countDocuments()).toBe(0);
  expect((await User.findById(user._id)).emailVerified).toBe(false);
});
