const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  requireControlRoomE2eHarnessEnabled,
  requireControlRoomE2eHarnessSecret,
} = require("../utils/controlRoomE2eHarnessAccess");
const {
  resolveAdminCredentials,
  resolveDirectorCredentials,
  resolveSupportAttorneyCredentials,
  resolveSupportParalegalCredentials,
  seedControlRoomFixtureSet,
  upsertHarnessAdmin,
  upsertHarnessAttorneyMatter,
  upsertHarnessDirector,
  upsertHarnessSupportAttorney,
  upsertHarnessSupportParalegal,
} = require("../services/ai/controlRoomE2eHarnessService");
const { sendInvitation } = require("../services/invitationService");

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
    const seedMatter =
      String(_req.query?.seedMatter || _req.body?.seedMatter || "")
        .trim()
        .toLowerCase() === "true";
    const resetMatter =
      String(_req.query?.resetMatter || _req.body?.resetMatter || "")
        .trim()
        .toLowerCase() === "true";
    const matter = seedMatter
      ? await upsertHarnessAttorneyMatter(attorney, { resetWorkflow: resetMatter })
      : null;
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
      matter: matter
        ? { id: String(matter._id), title: matter.title, status: matter.status }
        : null,
    });
  })
);

router.post(
  "/bootstrap-paralegal",
  asyncHandler(async (_req, res) => {
    const { paralegal, credentials } = await upsertHarnessSupportParalegal();
    const seedInvitation =
      String(_req.query?.seedInvitation || _req.body?.seedInvitation || "")
        .trim()
        .toLowerCase() === "true";
    const resetMatter =
      String(_req.query?.resetMatter || _req.body?.resetMatter || "")
        .trim()
        .toLowerCase() === "true";
    let matter = null;
    let invitation = null;
    if (seedInvitation) {
      const { attorney } = await upsertHarnessSupportAttorney();
      matter = await upsertHarnessAttorneyMatter(attorney, { resetWorkflow: resetMatter });
      invitation = await sendInvitation({ caseDoc: matter, paralegalId: paralegal._id });
      if (!invitation.sent && invitation.reason !== "already_pending") {
        const error = new Error(`Unable to seed the paralegal invitation (${invitation.reason || "unknown"}).`);
        error.statusCode = 409;
        throw error;
      }
    }
    res.status(201).json({
      ok: true,
      paralegal: {
        id: String(paralegal._id),
        email: credentials.email,
        role: paralegal.role,
        status: paralegal.status,
        approvedAt: paralegal.approvedAt,
        lastLoginAt: paralegal.lastLoginAt,
      },
      credentials: {
        email: credentials.email,
        passwordConfigured: Boolean(resolveSupportParalegalCredentials().password),
      },
      matter: matter
        ? { id: String(matter._id), title: matter.title, status: matter.status }
        : null,
      invitation: invitation
        ? { sent: invitation.sent === true, alreadyPending: invitation.reason === "already_pending" }
        : null,
    });
  })
);

router.post(
  "/bootstrap-director",
  asyncHandler(async (_req, res) => {
    const { director, credentials } = await upsertHarnessDirector();
    res.status(201).json({
      ok: true,
      director: {
        id: String(director._id),
        email: credentials.email,
        role: director.role,
        status: director.status,
        approvedAt: director.approvedAt,
        lastLoginAt: director.lastLoginAt,
      },
      credentials: {
        email: credentials.email,
        passwordConfigured: Boolean(resolveDirectorCredentials().password),
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
