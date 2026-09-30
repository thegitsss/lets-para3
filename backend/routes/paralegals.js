const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:paralegals");
const router = require("express").Router();
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const { formatDateOnly } = require("../utils/businessDate");
const { parseAvailabilityUpdate, effectiveAvailability } = require("../utils/availability");
const accountWriteGuard = require("../utils/accountWriteGuard");
const Paralegal = require("../models/User");
const { publishNotificationEvent } = require("../utils/notificationEvents");

router.post("/update-availability", verifyToken, requireApproved, requireRole("paralegal"), csrfProtection, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!accountWriteGuard.checkOwner(req)) throw accountWriteGuard.invalid();
    if (Object.keys(req.body || {}).some(key => !['status', 'nextAvailable', 'expectedOwnerId', 'expectedValues'].includes(key))) throw accountWriteGuard.invalid();
    const parsed = parseAvailabilityUpdate(req.body || {});
    if (parsed.error) return res.status(400).json({ msg: parsed.error });
    const current = await Paralegal.findById(userId);
    if (!current) return res.status(404).json({ msg: "Paralegal not found" });
    const filter = accountWriteGuard.prepareWrite(req, current, {
      fields: { availability: ['availability', 'availabilityDetails'] },
      current: { availability: effectiveAvailability(current) },
    });
    const updatedAt = new Date();

    const update = {
      availabilityDetails: {
        status: parsed.status,
        nextAvailable: parsed.nextAvailable,
        updatedAt,
      },
    };

    if (parsed.status === "available") {
      update.availability = "Available now";
    } else if (parsed.nextAvailableDate) {
      update.availability = `Unavailable until ${formatDateOnly(parsed.nextAvailableDate, "en-US", {
        month: "short",
        day: "numeric",
      })}`;
    } else {
      update.availability = "Unavailable";
    }

    const result = await Paralegal.findOneAndUpdate(
      filter,
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) {
      throw accountWriteGuard.conflict();
    }

    const availabilityDetails = {
      status: result.availabilityDetails?.status || parsed.status,
      nextAvailable: result.availabilityDetails?.nextAvailable || null,
      updatedAt: result.availabilityDetails?.updatedAt || updatedAt,
    };

    publishNotificationEvent(result._id, "notifications", {
      at: updatedAt.toISOString(),
      type: "availability_refresh",
    });

    res.json({
      ownerId: String(result._id),
      ...effectiveAvailability({ availability: result.availability, availabilityDetails }),
    });
  } catch (err) {
    if (accountWriteGuard.respond(err, res)) return;
    runtimeLogger.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

const savedParalegals = require('../services/savedParalegals');
const savedHandler = operation => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await savedParalegals[operation](req)); }
  catch (error) {
    if (!error.publicCode) runtimeLogger.error('Saved paralegals request failed', { error });
    res.status(error.status || 500).json({ code: error.publicCode || 'SAVED_PARALEGAL_UNAVAILABLE', error: 'Saved paralegals could not be updated or loaded.' });
  }
};
router.get('/saved', verifyToken, requireApproved, requireRole('attorney'), savedHandler('list'));
router.get('/saved/:paralegalId', verifyToken, requireApproved, requireRole('attorney'), savedHandler('read'));
router.put('/saved/:paralegalId', verifyToken, requireApproved, requireRole('attorney'), csrfProtection, savedHandler('write'));

module.exports = router;
