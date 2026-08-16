const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:paralegals");
const router = require("express").Router();
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const { formatDateOnly } = require("../utils/businessDate");
const { parseAvailabilityUpdate } = require("../utils/availability");
const Paralegal = require("../models/User");

router.post("/update-availability", verifyToken, requireApproved, requireRole("paralegal"), csrfProtection, async (req, res) => {
  try {
    const userId = req.user.id;
    const parsed = parseAvailabilityUpdate(req.body || {});
    if (parsed.error) return res.status(400).json({ msg: parsed.error });
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

    const result = await Paralegal.findByIdAndUpdate(
      userId,
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) {
      return res.status(404).json({ msg: "Paralegal not found" });
    }

    const availabilityDetails = {
      status: result.availabilityDetails?.status || parsed.status,
      nextAvailable: result.availabilityDetails?.nextAvailable || null,
      updatedAt: result.availabilityDetails?.updatedAt || updatedAt,
    };

    res.json({
      msg: "Availability updated successfully",
      availability: result.availability,
      availabilityDetails,
    });
  } catch (err) {
    runtimeLogger.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;
