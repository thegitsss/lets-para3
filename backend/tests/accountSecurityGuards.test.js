const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const request = require("supertest");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("@simplewebauthn/server", () => ({ ...jest.requireActual("@simplewebauthn/server"), verifyRegistrationResponse: jest.fn() }));
const webAuthn = require("@simplewebauthn/server");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const AuthChallenge = require("../models/AuthChallenge");
const PasskeyCredential = require("../models/PasskeyCredential");
const { createAuthSession } = require("../services/authSessionService");
const { generateTotpToken } = require("../services/mfaService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json());
app.use("/api/account", require("../routes/account"));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
const password = "A secure independent security test passphrase";
let user, current;
async function session(account = user) {
  const value = await createAuthSession(account, { headers: { "user-agent": "Synthetic security acceptance" } });
  const fresh = await User.findById(account._id).select("+authVersion");
  return { id: value.sessionId, cookie: `token=${jwt.sign({ id: String(account._id), sid: value.sessionId, av: fresh.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
}
function call(method, path, body, identity = current) {
  const req = request(app)[method](`/api/account${path}`).set("Cookie", identity.cookie);
  return body === undefined ? req : req.send({ expectedOwnerId: String(user._id), ...body });
}
const read = (path = "/2fa", identity = current) => call("get", `${path}${path.includes("?") ? "&" : "?"}expectedOwnerId=${user._id}`, undefined, identity);
const revision = async () => { const res = await read(); expect(res.status).toBe(200); return res.body.securityRevision; };
async function passkey(name = "Owned key") { return PasskeyCredential.create({ userId: user._id, credentialId: crypto.randomUUID(), publicKey: Buffer.from("synthetic-public-key"), name, counter: 0 }); }
beforeAll(connect, 150000); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  user = await User.create({ firstName: "Guard", lastName: "Owner", email: "security-guards@example.test", password, role: "attorney", status: "approved", emailVerified: true });
  current = await session();
  webAuthn.verifyRegistrationResponse.mockReset();
  webAuthn.verifyRegistrationResponse.mockResolvedValue({ verified: true, registrationInfo: { credential: { id: crypto.randomUUID(), publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] }, credentialDeviceType: "singleDevice", credentialBackedUp: false } });
});
afterEach(() => jest.restoreAllMocks());

test.each(["/2fa", "/passkeys", "/sessions"])("%s rejects malformed expected owners and sends private no-store", async path => {
  const malformed = await call("get", `${path}?expectedOwnerId[]=bad`);
  expect(malformed.status).toBe(400);
  const response = await read(path); expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
});

test.each([undefined, "bad", [], "a".repeat(63)])("guarded MFA requires a valid security revision (%p)", async expectedSecurityRevision => {
  const response = await call("post", "/2fa-toggle", { enabled: true, method: "email", currentPassword: password, ...(expectedSecurityRevision === undefined ? {} : { expectedSecurityRevision }) });
  expect(response.status).toBe(400);
  expect((await User.findById(user._id)).twoFactorEnabled).toBe(false);
});

test("current MFA session survives, other sessions revoke and independent profile fields remain intact", async () => {
  const other = await session(); const before = await revision();
  await User.updateOne({ _id: user._id }, { $set: { lawFirm: "A separately saved firm", "preferences.theme": "dark" } });
  const changed = await call("post", "/2fa-toggle", { enabled: true, method: "email", currentPassword: password, expectedSecurityRevision: before });
  expect(changed.status).toBe(200);
  expect((await AuthSession.findOne({ sessionId: current.id })).revokedAt).toBeNull();
  expect((await AuthSession.findOne({ sessionId: other.id })).revokedAt).not.toBeNull();
  expect(await User.findById(user._id).lean()).toMatchObject({ lawFirm: "A separately saved firm", preferences: { theme: "dark" }, twoFactorEnabled: true });
  expect(await revision()).not.toBe(before);
});

test.each(["/2fa-toggle", "/2fa/authenticator/setup", "/passkeys/registration-options"])("guarded %s rejects an unmanaged initiating session", async path => {
  const legacy = { cookie: `token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
  const response = await call("post", path, { enabled: true, method: "email", currentPassword: password, expectedSecurityRevision: await revision() }, legacy);
  expect(response.status).toBe(409); expect(response.body.code).toBe("SECURITY_SESSION_REQUIRED");
  expect(await AuthChallenge.countDocuments()).toBe(0);
  expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(1);
});

test("password update preserves hashing hooks, revokes every session and requires reauthentication", async () => {
  await session(); const replacement = "A wholly newer password with sufficient entropy";
  const result = await call("post", "/update-password", { currentPassword: password, newPassword: replacement, expectedSecurityRevision: await revision() });
  expect(result.status).toBe(200); expect(result.body).toEqual({ ok: true, reauthenticationRequired: true });
  const saved = await User.findById(user._id).select("+password +authVersion");
  expect(saved.password).not.toBe(replacement); expect(await saved.comparePassword(replacement)).toBe(true); expect(await saved.comparePassword(password)).toBe(false);
  expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(0);
  expect((await read()).status).toBe(403);
});

test("password proof cannot authorize an MFA write after a concurrent password change", async () => {
  const expectedSecurityRevision = await revision();
  const compare = User.prototype.comparePassword;
  jest.spyOn(User.prototype, "comparePassword").mockImplementationOnce(async function (input) {
    const valid = await compare.call(this, input);
    const changed = await User.findById(user._id).select("+password"); changed.password = "A concurrent replacement password value"; await changed.save();
    return valid;
  });
  const response = await call("post", "/2fa-toggle", { enabled: true, currentPassword: password, expectedSecurityRevision });
  expect(response.status).toBe(409); expect(response.body.code).toBe("ACCOUNT_CONFLICT");
  expect((await User.findById(user._id)).twoFactorEnabled).toBe(false);
});

test("revocation after authentication but before the security transaction prevents recovery writes", async () => {
  await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true } });
  const expectedSecurityRevision = await revision();
  const update = AuthSession.updateOne.bind(AuthSession);
  jest.spyOn(AuthSession, "updateOne").mockImplementationOnce(async (...args) => {
    await update({ sessionId: current.id }, { $set: { revokedAt: new Date() } });
    return update(...args);
  });
  const response = await call("post", "/2fa-backup-codes", { currentPassword: password, expectedSecurityRevision });
  expect(response.status).toBe(403);
  expect((await User.findById(user._id).select("+twoFactorBackupCodes")).twoFactorBackupCodes).toHaveLength(0);
});

test("authenticator enrollment is single-use, returns only the confirmed recovery codes and preserves current session", async () => {
  const other = await session(); const expectedSecurityRevision = await revision();
  const setup = await call("post", "/2fa/authenticator/setup", { currentPassword: password, expectedSecurityRevision }); expect(setup.status).toBe(200);
  const body = { challengeId: setup.body.challengeId, code: generateTotpToken(setup.body.manualSecret).token, expectedSecurityRevision };
  const confirmed = await call("post", "/2fa/authenticator/confirm", body);
  expect(confirmed.status).toBe(200); expect(confirmed.body.backupCodes).toHaveLength(8);
  const saved = await User.findById(user._id).select("+twoFactorBackupCodes +totpSecretEncrypted");
  expect(saved.twoFactorBackupCodes).toEqual(confirmed.body.backupCodes.map(code => crypto.createHash("sha256").update(code).digest("hex")));
  expect(saved.totpSecretEncrypted).not.toBe(setup.body.manualSecret);
  expect((await AuthSession.findOne({ sessionId: other.id })).revokedAt).not.toBeNull();
  expect((await AuthSession.findOne({ sessionId: current.id })).revokedAt).toBeNull();
  expect((await call("post", "/2fa/authenticator/confirm", { ...body, expectedSecurityRevision: await revision() })).status).toBeGreaterThanOrEqual(400);
});

test("authenticator enrollment cannot migrate to another managed session of the same account", async () => {
  const other = await session(); const expectedSecurityRevision = await revision();
  const setup = await call("post", "/2fa/authenticator/setup", { currentPassword: password, expectedSecurityRevision });
  const response = await call("post", "/2fa/authenticator/confirm", { challengeId: setup.body.challengeId, code: generateTotpToken(setup.body.manualSecret).token, expectedSecurityRevision }, other);
  expect(response.status).toBe(409); expect((await User.findById(user._id)).twoFactorEnabled).toBe(false);
  expect((await AuthChallenge.findOne({ challengeId: setup.body.challengeId })).consumedAt).toBeNull();
});

test("five invalid authenticator codes consume the challenge without changing security settings", async () => {
  const expectedSecurityRevision = await revision();
  const setup = await call("post", "/2fa/authenticator/setup", { currentPassword: password, expectedSecurityRevision });
  const wrong = generateTotpToken(setup.body.manualSecret).token === "000000" ? "111111" : "000000";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await call("post", "/2fa/authenticator/confirm", { challengeId: setup.body.challengeId, code: wrong, expectedSecurityRevision });
    expect(response.status).toBe(attempt === 5 ? 429 : 400);
  }
  const challenge = await AuthChallenge.findOne({ challengeId: setup.body.challengeId }).select("+metadata");
  expect(challenge.metadata.failedAttempts).toBe(5); expect(challenge.consumedAt).not.toBeNull();
  expect((await User.findById(user._id)).twoFactorEnabled).toBe(false);
});

test("passkey membership changes after password proof prevent an older removal from committing", async () => {
  const key = await passkey(); const expectedSecurityRevision = await revision();
  const compare = User.prototype.comparePassword;
  jest.spyOn(User.prototype, "comparePassword").mockImplementationOnce(async function (input) { const valid = await compare.call(this, input); await passkey("Another current key"); return valid; });
  const response = await call("delete", `/passkeys/${key._id}`, { currentPassword: password, expectedSecurityRevision });
  expect(response.status).toBe(409); expect(await PasskeyCredential.countDocuments()).toBe(2);
});

test.each(["session", "security"])("passkey setup rejects a changed %s context before verifier/credential writes", async changed => {
  const other = await session(); const expectedSecurityRevision = await revision();
  const setup = await call("post", "/passkeys/registration-options", { currentPassword: password, expectedSecurityRevision }); expect(setup.status).toBe(200);
  if (changed === "security") await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true } });
  const response = await call("post", "/passkeys/register", { challengeId: setup.body.challengeId, response: {}, expectedSecurityRevision: await revision() }, changed === "session" ? other : current);
  expect(response.status).toBe(409); expect(webAuthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  expect(await PasskeyCredential.countDocuments()).toBe(0); expect((await AuthChallenge.findOne({ challengeId: setup.body.challengeId })).consumedAt).toBeNull();
});

test("guarded passkey persistence changes revision, uses one challenge and removes only the selected owner credential", async () => {
  const expectedSecurityRevision = await revision();
  const setup = await call("post", "/passkeys/registration-options", { currentPassword: password, expectedSecurityRevision });
  const registered = await call("post", "/passkeys/register", { challengeId: setup.body.challengeId, response: {}, name: "Test key", expectedSecurityRevision });
  expect(registered.status).toBe(201); expect(registered.body.name).toBe("Test key"); expect(webAuthn.verifyRegistrationResponse).toHaveBeenCalledTimes(1);
  expect(await revision()).not.toBe(expectedSecurityRevision);
  const response = await call("delete", `/passkeys/${registered.body.id}`, { currentPassword: password, expectedSecurityRevision: await revision() });
  expect(response.status).toBe(200); expect(await PasskeyCredential.countDocuments()).toBe(0);
});

test("a passkey database failure remains unconfirmed and rolls back the challenge claim", async () => {
  const expectedSecurityRevision = await revision();
  const setup = await call("post", "/passkeys/registration-options", { currentPassword: password, expectedSecurityRevision });
  jest.spyOn(PasskeyCredential, "create").mockRejectedValueOnce(Object.assign(new Error("Synthetic credential persistence failure"), { name: "MongoNetworkError" }));
  const response = await call("post", "/passkeys/register", { challengeId: setup.body.challengeId, response: {}, expectedSecurityRevision });
  expect(response.status).toBe(503); expect(response.body.code).toBe("SECURITY_CHANGE_UNCONFIRMED");
  expect(await PasskeyCredential.countDocuments()).toBe(0);
  expect((await AuthChallenge.findOne({ challengeId: setup.body.challengeId })).consumedAt).toBeNull();
});

test("complete session pages retain current session beyond the old50 cap and immutable ordering despite activity", async () => {
  const base = new Date("2026-01-01T00:00:00Z");
  await AuthSession.collection.updateOne({ sessionId: current.id }, { $set: { createdAt: base } });
  await AuthSession.insertMany(Array.from({ length: 123 }, (_, i) => ({ userId: user._id, sessionId: `extra-${i}`, createdAt: new Date(base.getTime() + (i + 1) * 1000), expiresAt: new Date(Date.now() + 3600000) })));
  const first = await read("/sessions"); expect(first.status).toBe(200); expect(first.body.total).toBe(124); expect(first.body.sessions).toHaveLength(50);
  expect(first.body.currentSession).toMatchObject({ id: current.id, current: true }); expect(first.body.sessions.some(item => item.id === current.id)).toBe(false);
  await AuthSession.updateMany({ userId: user._id }, { $set: { lastSeenAt: new Date(Date.now() + 60000) } });
  const second = await read(`/sessions?cursor=${encodeURIComponent(first.body.nextCursor)}`); expect(second.status).toBe(200); expect(second.body.sessions).toHaveLength(50);
  const third = await read(`/sessions?cursor=${encodeURIComponent(second.body.nextCursor)}`); expect(third.status).toBe(200); expect(third.body.sessions).toHaveLength(24); expect(third.body.nextCursor).toBeNull();
  const ids = [...first.body.sessions, ...second.body.sessions, ...third.body.sessions].map(item => item.id);
  expect(new Set(ids).size).toBe(124); expect(ids.at(-1)).toBe(current.id);
  const legacy = await call("get", "/sessions"); expect(legacy.body.sessions).toHaveLength(50); expect(legacy.body).not.toHaveProperty("nextCursor");
});

test("session cursor survives boundary deletion and rejects tampering, malformed and cross-account use", async () => {
  const records = Array.from({ length: 56 }, (_, i) => ({ userId: user._id, sessionId: `tied-${i}`, createdAt: new Date("2026-01-01T00:00:00Z"), expiresAt: new Date(Date.now() + 3600000) }));
  await AuthSession.insertMany(records);
  const first = await read("/sessions"); const cursor = first.body.nextCursor;
  await AuthSession.deleteOne({ sessionId: first.body.sessions.at(-1).id });
  const second = await read(`/sessions?cursor=${encodeURIComponent(cursor)}`); expect(second.status).toBe(200); expect(second.body.sessions).toHaveLength(7); expect(second.body.nextCursor).toBeNull();
  expect(new Set([...first.body.sessions, ...second.body.sessions].map(item => item.id)).size).toBe(57);
  for (const value of ["", "broken", `${cursor.slice(0, -1)}${cursor.endsWith("0") ? "1" : "0"}`]) expect((await read(`/sessions?cursor=${encodeURIComponent(value)}`)).status).toBe(400);
  const other = await User.create({ firstName: "Other", lastName: "Owner", email: "security-other@example.test", password, role: "attorney", status: "approved" });
  const identity = await session(other);
  const response = await call("get", `/sessions?expectedOwnerId=${other._id}&cursor=${encodeURIComponent(cursor)}`, undefined, identity); expect(response.status).toBe(400);
});

test("session pages retain missing/null dates and exclude expired, revoked and unrelated sessions", async () => {
  const expiry = new Date(Date.now() + 3600000);
  await AuthSession.collection.insertMany(Array.from({ length: 54 }, (_, i) => ({ userId: user._id, sessionId: `retained-${i}`, ...(i % 2 ? { createdAt: null } : {}), expiresAt: expiry, revokedAt: null })));
  await AuthSession.create({ userId: user._id, sessionId: "expired", expiresAt: new Date(0) });
  await AuthSession.create({ userId: user._id, sessionId: "revoked", expiresAt: expiry, revokedAt: new Date() });
  const first = await read("/sessions"); const second = await read(`/sessions?cursor=${encodeURIComponent(first.body.nextCursor)}`);
  expect(first.body.total).toBe(55); expect(second.body.total).toBe(55); expect(second.body.nextCursor).toBeNull();
  const rows = [...first.body.sessions, ...second.body.sessions]; expect(new Set(rows.map(item => item.id)).size).toBe(55);
  expect(rows.some(item => ["expired", "revoked"].includes(item.id))).toBe(false);
});

test("guarded revoke-others preserves the known current session and current deletion confirms reauthentication", async () => {
  const other = await session();
  const others = await call("post", "/sessions/revoke-others", {}); expect(others.status).toBe(200); expect(others.body.revokedCount).toBe(1);
  expect((await AuthSession.findOne({ sessionId: other.id })).revokedAt).not.toBeNull(); expect((await AuthSession.findOne({ sessionId: current.id })).revokedAt).toBeNull();
  const currentRevoked = await call("delete", `/sessions/${current.id}`, {}); expect(currentRevoked.status).toBe(200); expect(currentRevoked.body.currentSessionRevoked).toBe(true);
  expect((await read()).status).toBe(403);
});
