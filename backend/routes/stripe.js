// backend/routes/stripe.js
const router = require("express").Router();
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const User = require("../models/User");
const stripe = require("../utils/stripe");

const CONNECT_COUNTRY = process.env.STRIPE_CONNECT_COUNTRY || "US";
const CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || process.env.FRONTEND_URL || "https://www.lets-paraconnect.com/profile-settings.html";
const CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || process.env.FRONTEND_URL || "https://www.lets-paraconnect.com/profile-settings.html";

// ----------------------------------------
// Optional CSRF (enable via ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken);

router.post(
  "/connect",
  requireRole(["paralegal"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("email stripeAccountId stripeOnboarded");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.email) return res.status(400).json({ error: "Email required for Stripe onboarding" });

    try {
      if (!user.stripeAccountId) {
        const account = await stripe.accounts.create({
          type: "express",
          country: CONNECT_COUNTRY,
          email: user.email,
          business_type: "individual",
          capabilities: {
            transfers: { requested: true },
          },
        });
        user.stripeAccountId = account.id;
        user.stripeOnboarded = false;
      }

      const link = await stripe.accountLinks.create({
        account: user.stripeAccountId,
        refresh_url: CONNECT_REFRESH_URL,
        return_url: CONNECT_RETURN_URL,
        type: "account_onboarding",
      });

      await user.save();
      res.json({ url: link.url, accountId: user.stripeAccountId });
    } catch (err) {
      console.error("[stripe] connect error", err);
      res.status(500).json({ error: "Unable to start Stripe onboarding" });
    }
  })
);

router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
