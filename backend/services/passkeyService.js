const { URL } = require("url");
const AuthChallenge = require("../models/AuthChallenge");
const PasskeyCredential = require("../models/PasskeyCredential");
const { newChallengeId } = require("./mfaService");
const webAuthn = require("@simplewebauthn/server");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function relyingParty(req) {
  const configuredOrigin = String(process.env.WEBAUTHN_ORIGIN || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req?.protocol || "http";
  const host = String(req?.get?.("host") || req?.headers?.host || "localhost:5050");
  const origin = configuredOrigin || `${protocol}://${host}`;
  const url = new URL(origin);
  return {
    rpID: String(process.env.WEBAUTHN_RP_ID || url.hostname),
    rpName: String(process.env.WEBAUTHN_RP_NAME || "Let's-ParaConnect"),
    origin: url.origin,
  };
}

async function replaceActiveChallenge({ userId = null, purpose, challenge, metadata = {} }) {
  if (userId) {
    await AuthChallenge.updateMany(
      { userId, purpose, consumedAt: null },
      { $set: { consumedAt: new Date() } }
    );
  } else if (purpose === "passkey_authentication") {
    await AuthChallenge.deleteMany({
      userId: null,
      purpose,
      expiresAt: { $lte: new Date() },
    });
  }
  const challengeId = newChallengeId();
  await AuthChallenge.create({
    challengeId,
    userId,
    purpose,
    challenge,
    metadata,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return challengeId;
}

async function claimChallenge({ challengeId, purpose, userId = null }) {
  const filter = {
    challengeId: String(challengeId || ""),
    purpose,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  };
  filter.userId = userId || null;
  const claimed = await AuthChallenge.findOneAndUpdate(
    filter,
    { $set: { consumedAt: new Date() } },
    { returnDocument: "before" }
  ).select("+challenge +metadata");
  return claimed;
}

async function registrationOptions(req, user) {
  const { generateRegistrationOptions } = webAuthn;
  const rp = relyingParty(req);
  const credentials = await PasskeyCredential.find({ userId: user._id }).select("credentialId transports").lean();
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: new Uint8Array(Buffer.from(String(user._id), "utf8")),
    userName: user.email,
    userDisplayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
    timeout: 120000,
  });
  const challengeId = await replaceActiveChallenge({
    userId: user._id,
    purpose: "passkey_registration",
    challenge: options.challenge,
    metadata: rp,
  });
  return { challengeId, options };
}

async function verifyRegistration(req, user, { challengeId, response, name }) {
  const { verifyRegistrationResponse } = webAuthn;
  const challenge = await claimChallenge({ challengeId, purpose: "passkey_registration", userId: user._id });
  if (!challenge) throw new Error("Passkey setup expired. Start again.");
  const rp = challenge.metadata || relyingParty(req);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error("Passkey verification failed.");
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const saved = await PasskeyCredential.create({
    userId: user._id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    name: String(name || "Passkey").trim().slice(0, 80) || "Passkey",
  });
  return saved;
}

async function authenticationOptions(req, { userId = null } = {}) {
  const { generateAuthenticationOptions } = webAuthn;
  const rp = relyingParty(req);
  const credentials = userId
    ? await PasskeyCredential.find({ userId }).select("credentialId transports").lean()
    : [];
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
    timeout: 120000,
    ...(userId
      ? {
          allowCredentials: credentials.map((credential) => ({
            id: credential.credentialId,
            transports: credential.transports,
          })),
        }
      : {}),
  });
  const challengeId = await replaceActiveChallenge({
    userId,
    purpose: "passkey_authentication",
    challenge: options.challenge,
    metadata: rp,
  });
  return { challengeId, options, available: userId ? credentials.length > 0 : true };
}

async function verifyAuthentication(req, { challengeId, response, expectedUserId = null }) {
  const { verifyAuthenticationResponse } = webAuthn;
  const challenge = await claimChallenge({
    challengeId,
    purpose: "passkey_authentication",
    userId: expectedUserId,
  });
  if (!challenge) throw new Error("Passkey sign-in expired. Start again.");
  const passkey = await PasskeyCredential.findOne({ credentialId: String(response?.id || "") })
    .select("+publicKey");
  if (!passkey || (expectedUserId && String(passkey.userId) !== String(expectedUserId))) {
    throw new Error("Passkey not recognized.");
  }
  const rp = challenge.metadata || relyingParty(req);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports,
    },
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error("Passkey verification failed.");
  passkey.counter = verification.authenticationInfo.newCounter;
  passkey.lastUsedAt = new Date();
  await passkey.save();
  return passkey;
}

module.exports = {
  authenticationOptions,
  claimChallenge,
  registrationOptions,
  relyingParty,
  replaceActiveChallenge,
  verifyAuthentication,
  verifyRegistration,
};
