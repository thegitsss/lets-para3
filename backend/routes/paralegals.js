const router = require("express").Router();
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const Paralegal = require("../models/User");

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  return status === "unavailable" ? "unavailable" : "available";
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

router.post("/update-availability", verifyToken, requireApproved, requireRole("paralegal"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, nextAvailable } = req.body || {};

    const normalizedStatus = normalizeStatus(status);
    const normalizedDate = normalizeDate(nextAvailable);
    const updatedAt = new Date();

    const update = {
      availabilityDetails: {
        status: normalizedStatus,
        nextAvailable: normalizedDate,
        updatedAt,
      },
    };

    if (normalizedStatus === "available") {
      update.availability = "Available now";
    } else if (normalizedDate) {
      update.availability = `Unavailable until ${normalizedDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })}`;
    } else {
      update.availability = "Unavailable";
    }

    const result = await Paralegal.findByIdAndUpdate(userId, { $set: update }, { new: true });
    if (!result) {
      return res.status(404).json({ msg: "Paralegal not found" });
    }

    const availabilityDetails = {
      status: result.availabilityDetails?.status || normalizedStatus,
      nextAvailable: result.availabilityDetails?.nextAvailable || null,
      updatedAt: result.availabilityDetails?.updatedAt || updatedAt,
    };

    res.json({
      msg: "Availability updated successfully",
      availability: result.availability,
      availabilityDetails,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;
