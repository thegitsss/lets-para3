const User = require("../models/User");
const AuthChallenge = require("../models/AuthChallenge");
const {
  authenticationOptions,
  claimChallenge,
  registrationOptions,
  relyingParty,
} = require("../services/passkeyService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const req = {
  protocol: "https",
  headers: { host: "accounts.example.com" },
  get(name) {
    return this.headers[String(name).toLowerCase()];
  },
};

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("passkey challenge service", () => {
  test("uses a scoped relying party and single-use registration challenge", async () => {
    const previousOrigin = process.env.WEBAUTHN_ORIGIN;
    process.env.WEBAUTHN_ORIGIN = "https://accounts.example.com";
    const user = await User.create({
      firstName: "Passkey",
      lastName: "Member",
      email: "passkey@example.com",
      password: "A secure current passphrase",
      role: "attorney",
      status: "approved",
      emailVerified: true,
    });
    expect(relyingParty(req)).toEqual(expect.objectContaining({
      rpID: "accounts.example.com",
      origin: "https://accounts.example.com",
    }));
    const generated = await registrationOptions(req, user);
    expect(generated.options.challenge).toBeTruthy();
    expect(generated.options.authenticatorSelection.residentKey).toBe("required");
    const first = await claimChallenge({
      challengeId: generated.challengeId,
      purpose: "passkey_registration",
      userId: user._id,
    });
    expect(first.challenge).toBe(generated.options.challenge);
    const replay = await claimChallenge({
      challengeId: generated.challengeId,
      purpose: "passkey_registration",
      userId: user._id,
    });
    expect(replay).toBeNull();
    if (previousOrigin === undefined) delete process.env.WEBAUTHN_ORIGIN;
    else process.env.WEBAUTHN_ORIGIN = previousOrigin;
  });

  test("anonymous authentication challenges cannot be claimed as user-bound challenges", async () => {
    const generated = await authenticationOptions(req);
    const challenge = await AuthChallenge.findOne({ challengeId: generated.challengeId }).lean();
    expect(challenge.userId).toBeNull();
    const mismatched = await claimChallenge({
      challengeId: generated.challengeId,
      purpose: "passkey_authentication",
      userId: new (require("mongoose").Types.ObjectId)(),
    });
    expect(mismatched).toBeNull();
  });
});
