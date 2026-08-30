const jwt = require("jsonwebtoken");
const User = require("../../models/User");

const PHASE2_CLOCK = Object.freeze({
  draft: new Date("2026-09-01T14:00:00.000Z"),
  published: new Date("2026-09-01T14:05:00.000Z"),
  applied: new Date("2026-09-01T14:10:00.000Z"),
  hired: new Date("2026-09-01T15:00:00.000Z"),
  completed: new Date("2026-09-02T18:00:00.000Z"),
});

function authCookieFor(user) {
  const token = jwt.sign(
    {
      id: String(user._id),
      role: user.role,
      email: user.email,
      status: user.status,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  return `token=${token}`;
}

async function createPhase2Actors() {
  const [attorney, paralegal, otherParalegal, admin] = await User.create([
    {
      firstName: "Phase Two",
      lastName: "Attorney",
      email: "phase2.attorney@lets-paraconnect.test",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    },
    {
      firstName: "Phase Two",
      lastName: "Paralegal",
      email: "phase2.paralegal@lets-paraconnect.test",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stateExperience: ["CA"],
      practiceAreas: ["Immigration"],
      yearsExperience: 8,
      profileImage: "https://assets.test/phase2-paralegal.jpg",
      stripeAccountId: "acct_phase2_paralegal",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    {
      firstName: "Phase Two",
      lastName: "Alternate",
      email: "phase2.alternate@lets-paraconnect.test",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stateExperience: ["CA"],
      practiceAreas: ["Immigration"],
      yearsExperience: 8,
      profileImage: "https://assets.test/phase2-alternate.jpg",
      stripeAccountId: "acct_phase2_alternate",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    {
      firstName: "Phase Two",
      lastName: "Admin",
      email: "phase2.admin@lets-paraconnect.test",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    },
  ]);

  return {
    attorney,
    paralegal,
    otherParalegal,
    admin,
    cookies: {
      attorney: authCookieFor(attorney),
      paralegal: authCookieFor(paralegal),
      otherParalegal: authCookieFor(otherParalegal),
      admin: authCookieFor(admin),
    },
  };
}

module.exports = {
  PHASE2_CLOCK,
  authCookieFor,
  createPhase2Actors,
};
