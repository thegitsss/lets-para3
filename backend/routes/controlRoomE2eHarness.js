const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  requireControlRoomE2eHarnessEnabled,
  requireControlRoomE2eHarnessSecret,
} = require("../utils/controlRoomE2eHarnessAccess");
const {
  resolveAdminCredentials,
  resolveSupportAttorneyCredentials,
  seedControlRoomFixtureSet,
  upsertHarnessAdmin,
  upsertHarnessSupportAttorney,
} = require("../services/ai/controlRoomE2eHarnessService");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireControlRoomE2eHarnessEnabled);
router.use(requireControlRoomE2eHarnessSecret);

router.post(
  "/bootstrap-admin",
  asyncHandler(async (_req, res) => {
    const { admin, credentials } = await upsertHarnessAdmin();
    res.status(201).json({
      ok: true,
      admin: {
        id: String(admin._id),
        email: credentials.email,
        role: admin.role,
        status: admin.status,
      },
      credentials: {
        email: credentials.email,
        passwordConfigured: Boolean(resolveAdminCredentials().password),
      },
    });
  })
);

router.post(
  "/bootstrap-attorney",
  asyncHandler(async (_req, res) => {
    const forceFreshApproval =
      String(_req.query?.freshApproval || _req.body?.freshApproval || "")
        .trim()
        .toLowerCase() === "true";
    const { attorney, credentials } = await upsertHarnessSupportAttorney({ forceFreshApproval });
    res.status(201).json({
      ok: true,
      attorney: {
        id: String(attorney._id),
        email: credentials.email,
        role: attorney.role,
        status: attorney.status,
        approvedAt: attorney.approvedAt,
        lastLoginAt: attorney.lastLoginAt,
      },
      credentials: {
        email: credentials.email,
        passwordConfigured: Boolean(resolveSupportAttorneyCredentials().password),
      },
    });
  })
);

router.use(verifyToken, requireApproved, requireRole("admin"));

router.post(
  "/seed",
  asyncHandler(async (req, res) => {
    const seeded = await seedControlRoomFixtureSet({
      adminUser: req.user || {},
      decisionCounts: req.body?.decisionCounts || {},
    });
    res.status(201).json({ ok: true, ...seeded });
  })
);

module.exports = router;
